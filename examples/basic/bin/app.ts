import { App, CfnOutput, CliCredentialsStackSynthesizer, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { AgentModel, ServerlessAgent } from '@serverless-agent/construct';

const SYSTEM_PROMPT = 'You are a concise support assistant. Use tools when they help. Never claim an email was sent unless the tool result says so.';

/** Real-AWS shape: Bedrock Nova Lite, WebSocket streaming, REST approvals. Synth only in v0.1. */
class ExampleAgentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const agent = new ServerlessAgent(this, 'SupportAgent', {
      model: AgentModel.bedrock(),
      toolsRequiringApproval: ['send_email'],
      approvalTimeout: Duration.hours(4),
      systemPrompt: SYSTEM_PROMPT,
    });
    new CfnOutput(this, 'WebSocketUrl', { value: agent.webSocketUrl ?? 'disabled' });
    new CfnOutput(this, 'ApprovalApiUrl', { value: agent.approvalBaseUrl });
    new CfnOutput(this, 'StateMachineArn', { value: agent.stateMachine.stateMachineArn });
    new CfnOutput(this, 'TableName', { value: agent.table.tableName });
  }
}

/** LocalStack Hobby profile (ADR 0009): no API Gateway v2, x86_64, Node 22, mock LLM, no bootstrap/ECR. */
class LocalAgentStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, {
      synthesizer: new CliCredentialsStackSynthesizer({
        fileAssetsBucketName: 'serverless-agent-local-assets',
        bucketPrefix: 'assets/',
      }),
    });
    const agent = new ServerlessAgent(this, 'LocalAgent', {
      model: AgentModel.openAiCompatible({ baseUrl: 'http://mock-llm:8080/v1', modelId: 'mock-llm', pricing: AgentModel.DEFAULT_BEDROCK_PRICING }),
      webSocketApi: false,
      architecture: lambda.Architecture.X86_64,
      lambdaRuntime: lambda.Runtime.NODEJS_22_X,
      removalPolicy: RemovalPolicy.DESTROY,
      approvalTimeout: Duration.minutes(15),
      systemPrompt: SYSTEM_PROMPT,
    });
    new CfnOutput(this, 'StateMachineArn', { value: agent.stateMachine.stateMachineArn });
    new CfnOutput(this, 'TableName', { value: agent.table.tableName });
    new CfnOutput(this, 'AgentFunctionName', { value: agent.agentFunction.functionName });
    new CfnOutput(this, 'ApprovalCallbackFunctionName', { value: agent.approvalCallbackFunction.functionName });
    new CfnOutput(this, 'ApprovalApiId', { value: agent.approvalApi.restApiId });
    new CfnOutput(this, 'ApprovalApiStage', { value: agent.approvalApi.deploymentStage.stageName });
    new CfnOutput(this, 'ApprovalApiUrl', { value: agent.approvalBaseUrl });
  }
}

const app = new App();
new ExampleAgentStack(app, 'ServerlessAgentExample', { description: 'ServerlessAgent v0.1 example: LangGraph.js on Lambda + Step Functions approvals' });
new LocalAgentStack(app, 'ServerlessAgentLocal');
