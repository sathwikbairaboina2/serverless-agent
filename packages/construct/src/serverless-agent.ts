import { Duration, RemovalPolicy, Stack, Tags, Token } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { AgentModel } from './agent-model';
import { runtimeCode } from './runtime-code';

export interface ServerlessAgentProps {
  readonly agentName?: string;
  readonly model?: AgentModel;
  readonly toolsRequiringApproval?: string[];
  readonly systemPrompt?: string;
  readonly approvalTimeout?: Duration;
  readonly maxRunDuration?: Duration;
  readonly checkpointTtl?: Duration;
  readonly agentTimeout?: Duration;
  readonly agentMemorySize?: number;
  readonly recursionLimit?: number;
  readonly webSocketApi?: boolean;
  readonly architecture?: lambda.Architecture;
  readonly lambdaRuntime?: lambda.Runtime;
  readonly logRetention?: logs.RetentionDays;
  readonly removalPolicy?: RemovalPolicy;
}

export class ServerlessAgent extends Construct {
  public readonly agentName: string;
  public readonly table: dynamodb.Table;
  public readonly agentFunction: lambda.Function;
  public readonly requestApprovalFunction: lambda.Function;
  public readonly approvalCallbackFunction: lambda.Function;
  public readonly webSocketApi?: apigwv2.WebSocketApi;
  public readonly webSocketStage?: apigwv2.WebSocketStage;
  public readonly webSocketUrl?: string;
  public readonly stateMachine: sfn.StateMachine;
  public readonly webSocketHandlerFunction?: lambda.Function;
  public readonly approvalApi: apigw.RestApi;
  public readonly approvalBaseUrl: string;

  constructor(scope: Construct, id: string, props: ServerlessAgentProps = {}) {
    super(scope, id);
    this.agentName = props.agentName ?? id;
    if (!Token.isUnresolved(this.agentName) && !/^[A-Za-z0-9-]{1,40}$/.test(this.agentName)) {
      throw new Error(`ServerlessAgent: agentName must match ^[A-Za-z0-9-]{1,40}$ (got "${this.agentName}")`);
    }
    const approvalTimeout = props.approvalTimeout ?? Duration.hours(24);
    const maxRunDuration = props.maxRunDuration ?? Duration.days(7);
    if (approvalTimeout.toSeconds() >= maxRunDuration.toSeconds()) {
      throw new Error('ServerlessAgent: approvalTimeout must be shorter than maxRunDuration');
    }
    const model = props.model ?? AgentModel.bedrock();
    const code = runtimeCode();
    const runtime = props.lambdaRuntime ?? lambda.Runtime.NODEJS_24_X;
    const architecture = props.architecture ?? lambda.Architecture.ARM_64;
    const retention = props.logRetention ?? logs.RetentionDays.ONE_MONTH;

    this.table = new dynamodb.Table(this, 'Checkpoints', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: props.removalPolicy ?? RemovalPolicy.RETAIN,
    });

    if (props.webSocketApi ?? true) {
      this.webSocketApi = new apigwv2.WebSocketApi(this, 'WebSocketApi', { apiName: `${this.agentName}-ws` });
      this.webSocketStage = new apigwv2.WebSocketStage(this, 'WebSocketStage', { webSocketApi: this.webSocketApi, stageName: 'live', autoDeploy: true });
      this.webSocketUrl = this.webSocketStage.url;
    }
    const wsEnv: { [key: string]: string } = this.webSocketStage ? { WEBSOCKET_CALLBACK_URL: this.webSocketStage.callbackUrl } : {};

