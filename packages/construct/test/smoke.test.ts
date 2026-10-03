import { describe, expect, it } from 'vitest';
import { CONSTRUCT_VERSION } from '../src';

describe('construct package', () => {
  it('exposes its version', () => {
    expect(CONSTRUCT_VERSION).toBe('0.1.0');
  });
});
