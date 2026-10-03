import { describe, expect, it } from 'vitest';
import { floatEnv, intEnv, listEnv, modelConfigFromEnv, pricingFromEnv, requireEnv } from '../src/config.js';

describe('config', () => {
  it('requireEnv names the missing variable', () => {
    expect(() => requireEnv({}, 'TABLE_NAME')).toThrow('Missing required environment variable TABLE_NAME');
    expect(requireEnv({ TABLE_NAME: 'x' }, 'TABLE_NAME')).toBe('x');
  });

  it('intEnv parses integers, uses fallback, rejects garbage', () => {
    expect(intEnv({ N: '42' }, 'N')).toBe(42);
    expect(intEnv({}, 'N', 7)).toBe(7);
    expect(() => intEnv({ N: '4.2' }, 'N')).toThrow(/N/);
    expect(() => intEnv({}, 'N')).toThrow(/N/);
  });

  it('floatEnv parses non-negative numbers', () => {
    expect(floatEnv({ P: '0.06' }, 'P', 0)).toBe(0.06);
    expect(floatEnv({}, 'P', 0)).toBe(0);
    expect(() => floatEnv({ P: '-1' }, 'P', 0)).toThrow(/P/);
  });

  it('listEnv splits on commas', () => {
    expect(listEnv({ L: ' send_email, ,delete_file ' }, 'L')).toEqual(['send_email', 'delete_file']);
    expect(listEnv({}, 'L')).toEqual([]);
  });

  it('modelConfigFromEnv validates the provider', () => {
    expect(modelConfigFromEnv({ MODEL_PROVIDER: 'bedrock', MODEL_ID: 'amazon.nova-lite-v1:0', AWS_REGION: 'us-east-1' }))
      .toEqual({ provider: 'bedrock', modelId: 'amazon.nova-lite-v1:0', region: 'us-east-1' });
    expect(modelConfigFromEnv({ MODEL_PROVIDER: 'openai-compatible', MODEL_ID: 'm', MODEL_BASE_URL: 'http://mock-llm:8080/v1', MODEL_API_KEY_SECRET_ARN: 'arn:x' }))
      .toEqual({ provider: 'openai-compatible', modelId: 'm', baseUrl: 'http://mock-llm:8080/v1', apiKeySecretArn: 'arn:x' });
    expect(() => modelConfigFromEnv({ MODEL_PROVIDER: 'gpt', MODEL_ID: 'm' })).toThrow(/MODEL_PROVIDER/);
    expect(() => modelConfigFromEnv({ MODEL_PROVIDER: 'openai-compatible', MODEL_ID: 'm' })).toThrow(/MODEL_BASE_URL/);
  });

  it('pricingFromEnv defaults to zero', () => {
    expect(pricingFromEnv({})).toEqual({ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
    expect(pricingFromEnv({ PRICE_INPUT_USD_PER_MTOK: '0.06', PRICE_OUTPUT_USD_PER_MTOK: '0.24' })).toEqual({ inputUsdPerMillionTokens: 0.06, outputUsdPerMillionTokens: 0.24 });
  });
});
