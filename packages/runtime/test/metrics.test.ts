import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { addUsage, buildEmfRecord, estimateCostUsd, usageFromMessages } from '../src/metrics.js';

describe('metrics', () => {
  it('estimates cost from token usage and per-million pricing', () => {
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, { inputUsdPerMillionTokens: 0.06, outputUsdPerMillionTokens: 0.24 })).toBeCloseTo(0.0003, 10);
  });

  it('returns zero cost for zero pricing', () => {
    expect(estimateCostUsd({ inputTokens: 5000, outputTokens: 5000 }, { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 })).toBe(0);
  });

  it('sums usage_metadata over AI messages only', () => {
    const msgs = [
      new HumanMessage('hi'),
      new AIMessage({ content: 'a', usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }),
      new AIMessage({ content: 'b' }),
      new AIMessage({ content: 'c', usage_metadata: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } }),
    ];
    expect(usageFromMessages(msgs)).toEqual({ inputTokens: 15, outputTokens: 3 });
  });

  it('adds usage', () => {
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 4, outputTokens: 6 });
  });

  it('builds a CloudWatch EMF record with AgentName dimension and runId as a property', () => {
    const rec = buildEmfRecord({ agentName: 'Agent', runId: 'r1', threadId: 't1', status: 'completed', usage: { inputTokens: 7, outputTokens: 3 }, estimatedCostUsd: 0.001, durationMs: 120, timestamp: 1_700_000_000_000 }) as any;
    expect(rec._aws.Timestamp).toBe(1_700_000_000_000);
    expect(rec._aws.CloudWatchMetrics[0].Namespace).toBe('ServerlessAgent');
    expect(rec._aws.CloudWatchMetrics[0].Dimensions).toEqual([['AgentName']]);
    expect(rec._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name)).toEqual(['InputTokens', 'OutputTokens', 'EstimatedCostUsd', 'StepDurationMs']);
    expect(rec).toMatchObject({ AgentName: 'Agent', runId: 'r1', threadId: 't1', status: 'completed', InputTokens: 7, OutputTokens: 3, EstimatedCostUsd: 0.001, StepDurationMs: 120 });
  });
});
