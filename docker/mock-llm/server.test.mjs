import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decide } from './script.mjs';
import { createServer } from './server.mjs';

describe('decide', () => {
  it('asks to send an email for email requests', () => {
    expect(decide([{ role: 'user', content: 'Please email Bob' }])).toEqual({ toolCalls: [{ name: 'send_email', arguments: { to: 'bob@example.com', subject: 'Hello', body: 'Hi Bob, this is a test.' } }] });
  });
  it('asks for the time', () => {
    expect(decide([{ role: 'user', content: [{ type: 'text', text: 'What TIME is it?' }] }])).toEqual({ toolCalls: [{ name: 'get_current_time', arguments: {} }] });
  });
  it('summarises tool results and rejections', () => {
    expect(decide([{ role: 'user', content: 'email' }, { role: 'tool', content: 'Demo stub: ok' }])).toEqual({ content: 'Done. Tool result: Demo stub: ok' });
    expect(decide([{ role: 'tool', content: 'Rejected by human reviewer: no. The tool was not executed.' }])).toEqual({ content: 'Understood. I did not send the email.' });
  });
  it('echoes otherwise', () => {
    expect(decide([{ role: 'user', content: 'hi' }])).toEqual({ content: 'mock-llm says hello. You said: hi' });
  });
});

describe('server', () => {
  let server; let base;
  beforeAll(async () => {
    server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('answers health checks', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('returns OpenAI-shaped tool calls with usage (non-streaming)', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-llm', messages: [{ role: 'user', content: 'email bob' }] }) });
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({ type: 'function', function: { name: 'send_email' } });
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments).to).toBe('bob@example.com');
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('streams SSE chunks ending with [DONE] and a usage chunk', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-llm', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }) });
    const text = await res.text();
    const events = text.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('mock-llm says hello. You said: hi');
    expect(chunks.at(-1).usage.completion_tokens).toBeGreaterThan(0);
  });
});
