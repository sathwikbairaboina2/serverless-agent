import type { Notifier, ServerMessage } from '../../src/notify.js';

export class RecordingNotifier implements Notifier {
  readonly sent: Array<{ connectionId: string | null | undefined; message: ServerMessage }> = [];
  async send(connectionId: string | null | undefined, message: ServerMessage): Promise<void> {
    this.sent.push({ connectionId, message });
  }
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.map((s) => s.message).filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}
