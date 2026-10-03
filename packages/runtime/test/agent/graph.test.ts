import { describe, expect, it } from 'vitest';
import { Command } from '@langchain/langgraph';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { buildAgentGraph, pendingApproval } from '../../src/agent/graph.js';
import { demoTools } from '../../src/agent/tools.js';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';
import { ScriptedChatModel, reply, toolCall } from '../support/scripted-model.js';

const EMAIL = { to: 'bob@example.com', subject: 'Hi', body: 'Hello Bob' };

function graphWith(script: AIMessage[], client = new FakeDocumentClient()) {
  const model = new ScriptedChatModel(script);
  const graph = buildAgentGraph({
    model, tools: demoTools, toolsRequiringApproval: ['send_email'],
    checkpointer: new DynamoDBSaver({ client, tableName: 'checkpoints' }),
  });
  return { graph, model, client };
}
const cfg = (thread: string) => ({ configurable: { thread_id: thread } });
const toolMessages = (msgs: unknown[]) => msgs.filter((m): m is ToolMessage => ToolMessage.isInstance(m as never));

describe('agent graph', () => {
  it('runs a safe tool without asking for approval', async () => {
    const { graph } = graphWith([toolCall('get_current_time', {}), reply('It is noon.')]);
    const out = await graph.invoke({ messages: [new HumanMessage('time?')] }, cfg('t1'));
    expect(out.messages.at(-1)?.content).toBe('It is noon.');
    expect(pendingApproval(await graph.getState(cfg('t1')))).toBeUndefined();
  });

  it('pauses before a sensitive tool and the pause survives a fresh graph instance', async () => {
    const client = new FakeDocumentClient();
    const first = graphWith([toolCall('send_email', EMAIL)], client);
    await first.graph.invoke({ messages: [new HumanMessage('email bob')] }, cfg('t2'));
    // Simulates a different Lambda invocation: new saver, same table.
    const second = graphWith([], client);
    const approval = pendingApproval(await second.graph.getState(cfg('t2')));
    expect(approval).toEqual({ kind: 'tool_approval', toolCalls: [{ id: 'call_send_email', name: 'send_email', args: EMAIL }] });
  });

  it('executes the tool after approval', async () => {
    const client = new FakeDocumentClient();
    await graphWith([toolCall('send_email', EMAIL)], client).graph.invoke({ messages: [new HumanMessage('email bob')] }, cfg('t3'));
    const { graph } = graphWith([reply('Sent.')], client);
    const out = await graph.invoke(new Command({ resume: { approved: true } }), cfg('t3'));
    expect(toolMessages(out.messages).map((m) => String(m.content)).join()).toMatch(/Demo stub/);
    expect(out.messages.at(-1)?.content).toBe('Sent.');
  });

  it('feeds a rejection back to the model without executing the tool', async () => {
    const client = new FakeDocumentClient();
    await graphWith([toolCall('send_email', EMAIL)], client).graph.invoke({ messages: [new HumanMessage('email bob')] }, cfg('t4'));
    const { graph } = graphWith([reply('Okay, not sending.')], client);
    const out = await graph.invoke(new Command({ resume: { approved: false, comment: 'not now' } }), cfg('t4'));
    const tools = toolMessages(out.messages);
    expect(tools).toHaveLength(1);
    expect(String(tools[0].content)).toBe('Rejected by human reviewer: not now. The tool was not executed.');
    expect(String(tools[0].content)).not.toMatch(/Demo stub/);
  });

  it('fails closed on a malformed resume value', async () => {
    const client = new FakeDocumentClient();
    await graphWith([toolCall('send_email', EMAIL)], client).graph.invoke({ messages: [new HumanMessage('email bob')] }, cfg('t5'));
    const { graph } = graphWith([reply('ok')], client);
    const out = await graph.invoke(new Command({ resume: { approved: 'yes' } }), cfg('t5'));
    expect(String(toolMessages(out.messages)[0].content)).toMatch(/^Rejected by human reviewer/);
  });

  it('requires approval for the whole turn when safe and sensitive calls are mixed', async () => {
    const mixed = new AIMessage({ content: '', tool_calls: [
      { id: 'a', name: 'get_current_time', args: {}, type: 'tool_call' },
      { id: 'b', name: 'send_email', args: EMAIL, type: 'tool_call' },
    ] });
    const { graph } = graphWith([mixed]);
    const out = await graph.invoke({ messages: [new HumanMessage('both')] }, cfg('t6'));
    expect(toolMessages(out.messages)).toHaveLength(0);
    expect(pendingApproval(await graph.getState(cfg('t6')))?.toolCalls.map((c) => c.name)).toEqual(['send_email']);
  });

  it('rejects unknown tools deterministically', async () => {
    const { graph } = graphWith([toolCall('rm_rf', { path: '/' }), reply('Sorry.')]);
    const out = await graph.invoke({ messages: [new HumanMessage('delete')] }, cfg('t7'));
    expect(String(toolMessages(out.messages)[0].content)).toMatch(/Unknown tool "rm_rf"/);
    expect(out.messages.at(-1)?.content).toBe('Sorry.');
  });
});
