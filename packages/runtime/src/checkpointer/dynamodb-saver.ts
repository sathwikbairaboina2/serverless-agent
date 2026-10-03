import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  maxChannelVersion,
  TASKS,
  WRITES_IDX_MAP,
} from '@langchain/langgraph-checkpoint';
import { isDeepStrictEqual } from 'node:util';
import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CheckpointTooLargeError, InvalidKeyError } from './errors.js';

export const MAX_CHECKPOINT_BYTES = 350_000;

export interface DocumentClientLike { send(command: any): Promise<any> }

export interface DynamoDBSaverOptions {
  client: DocumentClientLike;
  tableName: string;
  ttlSeconds?: number;
  now?: () => number;
  serde?: SerializerProtocol;
}

type Item = Record<string, any>;

const NAMES_PK = { '#pk': 'pk' };
const NAMES_PK_SK = { '#pk': 'pk', '#sk': 'sk' };

export function assertKeyPart(field: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('#') || value.length > 512 || (!allowEmpty && value.length === 0)) {
    throw new InvalidKeyError(field, value);
  }
  return value;
}

export const cpPrefix = (ns: string) => `cp#${ns}#`;
export const cpSk = (ns: string, id: string) => `${cpPrefix(ns)}${id}`;
export const blobSk = (ns: string, channel: string, version: string | number) => `bl#${ns}#${encodeURIComponent(channel)}#${encodeURIComponent(String(version))}`;
export const wrPrefix = (ns: string, id: string) => `wr#${ns}#${id}#`;
export const wrSk = (ns: string, id: string, taskId: string, idx: number) => `${wrPrefix(ns, id)}${taskId}#${idx}`;

export class DynamoDBSaver extends BaseCheckpointSaver {
  private readonly client: DocumentClientLike;
  private readonly tableName: string;
  private readonly ttlSeconds?: number;
  private readonly now: () => number;

  constructor(opts: DynamoDBSaverOptions) {
    super(opts.serde);
    this.client = opts.client;
    this.tableName = opts.tableName;
    this.ttlSeconds = opts.ttlSeconds;
    this.now = opts.now ?? Date.now;
  }

