import { Command, END, MessagesAnnotation, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ApprovalToolCall } from '../notify.js';

export interface ApprovalRequest { kind: 'tool_approval'; toolCalls: ApprovalToolCall[] }
export interface ApprovalDecision { approved: boolean; comment?: string }

export interface AgentGraphOptions {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  toolsRequiringApproval: string[];
  checkpointer: BaseCheckpointSaver;
  systemPrompt?: string;
}

type State = typeof MessagesAnnotation.State;

function lastAi(state: State): AIMessage | undefined {
  const last = state.messages.at(-1);
  return last && AIMessage.isInstance(last) ? last : undefined;
}

export function buildAgentGraph(opts: AgentGraphOptions) {
  const toolNames = new Set(opts.tools.map((t) => t.name));
  const sensitive = new Set(opts.toolsRequiringApproval);
  const bound = opts.model.bindTools!(opts.tools);

  const callModel = async (state: State, config?: RunnableConfig) => {
    const messages = opts.systemPrompt ? [new SystemMessage(opts.systemPrompt), ...state.messages] : state.messages;
    const response = await bound.invoke(messages, config);
    return { messages: [response] };
  };

  const gate = (state: State) => {
    const calls = lastAi(state)?.tool_calls ?? [];
    const unknown = calls.filter((c) => !toolNames.has(c.name));
    if (unknown.length > 0) {
      return new Command({
        goto: 'model',
        update: {
          messages: calls.map((c) => new ToolMessage({
            tool_call_id: c.id ?? '',
            status: 'error',
            content: toolNames.has(c.name)
              ? 'Not executed: another tool call in this turn was invalid.'
              : `Unknown tool "${c.name}". Available tools: ${[...toolNames].join(', ')}.`,
          })),
        },
      });
    }
    const needsApproval = calls.filter((c) => sensitive.has(c.name));
    if (needsApproval.length === 0) return new Command({ goto: 'tools' });

    const request: ApprovalRequest = {
      kind: 'tool_approval',
      toolCalls: needsApproval.map((c) => ({ id: c.id ?? '', name: c.name, args: c.args as Record<string, unknown> })),
    };
    const decision = interrupt(request) as Partial<ApprovalDecision> | undefined;
    if (decision?.approved === true) return new Command({ goto: 'tools' });

    const reason = typeof decision?.comment === 'string' && decision.comment.length > 0 ? `: ${decision.comment}` : '';
    return new Command({
      goto: 'model',
      update: {
        messages: calls.map((c) => new ToolMessage({
          tool_call_id: c.id ?? '',
          status: 'error',
          content: `Rejected by human reviewer${reason}. The tool was not executed.`,
        })),
      },
    });
  };

  return new StateGraph(MessagesAnnotation)
    .addNode('model', callModel)
    .addNode('gate', gate, { ends: ['tools', 'model'] })
    .addNode('tools', new ToolNode(opts.tools))
    .addEdge(START, 'model')
    .addConditionalEdges('model', (s: State) => ((lastAi(s)?.tool_calls?.length ?? 0) > 0 ? 'gate' : END), ['gate', END])
    .addEdge('tools', 'model')
    .compile({ checkpointer: opts.checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;

export function pendingApproval(state: { tasks: ReadonlyArray<{ interrupts?: ReadonlyArray<{ value?: unknown }> }> }): ApprovalRequest | undefined {
  for (const task of state.tasks) {
    for (const i of task.interrupts ?? []) {
      const v = i.value as ApprovalRequest | undefined;
      if (v?.kind === 'tool_approval') return v;
    }
  }
  return undefined;
}
