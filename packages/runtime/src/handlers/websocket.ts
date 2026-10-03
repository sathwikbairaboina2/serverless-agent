import { randomUUID } from 'node:crypto';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';

export interface WebSocketDeps { sfn: { send(command: any): Promise<any> }; stateMachineArn: string; newRunId?: () => string }
export interface WsEvent { requestContext: { routeKey: string; connectionId: string }; body?: string | null }

const THREAD_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_MESSAGE_CHARS = 16_000;
const error = (e: string) => ({ statusCode: 400, body: JSON.stringify({ type: 'error', error: e }) });

export function createWebSocketHandler(deps: WebSocketDeps) {
  const newRunId = deps.newRunId ?? randomUUID;
  return async (event: WsEvent): Promise<{ statusCode: number; body?: string }> => {
    const { routeKey, connectionId } = event.requestContext;
    if (routeKey === '$connect' || routeKey === '$disconnect') return { statusCode: 200 };
    let body: { action?: unknown; threadId?: unknown; message?: unknown };
    try {
      body = JSON.parse(event.body ?? '');
    } catch {
      return error('Body must be JSON: {"action":"run","threadId":"...","message":"..."}');
    }
    if (body?.action !== 'run') return error('action must be "run"');
    if (typeof body.threadId !== 'string' || !THREAD_RE.test(body.threadId)) return error('threadId must match ^[A-Za-z0-9_-]{1,128}$');
    if (typeof body.message !== 'string' || body.message.length === 0 || body.message.length > MAX_MESSAGE_CHARS) return error(`message must be 1-${MAX_MESSAGE_CHARS} characters`);
    const runId = newRunId();
    await deps.sfn.send(new StartExecutionCommand({
      stateMachineArn: deps.stateMachineArn,
      name: runId,
      input: JSON.stringify({ threadId: body.threadId, message: body.message, connectionId }),
    }));
    return { statusCode: 200, body: JSON.stringify({ type: 'run_accepted', runId }) };
  };
}
