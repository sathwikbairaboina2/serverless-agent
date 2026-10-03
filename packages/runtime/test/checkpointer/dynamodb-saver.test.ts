import { describe, expect, it } from 'vitest';
import { emptyCheckpoint, uuid6, type Checkpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { InvalidKeyError } from '../../src/checkpointer/errors.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return { ...emptyCheckpoint(), id: uuid6(-1), ...overrides };
}
const metadata: CheckpointMetadata = { source: 'input', step: -1, parents: {} } as CheckpointMetadata;

function makeSaver(client = new FakeDocumentClient()) {
  return { client, saver: new DynamoDBSaver({ client, tableName: 'checkpoints' }) };
}

describe('DynamoDBSaver put/getTuple', () => {
  it('returns undefined for an unknown thread', async () => {
    const { saver } = makeSaver();
    expect(await saver.getTuple({ configurable: { thread_id: 'nope' } })).toBeUndefined();
  });

  it('round-trips a checkpoint and returns the stored config', async () => {
    const { saver } = makeSaver();
    const cp = checkpoint({ channel_values: { messages: ['hi'] }, channel_versions: { messages: 1 } });
    const cfg = await saver.put({ configurable: { thread_id: 't1', checkpoint_ns: '' } }, cp, metadata, { messages: 1 });
    expect(cfg).toEqual({ configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: cp.id } });
    const tuple = await saver.getTuple({ configurable: { thread_id: 't1' } });
    expect(tuple?.checkpoint.id).toBe(cp.id);
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['hi'] });
    expect(tuple?.metadata).toEqual(metadata);
    expect(tuple?.config.configurable?.checkpoint_id).toBe(cp.id);
  });

  it('returns the latest checkpoint when no checkpoint_id is given and links the parent', async () => {
    const { saver } = makeSaver();
    const first = checkpoint();
    const firstCfg = await saver.put({ configurable: { thread_id: 't1' } }, first, metadata, {});
    const second = checkpoint();
    await saver.put(firstCfg, second, metadata, {});
    const latest = await saver.getTuple({ configurable: { thread_id: 't1' } });
    expect(latest?.checkpoint.id).toBe(second.id);
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe(first.id);
  });

  it('fetches a specific checkpoint by id', async () => {
    const { saver } = makeSaver();
    const first = checkpoint();
    const firstCfg = await saver.put({ configurable: { thread_id: 't1' } }, first, metadata, {});
    await saver.put(firstCfg, checkpoint(), metadata, {});
    const tuple = await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_id: first.id } });
    expect(tuple?.checkpoint.id).toBe(first.id);
  });

  it('keeps namespaces separate', async () => {
    const { saver } = makeSaver();
    const root = checkpoint();
    await saver.put({ configurable: { thread_id: 't1', checkpoint_ns: '' } }, root, metadata, {});
    const child = checkpoint();
    await saver.put({ configurable: { thread_id: 't1', checkpoint_ns: 'sub:1' } }, child, metadata, {});
    expect((await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_ns: '' } }))?.checkpoint.id).toBe(root.id);
    expect((await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_ns: 'sub:1' } }))?.checkpoint.id).toBe(child.id);
  });

  it('stores bytes, not JSON strings, and never writes undefined attributes', async () => {
    const { saver, client } = makeSaver();
    await saver.put({ configurable: { thread_id: 't1' } }, checkpoint(), metadata, {});
    const [item] = client.allItems();
    expect(item.checkpoint).toBeInstanceOf(Uint8Array);
    expect(item.sk).toMatch(/^cp##/);
    expect(item).not.toHaveProperty('parentCheckpointId');
  });

  it('rejects # in thread_id or checkpoint_ns', async () => {
    const { saver } = makeSaver();
    await expect(saver.put({ configurable: { thread_id: 'a#b' } }, checkpoint(), metadata, {})).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(saver.put({ configurable: { thread_id: 't', checkpoint_ns: 'x#y' } }, checkpoint(), metadata, {})).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('requires thread_id on put', async () => {
    const { saver } = makeSaver();
    await expect(saver.put({ configurable: {} }, checkpoint(), metadata, {})).rejects.toThrow(/thread_id/);
  });
});
