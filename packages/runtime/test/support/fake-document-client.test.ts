import { describe, expect, it } from 'vitest';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { FakeDocumentClient } from './fake-document-client.js';

const T = 'table';
const names = { '#pk': 'pk', '#sk': 'sk' };

describe('FakeDocumentClient', () => {
  it('puts and gets an item by key', async () => {
    const c = new FakeDocumentClient();
    await c.send(new PutCommand({ TableName: T, Item: { pk: 'a', sk: '1', v: new Uint8Array([1, 2]) } }));
    const out = await c.send(new GetCommand({ TableName: T, Key: { pk: 'a', sk: '1' } }));
    expect(out.Item).toEqual({ pk: 'a', sk: '1', v: new Uint8Array([1, 2]) });
  });

  it('rejects undefined attribute values like the real marshaller', async () => {
    const c = new FakeDocumentClient();
    await expect(c.send(new PutCommand({ TableName: T, Item: { pk: 'a', sk: '1', x: undefined } }))).rejects.toThrow(/undefined/);
  });

  it('queries by prefix in descending order with pagination', async () => {
    const c = new FakeDocumentClient({ maxPageSize: 2 });
    for (const sk of ['cp##1', 'cp##2', 'cp##3', 'wr##1']) c.putRaw({ pk: 't', sk });
    const input = {
      TableName: T,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ':pk': 't', ':skPrefix': 'cp#' },
      ScanIndexForward: false,
    };
    const page1 = await c.send(new QueryCommand(input));
    expect(page1.Items.map((i: { sk: string }) => i.sk)).toEqual(['cp##3', 'cp##2']);
    expect(page1.LastEvaluatedKey).toEqual({ pk: 't', sk: 'cp##2' });
    const page2 = await c.send(new QueryCommand({ ...input, ExclusiveStartKey: page1.LastEvaluatedKey }));
    expect(page2.Items.map((i: { sk: string }) => i.sk)).toEqual(['cp##1']);
    expect(page2.LastEvaluatedKey).toBeUndefined();
  });

  it('honours Limit', async () => {
    const c = new FakeDocumentClient();
    for (const sk of ['cp##1', 'cp##2']) c.putRaw({ pk: 't', sk });
    const out = await c.send(new QueryCommand({
      TableName: T, KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': 't' }, ScanIndexForward: false, Limit: 1,
    }));
    expect(out.Items).toHaveLength(1);
    expect(out.Items[0].sk).toBe('cp##2');
  });

  it('throws on expressions it does not understand', async () => {
    const c = new FakeDocumentClient();
    await expect(c.send(new QueryCommand({
      TableName: T, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 't' },
    }))).rejects.toThrow(/unsupported/);
  });

  it('enforces attribute_not_exists conditions with ConditionalCheckFailedException', async () => {
    const c = new FakeDocumentClient();
    const put = () => c.send(new PutCommand({ TableName: T, Item: { pk: 'a', sk: '1' }, ConditionExpression: 'attribute_not_exists(#sk)', ExpressionAttributeNames: { '#sk': 'sk' } }));
    await put();
    await expect(put()).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('deletes with attribute_exists and returns ALL_OLD', async () => {
    const c = new FakeDocumentClient();
    c.putRaw({ pk: 'a', sk: '1', token: 'x' });
    const del = () => c.send(new DeleteCommand({ TableName: T, Key: { pk: 'a', sk: '1' }, ConditionExpression: 'attribute_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' }, ReturnValues: 'ALL_OLD' }));
    expect((await del()).Attributes).toEqual({ pk: 'a', sk: '1', token: 'x' });
    await expect(del()).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('scans with a begins_with filter across partitions', async () => {
    const c = new FakeDocumentClient();
    c.putRaw({ pk: 'a', sk: 'cp##1' });
    c.putRaw({ pk: 'b', sk: 'cp##1' });
    c.putRaw({ pk: 'approval#x', sk: 'approval' });
    const out = await c.send(new ScanCommand({ TableName: T, FilterExpression: 'begins_with(#sk, :skPrefix)', ExpressionAttributeNames: { '#sk': 'sk' }, ExpressionAttributeValues: { ':skPrefix': 'cp#' } }));
    expect(out.Items).toHaveLength(2);
  });

  it('batch-deletes and can report unprocessed items once', async () => {
    const c = new FakeDocumentClient({ unprocessedOnFirstBatch: true });
    c.putRaw({ pk: 'a', sk: '1' });
    c.putRaw({ pk: 'a', sk: '2' });
    const req = { RequestItems: { [T]: [{ DeleteRequest: { Key: { pk: 'a', sk: '1' } } }, { DeleteRequest: { Key: { pk: 'a', sk: '2' } } }] } };
    const first = await c.send(new BatchWriteCommand(req));
    expect(first.UnprocessedItems[T]).toHaveLength(2);
    expect(c.items.size).toBe(2);
    const second = await c.send(new BatchWriteCommand(req));
    expect(second.UnprocessedItems).toEqual({});
    expect(c.items.size).toBe(0);
  });
});

describe('FakeDocumentClient UpdateCommand', () => {
  it('sets expiresAt only on an existing item', async () => {
    const c = new FakeDocumentClient();
    c.putRaw({ pk: 'a', sk: '1', expiresAt: 1 });
    const upd = (sk: string, expr = 'SET #e = :e') => c.send(new UpdateCommand({ TableName: T, Key: { pk: 'a', sk }, UpdateExpression: expr, ConditionExpression: 'attribute_exists(#pk)', ExpressionAttributeNames: { '#e': 'expiresAt', '#pk': 'pk' }, ExpressionAttributeValues: { ':e': 99 } }));
    await upd('1');
    expect(c.allItems()[0].expiresAt).toBe(99);
    await expect(upd('missing')).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    await expect(upd('1', 'SET x = :e')).rejects.toThrow(/unsupported/);
  });
});
