import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertLocalStackReady, clientConfig, loadOutputs, type LocalOutputs } from './support/localstack.js';

const lambda = new LambdaClient(clientConfig);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig));
let out: LocalOutputs;

async function invoke(payload: unknown): Promise<any> {
  const res = await lambda.send(new InvokeCommand({ FunctionName: out.AgentFunctionName, Payload: Buffer.from(JSON.stringify(payload)) }));
  const body = JSON.parse(Buffer.from(res.Payload ?? new Uint8Array()).toString('utf8') || 'null');
  if (res.FunctionError) throw new Error(`${res.FunctionError}: ${JSON.stringify(body)}`);
  return body;
}

describe('invoke path (agentStep Lambda on LocalStack, mock LLM)', () => {
  beforeAll(async () => { await assertLocalStackReady(); out = loadOutputs(); });

  it('completes a run that uses a safe tool and reports usage', async () => {
    const threadId = `inv-time-${randomUUID()}`;
    const res = await invoke({ runId: `run-${randomUUID()}`, input: { threadId, message: 'What time is it?', connectionId: null } });
    expect(res.status).toBe('completed');
    expect(res.output).toMatch(/^Done\. Tool result: \d{4}-\d{2}-\d{2}T/);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('pauses before send_email and persists checkpoints with TTL in the stack table', async () => {
    const threadId = `inv-email-${randomUUID()}`;
    const res = await invoke({ runId: `run-${randomUUID()}`, input: { threadId, message: 'Please email Bob', connectionId: null } });
    expect(res.status).toBe('interrupted');
    expect(res.interrupt.toolCalls[0]).toMatchObject({ name: 'send_email', args: { to: 'bob@example.com' } });
    const items = await doc.send(new QueryCommand({ TableName: out.TableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': threadId } }));
    const checkpoints = (items.Items ?? []).filter((i) => String(i.sk).startsWith('cp#'));
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const c of checkpoints) expect(typeof c.expiresAt).toBe('number');
  });
});
