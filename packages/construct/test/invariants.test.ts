import { describe, expect, it } from 'vitest';
import { actionsOf, allStatements, flat, statementsForFunction, synthAgent } from './support/template-helpers';

const STAR_RESOURCE_ALLOWLIST = new Set([
  'logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery',
  'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups',
]);

for (const [label, props] of [['default', {}], ['local profile', { webSocketApi: false }]] as const) {
  describe(`IAM least privilege (${label})`, () => {
    const { template } = synthAgent(props);
    const statements = allStatements(template);

    it('never uses a wildcard in an action', () => {
      const offenders = statements.flatMap(actionsOf).filter((a) => a.includes('*'));
      expect(offenders).toEqual([]);
    });

    it('never uses NotAction or Deny-less tricks', () => {
      expect(statements.filter((s) => s.NotAction !== undefined)).toEqual([]);
    });

    it('uses Resource "*" only for allowlisted log-delivery actions', () => {
      const offenders = statements
        .filter((s) => ([] as unknown[]).concat(s.Resource).some((r) => r === '*'))
        .flatMap(actionsOf)
        .filter((a) => !STAR_RESOURCE_ALLOWLIST.has(a));
      expect(offenders).toEqual([]);
    });

    it('attaches no managed policy except AWSLambdaBasicExecutionRole', () => {
      const arns = (Object.values(template.findResources('AWS::IAM::Role')) as any[]).flatMap((r) => r.Properties.ManagedPolicyArns ?? []).map(flat);
      for (const arn of arns) expect(arn).toMatch(/service-role\/AWSLambdaBasicExecutionRole$/);
    });
  });
}

describe('per-function grants', () => {
  const { template } = synthAgent();
  const actions = (handler: string) => statementsForFunction(template, handler).flatMap(actionsOf);

  it('agentStep: DynamoDB data, Bedrock invoke, WebSocket post, nothing from Step Functions', () => {
    const a = actions('index.agentStep');
    expect(a).toEqual(expect.arrayContaining(['dynamodb:PutItem', 'dynamodb:Query', 'bedrock:InvokeModel', 'execute-api:ManageConnections']));
    expect(a.some((x) => x.startsWith('states:'))).toBe(false);
  });

  it('requestApproval: DynamoDB writes and WebSocket post only', () => {
    const a = actions('index.requestApproval');
    expect(a).toContain('dynamodb:PutItem');
    expect(a.some((x) => x.startsWith('bedrock:') || x.startsWith('states:'))).toBe(false);
  });

  it('approvalCallback: DynamoDB writes plus task responses, no model access, no reads', () => {
    const a = actions('index.approvalCallback');
    expect(a).toEqual(expect.arrayContaining(['dynamodb:DeleteItem', 'states:SendTaskSuccess']));
    expect(a.some((x) => x.startsWith('bedrock:'))).toBe(false);
    expect(a).not.toContain('dynamodb:Query');
  });

  it('wsHandler: start executions only', () => {
    const a = actions('index.wsHandler');
    expect(a).toEqual(['states:StartExecution']);
  });

  it('scopes Bedrock to the configured model', () => {
    const s = statementsForFunction(template, 'index.agentStep').find((x) => actionsOf(x).includes('bedrock:InvokeModel'))!;
    expect(flat(s.Resource)).toContain('foundation-model/amazon.nova-lite-v1:0');
  });
});

describe('scale-to-zero', () => {
  const { template } = synthAgent();

  it('has no always-on compute or networking', () => {
    for (const type of ['AWS::Lambda::Version', 'AWS::Lambda::Alias', 'AWS::EC2::VPC', 'AWS::EC2::NatGateway', 'AWS::ApplicationAutoScaling::ScalableTarget']) {
      template.resourceCountIs(type, 0);
    }
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    for (const f of fns) {
      expect(f.Properties.ReservedConcurrentExecutions).toBeUndefined();
      expect(f.Properties.VpcConfig).toBeUndefined();
    }
  });

  it('bills DynamoDB per request and Step Functions per transition', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD' });
  });
});
