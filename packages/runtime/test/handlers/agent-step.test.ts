import { describe, expect, it } from 'vitest';
import type { AIMessage } from '@langchain/core/messages';
import { buildAgentGraph } from '../../src/agent/graph.js';
import { demoTools } from '../../src/agent/tools.js';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { createAgentStepHandler } from '../../src/handlers/agent-step.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';
import { RecordingNotifier } from '../support/recording-notifier.js';
import { ScriptedChatModel, reply, toolCall } from '../support/scripted-model.js';

const PRICING = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 };

function setup(script: AIMessage[], client = new FakeDocumentClient()) {
  const notifier = new RecordingNotifier();
  const logs: string[] = [];
  const graph = buildAgentGraph({ model: new ScriptedChatModel(script), tools: demoTools, toolsRequiringApproval: ['send_email'], checkpointer: new DynamoDBSaver({ client, tableName: 't' }) });
  const handler = createAgentStepHandler({ getGraph: async () => graph, notifier, agentName: 'Agent', pricing: PRICING, log: (l) => logs.push(l), now: () => 1000 });
  return { handler, notifier, logs, client };
}

describe('agentStep handler', () => {
  it('completes a run, streams tokens, reports usage and emits one EMF line', async () => {
    const { handler, notifier, logs } = setup([reply('Hello there')]);
    const out = await handler({ runId: 'r1', input: { threadId: 't1', message: 'hi', connectionId: 'c1' } });
    expect(out).toEqual({ status: 'completed', output: 'Hello there', usage: { inputTokens: 20, outputTokens: 8 }, estimatedCostUsd: (20 * 1 + 8 * 2) / 1e6 });
    expect(notifier.ofType('run_started')).toEqual([{ type: 'run_started', runId: 'r1', threadId: 't1' }]);
    expect(notifier.ofType('token').map((t) => t.text).join('')).toBe('Hello there');
    expect(notifier.ofType('run_completed')).toEqual([{ type: 'run_completed', runId: 'r1', output: 'Hello there' }]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({ AgentName: 'Agent', runId: 'r1', InputTokens: 20, OutputTokens: 8, status: 'completed' });
  });

  it('returns interrupted with the approval request, then completes on resume without double counting', async () => {
    const client = new FakeDocumentClient();
    const first = setup([toolCall('send_email', { to: 'bob@example.com', subject: 's', body: 'b' })], client);
    const paused = await first.handler({ runId: 'r2', input: { threadId: 't2', message: 'email bob', connectionId: 'c1' } });
    expect(paused.status).toBe('interrupted');
    expect(paused.status === 'interrupted' && paused.interrupt.toolCalls[0].name).toBe('send_email');
    expect(paused.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(first.notifier.ofType('run_completed')).toHaveLength(0);

    const second = setup([reply('Sent.')], client);
    const done = await second.handler({ runId: 'r2', input: { threadId: 't2', message: 'email bob', connectionId: 'c1', resume: { approved: true } } });
    expect(done).toMatchObject({ status: 'completed', output: 'Sent.', usage: { inputTokens: 20, outputTokens: 8 } });
    expect(second.notifier.ofType('run_started')).toHaveLength(0);
  });

  it('works with no connection id', async () => {
    const { handler } = setup([reply('quiet')]);
    await expect(handler({ runId: 'r3', input: { threadId: 't3', message: 'hi', connectionId: null } })).resolves.toMatchObject({ status: 'completed' });
  });

  it('notifies run_failed without leaking the error and rethrows', async () => {
    const { handler, notifier } = setup([]);
    await expect(handler({ runId: 'r4', input: { threadId: 't4', message: 'hi', connectionId: 'c1' } })).rejects.toThrow(/script exhausted/);
    expect(notifier.ofType('run_failed')).toEqual([{ type: 'run_failed', runId: 'r4', error: 'Agent step failed' }]);
  });

  it('rejects an event with neither message nor resume', async () => {
    const { handler } = setup([]);
    await expect(handler({ runId: 'r5', input: { threadId: 't5' } })).rejects.toThrow(/message/);
  });

  it('truncates very long outputs', async () => {
    const { handler } = setup([reply('x'.repeat(40_000))]);
    const out = await handler({ runId: 'r6', input: { threadId: 't6', message: 'hi' } });
    expect(out.status === 'completed' && out.output.length).toBe(32_000);
  });
});
