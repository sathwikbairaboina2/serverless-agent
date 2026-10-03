import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { beforeAll, describe, expect, it } from 'vitest';
import { AgentModel } from '../src';
import { synthAgent } from './support/template-helpers';

describe('ServerlessAgent core', () => {
  let t: ReturnType<typeof synthAgent>['template'];
  beforeAll(() => { t = synthAgent().template; });

  it('creates one on-demand checkpoint table with pk/sk, TTL on expiresAt and PITR, retained by default', () => {
    t.resourceCountIs('AWS::DynamoDB::Table', 1);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  it('runs functions on Node 24 arm64 from the shared bundle', () => {
    for (const handler of ['index.agentStep', 'index.requestApproval', 'index.approvalCallback']) {
      t.hasResourceProperties('AWS::Lambda::Function', { Handler: handler, Runtime: 'nodejs24.x', Architectures: ['arm64'] });
    }
  });

  it('configures the agent function from props', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.agentStep', MemorySize: 1024, Timeout: 300,
      Environment: { Variables: Match.objectLike({
        AGENT_NAME: 'Agent', TABLE_NAME: { Ref: Match.anyValue() }, CHECKPOINT_TTL_SECONDS: '2592000',
        TOOLS_REQUIRING_APPROVAL: 'send_email', RECURSION_LIMIT: '25',
        MODEL_PROVIDER: 'bedrock', MODEL_ID: 'amazon.nova-lite-v1:0', WEBSOCKET_CALLBACK_URL: Match.anyValue(),
      }) },
    });
  });

  it('gives the approval function its TTL and the callback only the table', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.requestApproval', Environment: { Variables: Match.objectLike({ APPROVAL_TTL_SECONDS: '86400' }) } });
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.approvalCallback', Environment: { Variables: { TABLE_NAME: { Ref: Match.anyValue() } } } });
  });

  it('tags resources for cost allocation', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Tags: Match.arrayWith([{ Key: 'serverless-agent:agent-name', Value: 'Agent' }]) });
    t.hasResourceProperties('AWS::DynamoDB::Table', { Tags: Match.arrayWith([{ Key: 'serverless-agent:agent-name', Value: 'Agent' }]) });
  });

  it('sets explicit log retention log groups', () => {
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });
});

describe('ServerlessAgent overrides and validation', () => {
  it('supports x86_64, Node 22, no WebSocket and destroyable table (LocalStack profile)', () => {
    const { template } = synthAgent({
      architecture: lambda.Architecture.X86_64, lambdaRuntime: lambda.Runtime.NODEJS_22_X, webSocketApi: false,
      removalPolicy: RemovalPolicy.DESTROY, model: AgentModel.openAiCompatible({ baseUrl: 'http://mock-llm:8080/v1', modelId: 'mock-llm' }),
      systemPrompt: 'Be brief.', checkpointTtl: Duration.days(1),
    });
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.agentStep', Runtime: 'nodejs22.x', Architectures: ['x86_64'],
      Environment: { Variables: Match.objectLike({ MODEL_BASE_URL: 'http://mock-llm:8080/v1', SYSTEM_PROMPT: 'Be brief.', CHECKPOINT_TTL_SECONDS: '86400' }) } });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
    const agentFn = Object.values(template.findResources('AWS::Lambda::Function', { Properties: { Handler: 'index.agentStep' } }))[0] as any;
    expect(agentFn.Properties.Environment.Variables.WEBSOCKET_CALLBACK_URL).toBeUndefined();
  });

  it('rejects an invalid agentName', () => {
    expect(() => synthAgent({ agentName: 'bad name!' })).toThrow(/agentName/);
  });

  it('rejects approvalTimeout >= maxRunDuration', () => {
    expect(() => synthAgent({ approvalTimeout: Duration.days(8) })).toThrow(/approvalTimeout/);
  });

  it('allows an empty approval list (disables approvals)', () => {
    expect(() => synthAgent({ toolsRequiringApproval: [] })).not.toThrow();
  });
});
