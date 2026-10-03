import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
/** Integration suites skip (not run) without a LocalStack token; see ADR 0009. */
export const hasToken = Boolean(process.env.LOCALSTACK_AUTH_TOKEN);
export const clientConfig = { endpoint: ENDPOINT, region: process.env.AWS_REGION ?? 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };

const here = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS = path.resolve(here, '../../../../examples/basic/cdk.local-outputs.json');

export async function assertLocalStackReady(): Promise<void> {
  let health: { services?: Record<string, string> };
  try {
    const res = await fetch(`${ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(3000) });
    health = (await res.json()) as { services?: Record<string, string> };
  } catch (err) {
    throw new Error(`BLOCKER: LocalStack not reachable at ${ENDPOINT} (${(err as Error).message}). Run "pnpm local:up" with LOCALSTACK_AUTH_TOKEN set (ADR 0009).`);
  }
  for (const svc of ['dynamodb', 'lambda', 'stepfunctions', 'apigateway', 'cloudformation']) {
    const state = health.services?.[svc];
    if (state && !['available', 'running'].includes(state)) throw new Error(`BLOCKER: LocalStack service ${svc} is "${state}" (license/plan?)`);
  }
}

export interface LocalOutputs {
  StateMachineArn: string; TableName: string; AgentFunctionName: string; ApprovalCallbackFunctionName: string;
  ApprovalApiId: string; ApprovalApiStage: string; ApprovalApiUrl: string;
}

export function loadOutputs(): LocalOutputs {
  if (!existsSync(OUTPUTS)) throw new Error(`BLOCKER: ${OUTPUTS} missing. Run "pnpm local:deploy" first.`);
  return JSON.parse(readFileSync(OUTPUTS, 'utf8'));
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000, intervalMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** LocalStack REST API invoke URL (no DNS needed). */
export const restApiUrl = (apiId: string, stage: string, p: string) => `${ENDPOINT}/restapis/${apiId}/${stage}/_user_request_${p}`;
