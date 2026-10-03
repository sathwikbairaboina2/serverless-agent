import type { Pricing } from './metrics.js';

export type Env = Record<string, string | undefined>;
export type ModelProvider = 'bedrock' | 'openai-compatible';
export interface ModelConfig { provider: ModelProvider; modelId: string; region?: string; baseUrl?: string; apiKeySecretArn?: string }

export function requireEnv(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function intEnv(env: Env, name: string, fallback?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  if (!/^-?\d+$/.test(raw)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return Number(raw);
}

export function floatEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Environment variable ${name} must be a non-negative number, got "${raw}"`);
  return n;
}

export function listEnv(env: Env, name: string): string[] {
  return (env[name] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function modelConfigFromEnv(env: Env): ModelConfig {
  const provider = requireEnv(env, 'MODEL_PROVIDER');
  const modelId = requireEnv(env, 'MODEL_ID');
  if (provider === 'bedrock') {
    const cfg: ModelConfig = { provider, modelId };
    if (env.AWS_REGION) cfg.region = env.AWS_REGION;
    return cfg;
  }
  if (provider === 'openai-compatible') {
    const cfg: ModelConfig = { provider, modelId, baseUrl: requireEnv(env, 'MODEL_BASE_URL') };
    if (env.MODEL_API_KEY_SECRET_ARN) cfg.apiKeySecretArn = env.MODEL_API_KEY_SECRET_ARN;
    return cfg;
  }
  throw new Error(`MODEL_PROVIDER must be "bedrock" or "openai-compatible", got "${provider}"`);
}

export function pricingFromEnv(env: Env): Pricing {
  return {
    inputUsdPerMillionTokens: floatEnv(env, 'PRICE_INPUT_USD_PER_MTOK', 0),
    outputUsdPerMillionTokens: floatEnv(env, 'PRICE_OUTPUT_USD_PER_MTOK', 0),
  };
}
