import { describe, expect, it } from 'vitest';
import { PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { ApiGatewayNotifier, NullNotifier, TokenBatcher } from '../src/notify.js';

class FakeApiClient {
  readonly commands: PostToConnectionCommand[] = [];
  failWith?: Error;
  async send(cmd: PostToConnectionCommand) {
    this.commands.push(cmd);
    if (this.failWith) throw this.failWith;
    return {};
  }
}

function gone(): Error {
  const e = new Error('gone');
  e.name = 'GoneException';
  return e;
}

describe('ApiGatewayNotifier', () => {
  it('posts JSON to the connection', async () => {
    const client = new FakeApiClient();
    await new ApiGatewayNotifier(client).send('c1', { type: 'token', runId: 'r', text: 'hi' });
    expect(client.commands[0].input.ConnectionId).toBe('c1');
    expect(JSON.parse(String(client.commands[0].input.Data))).toEqual({ type: 'token', runId: 'r', text: 'hi' });
  });

  it('does nothing without a connection id', async () => {
    const client = new FakeApiClient();
    await new ApiGatewayNotifier(client).send(null, { type: 'token', runId: 'r', text: 'hi' });
    expect(client.commands).toHaveLength(0);
  });

  it('stops sending to a connection after GoneException and never throws', async () => {
    const client = new FakeApiClient();
    client.failWith = gone();
    const n = new ApiGatewayNotifier(client, () => {});
    await expect(n.send('c1', { type: 'token', runId: 'r', text: 'a' })).resolves.toBeUndefined();
    await n.send('c1', { type: 'token', runId: 'r', text: 'b' });
    expect(client.commands).toHaveLength(1);
  });

  it('swallows other errors (streaming is best effort)', async () => {
    const client = new FakeApiClient();
    client.failWith = new Error('throttled');
    const logs: string[] = [];
    await expect(new ApiGatewayNotifier(client, (m) => logs.push(m)).send('c1', { type: 'token', runId: 'r', text: 'a' })).resolves.toBeUndefined();
    expect(logs.join()).toMatch(/throttled/);
  });

  it('NullNotifier accepts everything silently', async () => {
    await expect(new NullNotifier().send('c1', { type: 'token', runId: 'r', text: 'a' })).resolves.toBeUndefined();
  });
});

describe('TokenBatcher', () => {
  it('flushes when the buffer reaches minChars and on close', async () => {
    const flushed: string[] = [];
    const b = new TokenBatcher(async (t) => { flushed.push(t); }, 5);
    await b.push('ab');
    await b.push('cd');
    expect(flushed).toEqual([]);
    await b.push('e');
    expect(flushed).toEqual(['abcde']);
    await b.push('fg');
    await b.close();
    expect(flushed).toEqual(['abcde', 'fg']);
  });

  it('does not flush empty text on close', async () => {
    const flushed: string[] = [];
    const b = new TokenBatcher(async (t) => { flushed.push(t); });
    await b.close();
    expect(flushed).toEqual([]);
  });
});
