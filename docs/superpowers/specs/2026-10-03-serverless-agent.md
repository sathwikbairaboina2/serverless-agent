# ServerlessAgent v0.1: spec

Date: 2026-10-03 · Author: Claude (planner) for Sathwik · Status: approved by brief (no brainstorming round; decisions recorded as ADRs in `docs/adr/`)

## Why

Sathwik's resume claims AWS Lambda, DynamoDB, CDK and Step Functions, but no public repo shows that work. This repo is project #4 on the shortlist (`../docs/superpowers/specs/2026-10-03-project-shortlist.md`) and also backs up the profile thesis, **"the model proposes, the deterministic core disposes"**. The LLM can *propose* a sensitive tool call. A deterministic gate node and a human approval, enforced by a Step Functions task token, decide whether it runs.

Reference pattern: <https://github.com/aws-samples/sample-durable-multi-agent-step-functions-agentcore>. Our version targets plain Lambda plus LangGraph.js instead of AgentCore, and ships as a reusable construct.

## What (v0.1 scope)

1. **Runtime package `@serverless-agent/runtime`** (ESM, TypeScript)
   - `DynamoDBSaver`: a LangGraph `BaseCheckpointSaver` on one DynamoDB table, with TTL. It passes the official `@langchain/langgraph-checkpoint-validation` suite against an in-memory fake (unit) and against LocalStack DynamoDB (integration).
   - An agent graph: a `model` node, then a deterministic `gate` node, then a `tools` node. Tools named in `toolsRequiringApproval` trigger LangGraph `interrupt()`. Unknown tools and malformed approvals are rejected (fail closed).
   - Lambda handlers: `agentStep`, `requestApproval` (waitForTaskToken target), `approvalCallback` (HTTPS), `wsHandler` (WebSocket).
   - A pluggable model factory: Bedrock `ChatBedrockConverse` by default, plus OpenAI-compatible `ChatOpenAI` with `baseURL` (Ollama locally, `mock-llm` on LocalStack).
   - Cost-per-step metrics as CloudWatch EMF lines, using configured prices. These are labelled estimates.
2. **Construct package `@serverless-agent/construct`** (CommonJS, jsii-compatible public API; jsii compile is deferred, ADR 0001)
   - DynamoDB table: on-demand, TTL `expiresAt`, PITR, retained by default.
   - Lambda functions (Node 24 arm64 by default; runtime and architecture are configurable) sharing one esbuild-prebundled asset.
   - Step Functions Standard: `RunAgent → NeedsApproval? → WaitForApproval (lambda:invoke.waitForTaskToken, timeout) → RunAgent …`.
   - API Gateway WebSocket API with IAM auth on `$connect`, for run start and token streaming. Optional via `webSocketApi: false`.
   - API Gateway REST API `POST /approvals/{approvalId}`: a single-use 256-bit capability URL, stored only as a SHA-256 hash. Throttled.
   - `AgentModel.bedrock()` / `AgentModel.openAiCompatible()` with least-privilege grants.
   - Cost allocation tags on every taggable resource.
3. **Example app `examples/basic`** with two stacks. Both `cdk synth` with no AWS credentials.
   - `ServerlessAgentExample`: full and AWS-shaped.
   - `ServerlessAgentLocal`: no WebSocket API, x86_64, Node 22, mock LLM, bootstrap-free synthesizer. It deploys to LocalStack with an AWS SDK script.
4. **LocalStack integration environment** (user rule, ADR 0009)
   - `docker-compose.yml` runs `localstack` on `127.0.0.1:4566` and a deterministic OpenAI-compatible `mock-llm`.
   - `packages/integration` tests against LocalStack cover:
     - **checkpointer:** the official conformance suite on LocalStack DynamoDB;
     - **invoke path:** Lambda `Invoke` of `agentStep`, covering both completed and interrupted results;
     - **Step Functions approval callback:** through the REST endpoint, for approve and reject to `SUCCEEDED`, plus single-use.
   - LocalStack 2026.03+ requires `LOCALSTACK_AUTH_TOKEN`. It is read from the environment and never committed. The free Hobby plan (non-commercial) covers every service the local stack uses. HTTP/WebSocket APIs, ECR and Bedrock are not in Hobby, so the local stack avoids them.
5. **Docs**: README (headline number labelled as an estimate, mermaid diagram, usage), ADRs, `docs/cost-estimate.md`, `docs/DEVDOCS.md`, `docs/handoff.md`, and a CI workflow.

## Non-goals (v0.1)

- No real AWS deploy. No credentials exist here, and the AWS CLI and global CDK are not installed. Against AWS, only `cdk synth` runs. Deploys go to LocalStack only.
- No jsii compile, Construct Hub listing or npm publish (v0.2).
- No custom user graphs or tools via props. The runtime ships a demo graph with `get_current_time` and `send_email` (a stub).
- No S3 offload for checkpoints over 350 KB (`CheckpointTooLargeError`).
- No approver identity on the approval callback (capability URL only, ADR 0004).
- No per-thread run locking. Concurrent runs on one thread are unsupported and documented as such.

## Hard constraints

- `pnpm test` (unit) needs no AWS credentials, no network and no Docker.
- `pnpm test:integration` needs Docker, LocalStack on 4566, the `mock-llm` container and `LOCALSTACK_AUTH_TOKEN`. When those are missing it fails loudly. It never skips silently or fakes results.
- No `*` in any IAM action. `Resource: "*"` is allowed only for an allowlist of CloudWatch Logs delivery actions that Step Functions logging requires.
- Scale-to-zero: no provisioned concurrency, no VPC/NAT, DynamoDB PAY_PER_REQUEST, Step Functions STANDARD.
- Cost numbers are labelled **estimate** with dated assumptions.
- Use only local devDependencies (`pnpm exec cdk`). No global installs. Node 24, pnpm 9.12.
- No secrets in the repo.

## Acceptance criteria (v0.1 done)

1. `pnpm install && pnpm build && pnpm test` passes from a clean clone, offline after install.
2. The runtime unit tests include the conformance suite (green) plus graph, handler, metrics and config tests.
3. The construct tests prove that:
   - the table, the functions, the state machine, the WebSocket API and the REST API exist;
   - TTL is enabled on `expiresAt`;
   - `WaitForApproval` uses `lambda:invoke.waitForTaskToken` with a timeout and loops to `RunAgent`;
   - `$connect` uses `AWS_IAM`;
   - no IAM action contains `*`;
   - `Resource: "*"` appears only with allowlisted actions;
   - each function gets only its own grants;
   - the scale-to-zero invariants hold;
   - `webSocketApi: false` removes the WebSocket resources.
4. `pnpm synth` produces both `ServerlessAgentExample.template.json` and `ServerlessAgentLocal.template.json`.
5. With `LOCALSTACK_AUTH_TOKEN` set: `pnpm local:up && pnpm local:deploy && pnpm test:integration` passes. Without it, the blocker is recorded and not faked.
6. The README starts with a headline number labelled as an estimate, and has a mermaid diagram, a usage snippet and ADR links.
7. `docs/handoff.md` has a Claude entry that says the real AWS deploy has not been done.
