import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Command, MemorySaver } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { buildAgentGraph, pendingApproval } from '../agent/graph.js';
import { createChatModel } from '../agent/model.js';
import { demoTools } from '../agent/tools.js';
import { textOf } from '../handlers/agent-step.js';

const message = process.argv.slice(2).join(' ') || 'What time is it? Then email bob@example.com to say hi.';
const graph = buildAgentGraph({
  model: createChatModel({ provider: 'openai-compatible', baseUrl: process.env.MODEL_BASE_URL ?? 'http://localhost:11434/v1', modelId: process.env.MODEL_ID ?? 'llama3.1' }),
  tools: demoTools,
  toolsRequiringApproval: ['send_email'],
  checkpointer: new MemorySaver(),
});
const config = { configurable: { thread_id: `local-${Date.now()}` } };
const rl = createInterface({ input: stdin, output: stdout });

let input: unknown = { messages: [new HumanMessage(message)] };
for (;;) {
  const state = await graph.invoke(input as never, config);
  const approval = pendingApproval(await graph.getState(config));
  if (!approval) {
    console.log(`\nassistant: ${textOf(state.messages.at(-1)?.content)}`);
    break;
  }
  console.log('\nThe model proposes:', JSON.stringify(approval.toolCalls, null, 2));
  const answer = (await rl.question('approve? [y/N] ')).trim().toLowerCase();
  input = new Command({ resume: { approved: answer === 'y', comment: answer === 'y' ? undefined : 'declined locally' } });
}
rl.close();
