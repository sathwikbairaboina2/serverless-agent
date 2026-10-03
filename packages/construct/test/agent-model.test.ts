import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import { AgentModel } from '../src';
import { allStatements, actionsOf, flat } from './support/template-helpers';

function bindInStack(model: AgentModel) {
  const stack = new Stack(new App(), 'S', { env: { account: '123456789012', region: 'us-east-1' } });
  const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  const binding = model.bind(role);
  return { stack, binding, template: Template.fromStack(stack) };
}

describe('AgentModel.bedrock', () => {
  it('defaults to Nova Lite with estimated pricing and scoped invoke permissions', () => {
    const { binding, template } = bindInStack(AgentModel.bedrock());
    expect(binding.environment).toEqual({
      MODEL_PROVIDER: 'bedrock', MODEL_ID: 'amazon.nova-lite-v1:0',
      PRICE_INPUT_USD_PER_MTOK: '0.06', PRICE_OUTPUT_USD_PER_MTOK: '0.24',
    });
    const [stmt] = allStatements(template);
    expect(actionsOf(stmt).sort()).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(flat(stmt.Resource)).toBe('arn:{AWS::Partition}:bedrock:{AWS::Region}::foundation-model/amazon.nova-lite-v1:0');
  });

  it('grants the inference profile and the underlying model for geo profile ids', () => {
    const { template, binding } = bindInStack(AgentModel.bedrock('us.amazon.nova-pro-v1:0', { pricing: { inputUsdPerMillionTokens: 0.8, outputUsdPerMillionTokens: 3.2 } }));
    expect(binding.environment.PRICE_INPUT_USD_PER_MTOK).toBe('0.8');
    const resources = flat(allStatements(template)[0].Resource);
    expect(resources).toContain('inference-profile/us.amazon.nova-pro-v1:0');
    expect(resources).toContain('bedrock:*::foundation-model/amazon.nova-pro-v1:0');
  });

  it('defaults non-default models to zero pricing', () => {
    expect(bindInStack(AgentModel.bedrock('anthropic.claude-x')).binding.environment.PRICE_INPUT_USD_PER_MTOK).toBe('0');
  });
});

describe('AgentModel.openAiCompatible', () => {
  it('sets base URL env and grants nothing without a secret', () => {
    const { binding, template } = bindInStack(AgentModel.openAiCompatible({ baseUrl: 'http://mock-llm:8080/v1', modelId: 'mock-llm' }));
    expect(binding.environment).toMatchObject({ MODEL_PROVIDER: 'openai-compatible', MODEL_ID: 'mock-llm', MODEL_BASE_URL: 'http://mock-llm:8080/v1' });
    expect(allStatements(template)).toHaveLength(0);
  });

  it('grants read on the API key secret only', () => {
    const stack = new Stack(new App(), 'S2');
    const secret = new secretsmanager.Secret(stack, 'Key');
    const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const binding = AgentModel.openAiCompatible({ baseUrl: 'https://llm.example.com/v1', modelId: 'm', apiKeySecret: secret }).bind(role);
    expect(binding.environment.MODEL_API_KEY_SECRET_ARN).toBeDefined();
    const actions = allStatements(Template.fromStack(stack)).flatMap(actionsOf);
    expect(actions).toEqual(expect.arrayContaining(['secretsmanager:GetSecretValue']));
    expect(actions.some((a) => a.startsWith('bedrock:'))).toBe(false);
  });

  it('rejects a base URL without http(s) scheme', () => {
    expect(() => AgentModel.openAiCompatible({ baseUrl: 'mock-llm:8080', modelId: 'm' })).toThrow(/baseUrl/);
  });
});
