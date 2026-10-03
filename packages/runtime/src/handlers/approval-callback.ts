import { SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentClientLike } from '../checkpointer/dynamodb-saver.js';
import { approvalKey } from './request-approval.js';

export interface ApprovalCallbackDeps {
  client: DocumentClientLike;
  tableName: string;
  sfn: { send(command: any): Promise<any> };
  now?: () => number;
}

export interface HttpEvent { pathParameters?: Record<string, string | undefined> | null; body?: string | null; isBase64Encoded?: boolean }
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }

const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const TERMINAL_SFN_ERRORS = new Set(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken']);

const respond = (statusCode: number, body: unknown): HttpResult => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const badRequest = (message: string) => respond(400, { error: 'invalid_request', message });

export function createApprovalCallbackHandler(deps: ApprovalCallbackDeps) {
  const now = deps.now ?? Date.now;

  return async (event: HttpEvent): Promise<HttpResult> => {
    const approvalId = event.pathParameters?.approvalId;
    if (!approvalId || !ID_RE.test(approvalId)) return respond(404, { error: 'not_found' });

    let parsed: unknown;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
      parsed = JSON.parse(raw);
    } catch {
      return badRequest('Body must be JSON: {"decision":"approve"|"reject","comment"?:string}');
    }
    const { decision, comment } = (parsed ?? {}) as { decision?: unknown; comment?: unknown };
    if (decision !== 'approve' && decision !== 'reject') return badRequest('decision must be "approve" or "reject"');
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > 1000)) return badRequest('comment must be a string of at most 1000 characters');

    let item: Record<string, any> | undefined;
    try {
      const out = await deps.client.send(new DeleteCommand({
        TableName: deps.tableName, Key: approvalKey(approvalId),
        ConditionExpression: 'attribute_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' }, ReturnValues: 'ALL_OLD',
      }));
      item = out.Attributes;
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return respond(404, { error: 'not_found' });
      throw err;
    }
    if (!item) return respond(404, { error: 'not_found' });
    if (typeof item.expiresAt === 'number' && item.expiresAt <= Math.floor(now() / 1000)) return respond(410, { error: 'expired' });

    const approved = decision === 'approve';
    const output = comment === undefined ? { approved } : { approved, comment };
    try {
      await deps.sfn.send(new SendTaskSuccessCommand({ taskToken: item.taskToken, output: JSON.stringify(output) }));
    } catch (err) {
      if (TERMINAL_SFN_ERRORS.has((err as Error).name)) return respond(410, { error: 'expired' });
      await deps.client.send(new PutCommand({ TableName: deps.tableName, Item: item }));
      console.warn(`approvalCallback: restored approval for run ${item.runId} after ${(err as Error).name}`);
      return respond(502, { error: 'upstream_error' });
    }
    return respond(200, { status: approved ? 'approved' : 'rejected', runId: item.runId });
  };
}
