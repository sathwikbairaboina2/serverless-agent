import { describe, expect, it } from 'vitest';
import { SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { createApprovalCallbackHandler } from '../../src/handlers/approval-callback.js';
import { approvalKey } from '../../src/handlers/request-approval.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

const ID = 'B'.repeat(43);
const NOW = 1_700_000_000_000;

class FakeSfn {
  readonly commands: SendTaskSuccessCommand[] = [];
  failWith?: Error;
  async send(cmd: SendTaskSuccessCommand) {
    this.commands.push(cmd);
    if (this.failWith) throw this.failWith;
    return {};
  }
}

function setup(expiresAt = NOW / 1000 + 600) {
  const client = new FakeDocumentClient();
  client.putRaw({ ...approvalKey(ID), kind: 'approval', taskToken: 'tok', runId: 'run-1', threadId: 't1', expiresAt });
  const sfn = new FakeSfn();
  const handler = createApprovalCallbackHandler({ client, tableName: 't', sfn, now: () => NOW });
  return { client, sfn, handler };
}

const ev = (body: unknown, id = ID, base64 = false) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return { pathParameters: { approvalId: id }, body: base64 ? Buffer.from(raw).toString('base64') : raw, isBase64Encoded: base64 };
};
const json = (r: { body: string }) => JSON.parse(r.body);

describe('approvalCallback handler', () => {
  it('approves: resumes the execution with approved=true and consumes the link', async () => {
    const { handler, sfn, client } = setup();
    const res = await handler(ev({ decision: 'approve' }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ status: 'approved', runId: 'run-1' });
    expect(sfn.commands[0].input).toEqual({ taskToken: 'tok', output: JSON.stringify({ approved: true }) });
    expect(client.allItems()).toHaveLength(0);
  });

  it('rejects with a comment', async () => {
    const { handler, sfn } = setup();
    const res = await handler(ev({ decision: 'reject', comment: 'not now' }));
    expect(json(res)).toEqual({ status: 'rejected', runId: 'run-1' });
    expect(JSON.parse(String(sfn.commands[0].input.output))).toEqual({ approved: false, comment: 'not now' });
  });

  it('is single use', async () => {
    const { handler } = setup();
    await handler(ev({ decision: 'approve' }));
    const again = await handler(ev({ decision: 'approve' }));
    expect(again.statusCode).toBe(404);
  });

  it('accepts base64-encoded bodies', async () => {
    const { handler } = setup();
    expect((await handler(ev({ decision: 'approve' }, ID, true))).statusCode).toBe(200);
  });

  it.each([
    ['non-JSON body', 'nope'],
    ['unknown decision', { decision: 'maybe' }],
    ['non-string comment', { decision: 'approve', comment: 5 }],
    ['overlong comment', { decision: 'approve', comment: 'x'.repeat(1001) }],
  ])('returns 400 for %s without consuming the approval', async (_name, body) => {
    const { handler, client, sfn } = setup();
    const res = await handler(ev(body));
    expect(res.statusCode).toBe(400);
    expect(client.allItems()).toHaveLength(1);
    expect(sfn.commands).toHaveLength(0);
  });

  it('returns 404 for malformed and unknown ids', async () => {
    const { handler } = setup();
    expect((await handler(ev({ decision: 'approve' }, 'short'))).statusCode).toBe(404);
    expect((await handler(ev({ decision: 'approve' }, 'C'.repeat(43)))).statusCode).toBe(404);
  });

  it('returns 410 for an expired approval and does not resume', async () => {
    const { handler, sfn } = setup(NOW / 1000 - 1);
    expect((await handler(ev({ decision: 'approve' }))).statusCode).toBe(410);
    expect(sfn.commands).toHaveLength(0);
  });

  it('returns 410 when Step Functions says the task timed out', async () => {
    const { handler, sfn } = setup();
    sfn.failWith = Object.assign(new Error('timed out'), { name: 'TaskTimedOut' });
    expect((await handler(ev({ decision: 'approve' }))).statusCode).toBe(410);
  });

  it('restores the approval and returns 502 on transient Step Functions errors', async () => {
    const { handler, sfn, client } = setup();
    sfn.failWith = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    expect((await handler(ev({ decision: 'approve' }))).statusCode).toBe(502);
    expect(client.allItems()).toHaveLength(1);
  });
});
