import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/** Deterministic chat model: returns queued AIMessages in order; records inputs. */
export class ScriptedChatModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  private readonly queue: AIMessage[];

  constructor(script: AIMessage[]) {
    super({});
    this.queue = [...script];
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(_tools: unknown[]): any {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const next = this.queue.shift();
    if (!next) throw new Error('ScriptedChatModel: script exhausted');
    return { generations: [{ message: next, text: typeof next.content === 'string' ? next.content : '' }] };
  }
}

export function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): AIMessage {
  return new AIMessage({ content: '', tool_calls: [{ id, name, args, type: 'tool_call' }], usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
}

export function reply(text: string): AIMessage {
  return new AIMessage({ content: text, usage_metadata: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } });
}