  /** Adds expiresAt when TTL is configured. Never emits undefined attributes. */
  protected withTtl(item: Item): Item {
    if (this.ttlSeconds && this.ttlSeconds > 0) item.expiresAt = Math.floor(this.now() / 1000) + this.ttlSeconds;
    return item;
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<RunnableConfig> {
    if (config.configurable?.thread_id === undefined) throw new Error('DynamoDBSaver.put: config.configurable.thread_id is required');
    const threadId = assertKeyPart('thread_id', config.configurable.thread_id);
    const ns = assertKeyPart('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true);
    const id = assertKeyPart('checkpoint_id', checkpoint.id);
    const parent = config.configurable?.checkpoint_id as string | undefined;
    // Channel values are stored as separate blob items keyed by (channel, version), like the
    // official Postgres saver. The checkpoint item carries only the skeleton. Only channels in
    // newVersions are written; unchanged channels keep the blob written at their earlier version.
    const skeleton: Checkpoint = { ...copyCheckpoint(checkpoint), channel_values: {} };
    const channelValues = checkpoint.channel_values ?? {};
    const [[cpType, cpBytes], [mdType, mdBytes], blobs] = await Promise.all([
      this.serde.dumpsTyped(skeleton),
      this.serde.dumpsTyped(metadata),
      Promise.all(Object.entries(channelValues).map(async ([channel, value]) => {
        const [valueType, bytes] = await this.serde.dumpsTyped(value);
        return { channel, valueType, bytes };
      })),
    ]);
    const size = cpBytes.length + mdBytes.length + blobs.reduce((n, b) => n + b.bytes.length, 0);
    if (size > MAX_CHECKPOINT_BYTES) throw new CheckpointTooLargeError(size, MAX_CHECKPOINT_BYTES);
    const item: Item = {
      pk: threadId, sk: cpSk(ns, id), kind: 'checkpoint',
      threadId, checkpointNs: ns, checkpointId: id,
      cpType, checkpoint: cpBytes, mdType, metadata: mdBytes,
    };
    if (parent) item.parentCheckpointId = parent;
    // Unchanged channels keep their old blob, so refresh its TTL; otherwise it can expire while this checkpoint still references it.
    if (this.ttlSeconds && this.ttlSeconds > 0) {
      const expiresAt = Math.floor(this.now() / 1000) + this.ttlSeconds;
      await Promise.all(Object.entries(checkpoint.channel_versions ?? {})
        .filter(([channel]) => !(channel in newVersions))
        .map(async ([channel, version]) => {
          try {
            await this.client.send(new UpdateCommand({
              TableName: this.tableName,
              Key: { pk: threadId, sk: blobSk(ns, channel, version) },
              UpdateExpression: 'SET #e = :e',
              ConditionExpression: 'attribute_exists(#pk)',
              ExpressionAttributeNames: { '#e': 'expiresAt', '#pk': 'pk' },
              ExpressionAttributeValues: { ':e': expiresAt },
            }));
          } catch (err) {
            if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
          }
        }));
    }
    // Blobs first: a checkpoint item must never point at blobs that were not written.
    await Promise.all(blobs
      .filter((b) => b.channel in newVersions)
      .map((b) => this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: this.withTtl({ pk: threadId, sk: blobSk(ns, b.channel, newVersions[b.channel]), kind: 'blob', valueType: b.valueType, value: b.bytes }),
      }))));
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: this.withTtl(item) }));
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: id } };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const rawThread = config.configurable?.thread_id;
    if (rawThread === undefined) return undefined;
    const threadId = assertKeyPart('thread_id', rawThread);
    const ns = assertKeyPart('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true);
    const id = getCheckpointId(config);
    let item: Item | undefined;
    if (id) {
      const out = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: threadId, sk: cpSk(ns, assertKeyPart('checkpoint_id', id)) } }));
      item = out.Item;
    } else {
      const out = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
        ExpressionAttributeNames: NAMES_PK_SK,
        ExpressionAttributeValues: { ':pk': threadId, ':skPrefix': cpPrefix(ns) },
        ScanIndexForward: false,
        Limit: 1,
      }));
      item = out.Items?.[0];
    }
    return item ? this.toTuple(item) : undefined;
  }

  protected async toTuple(item: Item, preloadedMetadata?: CheckpointMetadata): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(item.cpType, item.checkpoint)) as Checkpoint;
    await this.hydrate(checkpoint, item);
    const metadata = preloadedMetadata ?? ((await this.serde.loadsTyped(item.mdType, item.metadata)) as CheckpointMetadata);
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: item.threadId, checkpoint_ns: item.checkpointNs, checkpoint_id: item.checkpointId } },
      checkpoint,
      metadata,
      pendingWrites: await this.loadWrites(item.threadId, item.checkpointNs, item.checkpointId),
    };
    if (item.parentCheckpointId) {
      tuple.parentConfig = { configurable: { thread_id: item.threadId, checkpoint_ns: item.checkpointNs, checkpoint_id: item.parentCheckpointId } };
    }
    return tuple;
  }

  /** Rebuilds channel_values from blob items and migrates pre-v4 pending sends. */
  protected async hydrate(checkpoint: Checkpoint, item: Item): Promise<void> {
    const versions = checkpoint.channel_versions ?? {};
    const values: Record<string, unknown> = {};
    await Promise.all(Object.entries(versions).map(async ([channel, version]) => {
      const out = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: item.threadId, sk: blobSk(item.checkpointNs, channel, version) } }));
      if (out.Item) values[channel] = await this.serde.loadsTyped(out.Item.valueType, out.Item.value);
    }));
    checkpoint.channel_values = values;
    if (checkpoint.v < 4 && item.parentCheckpointId) {
      const parentWrites = await this.loadWrites(item.threadId, item.checkpointNs, item.parentCheckpointId);
      checkpoint.channel_values[TASKS] = parentWrites.filter((w) => w[1] === TASKS).map((w) => w[2]);
      const existing = Object.values(checkpoint.channel_versions ?? {});
      checkpoint.channel_versions = {
        ...(checkpoint.channel_versions ?? {}),
        [TASKS]: existing.length > 0 ? maxChannelVersion(...existing) : this.getNextVersion(undefined),
      };
    }
  }

  /** Async generator over every item of a Query, following LastEvaluatedKey. */
  protected async *queryAll(input: Record<string, unknown>): AsyncGenerator<Item> {
    let startKey: Item | undefined;
    do {
      const out = await this.client.send(new QueryCommand({ ...input, TableName: this.tableName, ExclusiveStartKey: startKey } as any));
      for (const item of out.Items ?? []) yield item;
      startKey = out.LastEvaluatedKey;
    } while (startKey);
  }

  protected async loadWrites(threadId: string, ns: string, checkpointId: string): Promise<CheckpointPendingWrite[]> {
    const items: Item[] = [];
    for await (const item of this.queryAll({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: NAMES_PK_SK,
      ExpressionAttributeValues: { ':pk': threadId, ':skPrefix': wrPrefix(ns, checkpointId) },
    })) items.push(item);
    items.sort((a, b) => (a.taskId === b.taskId ? a.idx - b.idx : a.taskId < b.taskId ? -1 : 1));
    return Promise.all(items.map(async (i) => [i.taskId, i.channel, await this.serde.loadsTyped(i.valueType, i.value)] as CheckpointPendingWrite));
  }

  protected async *scanCheckpoints(): AsyncGenerator<Item> {
    const all: Item[] = [];
    let startKey: Item | undefined;
    do {
      const out = await this.client.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'begins_with(#sk, :skPrefix)',
        ExpressionAttributeNames: { '#sk': 'sk' },
        ExpressionAttributeValues: { ':skPrefix': 'cp#' },
        ExclusiveStartKey: startKey,
      }));
      all.push(...(out.Items ?? []));
      startKey = out.LastEvaluatedKey;
    } while (startKey);
    all.sort((a, b) => (a.pk === b.pk ? (a.sk < b.sk ? 1 : -1) : a.pk < b.pk ? 1 : -1));
    yield* all;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { before, filter } = options ?? {};
    let remaining = options?.limit;
    const rawThread = config.configurable?.thread_id;
    const rawNs = config.configurable?.checkpoint_ns;
    const ns = rawNs === undefined ? undefined : assertKeyPart('checkpoint_ns', rawNs, true);
    const onlyId = config.configurable?.checkpoint_id as string | undefined;
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;
    const source = rawThread === undefined
      ? this.scanCheckpoints()
      : this.queryAll({
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
          ExpressionAttributeNames: NAMES_PK_SK,
          ExpressionAttributeValues: { ':pk': assertKeyPart('thread_id', rawThread), ':skPrefix': ns === undefined ? 'cp#' : cpPrefix(ns) },
          ScanIndexForward: false,
        });
    for await (const item of source) {
      if (remaining !== undefined && remaining <= 0) return;
      if (ns !== undefined && item.checkpointNs !== ns) continue;
      if (onlyId && item.checkpointId !== onlyId) continue;
      if (beforeId && item.checkpointId >= beforeId) continue;
      const metadata = (await this.serde.loadsTyped(item.mdType, item.metadata)) as CheckpointMetadata;
      if (filter && !Object.entries(filter).every(([k, v]) => isDeepStrictEqual((metadata as Record<string, unknown>)[k], v))) continue;
      if (remaining !== undefined) remaining -= 1;
      yield await this.toTuple(item, metadata);
    }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    if (config.configurable?.thread_id === undefined) throw new Error('DynamoDBSaver.putWrites: config.configurable.thread_id is required');
    if (config.configurable?.checkpoint_id === undefined) throw new Error('DynamoDBSaver.putWrites: config.configurable.checkpoint_id is required');
    const threadId = assertKeyPart('thread_id', config.configurable.thread_id);
    const ns = assertKeyPart('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true);
    const checkpointId = assertKeyPart('checkpoint_id', config.configurable.checkpoint_id);
    const task = assertKeyPart('task_id', taskId);
    await Promise.all(writes.map(async ([channel, value], index) => {
      const idx = WRITES_IDX_MAP[channel] ?? index;
      const [valueType, bytes] = await this.serde.dumpsTyped(value);
      const item = this.withTtl({ pk: threadId, sk: wrSk(ns, checkpointId, task, idx), kind: 'write', taskId: task, channel, idx, valueType, value: bytes });
      if (idx < 0) {
        await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
        return;
      }
      try {
        await this.client.send(new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(#sk)', ExpressionAttributeNames: { '#sk': 'sk' } }));
      } catch (err) {
        if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
      }
    }));
  }

  async deleteThread(threadId: string): Promise<void> {
    const pk = assertKeyPart('thread_id', threadId);
    const keys: Item[] = [];
    for await (const item of this.queryAll({
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: NAMES_PK,
      ExpressionAttributeValues: { ':pk': pk },
    })) keys.push({ pk: item.pk, sk: item.sk });
    for (let i = 0; i < keys.length; i += 25) {
      let requests: Item[] = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
      for (let attempt = 1; requests.length > 0; attempt++) {
        if (attempt > 6) throw new Error(`DynamoDBSaver.deleteThread: ${requests.length} deletes still unprocessed after retries`);
        if (attempt > 1) await new Promise((r) => setTimeout(r, (attempt - 1) * 50));
        const out = await this.client.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } } as any));
        requests = out.UnprocessedItems?.[this.tableName] ?? [];
      }
    }
  }
}

export { NAMES_PK };
