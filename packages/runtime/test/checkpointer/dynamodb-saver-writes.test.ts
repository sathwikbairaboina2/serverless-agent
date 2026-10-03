import { describe, expect, it } from 'vitest';
import { emptyCheckpoint, uuid6, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

const metadata = { source: 'loop', step: 0, parents: {} } as CheckpointMetadata;

async function setup(client = new FakeDocumentClient()) {
  const saver = new DynamoDBSaver({ client, tableName: 'checkpoints' });
  const cfg = await saver.put({ configurable: { thread_id: 't1' } }, { ...emptyCheckpoint(), id: uuid6(-1) }, metadata, {});
  return { saver, client, cfg };
}

describe('DynamoDBSaver putWrites', () => {
  it('attaches pending writes to the checkpoint tuple', async () => {
    const { saver, cfg } = await setup();
    await saver.putWrites(cfg, [['messages', { text: 'a' }], ['count', 2]], 'task-1');
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.pendingWrites).toEqual([
      ['task-1', 'messages', { text: 'a' }],
      ['task-1', 'count', 2],
    ]);
  });

  it('keeps the first write for a regular channel index (idempotent retries)', async () => {
    const { saver, cfg } = await setup();
    await saver.putWrites(cfg, [['messages', 'first']], 'task-1');
    await saver.putWrites(cfg, [['messages', 'second']], 'task-1');
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.pendingWrites).toEqual([['task-1', 'messages', 'first']]);
  });

  it('overwrites special channels such as __error__', async () => {
    const { saver, cfg } = await setup();
    await saver.putWrites(cfg, [['__error__', 'boom-1']], 'task-1');
    await saver.putWrites(cfg, [['__error__', 'boom-2']], 'task-1');
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.pendingWrites).toEqual([['task-1', '__error__', 'boom-2']]);
  });

  it('reads writes across multiple DynamoDB pages', async () => {
    const { saver, cfg } = await setup(new FakeDocumentClient({ maxPageSize: 2 }));
    await saver.putWrites(cfg, [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]], 'task-1');
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.pendingWrites?.map((w) => w[1])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('requires checkpoint_id', async () => {
    const { saver } = await setup();
    await expect(saver.putWrites({ configurable: { thread_id: 't1' } }, [['a', 1]], 'task-1')).rejects.toThrow(/checkpoint_id/);
  });
});
