import { describe, expect, it } from 'vitest';
import { RUNTIME_VERSION } from '../src/index.js';

describe('runtime package', () => {
  it('exposes its version', () => {
    expect(RUNTIME_VERSION).toBe('0.1.0');
  });
});
