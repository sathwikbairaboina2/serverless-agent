import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { synthAgent } from './support/template-helpers';

describe('WebSocket API', () => {
  const { template: t, agent } = synthAgent();

  it('exists with IAM-authorized $connect and $disconnect/$default routes', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'WEBSOCKET' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$connect', AuthorizationType: 'AWS_IAM' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$disconnect' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', { StageName: 'live', AutoDeploy: true });
  });

  it('wires the handler to start executions', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.wsHandler', Environment: { Variables: { STATE_MACHINE_ARN: { Ref: Match.anyValue() } } } });
    expect(agent.webSocketHandlerFunction).toBeDefined();
    expect(agent.webSocketUrl).toBeDefined();
  });

  it('can be disabled (LocalStack Hobby has no API Gateway v2)', () => {
    const { template, agent: a } = synthAgent({ webSocketApi: false });
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    template.resourceCountIs('AWS::Lambda::Function', 3);
    expect(a.webSocketHandlerFunction).toBeUndefined();
  });
});

describe('REST approval API', () => {
  const { template: t } = synthAgent();

  it('exposes POST /approvals/{approvalId} via Lambda proxy, no CloudWatch account role', () => {
    t.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    t.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'approvals' });
    t.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{approvalId}' });
    t.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'POST', AuthorizationType: 'NONE', Integration: Match.objectLike({ Type: 'AWS_PROXY' }) });
    t.resourceCountIs('AWS::ApiGateway::Account', 0);
  });

  it('throttles the v1 stage', () => {
    t.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'v1',
      MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 })]),
    });
  });

  it('tells the approval function its public base URL', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.requestApproval', Environment: { Variables: Match.objectLike({ APPROVAL_BASE_URL: Match.anyValue() }) } });
  });

  it('exists even when the WebSocket API is disabled', () => {
    synthAgent({ webSocketApi: false }).template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });
});
