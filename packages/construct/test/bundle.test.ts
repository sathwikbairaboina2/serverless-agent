import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNTIME_ASSET_DIR } from '../src/runtime-code';

describe('runtime bundle', () => {
  const file = join(RUNTIME_ASSET_DIR, 'index.mjs');

  it('exists and is a reasonable size', () => {
    expect(existsSync(file)).toBe(true);
    const mib = statSync(file).size / 1024 / 1024;
    expect(mib).toBeGreaterThan(0.1);
    expect(mib).toBeLessThan(40);
  });

  it('exports the four Lambda handlers and imports without environment variables', async () => {
    const mod = await import(pathToFileURL(file).href);
    for (const name of ['agentStep', 'requestApproval', 'approvalCallback', 'wsHandler']) expect(typeof mod[name], name).toBe('function');
  });
});
