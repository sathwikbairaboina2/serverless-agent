# ADR 0009: LocalStack in Docker as the integration environment (Hobby-plan compatible)

Status: accepted, 2026-10-03 (user rule: every AWS dependency runs on LocalStack in Docker; real AWS deploy stays out of scope)

## Facts checked (2026-10-03, official sources, not guessed)

- **Auth token is mandatory.**
  - "As of version 2026.03.0, an auth token or CI auth token is required to start LocalStack for AWS" ([release notes](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/)).
  - "An Auth Token is a mandatory credential required to start the LocalStack container" ([auth token docs](https://docs.localstack.cloud/aws/getting-started/auth-token/)).
  - The `localstack/localstack:latest` image on this machine (created 2026-08-12) is labelled "LocalStack Pro Docker image".
  - The temporary bypass `LOCALSTACK_ACKNOWLEDGE_ACCOUNT_REQUIREMENT=1` expired on 2026-04-06.
- **Free plan:** "We provide the following subscription for non-commercial use: Hobby" ([licensing](https://docs.localstack.cloud/aws/licensing/)).
- **Per-service availability**, from the licensing table (Hobby / Base / Ultimate):

  | Service | Hobby | Base | Ultimate |
  |---|---|---|---|
  | CloudFormation, S3, IAM, STS, SSM Parameter Store, Lambda, DynamoDB, Step Functions, API Gateway **REST** API, Secrets Manager, CloudWatch Logs/Metrics | ✅ | ✅ | ✅ |
  | API Gateway **HTTP and WebSocket** API | ❌ | ✅ | ✅ |
  | ECR | ❌ | ✅ | ✅ |
  | Bedrock / Bedrock Runtime | ❌ | ❌ | ✅ |

- **The default `cdk bootstrap` template creates an ECR repository** (`ContainerAssetsRepository`), and ECR is not in Hobby. The LocalStack CDK docs also state "`lstk cdk` supersedes the older `cdklocal` wrapper script, which is deprecated", and `lstk` is a separately installed CLI ([CDK docs](https://docs.localstack.cloud/aws/connecting/infrastructure-as-code/aws-cdk/)).
- **Step Functions:** the Lambda integration supports "Request Response" and "Wait for Callback (.waitForTaskToken)". This was read from the service integration table on the [Step Functions docs](https://docs.localstack.cloud/aws/services/stepfunctions/).
- **Lambda architecture:** "ARM-compatible hosts can create functions with the arm64 architecture" ([Lambda docs](https://docs.localstack.cloud/aws/services/lambda/)). This host is x86_64. The docs' examples use `nodejs22.x`; `nodejs24.x` was not confirmed.
- `LOCALSTACK_AUTH_TOKEN` is **not set** on this machine (checked 2026-10-03).

## Decision

- **docker-compose.yml** (project `serverless-agent`, network `serverless-agent-net`) runs two services:
  - `localstack`: image `localstack/localstack:${LOCALSTACK_VERSION:-latest}` on `127.0.0.1:4566`. The token comes from the environment as `LOCALSTACK_AUTH_TOKEN: ${LOCALSTACK_AUTH_TOKEN:?...}`, so compose fails fast with a clear message. It is never committed. Also set: `LAMBDA_DOCKER_NETWORK=serverless-agent-net` and the Docker socket mount.
  - `mock-llm`: a dependency-free `node:24-alpine` OpenAI-compatible server with deterministic scripted replies (Chat Completions, streaming and non-streaming). Lambda containers reach it at `http://mock-llm:8080/v1`.
- **The approval endpoint is an API Gateway REST API (v1)** (`POST /approvals/{approvalId}`, stage `v1`, throttled), not an HTTP API. It is free on Hobby, so LocalStack exercises the real HTTPS callback. The cost difference at approval volume is negligible (estimate: $3.50 vs $1.00 per million requests). The Lambda proxy event fields we read (`pathParameters`, `body`, `isBase64Encoded`) are the same in v1 and v2.
- **The WebSocket API stays** (it is the right tool for streaming on AWS). It can be switched off with the construct prop `webSocketApi: false` for Hobby. Its wiring is covered by CDK assertion tests only.
- Construct props for local environments: `webSocketApi` (default `true`), `architecture` (default `ARM_64`) and `lambdaRuntime` (default `NODEJS_24_X`). The runtime bundle targets `node22` so it runs on both runtimes.
- **The local deploy uses the AWS SDK, without `cdk bootstrap` and without ECR.** The `ServerlessAgentLocal` stack uses `CliCredentialsStackSynthesizer({ fileAssetsBucketName: 'serverless-agent-local-assets', generateBootstrapVersionRule: false })`. `examples/basic/scripts/deploy-local.mjs` then does the following against `http://localhost:4566`:
  1. creates the bucket;
  2. zips each file asset listed in `ServerlessAgentLocal.assets.json` (using `fflate`) and uploads it;
  3. runs CloudFormation `CreateStack` or `UpdateStack` with the synthesized template;
  4. waits for completion, printing stack events on failure;
  5. writes `cdk.local-outputs.json`.

  `aws-cdk-local`/`cdklocal` is not used: it is deprecated, and default bootstrap needs ECR.
- **`examples/basic`** has two stacks:
  - `ServerlessAgentExample`: full and AWS-shaped (synth only);
  - `ServerlessAgentLocal`: `webSocketApi: false`, `X86_64`, `NODEJS_22_X`, `AgentModel.openAiCompatible({ baseUrl: 'http://mock-llm:8080/v1', modelId: 'mock-llm' })`, `removalPolicy: DESTROY`.
- **`packages/integration`** (`pnpm test:integration`, not part of `pnpm test`) runs against LocalStack:
  1. **Checkpointer:** the official conformance suite against LocalStack DynamoDB (fresh table per checkpointer).
  2. **Invoke path:** Lambda `Invoke` of the deployed `agentStep`. A "time" question runs the safe tool and completes. An "email" question returns `interrupted`.
  3. **Approval callback:** `StartExecution` → wait for the approval item and the `WaitForApproval` state → `POST` the REST endpoint `/approvals/{id}` → the execution reaches `SUCCEEDED`. Covered for approve and reject, plus single-use (second POST returns 404).
- Integration tests **fail loudly** when LocalStack is unreachable or the token is missing. They never skip silently or fake results. With no token, the blocker is recorded in `docs/handoff.md` and the final report.

## Consequences

- What we gave up:
  - Local coverage of the WebSocket path on the free plan (CDK assertions only).
  - Bedrock in the loop locally.
  - The `cdk deploy` UX locally; the SDK deploy script is about 120 lines we own.
- The approval-callback integration test cannot learn the real approval id: only its hash is stored, and the id is sent only over WebSocket, which is disabled locally. The test copies the real task token into a test-seeded approval item with a known id, then calls the real REST endpoint. This covers HTTPS → Lambda → DynamoDB claim → `SendTaskSuccess` → state machine resume → completion. Id generation and delivery are covered by unit tests.
