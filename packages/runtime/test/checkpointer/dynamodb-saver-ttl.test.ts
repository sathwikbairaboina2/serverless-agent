import { describe, expect, it } from 'vitest';
import { emptyCheckpoint, uuid6, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { CheckpointTooLargeError } from '../../src/checkpointer/errors.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

const md = { source: 'input', step: -1, parents: {} } as CheckpointMetadata;
const NOW = 1_700_000_000_000;

describe('DynamoDBSaver TTL', () => {
  it('stamps expiresAt on checkpoints and writes when ttlSeconds is set', async () => {
    const client = new FakeDocumentClient();
    const saver = new DynamoDBSaver({ client, tableName: 't', ttlSeconds: 3600, now: () => NOW });
    const cfg = await saver.put({ configurable: { thread_id: 't1' } }, { ...emptyCheckpoint(), id: uuid6(-1) }, md, {});
    await saver.putWrites(cfg, [['a', 1]], 'task');
    for (const item of client.allItems()) expect(item.expiresAt).toBe(1_700_003_600);
  });

  it('omits expiresAt when ttlSeconds is not set', async () => {
    const client = new FakeDocumentClient();
    const saver = new DynamoDBSaver({ client, tableName: 't' });
    await saver.put({ configurable: { thread_id: 't1' } }, { ...emptyCheckpoint(), id: uuid6(-1) }, md, {});
    expect(client.allItems()[0]).not.toHaveProperty('expiresAt');
  });

  it('refuses checkpoints that would exceed the DynamoDB item limit', async () => {
    const saver = new DynamoDBSaver({ client: new FakeDocumentClient(), tableName: 't' });
    const huge = { ...emptyCheckpoint(), id: uuid6(-1), channel_values: { blob: 'x'.repeat(400_000) } };
    await expect(saver.put({ configurable: { thread_id: 't1' } }, huge, md, {})).rejects.toBeInstanceOf(CheckpointTooLargeError);
  });
});

describe('DynamoDBSaver TTL refresh of unchanged channel blobs', () => {
  it('extends expiresAt of unchanged blobs without rewriting them', async () => {
    const client = new FakeDocumentClient();
    let now = NOW;
    const saver = new DynamoDBSaver({ client, tableName: 't', ttlSeconds: 3600, now: () => now });
    const cpA = { ...emptyCheckpoint(), id: uuid6(-1), channel_values: { a: 1, b: 2 }, channel_versions: { a: 1, b: 1 } };
    const cfgA = await saver.put({ configurable: { thread_id: 't1' } }, cpA, md, { a: 1, b: 1 });
    now += 3000 * 1000;
    const cpB = { ...emptyCheckpoint(), id: uuid6(-1), channel_values: { a: 3, b: 2 }, channel_versions: { a: 2, b: 1 } };
    await saver.put(cfgA, cpB, md, { a: 2 });
    const blobsB = client.allItems().filter((i) => i.kind === 'blob' && String(i.sk).includes('#b#'));
    expect(blobsB).toHaveLength(1);
    expect(blobsB[0].expiresAt).toBe(Math.floor(now / 1000) + 3600);
    const tuple = await saver.getTuple({ configurable: { thread_id: 't1' } });
    expect(tuple?.checkpoint.channel_values).toEqual({ a: 3, b: 2 });
  });
});