    const makeFunction = (name: string, handler: string, memorySize: number, timeout: Duration, environment: { [key: string]: string }) =>
      new lambda.Function(this, name, {
        runtime, architecture, code, handler: `index.${handler}`, memorySize, timeout, environment,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention, removalPolicy: RemovalPolicy.DESTROY }),
        description: `ServerlessAgent ${this.agentName}: ${handler}`,
      });

    this.agentFunction = makeFunction('AgentStep', 'agentStep', props.agentMemorySize ?? 1024, props.agentTimeout ?? Duration.minutes(5), {
      AGENT_NAME: this.agentName,
      TABLE_NAME: this.table.tableName,
      CHECKPOINT_TTL_SECONDS: String((props.checkpointTtl ?? Duration.days(30)).toSeconds()),
      TOOLS_REQUIRING_APPROVAL: (props.toolsRequiringApproval ?? ['send_email']).join(','),
      RECURSION_LIMIT: String(props.recursionLimit ?? 25),
      ...(props.systemPrompt ? { SYSTEM_PROMPT: props.systemPrompt } : {}),
      ...wsEnv,
    });
    for (const [k, v] of Object.entries(model.bind(this.agentFunction).environment)) this.agentFunction.addEnvironment(k, v);
    this.table.grantReadWriteData(this.agentFunction);

    this.requestApprovalFunction = makeFunction('RequestApproval', 'requestApproval', 256, Duration.seconds(10), {
      TABLE_NAME: this.table.tableName,
      APPROVAL_TTL_SECONDS: String(approvalTimeout.toSeconds()),
      ...wsEnv,
    });
    this.table.grantWriteData(this.requestApprovalFunction);

    this.approvalCallbackFunction = makeFunction('ApprovalCallback', 'approvalCallback', 256, Duration.seconds(10), {
      TABLE_NAME: this.table.tableName,
    });
    this.table.grantWriteData(this.approvalCallbackFunction);

    if (this.webSocketApi) {
      this.webSocketApi.grantManageConnections(this.agentFunction);
      this.webSocketApi.grantManageConnections(this.requestApprovalFunction);
    }

    const runFailed = new sfn.Fail(this, 'RunFailed', { error: 'AgentRunFailed', cause: 'The agent step or approval request failed; see execution history.' });
    const approvalTimedOut = new sfn.Fail(this, 'ApprovalTimedOut', { error: 'ApprovalTimedOut', cause: 'No human decision before approvalTimeout.' });
    const runCompleted = new sfn.Succeed(this, 'RunCompleted');

    const runAgent = new tasks.LambdaInvoke(this, 'RunAgent', {
      lambdaFunction: this.agentFunction,
      payload: sfn.TaskInput.fromObject({ runId: sfn.JsonPath.stringAt('$$.Execution.Name'), input: sfn.JsonPath.entirePayload }),
      payloadResponseOnly: true,
      resultPath: '$.step',
      retryOnServiceExceptions: true,
    });
    runAgent.addCatch(runFailed, { resultPath: '$.error' });

    const waitForApproval = new tasks.LambdaInvoke(this, 'WaitForApproval', {
      lambdaFunction: this.requestApprovalFunction,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ taskToken: sfn.JsonPath.taskToken, runId: sfn.JsonPath.stringAt('$$.Execution.Name'), input: sfn.JsonPath.entirePayload }),
      resultPath: '$.resume',
      taskTimeout: sfn.Timeout.duration(approvalTimeout),
    });
    waitForApproval.addCatch(approvalTimedOut, { errors: [sfn.Errors.TIMEOUT], resultPath: '$.error' });
    waitForApproval.addCatch(runFailed, { resultPath: '$.error' });

    const needsApproval = new sfn.Choice(this, 'NeedsApproval?')
      .when(sfn.Condition.stringEquals('$.step.status', 'interrupted'), waitForApproval)
      .otherwise(runCompleted);
    waitForApproval.next(runAgent);

    this.stateMachine = new sfn.StateMachine(this, 'RunStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(runAgent.next(needsApproval)),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: maxRunDuration,
      logs: {
        destination: new logs.LogGroup(this, 'RunStateMachineLogs', { retention, removalPolicy: RemovalPolicy.DESTROY }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });
    this.stateMachine.grantTaskResponse(this.approvalCallbackFunction);

    if (this.webSocketApi) {
      const wsFunction = makeFunction('WebSocketHandler', 'wsHandler', 256, Duration.seconds(10), { STATE_MACHINE_ARN: this.stateMachine.stateMachineArn });
      this.stateMachine.grantStartExecution(wsFunction);
      const integration = new WebSocketLambdaIntegration('WebSocketIntegration', wsFunction);
      this.webSocketApi.addRoute('$connect', { integration, authorizer: new WebSocketIamAuthorizer() });
      this.webSocketApi.addRoute('$disconnect', { integration });
      this.webSocketApi.addRoute('$default', { integration, returnResponse: true });
      this.webSocketHandlerFunction = wsFunction;
    }

    this.approvalApi = new apigw.RestApi(this, 'ApprovalApi', {
      restApiName: `${this.agentName}-approvals`,
      description: 'ServerlessAgent single-use human approval callbacks',
      cloudWatchRole: false,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: { stageName: 'v1', throttlingRateLimit: 10, throttlingBurstLimit: 20 },
    });
    this.approvalApi.root.addResource('approvals').addResource('{approvalId}')
      .addMethod('POST', new apigw.LambdaIntegration(this.approvalCallbackFunction));
    this.approvalBaseUrl = this.approvalApi.url;
    // Not approvalApi.url: that token goes through the deployment stage, which depends on the callback
    // function, whose SendTaskSuccess grant depends on the state machine, which depends on this function (cycle).
    const stackRef = Stack.of(this);
    this.requestApprovalFunction.addEnvironment('APPROVAL_BASE_URL', `https://${this.approvalApi.restApiId}.execute-api.${stackRef.region}.${stackRef.urlSuffix}/v1/`);

    Tags.of(this).add('serverless-agent:agent-name', this.agentName);
    Tags.of(this).add('serverless-agent:managed-by', 'serverless-agent-construct');
  }
}
