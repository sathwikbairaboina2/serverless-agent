import { AIMessage, type BaseMessage } from '@langchain/core/messages';

export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface Pricing { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }
export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };
export const METRICS_NAMESPACE = 'ServerlessAgent';

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export function usageFromMessages(messages: BaseMessage[]): TokenUsage {
  return messages.reduce<TokenUsage>((acc, m) => {
    if (!AIMessage.isInstance(m) || !m.usage_metadata) return acc;
    return addUsage(acc, { inputTokens: m.usage_metadata.input_tokens ?? 0, outputTokens: m.usage_metadata.output_tokens ?? 0 });
  }, ZERO_USAGE);
}

/** ESTIMATE: tokens x configured list price. Not AWS billing data. */
export function estimateCostUsd(usage: TokenUsage, pricing: Pricing): number {
  return (usage.inputTokens * pricing.inputUsdPerMillionTokens + usage.outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000;
}

export interface StepMetrics {
  agentName: string; runId: string; threadId: string; status: string;
  usage: TokenUsage; estimatedCostUsd: number; durationMs: number; timestamp: number;
}

export function buildEmfRecord(m: StepMetrics): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: m.timestamp,
      CloudWatchMetrics: [{
        Namespace: METRICS_NAMESPACE,
        Dimensions: [['AgentName']],
        Metrics: [
          { Name: 'InputTokens', Unit: 'Count' },
          { Name: 'OutputTokens', Unit: 'Count' },
          { Name: 'EstimatedCostUsd', Unit: 'None' },
          { Name: 'StepDurationMs', Unit: 'Milliseconds' },
        ],
      }],
    },
    AgentName: m.agentName,
    runId: m.runId,
    threadId: m.threadId,
    status: m.status,
    InputTokens: m.usage.inputTokens,
    OutputTokens: m.usage.outputTokens,
    EstimatedCostUsd: m.estimatedCostUsd,
    StepDurationMs: m.durationMs,
  };
}
