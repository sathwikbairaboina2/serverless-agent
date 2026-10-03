import { describe, expect, it } from 'vitest';
import { createAnswerSource, isApproval } from '../src/local/answers.js';

async function* lines(...xs: string[]): AsyncGenerator<string> { for (const x of xs) yield x; }

describe('local approval answers', () => {
  it('returns piped answers in order', async () => {
    const next = createAnswerSource(lines('y', 'n'));
    expect(await next()).toBe('y');
    expect(await next()).toBe('n');
  });

  it('treats EOF as a decline', async () => {
    const next = createAnswerSource(lines('y'));
    await next();
    expect(isApproval(await next())).toBe(false);
  });

  it('approves only on y', () => {
    expect(isApproval(' Y ')).toBe(true);
    expect(isApproval('yes')).toBe(false);
    expect(isApproval('')).toBe(false);
  });
});
