const textOf = (content) => (Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : String(content ?? ''));

export function decide(messages) {
  const last = messages.at(-1) ?? {};
  if (last.role === 'tool') {
    const content = textOf(last.content);
    if (content.startsWith('Rejected by human reviewer')) return { content: 'Understood. I did not send the email.' };
    return { content: `Done. Tool result: ${content}` };
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const said = textOf(lastUser?.content);
  const lower = said.toLowerCase();
  if (lower.includes('email')) return { toolCalls: [{ name: 'send_email', arguments: { to: 'bob@example.com', subject: 'Hello', body: 'Hi Bob, this is a test.' } }] };
  if (lower.includes('time')) return { toolCalls: [{ name: 'get_current_time', arguments: {} }] };
  return { content: `mock-llm says hello. You said: ${said}` };
}

export const tokens = (s) => Math.max(1, Math.ceil(String(s).length / 4));
