import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SFNClient } from '@aws-sdk/client-sfn';
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { buildAgentGraph, type AgentGraph } from '../agent/graph.js';
import { createChatModel } from '../agent/model.js';
import { demoTools } from '../agent/tools.js';
import { DynamoDBSaver } from '../checkpointer/dynamodb-saver.js';
import { intEnv, listEnv, modelConfigFromEnv, pricingFromEnv, requireEnv, type Env } from '../config.js';
import { ApiGatewayNotifier, NullNotifier, type Notifier } from '../notify.js';
import { createAgentStepHandler, type AgentStepEvent } from './agent-step.js';
import { createApprovalCallbackHandler, type HttpEvent } from './approval-callback.js';
import { createRequestApprovalHandler, type RequestApprovalEvent } from './request-approval.js';
import { createWebSocketHandler, type WsEvent } from './websocket.js';

const env = (): Env => process.env;

let documentClient: DynamoDBDocumentClient | undefined;
const docClient = () => (documentClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));
const sfnClient = () => new SFNClient({});

function notifierFrom(e: Env): Notifier {
  return e.WEBSOCKET_CALLBACK_URL ? new ApiGatewayNotifier(new ApiGatewayManagementApiClient({ endpoint: e.WEBSOCKET_CALLBACK_URL })) : new NullNotifier();
}

/** Builds the real handler on first call, then reuses it for the life of the container. */
function lazy<E, R>(factory: () => Promise<(event: E) => Promise<R>>): (event: E) => Promise<R> {
  let handler: Promise<(event: E) => Promise<R>> | undefined;
  return async (event: E) => {
    handler ??= factory().catch((err) => { handler = undefined; throw err; });
    return (await handler)(event);
  };
}

async function readApiKey(secretArn: string | undefined): Promise<string | undefined> {
  if (!secretArn) return undefined;
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  return out.SecretString;
}

export const agentStep = lazy<AgentStepEvent, unknown>(async () => {
  const e = env();
  const agentName = requireEnv(e, 'AGENT_NAME');
  const tableName = requireEnv(e, 'TABLE_NAME');
  const model = modelConfigFromEnv(e);
  const apiKey = await readApiKey(model.apiKeySecretArn);
  const ttl = intEnv(e, 'CHECKPOINT_TTL_SECONDS', 0);
  let graph: Promise<AgentGraph> | undefined;
  const getGraph = () => (graph ??= Promise.resolve(buildAgentGraph({
    model: createChatModel({ ...model, apiKey }),
    tools: demoTools,
    toolsRequiringApproval: listEnv(e, 'TOOLS_REQUIRING_APPROVAL'),
    checkpointer: new DynamoDBSaver({ client: docClient(), tableName, ttlSeconds: ttl > 0 ? ttl : undefined }),
    systemPrompt: e.SYSTEM_PROMPT || undefined,
  })));
  return createAgentStepHandler({ getGraph, notifier: notifierFrom(e), agentName, pricing: pricingFromEnv(e), recursionLimit: intEnv(e, 'RECURSION_LIMIT', 25) });
});

export const requestApproval = lazy<RequestApprovalEvent, unknown>(async () => {
  const e = env();
  return createRequestApprovalHandler({
    client: docClient(), tableName: requireEnv(e, 'TABLE_NAME'), notifier: notifierFrom(e),
    approvalBaseUrl: e.APPROVAL_BASE_URL ?? '', approvalTtlSeconds: intEnv(e, 'APPROVAL_TTL_SECONDS'),
  });
});

export const approvalCallback = lazy<HttpEvent, unknown>(async () => {
  const e = env();
  return createApprovalCallbackHandler({ client: docClient(), tableName: requireEnv(e, 'TABLE_NAME'), sfn: sfnClient() });
});

export const wsHandler = lazy<WsEvent, unknown>(async () => {
  const e = env();
  return createWebSocketHandler({ sfn: sfnClient(), stateMachineArn: requireEnv(e, 'STATE_MACHINE_ARN') });
});
