import { describe, expect, it } from 'vitest';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { createWebSocketHandler } from '../../src/handlers/websocket.js';

class FakeSfn {
  readonly commands: StartExecutionCommand[] = [];
  async send(cmd: StartExecutionCommand) { this.commands.push(cmd); return { executionArn: 'arn:exec' }; }
}

function setup() {
  const sfn = new FakeSfn();
  const handler = createWebSocketHandler({ sfn, stateMachineArn: 'arn:sm', newRunId: () => 'run-1' });
  return { sfn, handler };
}
const msg = (body: unknown, routeKey = '$default') => ({ requestContext: { routeKey, connectionId: 'conn-1' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('websocket handler', () => {
  it('accepts connect and disconnect', async () => {
    const { handler } = setup();
    expect((await handler(msg(null, '$connect'))).statusCode).toBe(200);
    expect((await handler(msg(null, '$disconnect'))).statusCode).toBe(200);
  });

  it('starts a Step Functions execution named after the run id with the connection id', async () => {
    const { handler, sfn } = setup();
    const res = await handler(msg({ action: 'run', threadId: 'thread-1', message: 'hello' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ type: 'run_accepted', runId: 'run-1' });
    expect(sfn.commands[0].input).toEqual({ stateMachineArn: 'arn:sm', name: 'run-1', input: JSON.stringify({ threadId: 'thread-1', message: 'hello', connectionId: 'conn-1' }) });
  });

  it.each([
    ['non-JSON', 'oops'],
    ['wrong action', { action: 'delete', threadId: 't', message: 'm' }],
    ['bad threadId', { action: 'run', threadId: 'a#b', message: 'm' }],
    ['empty message', { action: 'run', threadId: 't', message: '' }],
    ['huge message', { action: 'run', threadId: 't', message: 'x'.repeat(16_001) }],
  ])('rejects %s with 400 and does not start a run', async (_n, body) => {
    const { handler, sfn } = setup();
    expect((await handler(msg(body))).statusCode).toBe(400);
    expect(sfn.commands).toHaveLength(0);
  });
});
