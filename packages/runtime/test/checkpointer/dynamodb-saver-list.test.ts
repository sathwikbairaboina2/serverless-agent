import { describe, expect, it } from 'vitest';
import { emptyCheckpoint, uuid6, type CheckpointMetadata, type CheckpointTuple } from '@langchain/langgraph-checkpoint';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

async function collect(gen: AsyncGenerator<CheckpointTuple>) {
  const out: CheckpointTuple[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

async function seed(saver: DynamoDBSaver, threadId: string, n: number, ns = '') {
  const ids: string[] = [];
  let cfg = { configurable: { thread_id: threadId, checkpoint_ns: ns } } as any;
  for (let step = 0; step < n; step++) {
    const cp = { ...emptyCheckpoint(), id: uuid6(-1) };
    cfg = await saver.put(cfg, cp, { source: 'loop', step, parents: {} } as CheckpointMetadata, {});
    ids.push(cp.id);
  }
  return ids;
}

describe('DynamoDBSaver list', () => {
  it('lists a thread newest first across pages', async () => {
    const saver = new DynamoDBSaver({ client: new FakeDocumentClient({ maxPageSize: 2 }), tableName: 't' });
    const ids = await seed(saver, 't1', 5);
    const listed = await collect(saver.list({ configurable: { thread_id: 't1' } }));
    expect(listed.map((t) => t.checkpoint.id)).toEqual([...ids].reverse());
  });

  it('applies limit, before and metadata filter', async () => {
    const saver = new DynamoDBSaver({ client: new FakeDocumentClient(), tableName: 't' });
    const ids = await seed(saver, 't1', 4);
    expect((await collect(saver.list({ configurable: { thread_id: 't1' } }, { limit: 2 }))).map((t) => t.checkpoint.id)).toEqual([ids[3], ids[2]]);
    expect((await collect(saver.list({ configurable: { thread_id: 't1' } }, { before: { configurable: { checkpoint_id: ids[2] } } }))).map((t) => t.checkpoint.id)).toEqual([ids[1], ids[0]]);
    expect((await collect(saver.list({ configurable: { thread_id: 't1' } }, { filter: { step: 1 } }))).map((t) => t.checkpoint.id)).toEqual([ids[1]]);
  });

  it('restricts to a namespace when checkpoint_ns is given', async () => {
    const saver = new DynamoDBSaver({ client: new FakeDocumentClient(), tableName: 't' });
    await seed(saver, 't1', 2, '');
    const sub = await seed(saver, 't1', 1, 'child:1');
    const listed = await collect(saver.list({ configurable: { thread_id: 't1', checkpoint_ns: 'child:1' } }));
    expect(listed.map((t) => t.checkpoint.id)).toEqual(sub);
    expect(await collect(saver.list({ configurable: { thread_id: 't1' } }))).toHaveLength(3);
  });

  it('lists across threads with a scan when no thread_id is given, ignoring approval items', async () => {
    const client = new FakeDocumentClient();
    const saver = new DynamoDBSaver({ client, tableName: 't' });
    await seed(saver, 'a', 1);
    await seed(saver, 'b', 2);
    client.putRaw({ pk: 'approval#abc', sk: 'approval', taskToken: 'x' });
    expect(await collect(saver.list({}))).toHaveLength(3);
  });
});

describe('DynamoDBSaver deleteThread', () => {
  it('deletes every item of one thread across pages and batches, keeping other threads', async () => {
    const client = new FakeDocumentClient({ maxPageSize: 7, unprocessedOnFirstBatch: true });
    const saver = new DynamoDBSaver({ client, tableName: 't' });
    const ids = await seed(saver, 'gone', 30);
    await saver.putWrites({ configurable: { thread_id: 'gone', checkpoint_ns: '', checkpoint_id: ids[0] } }, [['a', 1]], 'task');
    await seed(saver, 'kept', 1);
    await saver.deleteThread('gone');
    expect(client.allItems().every((i) => i.pk === 'kept')).toBe(true);
    expect(client.allItems()).toHaveLength(1);
  });
});
