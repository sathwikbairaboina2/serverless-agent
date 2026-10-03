import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export type Item = Record<string, unknown>;
export interface DocumentClientLike { send(command: any): Promise<any> }

const KEY_ONLY = '#pk = :pk';
const KEY_PREFIX = '#pk = :pk AND begins_with(#sk, :skPrefix)';
const FILTER_PREFIX = 'begins_with(#sk, :skPrefix)';

function conditionalFailed(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

function keyOf(pk: unknown, sk: unknown): string {
  return `${String(pk)}\u0000${String(sk)}`;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function checkNames(names: Record<string, string> | undefined, used: string[]): void {
  for (const n of used) {
    const expected = n === '#pk' ? 'pk' : 'sk';
    if (names?.[n] !== expected) throw new Error(`FakeDocumentClient: unsupported ExpressionAttributeNames (need ${n} -> ${expected})`);
  }
}

export class FakeDocumentClient implements DocumentClientLike {
  readonly items = new Map<string, Item>();
  private readonly maxPageSize: number;
  private unprocessedPending: boolean;

  constructor(opts: { maxPageSize?: number; unprocessedOnFirstBatch?: boolean } = {}) {
    this.maxPageSize = opts.maxPageSize ?? Number.MAX_SAFE_INTEGER;
    this.unprocessedPending = opts.unprocessedOnFirstBatch ?? false;
  }

  allItems(): Item[] {
    return [...this.items.values()].map(clone);
  }

  putRaw(item: Item): void {
    this.items.set(keyOf(item.pk, item.sk), clone(item));
  }

  async send(command: unknown): Promise<any> {
    if (command instanceof GetCommand) return this.get(command.input as any);
    if (command instanceof PutCommand) return this.put(command.input as any);
    if (command instanceof DeleteCommand) return this.delete(command.input as any);
    if (command instanceof QueryCommand) return this.query(command.input as any);
    if (command instanceof ScanCommand) return this.scan(command.input as any);
    if (command instanceof UpdateCommand) return this.update(command.input as any);
    if (command instanceof BatchWriteCommand) return this.batchWrite(command.input as any);
    throw new Error(`FakeDocumentClient: unsupported command ${(command as object)?.constructor?.name}`);
  }

  private get(input: { Key: Item }) {
    const found = this.items.get(keyOf(input.Key.pk, input.Key.sk));
    return { Item: found ? clone(found) : undefined };
  }

  private checkCondition(expr: string | undefined, names: Record<string, string> | undefined, existing: Item | undefined): void {
    if (expr === undefined) return;
    if (expr === 'attribute_not_exists(#sk)') { checkNames(names, ['#sk']); if (existing) throw conditionalFailed(); return; }
    if (expr === 'attribute_not_exists(#pk)') { checkNames(names, ['#pk']); if (existing) throw conditionalFailed(); return; }
    if (expr === 'attribute_exists(#pk)') { checkNames(names, ['#pk']); if (!existing) throw conditionalFailed(); return; }
    throw new Error(`FakeDocumentClient: unsupported ConditionExpression "${expr}"`);
  }

  private put(input: { Item: Item; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string> }) {
    for (const [k, v] of Object.entries(input.Item)) {
      if (v === undefined) throw new Error(`FakeDocumentClient: attribute "${k}" is undefined (real client throws unless removeUndefinedValues)`);
    }
    if (typeof input.Item.pk !== 'string' || typeof input.Item.sk !== 'string') throw new Error('FakeDocumentClient: pk and sk must be strings');
    const key = keyOf(input.Item.pk, input.Item.sk);
    this.checkCondition(input.ConditionExpression, input.ExpressionAttributeNames, this.items.get(key));
    this.items.set(key, clone(input.Item));
    return {};
  }

  private delete(input: { Key: Item; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ReturnValues?: string }) {
    const key = keyOf(input.Key.pk, input.Key.sk);
    const existing = this.items.get(key);
    this.checkCondition(input.ConditionExpression, input.ExpressionAttributeNames, existing);
    this.items.delete(key);
    return { Attributes: input.ReturnValues === 'ALL_OLD' && existing ? clone(existing) : undefined };
  }

  private update(input: { Key: Item; UpdateExpression?: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Item }) {
    if (input.UpdateExpression !== 'SET #e = :e') throw new Error(`FakeDocumentClient: unsupported UpdateExpression "${input.UpdateExpression}"`);
    if (input.ExpressionAttributeNames?.['#e'] !== 'expiresAt') throw new Error('FakeDocumentClient: unsupported ExpressionAttributeNames (need #e -> expiresAt)');
    const key = keyOf(input.Key.pk, input.Key.sk);
    const existing = this.items.get(key);
    this.checkCondition(input.ConditionExpression, input.ExpressionAttributeNames, existing);
    if (!existing) throw new Error('FakeDocumentClient: UpdateItem without a condition would create an item');
    existing.expiresAt = input.ExpressionAttributeValues?.[':e'];
    return {};
  }

  private page(sorted: Item[], limit: number | undefined, startKey: Item | undefined) {
    let start = 0;
    if (startKey) {
      const idx = sorted.findIndex((i) => i.pk === startKey.pk && i.sk === startKey.sk);
      start = idx + 1;
    }
    const size = Math.min(limit ?? Number.MAX_SAFE_INTEGER, this.maxPageSize);
    const slice = sorted.slice(start, start + size);
    const more = start + size < sorted.length;
    const last = slice.at(-1);
    return {
      Items: slice.map(clone),
      Count: slice.length,
      LastEvaluatedKey: more && last ? { pk: last.pk, sk: last.sk } : undefined,
    };
  }

  private query(input: {
    KeyConditionExpression: string; ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues: Item; ScanIndexForward?: boolean; Limit?: number; ExclusiveStartKey?: Item;
  }) {
    const expr = input.KeyConditionExpression;
    let prefix: string | undefined;
    if (expr === KEY_ONLY) checkNames(input.ExpressionAttributeNames, ['#pk']);
    else if (expr === KEY_PREFIX) { checkNames(input.ExpressionAttributeNames, ['#pk', '#sk']); prefix = String(input.ExpressionAttributeValues[':skPrefix']); }
    else throw new Error(`FakeDocumentClient: unsupported KeyConditionExpression "${expr}"`);
    const pk = input.ExpressionAttributeValues[':pk'];
    const matching = [...this.items.values()]
      .filter((i) => i.pk === pk && (prefix === undefined || String(i.sk).startsWith(prefix)))
      .sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : String(a.sk) > String(b.sk) ? 1 : 0));
    if (input.ScanIndexForward === false) matching.reverse();
    return this.page(matching, input.Limit, input.ExclusiveStartKey);
  }

  private scan(input: { FilterExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Item; ExclusiveStartKey?: Item }) {
    let prefix: string | undefined;
    if (input.FilterExpression !== undefined) {
      if (input.FilterExpression !== FILTER_PREFIX) throw new Error(`FakeDocumentClient: unsupported FilterExpression "${input.FilterExpression}"`);
      checkNames(input.ExpressionAttributeNames, ['#sk']);
      prefix = String(input.ExpressionAttributeValues?.[':skPrefix']);
    }
    const all = [...this.items.values()].sort((a, b) => (keyOf(a.pk, a.sk) < keyOf(b.pk, b.sk) ? -1 : 1));
    const pageOut = this.page(all, undefined, input.ExclusiveStartKey);
    // Real Scan applies the filter after reading the page; mimic that.
    pageOut.Items = pageOut.Items.filter((i) => prefix === undefined || String(i.sk).startsWith(prefix));
    pageOut.Count = pageOut.Items.length;
    return pageOut;
  }

  private batchWrite(input: { RequestItems: Record<string, Array<{ PutRequest?: { Item: Item }; DeleteRequest?: { Key: Item } }>> }) {
    const entries = Object.entries(input.RequestItems);
    const total = entries.reduce((n, [, reqs]) => n + reqs.length, 0);
    if (total > 25) throw new Error('FakeDocumentClient: BatchWrite accepts at most 25 requests');
    if (this.unprocessedPending) {
      this.unprocessedPending = false;
      return { UnprocessedItems: clone(input.RequestItems) };
    }
    for (const [, reqs] of entries) {
      for (const r of reqs) {
        if (r.PutRequest) this.put({ Item: r.PutRequest.Item });
        else if (r.DeleteRequest) this.items.delete(keyOf(r.DeleteRequest.Key.pk, r.DeleteRequest.Key.sk));
      }
    }
    return { UnprocessedItems: {} };
  }
}
