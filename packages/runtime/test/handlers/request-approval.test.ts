import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRequestApprovalHandler, hashApprovalId } from '../../src/handlers/request-approval.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';
import { RecordingNotifier } from '../support/recording-notifier.js';

const ID = 'A'.repeat(43);
const event = {
  taskToken: 'token-123', runId: 'run-1',
  input: { threadId: 't1', connectionId: 'c1', step: { status: 'interrupted' as const, interrupt: { kind: 'tool_approval' as const, toolCalls: [{ id: 'x', name: 'send_email', args: { to: 'bob@example.com' } }] } } },
};

function setup(base = 'https://api.example.com/') {
  const client = new FakeDocumentClient();
  const notifier = new RecordingNotifier();
  const handler = createRequestApprovalHandler({ client, tableName: 't', notifier, approvalBaseUrl: base, approvalTtlSeconds: 3600, now: () => 1_700_000_000_000, newApprovalId: () => ID });
  return { client, notifier, handler };
}

describe('requestApproval handler', () => {
  it('stores the task token under the hash of the approval id, never the id itself', async () => {
    const { client, handler } = setup();
    await handler(event);
    const [item] = client.allItems();
    expect(item.pk).toBe(`approval#${createHash('sha256').update(ID).digest('hex')}`);
    expect(item.pk).toBe(`approval#${hashApprovalId(ID)}`);
    expect(item).toMatchObject({ sk: 'approval', taskToken: 'token-123', runId: 'run-1', threadId: 't1', expiresAt: 1_700_003_600 });
    expect(JSON.stringify(item)).not.toContain(ID);
  });

  it('sends the approval URL and tool calls to the WebSocket client', async () => {
    const { notifier, handler } = setup();
    await handler(event);
    expect(notifier.ofType('approval_required')).toEqual([{
      type: 'approval_required', runId: 'run-1', approvalUrl: `https://api.example.com/approvals/${ID}`,
      toolCalls: event.input.step.interrupt.toolCalls, expiresAt: new Date(1_700_003_600_000).toISOString(),
    }]);
  });

  it('uses a relative URL when no API base URL is configured', async () => {
    const { notifier, handler } = setup('');
    await handler(event);
    expect(notifier.ofType('approval_required')[0].approvalUrl).toBe(`/approvals/${ID}`);
  });

  it('generates 256-bit url-safe ids by default', async () => {
    const client = new FakeDocumentClient();
    const notifier = new RecordingNotifier();
    await createRequestApprovalHandler({ client, tableName: 't', notifier, approvalTtlSeconds: 60 })(event);
    const url = notifier.ofType('approval_required')[0].approvalUrl;
    expect(url).toMatch(/^\/approvals\/[A-Za-z0-9_-]{43}$/);
  });
});
