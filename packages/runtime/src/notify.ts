import { PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

export interface ApprovalToolCall { id: string; name: string; args: Record<string, unknown> }

export type ServerMessage =
  | { type: 'run_started'; runId: string; threadId: string }
  | { type: 'token'; runId: string; text: string }
  | { type: 'approval_required'; runId: string; approvalUrl: string; toolCalls: ApprovalToolCall[]; expiresAt: string }
  | { type: 'run_completed'; runId: string; output: string }
  | { type: 'run_failed'; runId: string; error: string };

export interface Notifier {
  send(connectionId: string | null | undefined, message: ServerMessage): Promise<void>;
}

export class NullNotifier implements Notifier {
  async send(_connectionId?: string | null, _message?: ServerMessage): Promise<void> {}
}

export class ApiGatewayNotifier implements Notifier {
  private readonly gone = new Set<string>();

  constructor(
    private readonly client: { send(command: any): Promise<any> },
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  async send(connectionId: string | null | undefined, message: ServerMessage): Promise<void> {
    if (!connectionId || this.gone.has(connectionId)) return;
    try {
      await this.client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(message) }));
    } catch (err) {
      if ((err as Error).name === 'GoneException') this.gone.add(connectionId);
      this.log(`notifier: dropped ${message.type} for ${connectionId}: ${(err as Error).name}: ${(err as Error).message}`);
    }
  }
}

/** Coalesces streamed tokens to cut WebSocket message count (ADR 0005). */
export class TokenBatcher {
  private buffer = '';

  constructor(private readonly flush: (text: string) => Promise<void>, private readonly minChars = 64) {}

  async push(text: string): Promise<void> {
    this.buffer += text;
    if (this.buffer.length >= this.minChars) await this.drain();
  }

  async close(): Promise<void> {
    if (this.buffer.length > 0) await this.drain();
  }

  private async drain(): Promise<void> {
    const out = this.buffer;
    this.buffer = '';
    await this.flush(out);
  }
}
