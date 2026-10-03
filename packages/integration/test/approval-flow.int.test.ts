import { randomBytes, randomUUID } from 'node:crypto';
import { DescribeExecutionCommand, GetExecutionHistoryCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { hashApprovalId } from '@serverless-agent/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertLocalStackReady, clientConfig, loadOutputs, restApiUrl, waitFor, type LocalOutputs } from './support/localstack.js';

const sfn = new SFNClient(clientConfig);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig));
let out: LocalOutputs;

async function startRun(message: string) {
  const runId = randomUUID();
  const threadId = `flow-${runId}`;
  const { executionArn } = await sfn.send(new StartExecutionCommand({ stateMachineArn: out.StateMachineArn, name: runId, input: JSON.stringify({ threadId, message, connectionId: null }) }));
  return { runId, threadId, executionArn: executionArn! };
}

/** The real approval id is only sent over WebSocket (disabled locally) and only its hash is stored, so the
 *  test re-keys the real task token under a known id. See ADR 0009 for what this does and does not cover. */
async function seedKnownApprovalId(runId: string): Promise<string> {
  const item = await waitFor('approval item', async () => {
    const res = await doc.send(new ScanCommand({ TableName: out.TableName, FilterExpression: '#k = :k AND runId = :r', ExpressionAttributeNames: { '#k': 'kind' }, ExpressionAttributeValues: { ':k': 'approval', ':r': runId } }));
    return res.Items?.[0];
  });
  const id = randomBytes(32).toString('base64url');
  await doc.send(new PutCommand({ TableName: out.TableName, Item: { ...item, pk: `approval#${hashApprovalId(id)}` } }));
  await doc.send(new DeleteCommand({ TableName: out.TableName, Key: { pk: item.pk, sk: item.sk } }));
  return id;
}

async function post(id: string, body: unknown) {
  const res = await fetch(restApiUrl(out.ApprovalApiId, out.ApprovalApiStage, `/approvals/${id}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}

async function finished(executionArn: string) {
  return waitFor('execution to finish', async () => {
    const d = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    return d.status === 'RUNNING' ? undefined : d;
  });
}

describe('Step Functions approval callback on LocalStack', () => {
  beforeAll(async () => { await assertLocalStackReady(); out = loadOutputs(); });

  it('approve: HTTPS callback resumes the execution, the tool runs, the run succeeds', async () => {
    const run = await startRun('Please email Bob hello');
    const id = await seedKnownApprovalId(run.runId);
    const res = await post(id, { decision: 'approve' });
    expect(res).toEqual({ status: 200, json: { status: 'approved', runId: run.runId } });
    const exec = await finished(run.executionArn);
    expect(exec.status).toBe('SUCCEEDED');
    const state = JSON.parse(exec.output!);
    expect(state.resume).toEqual({ approved: true });
    expect(state.step).toMatchObject({ status: 'completed' });
    expect(state.step.output).toMatch(/^Done\. Tool result: Demo stub: email to bob@example\.com/);
    const history = await sfn.send(new GetExecutionHistoryCommand({ executionArn: run.executionArn, maxResults: 200 }));
    expect(history.events?.some((e) => e.stateEnteredEventDetails?.name === 'WaitForApproval')).toBe(true);
  });

  it('reject: the model is told, the tool never runs, the run still succeeds', async () => {
    const run = await startRun('Please email Bob hello');
    const id = await seedKnownApprovalId(run.runId);
    expect((await post(id, { decision: 'reject', comment: 'not today' })).status).toBe(200);
    const exec = await finished(run.executionArn);
    expect(exec.status).toBe('SUCCEEDED');
    const state = JSON.parse(exec.output!);
    expect(state.resume).toEqual({ approved: false, comment: 'not today' });
    expect(state.step.output).toBe('Understood. I did not send the email.');
  });

  it('links are single use and bad input never consumes them', async () => {
    const run = await startRun('Please email Bob hello');
    const id = await seedKnownApprovalId(run.runId);
    expect((await post(id, { decision: 'maybe' })).status).toBe(400);
    expect((await post(id, { decision: 'approve' })).status).toBe(200);
    expect((await post(id, { decision: 'approve' })).status).toBe(404);
    expect((await finished(run.executionArn)).status).toBe('SUCCEEDED');
  });
});
