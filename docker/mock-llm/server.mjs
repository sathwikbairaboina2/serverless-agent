import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { decide, tokens } from './script.mjs';

let counter = 0;

function completion(req) {
  const decision = decide(req.messages ?? []);
  const id = `chatcmpl-mock-${++counter}`;
  const toolCalls = (decision.toolCalls ?? []).map((c, i) => ({ id: `call_${counter}_${i}_${c.name}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
  const content = decision.content ?? null;
  const usage = { prompt_tokens: tokens(JSON.stringify(req.messages ?? [])), completion_tokens: tokens(content ?? JSON.stringify(toolCalls)) };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return { id, content, toolCalls, usage, model: req.model ?? 'mock-llm' };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return send(res, 404, { error: 'not found' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
    const c = completion(body);
    const created = Math.floor(Date.now() / 1000);
    const finish = c.toolCalls.length ? 'tool_calls' : 'stop';
    if (!body.stream) {
      return send(res, 200, {
        id: c.id, object: 'chat.completion', created, model: c.model,
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: c.content, ...(c.toolCalls.length ? { tool_calls: c.toolCalls } : {}) } }],
        usage: c.usage,
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: c.id, object: 'chat.completion.chunk', created, model: c.model };
    emit({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (c.content) {
      const mid = Math.ceil(c.content.length / 2);
      for (const part of [c.content.slice(0, mid), c.content.slice(mid)]) emit({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
    }
    c.toolCalls.forEach((tc, index) => emit({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] }));
    emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    if (body.stream_options?.include_usage) emit({ ...base, choices: [], usage: c.usage });
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  createServer().listen(port, '0.0.0.0', () => console.log(`mock-llm listening on :${port}`));
}
