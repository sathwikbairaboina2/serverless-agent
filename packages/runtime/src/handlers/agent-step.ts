import { Command } from '@langchain/langgraph';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { pendingApproval, type AgentGraph, type ApprovalDecision, type ApprovalRequest } from '../agent/graph.js';
import { buildEmfRecord, estimateCostUsd, usageFromMessages, type Pricing, type TokenUsage } from '../metrics.js';
import { TokenBatcher, type Notifier } from '../notify.js';

export interface AgentStepEvent {
  runId: string;
  input: { threadId: string; message?: string; connectionId?: string | null; resume?: ApprovalDecision; [k: string]: unknown };
}

export type AgentStepResult =
  | { status: 'interrupted'; interrupt: ApprovalRequest; usage: TokenUsage; estimatedCostUsd: number }
  | { status: 'completed'; output: string; usage: TokenUsage; estimatedCostUsd: number };

export interface AgentStepDeps {
  getGraph: () => Promise<AgentGraph>;
  notifier: Notifier;
  agentName: string;
  pricing: Pricing;
  recursionLimit?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export const MAX_OUTPUT_CHARS = 32_000;

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: string }).text ?? '') : '')).join('');
  }
  return '';
}

export function createAgentStepHandler(deps: AgentStepDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;

  return async (event: AgentStepEvent): Promise<AgentStepResult> => {
    const started = now();
    const { runId } = event;
    const { threadId, message, connectionId, resume } = event.input;
    if (resume === undefined && (typeof message !== 'string' || message.length === 0)) {
      throw new Error('agentStep: input.message is required when not resuming');
    }
    const notify = deps.notifier;
    try {
      const graph = await deps.getGraph();
      const config = { configurable: { thread_id: threadId }, recursionLimit: deps.recursionLimit ?? 25 };
      const before = ((await graph.getState(config)).values as { messages?: BaseMessage[] }).messages?.length ?? 0;
      const input = resume !== undefined ? new Command({ resume }) : { messages: [new HumanMessage(message as string)] };
      if (resume === undefined) await notify.send(connectionId, { type: 'run_started', runId, threadId });

      const batcher = new TokenBatcher((text) => notify.send(connectionId, { type: 'token', runId, text }));
      const stream = await graph.stream(input as never, { ...config, streamMode: 'messages' });
      for await (const [chunk, meta] of stream as AsyncIterable<[BaseMessage, { langgraph_node?: string }]>) {
        if (meta?.langgraph_node !== 'model') continue;
        const text = textOf(chunk.content);
        if (text) await batcher.push(text);
      }
      await batcher.close();

      const state = await graph.getState(config);
      const messages = ((state.values as { messages?: BaseMessage[] }).messages ?? []);
      const usage = usageFromMessages(messages.slice(before));
      const estimatedCostUsd = estimateCostUsd(usage, deps.pricing);
      const approval = pendingApproval(state as never);
      const status = approval ? 'interrupted' : 'completed';
      log(JSON.stringify(buildEmfRecord({ agentName: deps.agentName, runId, threadId, status, usage, estimatedCostUsd, durationMs: now() - started, timestamp: now() })));

      if (approval) return { status: 'interrupted', interrupt: approval, usage, estimatedCostUsd };
      const output = textOf(messages.at(-1)?.content).slice(0, MAX_OUTPUT_CHARS);
      await notify.send(connectionId, { type: 'run_completed', runId, output });
      return { status: 'completed', output, usage, estimatedCostUsd };
    } catch (err) {
      await notify.send(connectionId, { type: 'run_failed', runId, error: 'Agent step failed' });
      throw err;
    }
  };
}
