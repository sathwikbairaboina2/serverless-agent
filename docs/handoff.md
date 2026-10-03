# Handoff log: serverless-agent

## 2026-10-03 · Claude (Opus, planner) · branch main (nothing committed)

**Changed:**
- Created the repo (`git init -b main`).
- Wrote the spec `docs/superpowers/specs/2026-10-03-serverless-agent.md`.
- Wrote ADRs `docs/adr/0001`–`0009`.
- Wrote the 30-task TDD plan `docs/superpowers/plans/2026-10-03-serverless-agent.md`.
- Wrote the developer docs `docs/DEVDOCS.md`.
- No code yet.

**Verified facts used by the plan:**
- Library APIs and versions came from the npm registry and unpkg on 2026-10-03:
  - `BaseCheckpointSaver` 1.1.5 has async serde;
  - `@langchain/langgraph-checkpoint-validation` 1.1.1 exposes `validate()` and depends on vitest ^4.1.10;
  - aws-cdk-lib 2.272.0 has `NODEJS_24_X` and `grantTaskResponse`.
- LocalStack facts came from the official docs and licensing table (ADR 0009):
  - an auth token has been mandatory since 2026.03.0;
  - the Hobby plan is free for non-commercial use;
  - Hobby includes Lambda, DynamoDB, Step Functions, REST API Gateway, CloudFormation, S3, IAM, Secrets Manager and Logs;
  - Hobby excludes HTTP/WebSocket API Gateway, ECR and Bedrock;
  - Lambda supports `.waitForTaskToken`;
  - `cdklocal` is deprecated.
- `LOCALSTACK_AUTH_TOKEN` is **not set** on this machine.

**Left:**
- Everything in the plan (Tasks 1–30).
- Real AWS deploy NOT done, by design: no credentials.
- LocalStack integration is blocked until a token is provided.
- Commits: the planner's attempt to commit the docs was denied by the permission system. All files are uncommitted, awaiting the user's decision.

**How to verify:** read the spec, then the ADRs, then the plan. The plan's "Final verification checklist" lists the exact commands.

## 2026-10-03 · Claude (builder, Sonnet) · branch main (nothing committed)

**Changed:**
- Runtime: `DynamoDBSaver` (with channel-blob storage, TTL, size guard), fake DynamoDB client, approval-gated graph, model factory, metrics, notifier, four Lambda handlers, optional Ollama runner (tasks 1-17, 27).
- Construct: `AgentModel`, `ServerlessAgent` (table, functions, state machine with `waitForTaskToken` loop, IAM-auth WebSocket API, throttled REST approval API), esbuild runtime bundle, IAM and scale-to-zero invariant tests (tasks 17-22).
- Example: `examples/basic` with `ServerlessAgentExample` and `ServerlessAgentLocal` (task 23).
- Local env: mock LLM, `docker-compose.yml`, `scripts/with-localstack-env.mjs`, `examples/basic/scripts/deploy-local.mjs`, `packages/integration` (tasks 24-26).
- Docs and CI: README, `docs/cost-estimate.md`, DEVDOCS results, ADR 0002 addendum, `.github/workflows/ci.yml` (tasks 28-30).
- The per-task ledger with rulings is in `.superpowers/sdd/progress.md`.

**Verified (2026-10-03, clean tree, real output in DEVDOCS section 14):**
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build` (bundle 2.25 MiB), `pnpm test` (25 files, 866 tests at that time; now 26 files/869: runtime 814 incl. conformance 718/718, construct 48, mock-llm 7) and `pnpm synth` (Example 40 resources / 46,111 bytes, Local 26 resources / 32,307 bytes) all exit 0.
- IAM wildcard check on both synthesized templates: no wildcard actions.
- `docker compose config` fails fast without a token and passes with a dummy token in the environment; the mock-llm container answered a health check; actionlint passed on the CI file.

**Not done / left:**
- Real AWS deploy NOT done (no credentials by design; synth + LocalStack only).
- LocalStack integration: BLOCKED: LOCALSTACK_AUTH_TOKEN not set (`pnpm test:integration` exit 2, "BLOCKER: LocalStack is not reachable at http://localhost:4566 (fetch failed)."). The deploy script and the three integration files have never run against LocalStack, so expect to fix emulation gaps (for example the REST invoke URL helper) on the first run.
- Nothing is committed: the permission system denied commits. The natural commit subjects are in the ledger and in DEVDOCS section 11.
- jsii/projen + Construct Hub publish (v0.2), custom user graphs/tools via props, S3 offload for >350 KB checkpoints, approver identity (Cognito/JWT), SNS/Slack approval notifier, per-thread run locking.

**Deviations from the plan (details in the ledger):**
- `DynamoDBSaver` stores channel values as separate blob items; the official suite fails otherwise. Unchanged-channel blobs get their TTL refreshed on each put (one UpdateItem per unchanged channel; fixed in review round 1).
- `APPROVAL_BASE_URL` is built from the REST API id, not `approvalApi.url`, to avoid a CloudFormation dependency cycle.
- Root `typecheck` builds first, because the example and integration packages resolve built `lib` output.
- Vitest `globals: true` in the runtime and integration configs (the validation package uses global `beforeAll`); construct vitest config is `.mts`.

**How to verify:** `pnpm install && pnpm build && pnpm test && pnpm synth`; with a token: `pnpm local:up && pnpm local:deploy && pnpm test:integration`.

## 2026-10-04 · Claude (Opus, lead) · branch main (committed locally, not pushed)

**Changed (finish run, plan `docs/superpowers/plans/2026-10-04-finish.md`):**
- Committed all v0.1 work as logical conventional commits on `main`. No remote, nothing pushed.
- Integration tests skip cleanly without `LOCALSTACK_AUTH_TOKEN` (SKIPPED, exit 0). With a token but no LocalStack they exit 2 with BLOCKER. `pnpm local:deploy` without a token exits 2 before building.
- Fixed the local Ollama runner crash on piped stdin (`ERR_USE_AFTER_CLOSE`).
- Added the MIT `LICENSE`. README now leads with the measured conformance result (718/718); cost stays a labelled estimate.
- Rewrote `docs/DEVDOCS.md` as a short developer guide (what it is, quickstart, architecture, layout, commands, decisions, limits).
- Note: two consecutive commits share the subject "docs: lead README with measured conformance result" (one is ledger-only). Left as is; no history rewrite.

**Verified (2026-10-04, Opus, real output):**
- `pnpm install --frozen-lockfile` 0; `pnpm typecheck` 0; `pnpm test` 0 with runtime 814 + construct 48 + mock-llm 7 = 869 tests; conformance file alone 718/718.
- `pnpm synth` 0: Example 40 resources, Local 26. IAM wildcard check: Example 40 actions `[]`, Local 35 actions `[]`.
- Token unset: `pnpm test:integration` 0 SKIPPED; integration package direct run 0 (3 files, 5 tests skipped); integration typecheck 0; `pnpm local:deploy` 2 with ERROR. `LOCALSTACK_AUTH_TOKEN=dummy pnpm test:integration` 2 with BLOCKER.
- No `serverless-agent-*` containers running. `git ls-files` has no build artifacts or secrets.

**Left for the user:**
- Get a free LocalStack Hobby token and run `pnpm local:up && pnpm local:deploy && pnpm test:integration` (never run; expect small emulation fixes).
- Real AWS deploy and measured latency/cost.
- npm scope, projen/jsii, npm and Construct Hub publish. Pushing to a remote.

**How to verify:** `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm synth && pnpm test:integration` (the last prints SKIPPED without a token). See `docs/DEVDOCS.md` section 5.
