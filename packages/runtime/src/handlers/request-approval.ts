import { createHash, randomBytes } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ApprovalRequest } from '../agent/graph.js';
import type { DocumentClientLike } from '../checkpointer/dynamodb-saver.js';
import type { Notifier } from '../notify.js';

export interface RequestApprovalEvent {
  taskToken: string;
  runId: string;
  input: { threadId: string; connectionId?: string | null; step: { status: 'interrupted'; interrupt: ApprovalRequest }; [k: string]: unknown };
}

export interface RequestApprovalDeps {
  client: DocumentClientLike;
  tableName: string;
  notifier: Notifier;
  approvalBaseUrl?: string;
  approvalTtlSeconds: number;
  now?: () => number;
  newApprovalId?: () => string;
}

export function hashApprovalId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

export function approvalKey(id: string): { pk: string; sk: 'approval' } {
  return { pk: `approval#${hashApprovalId(id)}`, sk: 'approval' };
}

export function createRequestApprovalHandler(deps: RequestApprovalDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newApprovalId ?? (() => randomBytes(32).toString('base64url'));
  const base = (deps.approvalBaseUrl ?? '').replace(/\/+$/, '');

  return async (event: RequestApprovalEvent): Promise<{ approvalRequested: true }> => {
    const approvalId = newId();
    const nowSec = Math.floor(now() / 1000);
    const expiresAt = nowSec + deps.approvalTtlSeconds;
    const toolCalls = event.input.step.interrupt.toolCalls;
    await deps.client.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        ...approvalKey(approvalId), kind: 'approval',
        taskToken: event.taskToken, runId: event.runId, threadId: event.input.threadId,
        toolCalls: JSON.stringify(toolCalls), createdAt: nowSec, expiresAt,
      },
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'pk' },
    }));
    await deps.notifier.send(event.input.connectionId, {
      type: 'approval_required',
      runId: event.runId,
      approvalUrl: `${base}/approvals/${approvalId}`,
      toolCalls,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    });
    return { approvalRequested: true };
  };
}
