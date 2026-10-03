# ServerlessAgent v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a TypeScript CDK v2 construct, `ServerlessAgent`, that deploys a LangGraph.js agent on Lambda. It includes a DynamoDB checkpointer, Step Functions `waitForTaskToken` human approval, WebSocket token streaming and estimated cost-per-run metrics. It is proven by offline unit tests, `cdk synth`, and LocalStack integration tests.

**Architecture:** A pnpm workspace with these parts:
- `packages/runtime` (ESM): the `DynamoDBSaver`, the agent graph with a deterministic approval gate, and the Lambda handlers.
- `packages/construct` (CommonJS, jsii-compatible API): the CDK construct. It consumes an esbuild bundle of the runtime as a Lambda asset. Approvals go through a REST API endpoint.
- `examples/basic`: two stacks, one AWS-shaped and one for LocalStack.
- `docker/mock-llm`: a deterministic OpenAI-compatible mock.
- `packages/integration`: tests against LocalStack in Docker.

Every run is a Step Functions Standard execution: `RunAgent → NeedsApproval? → WaitForApproval (task token) → RunAgent`.

**Tech Stack:**
- Node 24, pnpm 9.12.0, TypeScript 5.9.3, Vitest 4.1.11
- aws-cdk-lib 2.272.0, aws-cdk 2.1144.0
- @langchain/langgraph 1.4.18, @langchain/langgraph-checkpoint 1.1.5, @langchain/core 1.2.14, @langchain/aws 1.4.6, @langchain/openai 1.6.2
- @langchain/langgraph-checkpoint-validation 1.1.1
- AWS SDK v3, esbuild 0.28.2, zod 3.25.x, fflate (zip for the local deploy)
- LocalStack (Docker) on port 4566, deployed with an AWS SDK script (no bootstrap, no ECR, no cdklocal; ADR 0009)

**Spec:** `docs/superpowers/specs/2026-10-03-serverless-agent.md`. Decisions are in `docs/adr/0001`–`0009`. Developer docs are in `docs/DEVDOCS.md`. Read the spec and ADR 0002, 0004 and 0009 before starting.

**Status at plan time:** No code has been written. The repo has `git init -b main`, docs and ADRs only. Every task below is still to do.

## Global Constraints

- Repo root: `C:\Users\sathwik\projects\taskarinchu\serverless-agent`. Edit nothing outside it.
- Never deploy to real AWS. Never install anything globally. Use `pnpm exec cdk` from devDependencies only. Local deploys go to LocalStack through `scripts/with-localstack-env.mjs`, which forces the endpoint and `test` credentials.
- Pin these exact versions: `typescript@5.9.3`, `vitest@4.1.11`, `aws-cdk-lib@2.272.0`, `constructs@10.8.1`, `aws-cdk@2.1144.0`, `esbuild@0.28.2`, `@langchain/core@1.2.14`, `@langchain/langgraph@1.4.18`, `@langchain/langgraph-checkpoint@1.1.5`, `@langchain/langgraph-checkpoint-validation@1.1.1`, `@langchain/aws@1.4.6`, `@langchain/openai@1.6.2`, `zod@3.25.76`.
- Do not use Vitest 5 (ADR 0007). Do not use TypeScript 7.
- `pnpm test` must pass with no network, no Docker and no AWS credentials. Only `pnpm test:integration` may need Docker and LocalStack.
- Runtime package: ESM (`"type": "module"`, `module: NodeNext`). **Every relative import ends in `.js`**, even from `.ts` files.
- Construct package: CommonJS (`module: Node16`, no `"type"` field).
- Construct public API stays jsii-compatible:
  - `interface` props with `readonly` fields;
  - no union types or type aliases in exported signatures;
  - no `any` in public signatures.
- IAM: no action containing `*`. `Resource: "*"` only for the allowlist in Task 22.
- Every cost number in docs is labelled **estimate** with its assumptions.
- No secrets in the repo. `LOCALSTACK_AUTH_TOKEN` comes from the environment only.
- Commits: one small commit per task with the subject given in the task, ending with a blank line and then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. **Only commit if your dispatcher explicitly authorizes commits. Otherwise leave changes uncommitted and list them in your report.** Never push, never squash, never amend.
- Windows host: run commands from Git Bash or PowerShell. All `package.json` scripts must be cross-platform: no inline `VAR=x cmd`, use the node wrapper scripts defined below.

## Review Focus

Five input classes the spec implies but a happy-path test would miss. Each one has a test in its owning task.

1. **Paginated DynamoDB results.** History longer than one page must still list and delete correctly (`LastEvaluatedKey` loops). Task 4 and Task 5 run tests with `maxPageSize: 2`.
2. **Malformed or hostile approval input.** A non-`true` `approved`, an unknown `decision`, a reused approval id, an expired id or a non-JSON body must fail closed and must not consume the approval. Tests are in Task 12 (gate) and Task 15 (callback).
3. **The model calls an unknown tool or mixes safe and sensitive tools.** No tool executes without approval when any sensitive call is present, and unknown tools never execute. Task 12.
4. **The WebSocket client is gone (`GoneException`) or there is no connection id.** The run must still complete. Task 9 and Task 13.
5. **Key characters and size limits.** A `#` in `thread_id`/`checkpoint_ns`, an invalid `threadId` from the client, and a checkpoint over 350 KB all throw clear errors, not silent corruption. Tasks 3, 6 and 16.

---

## File Structure

```
serverless-agent/
  package.json                      # workspace root scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore  .npmrc  .env.example
  docker-compose.yml                # localstack + mock-llm (Task 24)
  docker/mock-llm/{package.json,server.mjs,script.mjs,server.test.mjs}  # deterministic OpenAI-compatible mock (Task 24)
  scripts/with-localstack-env.mjs   # forces LocalStack endpoint/test creds, health check, spawns a command (Task 25)
  .github/workflows/ci.yml          # Task 29
  packages/runtime/
    package.json tsconfig.json tsconfig.build.json vitest.config.ts
    src/index.ts                                # public exports
    src/checkpointer/dynamodb-saver.ts          # DynamoDBSaver (Tasks 3-6)
    src/checkpointer/errors.ts                  # CheckpointTooLargeError, InvalidKeyError
    src/agent/graph.ts                          # buildAgentGraph + types (Task 12)
    src/agent/tools.ts                          # demo tools (Task 12)
    src/agent/model.ts                          # createChatModel (Task 11)
    src/metrics.ts                              # cost + EMF (Task 8)
    src/notify.ts                               # Notifier, ApiGatewayNotifier, NullNotifier, TokenBatcher (Task 9)
    src/config.ts                               # env parsing (Task 10)
    src/handlers/agent-step.ts                  # Task 13
    src/handlers/request-approval.ts            # Task 14
    src/handlers/approval-callback.ts           # Task 15 (REST API proxy event)
    src/handlers/websocket.ts                   # Task 16
    src/handlers/index.ts                       # Lambda entrypoints wiring env -> deps (Task 17)
    src/local/chat.ts                           # optional local runner against Ollama (Task 27)
    test/support/fake-document-client.ts        # Task 2
    test/support/scripted-model.ts              # Task 12
    test/support/recording-notifier.ts          # Task 9
    test/**/*.test.ts
  packages/construct/
    package.json tsconfig.json tsconfig.build.json vitest.config.ts
    scripts/bundle-runtime.mjs                  # Task 17
    src/index.ts src/agent-model.ts src/serverless-agent.ts src/runtime-code.ts
    test/*.test.ts  test/support/template-helpers.ts
  packages/integration/                         # Task 26
    package.json tsconfig.json vitest.config.ts
    test/support/localstack.ts
    test/checkpointer.int.test.ts test/invoke.int.test.ts test/approval-flow.int.test.ts
  examples/basic/
    package.json tsconfig.json cdk.json bin/app.ts   # Task 23
    scripts/deploy-local.mjs                         # SDK deploy to LocalStack (Task 25)
  docs/ README.md docs/cost-estimate.md docs/handoff.md docs/DEVDOCS.md
```

---

### Task 1: Scaffold the pnpm workspace

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.npmrc`, `.env.example`
- Create: `packages/runtime/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,src/index.ts,test/smoke.test.ts}`
- Create: `packages/construct/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,src/index.ts,test/smoke.test.ts}`

**Interfaces:** Produces the workspace that every later task uses. Root scripts are `build`, `test`, `typecheck`, `synth`, `local:up`, `local:down`, `local:deploy` and `test:integration`. The last four are added in Tasks 24–26.

This task is configuration, so TDD does not apply. The smoke tests below prove the toolchain works.

- [ ] **Step 1: Write the root files**

`package.json`:
```json
{
  "name": "serverless-agent-monorepo",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r --workspace-concurrency=1 run build",
    "test": "pnpm -r --workspace-concurrency=1 --filter \"!@serverless-agent/integration-tests\" run test",
    "typecheck": "pnpm -r run typecheck",
    "synth": "pnpm --filter @serverless-agent/example-basic run synth"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "examples/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "forceConsistentCasingInFileNames": true,
    "noUnusedLocals": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "types": ["node"]
  }
}
```

`.gitignore`:
```
node_modules/
lib/
cdk.out/
coverage/
*.tsbuildinfo
packages/construct/assets/
examples/basic/cdk.local-outputs.json
.env
.env.*
!.env.example
```

`.npmrc`:
```
auto-install-peers=true
strict-peer-dependencies=false
```

`.env.example` (documentation only; never put real values here):
```
# LocalStack 2026.03+ requires an auth token (free Hobby plan works for non-commercial use).
# Export it in your shell; do NOT commit a real value.
LOCALSTACK_AUTH_TOKEN=
```

- [ ] **Step 2: Write the runtime package skeleton**

`packages/runtime/package.json`:
```json
{
  "name": "@serverless-agent/runtime",
  "version": "0.1.0",
  "description": "LangGraph.js runtime for ServerlessAgent: DynamoDB checkpointer, approval-gated agent graph, Lambda handlers.",
  "license": "MIT",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" } },
  "files": ["lib"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "local": "tsx src/local/chat.ts"
  }
}
```

`packages/runtime/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "rootDir": ".", "noEmit": true },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/runtime/tsconfig.build.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "rootDir": "src", "outDir": "lib" },
  "include": ["src"],
  "exclude": ["src/local"]
}
```

`packages/runtime/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 20_000 },
});
```

`packages/runtime/src/index.ts`:
```ts
export const RUNTIME_VERSION = '0.1.0';
```

`packages/runtime/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { RUNTIME_VERSION } from '../src/index.js';

describe('runtime package', () => {
  it('exposes its version', () => {
    expect(RUNTIME_VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 3: Write the construct package skeleton**

`packages/construct/package.json`:
```json
{
  "name": "@serverless-agent/construct",
  "version": "0.1.0",
  "description": "AWS CDK construct: LangGraph.js agent on Lambda with DynamoDB checkpoints, Step Functions human approval and WebSocket streaming.",
  "license": "MIT",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "assets"],
  "keywords": ["aws-cdk", "cdk-construct", "langgraph", "agent", "lambda", "step-functions", "dynamodb"],
  "scripts": {
    "bundle": "node scripts/bundle-runtime.mjs",
    "build": "pnpm run bundle && tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "pnpm run bundle && vitest run"
  },
  "peerDependencies": { "aws-cdk-lib": "^2.272.0", "constructs": "^10.0.0" }
}
```
(Task 17 creates `scripts/bundle-runtime.mjs`. Until then, temporarily set `"test": "vitest run"` and `"build": "tsc -p tsconfig.build.json"`. Task 17 restores the bundle step.)

`packages/construct/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "Node16", "moduleResolution": "Node16", "rootDir": ".", "noEmit": true },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/construct/tsconfig.build.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "Node16", "moduleResolution": "Node16", "rootDir": "src", "outDir": "lib" },
  "include": ["src"]
}
```

`packages/construct/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
});
```

`packages/construct/src/index.ts`:
```ts
export const CONSTRUCT_VERSION = '0.1.0';
```

`packages/construct/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CONSTRUCT_VERSION } from '../src';

describe('construct package', () => {
  it('exposes its version', () => {
    expect(CONSTRUCT_VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 4: Install dependencies (pinned)**

Run from the repo root:
```bash
pnpm --filter @serverless-agent/runtime add @langchain/core@1.2.14 @langchain/langgraph@1.4.18 @langchain/langgraph-checkpoint@1.1.5 @langchain/aws@1.4.6 @langchain/openai@1.6.2 @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-sfn @aws-sdk/client-apigatewaymanagementapi @aws-sdk/client-secrets-manager zod@3.25.76
pnpm --filter @serverless-agent/runtime add -D typescript@5.9.3 vitest@4.1.11 @langchain/langgraph-checkpoint-validation@1.1.1 @types/node@24 @types/aws-lambda tsx
pnpm --filter @serverless-agent/construct add -D aws-cdk-lib@2.272.0 constructs@10.8.1 esbuild@0.28.2 typescript@5.9.3 vitest@4.1.11 @types/node@24 "@serverless-agent/runtime@workspace:*"
```
Expected: the installs succeed and `pnpm-lock.yaml` is created.

- [ ] **Step 5: Verify that only one Vitest is installed, then run the smoke tests**

Run: `pnpm why vitest -r`
Expected: only `vitest 4.1.11` (the validation package must resolve to the same copy). If two versions appear, add `"pnpm": { "overrides": { "vitest": "4.1.11" } }` to the root `package.json` and reinstall.

Run: `pnpm test`
Expected: 2 test files pass (`runtime package > exposes its version` and `construct package > exposes its version`).

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace for runtime and construct packages"
```

**Acceptance:** `pnpm test` and `pnpm typecheck` both pass. There is exactly one Vitest version, and the lockfile exists.

---

### Task 2: In-memory DynamoDB document client fake

**Files:**
- Create: `packages/runtime/test/support/fake-document-client.ts`
- Test: `packages/runtime/test/support/fake-document-client.test.ts`

**Interfaces:**
- Produces `class FakeDocumentClient` with:
  - `constructor(opts?: { maxPageSize?: number; unprocessedOnFirstBatch?: boolean })`
  - `send(command: unknown): Promise<any>`
  - `items: Map<string, Record<string, unknown>>`
  - `allItems(): Record<string, unknown>[]`
  - `putRaw(item: Record<string, unknown>): void`
- Produces the exported type `DocumentClientLike = { send(command: any): Promise<any> }`. It is re-declared in the saver (Task 3), so tests and production use the same structural type.
- Supported commands: `GetCommand`, `PutCommand`, `DeleteCommand`, `QueryCommand`, `ScanCommand`, `BatchWriteCommand` from `@aws-sdk/lib-dynamodb`.
- Supported expressions (exact strings, anything else throws `FakeDocumentClient: unsupported ...`):
  - KeyCondition: `#pk = :pk` or `#pk = :pk AND begins_with(#sk, :skPrefix)`
  - Scan filter: `begins_with(#sk, :skPrefix)`
  - Condition: `attribute_not_exists(#sk)`, `attribute_not_exists(#pk)` or `attribute_exists(#pk)`
  - `ExpressionAttributeNames` must map `#pk → pk` and `#sk → sk` when they are used.

This is test infrastructure, but it has behavior the saver relies on, so it gets its own tests first.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/support/fake-document-client.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { FakeDocumentClient } from './fake-document-client.js';

const T = 'table';
const names = { '#pk': 'pk', '#sk': 'sk' };

describe('FakeDocumentClient', () => {
  it('puts and gets an item by key', async () => {
    const c = new FakeDocumentClient();
    await c.send(new PutCommand({ TableName: T, Item: { pk: 'a', sk: '1', v: new Uint8Array([1, 2]) } }));
    const out = await c.send(new GetCommand({ TableName: T, Key: { pk: 'a', sk: '1' } }));
    expect(out.Item).toEqual({ pk: 'a', sk: '1', v: new Uint8Array([1, 2]) });
  });

  it('rejects undefined attribute values like the real marshaller', async () => {
    const c = new FakeDocumentClient();
    await expect(c.send(new PutCommand({ TableName: T, Item: { pk: 'a', sk: '1', x: undefined } }))).rejects.toThrow(/undefined/);
  });

  it('queries by prefix in descending order with pagination', async () => {
    const c = new FakeDocumentClient({ maxPageSize: 2 });
    for (const sk of ['cp##1', 'cp##2', 'cp##3', 'wr##1']) c.putRaw({ pk: 't', sk });
    const input = {
      TableName: T,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ':pk': 't', ':skPrefix': 'cp#' },
      ScanIndexForward: false,
    };
    const page1 = await c.send(new QueryCommand(input));
    expect(page1.Items.map((i: { sk: string }) => i.sk)).toEqual(['cp##3', 'cp##2']);
    expect(page1.LastEvaluatedKey).toEqual({ pk: 't', sk: 'cp##2' });
    const page2 = await c.send(new QueryCommand({ ...input, ExclusiveStartKey: page1.LastEvaluatedKey }));
    expect(page2.Items.map((i: { sk: string }) => i.sk)).toEqual(['cp##1']);
    expect(page2.LastEvaluatedKey).toBeUndefined();
  });

  it('honours Limit', async () => {
    const c = new FakeDocumentClient();
    for (const sk of ['cp##1', 'cp##2']) c.putRaw({ pk: 't', sk });
    const out = await c.send(new QueryCommand({
      TableName: T, KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': 't' }, ScanIndexForward: false, Limit: 1,
    }));
    expect(out.Items).toHaveLength(1);
    expect(out.Items[0].sk).toBe('cp##2');
  });

  it('throws on expressions it does not understand', async () => {
    const c = new FakeDocumentClient();
    await expect(c.send(new QueryCommand({
      TableName: T, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 't' },
    }))).rejects.toThrow(/unsupported/);
  });

  it('enforces attribute_not_exists conditions with ConditionalCheckFailedException', async () => {
    const c = new FakeDocumentClient();
    const put = () => c.send(new PutCommand({ TableName: T, Item: { pk: 'a', sk: '1' }, ConditionExpression: 'attribute_not_exists(#sk)', ExpressionAttributeNames: { '#sk': 'sk' } }));
    await put();
    await expect(put()).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('deletes with attribute_exists and returns ALL_OLD', async () => {
    const c = new FakeDocumentClient();
    c.putRaw({ pk: 'a', sk: '1', token: 'x' });
    const del = () => c.send(new DeleteCommand({ TableName: T, Key: { pk: 'a', sk: '1' }, ConditionExpression: 'attribute_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' }, ReturnValues: 'ALL_OLD' }));
    expect((await del()).Attributes).toEqual({ pk: 'a', sk: '1', token: 'x' });
    await expect(del()).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('scans with a begins_with filter across partitions', async () => {
    const c = new FakeDocumentClient();
    c.putRaw({ pk: 'a', sk: 'cp##1' });
    c.putRaw({ pk: 'b', sk: 'cp##1' });
    c.putRaw({ pk: 'approval#x', sk: 'approval' });
    const out = await c.send(new ScanCommand({ TableName: T, FilterExpression: 'begins_with(#sk, :skPrefix)', ExpressionAttributeNames: { '#sk': 'sk' }, ExpressionAttributeValues: { ':skPrefix': 'cp#' } }));
    expect(out.Items).toHaveLength(2);
  });

  it('batch-deletes and can report unprocessed items once', async () => {
    const c = new FakeDocumentClient({ unprocessedOnFirstBatch: true });
    c.putRaw({ pk: 'a', sk: '1' });
    c.putRaw({ pk: 'a', sk: '2' });
    const req = { RequestItems: { [T]: [{ DeleteRequest: { Key: { pk: 'a', sk: '1' } } }, { DeleteRequest: { Key: { pk: 'a', sk: '2' } } }] } };
    const first = await c.send(new BatchWriteCommand(req));
    expect(first.UnprocessedItems[T]).toHaveLength(2);
    expect(c.items.size).toBe(2);
    const second = await c.send(new BatchWriteCommand(req));
    expect(second.UnprocessedItems).toEqual({});
    expect(c.items.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/support/fake-document-client.test.ts`
Expected: FAIL, `Failed to resolve import "./fake-document-client.js"`.

- [ ] **Step 3: Implement the fake**

`packages/runtime/test/support/fake-document-client.ts`:
```ts
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

export type Item = Record<string, unknown>;
export interface DocumentClientLike { send(command: any): Promise<any> }

const KEY_ONLY = '#pk = :pk';
const KEY_PREFIX = '#pk = :pk AND begins_with(#sk, :skPrefix)';
const FILTER_PREFIX = 'begins_with(#sk, :skPrefix)';

function conditionalFailed(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

function keyOf(pk: unknown, sk: unknown): string {
  return `${String(pk)}\u0000${String(sk)}`;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function checkNames(names: Record<string, string> | undefined, used: string[]): void {
  for (const n of used) {
    const expected = n === '#pk' ? 'pk' : 'sk';
    if (names?.[n] !== expected) throw new Error(`FakeDocumentClient: unsupported ExpressionAttributeNames (need ${n} -> ${expected})`);
  }
}

export class FakeDocumentClient implements DocumentClientLike {
  readonly items = new Map<string, Item>();
  private readonly maxPageSize: number;
  private unprocessedPending: boolean;

  constructor(opts: { maxPageSize?: number; unprocessedOnFirstBatch?: boolean } = {}) {
    this.maxPageSize = opts.maxPageSize ?? Number.MAX_SAFE_INTEGER;
    this.unprocessedPending = opts.unprocessedOnFirstBatch ?? false;
  }

  allItems(): Item[] {
    return [...this.items.values()].map(clone);
  }

  putRaw(item: Item): void {
    this.items.set(keyOf(item.pk, item.sk), clone(item));
  }

  async send(command: unknown): Promise<any> {
    if (command instanceof GetCommand) return this.get(command.input as any);
    if (command instanceof PutCommand) return this.put(command.input as any);
    if (command instanceof DeleteCommand) return this.delete(command.input as any);
    if (command instanceof QueryCommand) return this.query(command.input as any);
    if (command instanceof ScanCommand) return this.scan(command.input as any);
    if (command instanceof BatchWriteCommand) return this.batchWrite(command.input as any);
    throw new Error(`FakeDocumentClient: unsupported command ${(command as object)?.constructor?.name}`);
  }

  private get(input: { Key: Item }) {
    const found = this.items.get(keyOf(input.Key.pk, input.Key.sk));
    return { Item: found ? clone(found) : undefined };
  }

  private checkCondition(expr: string | undefined, names: Record<string, string> | undefined, existing: Item | undefined): void {
    if (expr === undefined) return;
    if (expr === 'attribute_not_exists(#sk)') { checkNames(names, ['#sk']); if (existing) throw conditionalFailed(); return; }
    if (expr === 'attribute_not_exists(#pk)') { checkNames(names, ['#pk']); if (existing) throw conditionalFailed(); return; }
    if (expr === 'attribute_exists(#pk)') { checkNames(names, ['#pk']); if (!existing) throw conditionalFailed(); return; }
    throw new Error(`FakeDocumentClient: unsupported ConditionExpression "${expr}"`);
  }

  private put(input: { Item: Item; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string> }) {
    for (const [k, v] of Object.entries(input.Item)) {
      if (v === undefined) throw new Error(`FakeDocumentClient: attribute "${k}" is undefined (real client throws unless removeUndefinedValues)`);
    }
    if (typeof input.Item.pk !== 'string' || typeof input.Item.sk !== 'string') throw new Error('FakeDocumentClient: pk and sk must be strings');
    const key = keyOf(input.Item.pk, input.Item.sk);
    this.checkCondition(input.ConditionExpression, input.ExpressionAttributeNames, this.items.get(key));
    this.items.set(key, clone(input.Item));
    return {};
  }

  private delete(input: { Key: Item; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ReturnValues?: string }) {
    const key = keyOf(input.Key.pk, input.Key.sk);
    const existing = this.items.get(key);
    this.checkCondition(input.ConditionExpression, input.ExpressionAttributeNames, existing);
    this.items.delete(key);
    return { Attributes: input.ReturnValues === 'ALL_OLD' && existing ? clone(existing) : undefined };
  }

  private page(sorted: Item[], limit: number | undefined, startKey: Item | undefined) {
    let start = 0;
    if (startKey) {
      const idx = sorted.findIndex((i) => i.pk === startKey.pk && i.sk === startKey.sk);
      start = idx + 1;
    }
    const size = Math.min(limit ?? Number.MAX_SAFE_INTEGER, this.maxPageSize);
    const slice = sorted.slice(start, start + size);
    const more = start + size < sorted.length;
    const last = slice.at(-1);
    return {
      Items: slice.map(clone),
      Count: slice.length,
      LastEvaluatedKey: more && last ? { pk: last.pk, sk: last.sk } : undefined,
    };
  }

  private query(input: {
    KeyConditionExpression: string; ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues: Item; ScanIndexForward?: boolean; Limit?: number; ExclusiveStartKey?: Item;
  }) {
    const expr = input.KeyConditionExpression;
    let prefix: string | undefined;
    if (expr === KEY_ONLY) checkNames(input.ExpressionAttributeNames, ['#pk']);
    else if (expr === KEY_PREFIX) { checkNames(input.ExpressionAttributeNames, ['#pk', '#sk']); prefix = String(input.ExpressionAttributeValues[':skPrefix']); }
    else throw new Error(`FakeDocumentClient: unsupported KeyConditionExpression "${expr}"`);
    const pk = input.ExpressionAttributeValues[':pk'];
    const matching = [...this.items.values()]
      .filter((i) => i.pk === pk && (prefix === undefined || String(i.sk).startsWith(prefix)))
      .sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : String(a.sk) > String(b.sk) ? 1 : 0));
    if (input.ScanIndexForward === false) matching.reverse();
    return this.page(matching, input.Limit, input.ExclusiveStartKey);
  }

  private scan(input: { FilterExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Item; ExclusiveStartKey?: Item }) {
    let prefix: string | undefined;
    if (input.FilterExpression !== undefined) {
      if (input.FilterExpression !== FILTER_PREFIX) throw new Error(`FakeDocumentClient: unsupported FilterExpression "${input.FilterExpression}"`);
      checkNames(input.ExpressionAttributeNames, ['#sk']);
      prefix = String(input.ExpressionAttributeValues?.[':skPrefix']);
    }
    const all = [...this.items.values()].sort((a, b) => (keyOf(a.pk, a.sk) < keyOf(b.pk, b.sk) ? -1 : 1));
    const pageOut = this.page(all, undefined, input.ExclusiveStartKey);
    // Real Scan applies the filter after reading the page; mimic that.
    pageOut.Items = pageOut.Items.filter((i) => prefix === undefined || String(i.sk).startsWith(prefix));
    pageOut.Count = pageOut.Items.length;
    return pageOut;
  }

  private batchWrite(input: { RequestItems: Record<string, Array<{ PutRequest?: { Item: Item }; DeleteRequest?: { Key: Item } }>> }) {
    const entries = Object.entries(input.RequestItems);
    const total = entries.reduce((n, [, reqs]) => n + reqs.length, 0);
    if (total > 25) throw new Error('FakeDocumentClient: BatchWrite accepts at most 25 requests');
    if (this.unprocessedPending) {
      this.unprocessedPending = false;
      return { UnprocessedItems: clone(input.RequestItems) };
    }
    for (const [, reqs] of entries) {
      for (const r of reqs) {
        if (r.PutRequest) this.put({ Item: r.PutRequest.Item });
        else if (r.DeleteRequest) this.items.delete(keyOf(r.DeleteRequest.Key.pk, r.DeleteRequest.Key.sk));
      }
    }
    return { UnprocessedItems: {} };
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/support/fake-document-client.test.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/test/support
git commit -m "test(runtime): add in-memory DynamoDB document client fake"
```

**Acceptance:**
- All 9 fake tests pass.
- Unknown expressions throw.
- Pagination returns `LastEvaluatedKey`.

---

### Task 3: DynamoDBSaver put and getTuple

**Files:**
- Create: `packages/runtime/src/checkpointer/errors.ts`, `packages/runtime/src/checkpointer/dynamodb-saver.ts`
- Test: `packages/runtime/test/checkpointer/dynamodb-saver.test.ts`

**Interfaces:**
- Consumes `FakeDocumentClient` (Task 2).
- Produces:
```ts
export interface DocumentClientLike { send(command: any): Promise<any> }
export interface DynamoDBSaverOptions {
  client: DocumentClientLike;      // DynamoDBDocumentClient in prod
  tableName: string;
  ttlSeconds?: number;             // Task 6
  now?: () => number;              // epoch ms, default Date.now
  serde?: SerializerProtocol;
}
export class DynamoDBSaver extends BaseCheckpointSaver {
  constructor(opts: DynamoDBSaverOptions);
  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined>;
  list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple>; // Task 5
  put(config, checkpoint, metadata, newVersions): Promise<RunnableConfig>;
  putWrites(config, writes, taskId): Promise<void>;     // Task 4
  deleteThread(threadId: string): Promise<void>;        // Task 5
}
export class InvalidKeyError extends Error {}           // errors.ts
export class CheckpointTooLargeError extends Error {}   // errors.ts (Task 6)
```
- Key layout (ADR 0002):
  - checkpoint: `pk=<thread_id>`, `sk=cp#<ns>#<checkpoint_id>`;
  - write: `pk=<thread_id>`, `sk=wr#<ns>#<checkpoint_id>#<task_id>#<idx>`.
- Checkpoint item attributes: `pk, sk, kind:'checkpoint', threadId, checkpointNs, checkpointId, parentCheckpointId?, cpType, checkpoint (Uint8Array), mdType, metadata (Uint8Array), expiresAt?`.
- `serde.dumpsTyped` and `serde.loadsTyped` are **async** in `@langchain/langgraph-checkpoint` 1.x. Always `await` them.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/checkpointer/dynamodb-saver.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emptyCheckpoint, uuid6, type Checkpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { InvalidKeyError } from '../../src/checkpointer/errors.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return { ...emptyCheckpoint(), id: uuid6(-1), ...overrides };
}
const metadata: CheckpointMetadata = { source: 'input', step: -1, parents: {} } as CheckpointMetadata;

function makeSaver(client = new FakeDocumentClient()) {
  return { client, saver: new DynamoDBSaver({ client, tableName: 'checkpoints' }) };
}

describe('DynamoDBSaver put/getTuple', () => {
  it('returns undefined for an unknown thread', async () => {
    const { saver } = makeSaver();
    expect(await saver.getTuple({ configurable: { thread_id: 'nope' } })).toBeUndefined();
  });

  it('round-trips a checkpoint and returns the stored config', async () => {
    const { saver } = makeSaver();
    const cp = checkpoint({ channel_values: { messages: ['hi'] } });
    const cfg = await saver.put({ configurable: { thread_id: 't1', checkpoint_ns: '' } }, cp, metadata, {});
    expect(cfg).toEqual({ configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: cp.id } });
    const tuple = await saver.getTuple({ configurable: { thread_id: 't1' } });
    expect(tuple?.checkpoint.id).toBe(cp.id);
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['hi'] });
    expect(tuple?.metadata).toEqual(metadata);
    expect(tuple?.config.configurable?.checkpoint_id).toBe(cp.id);
  });

  it('returns the latest checkpoint when no checkpoint_id is given and links the parent', async () => {
    const { saver } = makeSaver();
    const first = checkpoint();
    const firstCfg = await saver.put({ configurable: { thread_id: 't1' } }, first, metadata, {});
    const second = checkpoint();
    await saver.put(firstCfg, second, metadata, {});
    const latest = await saver.getTuple({ configurable: { thread_id: 't1' } });
    expect(latest?.checkpoint.id).toBe(second.id);
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe(first.id);
  });

  it('fetches a specific checkpoint by id', async () => {
    const { saver } = makeSaver();
    const first = checkpoint();
    const firstCfg = await saver.put({ configurable: { thread_id: 't1' } }, first, metadata, {});
    await saver.put(firstCfg, checkpoint(), metadata, {});
    const tuple = await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_id: first.id } });
    expect(tuple?.checkpoint.id).toBe(first.id);
  });

  it('keeps namespaces separate', async () => {
    const { saver } = makeSaver();
    const root = checkpoint();
    await saver.put({ configurable: { thread_id: 't1', checkpoint_ns: '' } }, root, metadata, {});
    const child = checkpoint();
    await saver.put({ configurable: { thread_id: 't1', checkpoint_ns: 'sub:1' } }, child, metadata, {});
    expect((await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_ns: '' } }))?.checkpoint.id).toBe(root.id);
    expect((await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_ns: 'sub:1' } }))?.checkpoint.id).toBe(child.id);
  });

  it('stores bytes, not JSON strings, and never writes undefined attributes', async () => {
    const { saver, client } = makeSaver();
    await saver.put({ configurable: { thread_id: 't1' } }, checkpoint(), metadata, {});
    const [item] = client.allItems();
    expect(item.checkpoint).toBeInstanceOf(Uint8Array);
    expect(item.sk).toMatch(/^cp##/);
    expect(item).not.toHaveProperty('parentCheckpointId');
  });

  it('rejects # in thread_id or checkpoint_ns', async () => {
    const { saver } = makeSaver();
    await expect(saver.put({ configurable: { thread_id: 'a#b' } }, checkpoint(), metadata, {})).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(saver.put({ configurable: { thread_id: 't', checkpoint_ns: 'x#y' } }, checkpoint(), metadata, {})).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('requires thread_id on put', async () => {
    const { saver } = makeSaver();
    await expect(saver.put({ configurable: {} }, checkpoint(), metadata, {})).rejects.toThrow(/thread_id/);
  });
});
```
(`uuid6` is exported from `@langchain/langgraph-checkpoint`. If the import fails, import it from `@langchain/langgraph-checkpoint/dist/id.js` or use `import { v6 as uuid6 } from 'uuid'` after `pnpm --filter @serverless-agent/runtime add -D uuid`.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer/dynamodb-saver.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/checkpointer/dynamodb-saver.js"`.

- [ ] **Step 3: Implement the errors and the saver (put/getTuple only, stubs for the rest)**

`packages/runtime/src/checkpointer/errors.ts`:
```ts
export class InvalidKeyError extends Error {
  constructor(field: string, value: unknown) {
    super(`Invalid ${field} ${JSON.stringify(value)}: must be a string without "#" (max 512 chars)`);
    this.name = 'InvalidKeyError';
  }
}

export class CheckpointTooLargeError extends Error {
  constructor(bytes: number, limit: number) {
    super(`Serialized checkpoint is ${bytes} bytes; DynamoDBSaver limit is ${limit} bytes (DynamoDB items max 400 KB). Trim state or offload large values.`);
    this.name = 'CheckpointTooLargeError';
  }
}
```

`packages/runtime/src/checkpointer/dynamodb-saver.ts`:
```ts
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { InvalidKeyError } from './errors.js';

export interface DocumentClientLike { send(command: any): Promise<any> }

export interface DynamoDBSaverOptions {
  client: DocumentClientLike;
  tableName: string;
  ttlSeconds?: number;
  now?: () => number;
  serde?: SerializerProtocol;
}

type Item = Record<string, any>;

const NAMES_PK = { '#pk': 'pk' };
const NAMES_PK_SK = { '#pk': 'pk', '#sk': 'sk' };

export function assertKeyPart(field: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('#') || value.length > 512 || (!allowEmpty && value.length === 0)) {
    throw new InvalidKeyError(field, value);
  }
  return value;
}

export const cpPrefix = (ns: string) => `cp#${ns}#`;
export const cpSk = (ns: string, id: string) => `${cpPrefix(ns)}${id}`;
export const wrPrefix = (ns: string, id: string) => `wr#${ns}#${id}#`;
export const wrSk = (ns: string, id: string, taskId: string, idx: number) => `${wrPrefix(ns, id)}${taskId}#${idx}`;

export class DynamoDBSaver extends BaseCheckpointSaver {
  private readonly client: DocumentClientLike;
  private readonly tableName: string;
  private readonly ttlSeconds?: number;
  private readonly now: () => number;

  constructor(opts: DynamoDBSaverOptions) {
    super(opts.serde);
    this.client = opts.client;
    this.tableName = opts.tableName;
    this.ttlSeconds = opts.ttlSeconds;
    this.now = opts.now ?? Date.now;
  }

  /** Adds expiresAt when TTL is configured. Never emits undefined attributes. */
  protected withTtl(item: Item): Item {
    if (this.ttlSeconds && this.ttlSeconds > 0) item.expiresAt = Math.floor(this.now() / 1000) + this.ttlSeconds;
    return item;
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    if (config.configurable?.thread_id === undefined) throw new Error('DynamoDBSaver.put: config.configurable.thread_id is required');
    const threadId = assertKeyPart('thread_id', config.configurable.thread_id);
    const ns = assertKeyPart('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true);
    const id = assertKeyPart('checkpoint_id', checkpoint.id);
    const parent = config.configurable?.checkpoint_id as string | undefined;
    const [[cpType, cpBytes], [mdType, mdBytes]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    const item: Item = {
      pk: threadId, sk: cpSk(ns, id), kind: 'checkpoint',
      threadId, checkpointNs: ns, checkpointId: id,
      cpType, checkpoint: cpBytes, mdType, metadata: mdBytes,
    };
    if (parent) item.parentCheckpointId = parent;
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: this.withTtl(item) }));
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: id } };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const rawThread = config.configurable?.thread_id;
    if (rawThread === undefined) return undefined;
    const threadId = assertKeyPart('thread_id', rawThread);
    const ns = assertKeyPart('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true);
    const id = getCheckpointId(config);
    let item: Item | undefined;
    if (id) {
      const out = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: threadId, sk: cpSk(ns, assertKeyPart('checkpoint_id', id)) } }));
      item = out.Item;
    } else {
      const out = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
        ExpressionAttributeNames: NAMES_PK_SK,
        ExpressionAttributeValues: { ':pk': threadId, ':skPrefix': cpPrefix(ns) },
        ScanIndexForward: false,
        Limit: 1,
      }));
      item = out.Items?.[0];
    }
    return item ? this.toTuple(item) : undefined;
  }

  protected async toTuple(item: Item, preloadedMetadata?: CheckpointMetadata): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(item.cpType, item.checkpoint)) as Checkpoint;
    const metadata = preloadedMetadata ?? ((await this.serde.loadsTyped(item.mdType, item.metadata)) as CheckpointMetadata);
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: item.threadId, checkpoint_ns: item.checkpointNs, checkpoint_id: item.checkpointId } },
      checkpoint,
      metadata,
      pendingWrites: await this.loadWrites(item.threadId, item.checkpointNs, item.checkpointId),
    };
    if (item.parentCheckpointId) {
      tuple.parentConfig = { configurable: { thread_id: item.threadId, checkpoint_ns: item.checkpointNs, checkpoint_id: item.parentCheckpointId } };
    }
    return tuple;
  }

  /** Implemented in Task 4. */
  protected async loadWrites(_threadId: string, _ns: string, _checkpointId: string): Promise<CheckpointPendingWrite[]> {
    return [];
  }

  async *list(_config: RunnableConfig, _options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    throw new Error('not implemented (Task 5)');
  }

  async putWrites(_config: RunnableConfig, _writes: PendingWrite[], _taskId: string): Promise<void> {
    throw new Error('not implemented (Task 4)');
  }

  async deleteThread(_threadId: string): Promise<void> {
    throw new Error('not implemented (Task 5)');
  }
}

export { NAMES_PK };
```
If TypeScript reports that `CheckpointPendingWrite` or `SerializerProtocol` is not exported from the package root, import them from `@langchain/langgraph-checkpoint` sub-paths as the compiler suggests. Keep behavior identical.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer/dynamodb-saver.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/checkpointer packages/runtime/test/checkpointer
git commit -m "feat(runtime): persist LangGraph checkpoints to DynamoDB"
```

**Acceptance:**
- put and getTuple round-trip.
- The latest checkpoint and parent links work.
- Namespaces are isolated.
- `#` is rejected.
- No undefined attributes are written.

---

### Task 4: putWrites and pending writes on tuples

**Files:**
- Modify: `packages/runtime/src/checkpointer/dynamodb-saver.ts`
- Test: `packages/runtime/test/checkpointer/dynamodb-saver-writes.test.ts`

**Interfaces:**
- Write item attributes: `pk, sk, kind:'write', taskId, channel, idx (number), valueType, value (Uint8Array), expiresAt?`.
- `idx = WRITES_IDX_MAP[channel] ?? index`. A non-negative idx is first-writer-wins (`ConditionExpression: 'attribute_not_exists(#sk)'`, swallow `ConditionalCheckFailedException`). A negative idx (special channels such as errors and interrupts) overwrites.
- Order of `pendingWrites`: by `taskId`, then by numeric `idx` ascending.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/checkpointer/dynamodb-saver-writes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emptyCheckpoint, uuid6, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

const metadata = { source: 'loop', step: 0, parents: {} } as CheckpointMetadata;

async function setup(client = new FakeDocumentClient()) {
  const saver = new DynamoDBSaver({ client, tableName: 'checkpoints' });
  const cfg = await saver.put({ configurable: { thread_id: 't1' } }, { ...emptyCheckpoint(), id: uuid6(-1) }, metadata, {});
  return { saver, client, cfg };
}

describe('DynamoDBSaver putWrites', () => {
  it('attaches pending writes to the checkpoint tuple', async () => {
    const { saver, cfg } = await setup();
    await saver.putWrites(cfg, [['messages', { text: 'a' }], ['count', 2]], 'task-1');
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.pendingWrites).toEqual([
      ['task-1', 'messages', { text: 'a' }],
      ['task-1', 'count', 2],
    ]);
  });

  it('keeps the first write for a regular channel index (idempotent retries)', async () => {
    const { saver, cfg } = await setup();
    await saver.putWrites(cfg, [['messages', 'first']], 'task-1');
    await saver.putWrites(cfg, [['messages', 'second']], 'task-1');
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.pendingWrites).toEqual([['task-1', 'messages', 'first']]);
  });

  it('overwrites special channels such as __error__', async () => {
    const { saver, cfg } = await setup();
    await saver.putWrites(cfg, [['__error__', 'boom-1']], 'task-1');
    await saver.putWrites(cfg, [['__error__', 'boom-2']], 'task-1');
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.pendingWrites).toEqual([['task-1', '__error__', 'boom-2']]);
  });

  it('reads writes across multiple DynamoDB pages', async () => {
    const { saver, cfg } = await setup(new FakeDocumentClient({ maxPageSize: 2 }));
    await saver.putWrites(cfg, [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]], 'task-1');
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.pendingWrites?.map((w) => w[1])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('requires checkpoint_id', async () => {
    const { saver } = await setup();
    await expect(saver.putWrites({ configurable: { thread_id: 't1' } }, [['a', 1]], 'task-1')).rejects.toThrow(/checkpoint_id/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer/dynamodb-saver-writes.test.ts`
Expected: FAIL with `not implemented (Task 4)`.

- [ ] **Step 3: Implement putWrites, loadWrites and a paginated query helper**

Add `WRITES_IDX_MAP` to the `@langchain/langgraph-checkpoint` import. In `dynamodb-saver.ts`, replace the `loadWrites` and `putWrites` stubs and add `queryAll`:
```ts
  /** Async generator over every item of a Query, following LastEvaluatedKey. */
  protected async *queryAll(input: Record<string, unknown>): AsyncGenerator<Item> {
    let startKey: Item | undefined;
    do {
      const out = await this.client.send(new QueryCommand({ ...input, TableName: this.tableName, ExclusiveStartKey: startKey } as any));
      for (const item of out.Items ?? []) yield item;
      startKey = out.LastEvaluatedKey;
    } while (startKey);
  }

  protected async loadWrites(threadId: string, ns: string, checkpointId: string): Promise<CheckpointPendingWrite[]> {
    const items: Item[] = [];
    for await (const item of this.queryAll({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: NAMES_PK_SK,
      ExpressionAttributeValues: { ':pk': threadId, ':skPrefix': wrPrefix(ns, checkpointId) },
    })) items.push(item);
    items.sort((a, b) => (a.taskId === b.taskId ? a.idx - b.idx : a.taskId < b.taskId ? -1 : 1));
    return Promise.all(items.map(async (i) => [i.taskId, i.channel, await this.serde.loadsTyped(i.valueType, i.value)] as CheckpointPendingWrite));
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    if (config.configurable?.thread_id === undefined) throw new Error('DynamoDBSaver.putWrites: config.configurable.thread_id is required');
    if (config.configurable?.checkpoint_id === undefined) throw new Error('DynamoDBSaver.putWrites: config.configurable.checkpoint_id is required');
    const threadId = assertKeyPart('thread_id', config.configurable.thread_id);
    const ns = assertKeyPart('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true);
    const checkpointId = assertKeyPart('checkpoint_id', config.configurable.checkpoint_id);
    const task = assertKeyPart('task_id', taskId);
    await Promise.all(writes.map(async ([channel, value], index) => {
      const idx = WRITES_IDX_MAP[channel] ?? index;
      const [valueType, bytes] = await this.serde.dumpsTyped(value);
      const item = this.withTtl({ pk: threadId, sk: wrSk(ns, checkpointId, task, idx), kind: 'write', taskId: task, channel, idx, valueType, value: bytes });
      if (idx < 0) {
        await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
        return;
      }
      try {
        await this.client.send(new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(#sk)', ExpressionAttributeNames: { '#sk': 'sk' } }));
      } catch (err) {
        if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
      }
    }));
  }
```

- [ ] **Step 4: Run the tests and confirm they pass (new file plus Task 3 file)**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer`
Expected: 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/checkpointer packages/runtime/test/checkpointer
git commit -m "feat(runtime): store pending writes alongside DynamoDB checkpoints"
```

**Acceptance:**
- Pending writes round-trip in order.
- Regular channels are first-writer-wins.
- Special channels overwrite.
- Reads paginate.

---

### Task 5: list() and deleteThread()

**Files:**
- Modify: `packages/runtime/src/checkpointer/dynamodb-saver.ts`
- Test: `packages/runtime/test/checkpointer/dynamodb-saver-list.test.ts`

**Interfaces:**
- `list(config, { limit?, before?, filter? })` yields newest first.
  - With `thread_id`: Query with prefix `cp#<ns>#` if `checkpoint_ns` is given, else `cp#`.
  - Without `thread_id`: Scan with filter `begins_with(#sk, :skPrefix)` and `:skPrefix = 'cp#'`, then sort by `(pk, sk)` descending.
  - `filter` matches metadata keys with `util.isDeepStrictEqual`.
  - `before` excludes `checkpointId >= before.configurable.checkpoint_id`.
  - `config.configurable.checkpoint_id`, if present, restricts results to that id.
- `deleteThread(threadId)` queries `#pk = :pk` (all pages) and BatchWrite-deletes in chunks of 25. It retries `UnprocessedItems` up to 5 times with an `attempt * 50 ms` delay, then throws.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/checkpointer/dynamodb-saver-list.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emptyCheckpoint, uuid6, type CheckpointMetadata, type CheckpointTuple } from '@langchain/langgraph-checkpoint';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

async function collect(gen: AsyncGenerator<CheckpointTuple>) {
  const out: CheckpointTuple[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

async function seed(saver: DynamoDBSaver, threadId: string, n: number, ns = '') {
  const ids: string[] = [];
  let cfg = { configurable: { thread_id: threadId, checkpoint_ns: ns } } as any;
  for (let step = 0; step < n; step++) {
    const cp = { ...emptyCheckpoint(), id: uuid6(-1) };
    cfg = await saver.put(cfg, cp, { source: 'loop', step, parents: {} } as CheckpointMetadata, {});
    ids.push(cp.id);
  }
  return ids;
}

describe('DynamoDBSaver list', () => {
  it('lists a thread newest first across pages', async () => {
    const saver = new DynamoDBSaver({ client: new FakeDocumentClient({ maxPageSize: 2 }), tableName: 't' });
    const ids = await seed(saver, 't1', 5);
    const listed = await collect(saver.list({ configurable: { thread_id: 't1' } }));
    expect(listed.map((t) => t.checkpoint.id)).toEqual([...ids].reverse());
  });

  it('applies limit, before and metadata filter', async () => {
    const saver = new DynamoDBSaver({ client: new FakeDocumentClient(), tableName: 't' });
    const ids = await seed(saver, 't1', 4);
    expect((await collect(saver.list({ configurable: { thread_id: 't1' } }, { limit: 2 }))).map((t) => t.checkpoint.id)).toEqual([ids[3], ids[2]]);
    expect((await collect(saver.list({ configurable: { thread_id: 't1' } }, { before: { configurable: { checkpoint_id: ids[2] } } }))).map((t) => t.checkpoint.id)).toEqual([ids[1], ids[0]]);
    expect((await collect(saver.list({ configurable: { thread_id: 't1' } }, { filter: { step: 1 } }))).map((t) => t.checkpoint.id)).toEqual([ids[1]]);
  });

  it('restricts to a namespace when checkpoint_ns is given', async () => {
    const saver = new DynamoDBSaver({ client: new FakeDocumentClient(), tableName: 't' });
    await seed(saver, 't1', 2, '');
    const sub = await seed(saver, 't1', 1, 'child:1');
    const listed = await collect(saver.list({ configurable: { thread_id: 't1', checkpoint_ns: 'child:1' } }));
    expect(listed.map((t) => t.checkpoint.id)).toEqual(sub);
    expect(await collect(saver.list({ configurable: { thread_id: 't1' } }))).toHaveLength(3);
  });

  it('lists across threads with a scan when no thread_id is given, ignoring approval items', async () => {
    const client = new FakeDocumentClient();
    const saver = new DynamoDBSaver({ client, tableName: 't' });
    await seed(saver, 'a', 1);
    await seed(saver, 'b', 2);
    client.putRaw({ pk: 'approval#abc', sk: 'approval', taskToken: 'x' });
    expect(await collect(saver.list({}))).toHaveLength(3);
  });
});

describe('DynamoDBSaver deleteThread', () => {
  it('deletes every item of one thread across pages and batches, keeping other threads', async () => {
    const client = new FakeDocumentClient({ maxPageSize: 7, unprocessedOnFirstBatch: true });
    const saver = new DynamoDBSaver({ client, tableName: 't' });
    const ids = await seed(saver, 'gone', 30);
    await saver.putWrites({ configurable: { thread_id: 'gone', checkpoint_ns: '', checkpoint_id: ids[0] } }, [['a', 1]], 'task');
    await seed(saver, 'kept', 1);
    await saver.deleteThread('gone');
    expect(client.allItems().every((i) => i.pk === 'kept')).toBe(true);
    expect(client.allItems()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer/dynamodb-saver-list.test.ts`
Expected: FAIL with `not implemented (Task 5)`.

- [ ] **Step 3: Implement list and deleteThread**

Add `import { isDeepStrictEqual } from 'node:util';` and extend the lib-dynamodb import with `BatchWriteCommand, ScanCommand`. Replace the stubs:
```ts
  protected async *scanCheckpoints(): AsyncGenerator<Item> {
    const all: Item[] = [];
    let startKey: Item | undefined;
    do {
      const out = await this.client.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'begins_with(#sk, :skPrefix)',
        ExpressionAttributeNames: { '#sk': 'sk' },
        ExpressionAttributeValues: { ':skPrefix': 'cp#' },
        ExclusiveStartKey: startKey,
      }));
      all.push(...(out.Items ?? []));
      startKey = out.LastEvaluatedKey;
    } while (startKey);
    all.sort((a, b) => (a.pk === b.pk ? (a.sk < b.sk ? 1 : -1) : a.pk < b.pk ? 1 : -1));
    yield* all;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { before, filter } = options ?? {};
    let remaining = options?.limit;
    const rawThread = config.configurable?.thread_id;
    const rawNs = config.configurable?.checkpoint_ns;
    const ns = rawNs === undefined ? undefined : assertKeyPart('checkpoint_ns', rawNs, true);
    const onlyId = config.configurable?.checkpoint_id as string | undefined;
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;
    const source = rawThread === undefined
      ? this.scanCheckpoints()
      : this.queryAll({
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
          ExpressionAttributeNames: NAMES_PK_SK,
          ExpressionAttributeValues: { ':pk': assertKeyPart('thread_id', rawThread), ':skPrefix': ns === undefined ? 'cp#' : cpPrefix(ns) },
          ScanIndexForward: false,
        });
    for await (const item of source) {
      if (remaining !== undefined && remaining <= 0) return;
      if (ns !== undefined && item.checkpointNs !== ns) continue;
      if (onlyId && item.checkpointId !== onlyId) continue;
      if (beforeId && item.checkpointId >= beforeId) continue;
      const metadata = (await this.serde.loadsTyped(item.mdType, item.metadata)) as CheckpointMetadata;
      if (filter && !Object.entries(filter).every(([k, v]) => isDeepStrictEqual((metadata as Record<string, unknown>)[k], v))) continue;
      if (remaining !== undefined) remaining -= 1;
      yield await this.toTuple(item, metadata);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const pk = assertKeyPart('thread_id', threadId);
    const keys: Item[] = [];
    for await (const item of this.queryAll({
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: NAMES_PK,
      ExpressionAttributeValues: { ':pk': pk },
    })) keys.push({ pk: item.pk, sk: item.sk });
    for (let i = 0; i < keys.length; i += 25) {
      let requests: Item[] = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
      for (let attempt = 1; requests.length > 0; attempt++) {
        if (attempt > 6) throw new Error(`DynamoDBSaver.deleteThread: ${requests.length} deletes still unprocessed after retries`);
        if (attempt > 1) await new Promise((r) => setTimeout(r, (attempt - 1) * 50));
        const out = await this.client.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } } as any));
        requests = out.UnprocessedItems?.[this.tableName] ?? [];
      }
    }
  }
```

- [ ] **Step 4: Run all checkpointer tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer`
Expected: 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/checkpointer packages/runtime/test/checkpointer
git commit -m "feat(runtime): list checkpoint history and delete threads"
```

**Acceptance:**
- list is newest first and pages correctly.
- limit, before and filter work, and namespace scoping works.
- A scan ignores approval items.
- deleteThread survives pagination and UnprocessedItems.

---

### Task 6: TTL and the item-size guard

**Files:**
- Modify: `packages/runtime/src/checkpointer/dynamodb-saver.ts`
- Test: `packages/runtime/test/checkpointer/dynamodb-saver-ttl.test.ts`

**Interfaces:**
- `ttlSeconds` and `now` options (already in the constructor) set `expiresAt = floor(now/1000) + ttlSeconds` on checkpoint **and** write items.
- `MAX_CHECKPOINT_BYTES = 350_000` is exported. `put` throws `CheckpointTooLargeError` when `cpBytes.length + mdBytes.length > MAX_CHECKPOINT_BYTES`.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/checkpointer/dynamodb-saver-ttl.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emptyCheckpoint, uuid6, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { CheckpointTooLargeError } from '../../src/checkpointer/errors.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

const md = { source: 'input', step: -1, parents: {} } as CheckpointMetadata;
const NOW = 1_700_000_000_000;

describe('DynamoDBSaver TTL', () => {
  it('stamps expiresAt on checkpoints and writes when ttlSeconds is set', async () => {
    const client = new FakeDocumentClient();
    const saver = new DynamoDBSaver({ client, tableName: 't', ttlSeconds: 3600, now: () => NOW });
    const cfg = await saver.put({ configurable: { thread_id: 't1' } }, { ...emptyCheckpoint(), id: uuid6(-1) }, md, {});
    await saver.putWrites(cfg, [['a', 1]], 'task');
    for (const item of client.allItems()) expect(item.expiresAt).toBe(1_700_003_600);
  });

  it('omits expiresAt when ttlSeconds is not set', async () => {
    const client = new FakeDocumentClient();
    const saver = new DynamoDBSaver({ client, tableName: 't' });
    await saver.put({ configurable: { thread_id: 't1' } }, { ...emptyCheckpoint(), id: uuid6(-1) }, md, {});
    expect(client.allItems()[0]).not.toHaveProperty('expiresAt');
  });

  it('refuses checkpoints that would exceed the DynamoDB item limit', async () => {
    const saver = new DynamoDBSaver({ client: new FakeDocumentClient(), tableName: 't' });
    const huge = { ...emptyCheckpoint(), id: uuid6(-1), channel_values: { blob: 'x'.repeat(400_000) } };
    await expect(saver.put({ configurable: { thread_id: 't1' } }, huge, md, {})).rejects.toBeInstanceOf(CheckpointTooLargeError);
  });
});
```

- [ ] **Step 2: Run the tests and confirm only the size test fails**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer/dynamodb-saver-ttl.test.ts`
Expected: the first two tests PASS, because TTL was built in Task 3. That is acceptable: they pin existing behavior. The third FAILS with `promise resolved instead of rejecting`.

- [ ] **Step 3: Implement the size guard**

In `dynamodb-saver.ts`, add `import { CheckpointTooLargeError, InvalidKeyError } from './errors.js';` and export the constant:
```ts
export const MAX_CHECKPOINT_BYTES = 350_000;
```
In `put`, right after the `Promise.all` serialization:
```ts
    const size = cpBytes.length + mdBytes.length;
    if (size > MAX_CHECKPOINT_BYTES) throw new CheckpointTooLargeError(size, MAX_CHECKPOINT_BYTES);
```

- [ ] **Step 4: Run all checkpointer tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer`
Expected: 21 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/checkpointer packages/runtime/test/checkpointer
git commit -m "feat(runtime): expire checkpoint items with DynamoDB TTL and guard item size"
```

**Acceptance:**
- `expiresAt` is exact on both item kinds and absent without TTL.
- An oversized checkpoint throws `CheckpointTooLargeError`.

---

### Task 7: Run the official LangGraph checkpointer conformance suite

**Files:**
- Test: `packages/runtime/test/checkpointer/conformance.test.ts`
- Modify (only if the suite finds gaps): `packages/runtime/src/checkpointer/dynamodb-saver.ts`

**Interfaces:**
- Consumes `validate` from `@langchain/langgraph-checkpoint-validation` (the signature is `validate(initializer: { checkpointerName: string; createCheckpointer(): Saver | Promise<Saver>; destroyCheckpointer?(s): void; beforeAll?(); afterAll?() })`). Each `createCheckpointer` call must get **fresh, isolated** storage.

- [ ] **Step 1: Write the suite file (it is the test)**

`packages/runtime/test/checkpointer/conformance.test.ts`:
```ts
import { validate } from '@langchain/langgraph-checkpoint-validation';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

validate({
  checkpointerName: 'DynamoDBSaver (in-memory DynamoDB fake)',
  createCheckpointer: () => new DynamoDBSaver({ client: new FakeDocumentClient({ maxPageSize: 3 }), tableName: 'conformance' }),
});
```

- [ ] **Step 2: Run it and record failures**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/checkpointer/conformance.test.ts`
Expected: most suites pass. Any failure is a real conformance gap. Read the failing spec name, for example `getTuple > ... returns parentConfig` or `list > ... filter`.

- [ ] **Step 3: Fix each gap in `dynamodb-saver.ts`, one at a time, re-running after each fix**

Known places to look:
- The `config` shape returned by `getTuple` when `checkpoint_id` was passed. If the suite expects the input config echoed back, return `config` merged with the normalized `checkpoint_ns`.
- How a `list()` filter treats `undefined` metadata keys.
- `deleteThread` must also remove writes.
- Checkpoint ids that are not uuid6. Ordering then still uses string compare. Do not change the sort order unless the suite demands it.

Never weaken the suite. Never wrap it in `describe.skip`. If the suite cannot run at all because of a Vitest instance conflict, the error is "describe() called outside of a test file" or "failed to find the runner". In that case:
1. Confirm `pnpm why vitest -r` shows a single 4.1.11.
2. As a fallback, create `packages/runtime/test/checkpointer/initializer.ts` that default-exports the same initializer object, and add the script `"test:conformance": "validate-checkpointer ./test/checkpointer/initializer.ts"` to the runtime `package.json`. Run that instead and record the reason in `docs/handoff.md`.

- [ ] **Step 4: Run the full runtime suite**

Run: `pnpm --filter @serverless-agent/runtime test`
Expected: all tests pass. Record the conformance pass count for the handoff.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "test(runtime): run LangGraph checkpointer conformance suite against DynamoDBSaver"
```

**Acceptance:** The official conformance suite is green against `DynamoDBSaver`. There are no skipped specs.

---

### Task 8: Cost estimation and EMF metrics

**Files:**
- Create: `packages/runtime/src/metrics.ts`
- Test: `packages/runtime/test/metrics.test.ts`

**Interfaces:**
```ts
export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface Pricing { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }
export const ZERO_USAGE: TokenUsage;
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage;
export function usageFromMessages(messages: BaseMessage[]): TokenUsage; // sums AIMessage.usage_metadata
export function estimateCostUsd(usage: TokenUsage, pricing: Pricing): number;
export interface StepMetrics { agentName: string; runId: string; threadId: string; status: string; usage: TokenUsage; estimatedCostUsd: number; durationMs: number; timestamp: number }
export function buildEmfRecord(m: StepMetrics): Record<string, unknown>;
export const METRICS_NAMESPACE = 'ServerlessAgent';
```

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/metrics.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { addUsage, buildEmfRecord, estimateCostUsd, usageFromMessages } from '../src/metrics.js';

describe('metrics', () => {
  it('estimates cost from token usage and per-million pricing', () => {
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, { inputUsdPerMillionTokens: 0.06, outputUsdPerMillionTokens: 0.24 })).toBeCloseTo(0.0003, 10);
  });

  it('returns zero cost for zero pricing', () => {
    expect(estimateCostUsd({ inputTokens: 5000, outputTokens: 5000 }, { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 })).toBe(0);
  });

  it('sums usage_metadata over AI messages only', () => {
    const msgs = [
      new HumanMessage('hi'),
      new AIMessage({ content: 'a', usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }),
      new AIMessage({ content: 'b' }),
      new AIMessage({ content: 'c', usage_metadata: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } }),
    ];
    expect(usageFromMessages(msgs)).toEqual({ inputTokens: 15, outputTokens: 3 });
  });

  it('adds usage', () => {
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 4, outputTokens: 6 });
  });

  it('builds a CloudWatch EMF record with AgentName dimension and runId as a property', () => {
    const rec = buildEmfRecord({ agentName: 'Agent', runId: 'r1', threadId: 't1', status: 'completed', usage: { inputTokens: 7, outputTokens: 3 }, estimatedCostUsd: 0.001, durationMs: 120, timestamp: 1_700_000_000_000 }) as any;
    expect(rec._aws.Timestamp).toBe(1_700_000_000_000);
    expect(rec._aws.CloudWatchMetrics[0].Namespace).toBe('ServerlessAgent');
    expect(rec._aws.CloudWatchMetrics[0].Dimensions).toEqual([['AgentName']]);
    expect(rec._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name)).toEqual(['InputTokens', 'OutputTokens', 'EstimatedCostUsd', 'StepDurationMs']);
    expect(rec).toMatchObject({ AgentName: 'Agent', runId: 'r1', threadId: 't1', status: 'completed', InputTokens: 7, OutputTokens: 3, EstimatedCostUsd: 0.001, StepDurationMs: 120 });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/metrics.test.ts`
Expected: FAIL, the import of `../src/metrics.js` cannot be resolved.

- [ ] **Step 3: Implement**

`packages/runtime/src/metrics.ts`:
```ts
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface Pricing { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }
export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };
export const METRICS_NAMESPACE = 'ServerlessAgent';

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export function usageFromMessages(messages: BaseMessage[]): TokenUsage {
  return messages.reduce<TokenUsage>((acc, m) => {
    if (!AIMessage.isInstance(m) || !m.usage_metadata) return acc;
    return addUsage(acc, { inputTokens: m.usage_metadata.input_tokens ?? 0, outputTokens: m.usage_metadata.output_tokens ?? 0 });
  }, ZERO_USAGE);
}

/** ESTIMATE: tokens x configured list price. Not AWS billing data. */
export function estimateCostUsd(usage: TokenUsage, pricing: Pricing): number {
  return (usage.inputTokens * pricing.inputUsdPerMillionTokens + usage.outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000;
}

export interface StepMetrics {
  agentName: string; runId: string; threadId: string; status: string;
  usage: TokenUsage; estimatedCostUsd: number; durationMs: number; timestamp: number;
}

export function buildEmfRecord(m: StepMetrics): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: m.timestamp,
      CloudWatchMetrics: [{
        Namespace: METRICS_NAMESPACE,
        Dimensions: [['AgentName']],
        Metrics: [
          { Name: 'InputTokens', Unit: 'Count' },
          { Name: 'OutputTokens', Unit: 'Count' },
          { Name: 'EstimatedCostUsd', Unit: 'None' },
          { Name: 'StepDurationMs', Unit: 'Milliseconds' },
        ],
      }],
    },
    AgentName: m.agentName,
    runId: m.runId,
    threadId: m.threadId,
    status: m.status,
    InputTokens: m.usage.inputTokens,
    OutputTokens: m.usage.outputTokens,
    EstimatedCostUsd: m.estimatedCostUsd,
    StepDurationMs: m.durationMs,
  };
}
```
If `AIMessage.isInstance` does not exist in `@langchain/core@1.2.14`, use `m.getType() === 'ai'` and cast the message to `AIMessage`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/metrics.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/metrics.ts packages/runtime/test/metrics.test.ts
git commit -m "feat(runtime): estimate per-step cost and emit CloudWatch EMF metrics"
```

**Acceptance:**
- The cost math is exact.
- The EMF shape has namespace `ServerlessAgent`, dimension `AgentName` and 4 metrics.
- `runId` is a property, not a dimension.

---

### Task 9: Notifier, GoneException handling and TokenBatcher

**Files:**
- Create: `packages/runtime/src/notify.ts`, `packages/runtime/test/support/recording-notifier.ts`
- Test: `packages/runtime/test/notify.test.ts`

**Interfaces:**
```ts
export interface ApprovalToolCall { id: string; name: string; args: Record<string, unknown> }
export type ServerMessage =
  | { type: 'run_started'; runId: string; threadId: string }
  | { type: 'token'; runId: string; text: string }
  | { type: 'approval_required'; runId: string; approvalUrl: string; toolCalls: ApprovalToolCall[]; expiresAt: string }
  | { type: 'run_completed'; runId: string; output: string }
  | { type: 'run_failed'; runId: string; error: string };
export interface Notifier { send(connectionId: string | null | undefined, message: ServerMessage): Promise<void> }
export class NullNotifier implements Notifier {}
export class ApiGatewayNotifier implements Notifier { constructor(client: { send(cmd: any): Promise<any> }, log?: (msg: string) => void) }
export class TokenBatcher { constructor(flush: (text: string) => Promise<void>, minChars?: number /* 64 */); push(text: string): Promise<void>; close(): Promise<void> }
```
- `ApiGatewayNotifier.send` does the following:
  - it is a no-op if `connectionId` is falsy or has been marked gone;
  - otherwise it sends `PostToConnectionCommand({ ConnectionId, Data: JSON.stringify(message) })`;
  - on `GoneException` it marks the connection gone;
  - on **any** error it logs and swallows (best effort, ADR 0005).

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/support/recording-notifier.ts`:
```ts
import type { Notifier, ServerMessage } from '../../src/notify.js';

export class RecordingNotifier implements Notifier {
  readonly sent: Array<{ connectionId: string | null | undefined; message: ServerMessage }> = [];
  async send(connectionId: string | null | undefined, message: ServerMessage): Promise<void> {
    this.sent.push({ connectionId, message });
  }
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.map((s) => s.message).filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}
```

`packages/runtime/test/notify.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { ApiGatewayNotifier, NullNotifier, TokenBatcher } from '../src/notify.js';

class FakeApiClient {
  readonly commands: PostToConnectionCommand[] = [];
  failWith?: Error;
  async send(cmd: PostToConnectionCommand) {
    this.commands.push(cmd);
    if (this.failWith) throw this.failWith;
    return {};
  }
}

function gone(): Error {
  const e = new Error('gone');
  e.name = 'GoneException';
  return e;
}

describe('ApiGatewayNotifier', () => {
  it('posts JSON to the connection', async () => {
    const client = new FakeApiClient();
    await new ApiGatewayNotifier(client).send('c1', { type: 'token', runId: 'r', text: 'hi' });
    expect(client.commands[0].input.ConnectionId).toBe('c1');
    expect(JSON.parse(String(client.commands[0].input.Data))).toEqual({ type: 'token', runId: 'r', text: 'hi' });
  });

  it('does nothing without a connection id', async () => {
    const client = new FakeApiClient();
    await new ApiGatewayNotifier(client).send(null, { type: 'token', runId: 'r', text: 'hi' });
    expect(client.commands).toHaveLength(0);
  });

  it('stops sending to a connection after GoneException and never throws', async () => {
    const client = new FakeApiClient();
    client.failWith = gone();
    const n = new ApiGatewayNotifier(client, () => {});
    await expect(n.send('c1', { type: 'token', runId: 'r', text: 'a' })).resolves.toBeUndefined();
    await n.send('c1', { type: 'token', runId: 'r', text: 'b' });
    expect(client.commands).toHaveLength(1);
  });

  it('swallows other errors (streaming is best effort)', async () => {
    const client = new FakeApiClient();
    client.failWith = new Error('throttled');
    const logs: string[] = [];
    await expect(new ApiGatewayNotifier(client, (m) => logs.push(m)).send('c1', { type: 'token', runId: 'r', text: 'a' })).resolves.toBeUndefined();
    expect(logs.join()).toMatch(/throttled/);
  });

  it('NullNotifier accepts everything silently', async () => {
    await expect(new NullNotifier().send('c1', { type: 'token', runId: 'r', text: 'a' })).resolves.toBeUndefined();
  });
});

describe('TokenBatcher', () => {
  it('flushes when the buffer reaches minChars and on close', async () => {
    const flushed: string[] = [];
    const b = new TokenBatcher(async (t) => { flushed.push(t); }, 5);
    await b.push('ab');
    await b.push('cd');
    expect(flushed).toEqual([]);
    await b.push('e');
    expect(flushed).toEqual(['abcde']);
    await b.push('fg');
    await b.close();
    expect(flushed).toEqual(['abcde', 'fg']);
  });

  it('does not flush empty text on close', async () => {
    const flushed: string[] = [];
    const b = new TokenBatcher(async (t) => { flushed.push(t); });
    await b.close();
    expect(flushed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/notify.test.ts`
Expected: FAIL, the import of `../src/notify.js` cannot be resolved.

- [ ] **Step 3: Implement**

`packages/runtime/src/notify.ts`:
```ts
import { PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

export interface ApprovalToolCall { id: string; name: string; args: Record<string, unknown> }

export type ServerMessage =
  | { type: 'run_started'; runId: string; threadId: string }
  | { type: 'token'; runId: string; text: string }
  | { type: 'approval_required'; runId: string; approvalUrl: string; toolCalls: ApprovalToolCall[]; expiresAt: string }
  | { type: 'run_completed'; runId: string; output: string }
  | { type: 'run_failed'; runId: string; error: string };

export interface Notifier {
  send(connectionId: string | null | undefined, message: ServerMessage): Promise<void>;
}

export class NullNotifier implements Notifier {
  async send(): Promise<void> {}
}

export class ApiGatewayNotifier implements Notifier {
  private readonly gone = new Set<string>();

  constructor(
    private readonly client: { send(command: any): Promise<any> },
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  async send(connectionId: string | null | undefined, message: ServerMessage): Promise<void> {
    if (!connectionId || this.gone.has(connectionId)) return;
    try {
      await this.client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(message) }));
    } catch (err) {
      if ((err as Error).name === 'GoneException') this.gone.add(connectionId);
      this.log(`notifier: dropped ${message.type} for ${connectionId}: ${(err as Error).name}: ${(err as Error).message}`);
    }
  }
}

/** Coalesces streamed tokens to cut WebSocket message count (ADR 0005). */
export class TokenBatcher {
  private buffer = '';

  constructor(private readonly flush: (text: string) => Promise<void>, private readonly minChars = 64) {}

  async push(text: string): Promise<void> {
    this.buffer += text;
    if (this.buffer.length >= this.minChars) await this.drain();
  }

  async close(): Promise<void> {
    if (this.buffer.length > 0) await this.drain();
  }

  private async drain(): Promise<void> {
    const out = this.buffer;
    this.buffer = '';
    await this.flush(out);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/notify.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/notify.ts packages/runtime/test/notify.test.ts packages/runtime/test/support/recording-notifier.ts
git commit -m "feat(runtime): add best-effort WebSocket notifier with token batching"
```

**Acceptance:**
- No throw on `GoneException` or any other error.
- A gone connection is skipped from then on.
- Batching flushes at the threshold and on close.

---

### Task 10: Environment configuration parsing

**Files:**
- Create: `packages/runtime/src/config.ts`
- Test: `packages/runtime/test/config.test.ts`

**Interfaces:**
```ts
export type Env = Record<string, string | undefined>;
export function requireEnv(env: Env, name: string): string;                 // throws `Missing required environment variable ${name}`
export function intEnv(env: Env, name: string, fallback?: number): number;   // throws on non-integer
export function floatEnv(env: Env, name: string, fallback: number): number;  // throws on NaN or negative
export function listEnv(env: Env, name: string): string[];                   // comma split, trimmed, empty removed
export type ModelProvider = 'bedrock' | 'openai-compatible';
export interface ModelConfig { provider: ModelProvider; modelId: string; region?: string; baseUrl?: string; apiKeySecretArn?: string }
export function modelConfigFromEnv(env: Env): ModelConfig; // MODEL_PROVIDER, MODEL_ID, AWS_REGION, MODEL_BASE_URL, MODEL_API_KEY_SECRET_ARN
export function pricingFromEnv(env: Env): Pricing;         // PRICE_INPUT_USD_PER_MTOK, PRICE_OUTPUT_USD_PER_MTOK, default 0
```

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { floatEnv, intEnv, listEnv, modelConfigFromEnv, pricingFromEnv, requireEnv } from '../src/config.js';

describe('config', () => {
  it('requireEnv names the missing variable', () => {
    expect(() => requireEnv({}, 'TABLE_NAME')).toThrow('Missing required environment variable TABLE_NAME');
    expect(requireEnv({ TABLE_NAME: 'x' }, 'TABLE_NAME')).toBe('x');
  });

  it('intEnv parses integers, uses fallback, rejects garbage', () => {
    expect(intEnv({ N: '42' }, 'N')).toBe(42);
    expect(intEnv({}, 'N', 7)).toBe(7);
    expect(() => intEnv({ N: '4.2' }, 'N')).toThrow(/N/);
    expect(() => intEnv({}, 'N')).toThrow(/N/);
  });

  it('floatEnv parses non-negative numbers', () => {
    expect(floatEnv({ P: '0.06' }, 'P', 0)).toBe(0.06);
    expect(floatEnv({}, 'P', 0)).toBe(0);
    expect(() => floatEnv({ P: '-1' }, 'P', 0)).toThrow(/P/);
  });

  it('listEnv splits on commas', () => {
    expect(listEnv({ L: ' send_email, ,delete_file ' }, 'L')).toEqual(['send_email', 'delete_file']);
    expect(listEnv({}, 'L')).toEqual([]);
  });

  it('modelConfigFromEnv validates the provider', () => {
    expect(modelConfigFromEnv({ MODEL_PROVIDER: 'bedrock', MODEL_ID: 'amazon.nova-lite-v1:0', AWS_REGION: 'us-east-1' }))
      .toEqual({ provider: 'bedrock', modelId: 'amazon.nova-lite-v1:0', region: 'us-east-1' });
    expect(modelConfigFromEnv({ MODEL_PROVIDER: 'openai-compatible', MODEL_ID: 'm', MODEL_BASE_URL: 'http://mock-llm:8080/v1', MODEL_API_KEY_SECRET_ARN: 'arn:x' }))
      .toEqual({ provider: 'openai-compatible', modelId: 'm', baseUrl: 'http://mock-llm:8080/v1', apiKeySecretArn: 'arn:x' });
    expect(() => modelConfigFromEnv({ MODEL_PROVIDER: 'gpt', MODEL_ID: 'm' })).toThrow(/MODEL_PROVIDER/);
    expect(() => modelConfigFromEnv({ MODEL_PROVIDER: 'openai-compatible', MODEL_ID: 'm' })).toThrow(/MODEL_BASE_URL/);
  });

  it('pricingFromEnv defaults to zero', () => {
    expect(pricingFromEnv({})).toEqual({ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
    expect(pricingFromEnv({ PRICE_INPUT_USD_PER_MTOK: '0.06', PRICE_OUTPUT_USD_PER_MTOK: '0.24' })).toEqual({ inputUsdPerMillionTokens: 0.06, outputUsdPerMillionTokens: 0.24 });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/config.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Implement**

`packages/runtime/src/config.ts`:
```ts
import type { Pricing } from './metrics.js';

export type Env = Record<string, string | undefined>;
export type ModelProvider = 'bedrock' | 'openai-compatible';
export interface ModelConfig { provider: ModelProvider; modelId: string; region?: string; baseUrl?: string; apiKeySecretArn?: string }

export function requireEnv(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function intEnv(env: Env, name: string, fallback?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  if (!/^-?\d+$/.test(raw)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return Number(raw);
}

export function floatEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Environment variable ${name} must be a non-negative number, got "${raw}"`);
  return n;
}

export function listEnv(env: Env, name: string): string[] {
  return (env[name] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function modelConfigFromEnv(env: Env): ModelConfig {
  const provider = requireEnv(env, 'MODEL_PROVIDER');
  const modelId = requireEnv(env, 'MODEL_ID');
  if (provider === 'bedrock') {
    const cfg: ModelConfig = { provider, modelId };
    if (env.AWS_REGION) cfg.region = env.AWS_REGION;
    return cfg;
  }
  if (provider === 'openai-compatible') {
    const cfg: ModelConfig = { provider, modelId, baseUrl: requireEnv(env, 'MODEL_BASE_URL') };
    if (env.MODEL_API_KEY_SECRET_ARN) cfg.apiKeySecretArn = env.MODEL_API_KEY_SECRET_ARN;
    return cfg;
  }
  throw new Error(`MODEL_PROVIDER must be "bedrock" or "openai-compatible", got "${provider}"`);
}

export function pricingFromEnv(env: Env): Pricing {
  return {
    inputUsdPerMillionTokens: floatEnv(env, 'PRICE_INPUT_USD_PER_MTOK', 0),
    outputUsdPerMillionTokens: floatEnv(env, 'PRICE_OUTPUT_USD_PER_MTOK', 0),
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/config.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/config.ts packages/runtime/test/config.test.ts
git commit -m "feat(runtime): parse and validate Lambda environment configuration"
```

**Acceptance:**
- Missing or invalid variables throw errors that name the variable.
- An unknown provider is rejected.

---

### Task 11: Pluggable chat model factory

**Files:**
- Create: `packages/runtime/src/agent/model.ts`
- Test: `packages/runtime/test/agent/model.test.ts`

**Interfaces:**
- `export function createChatModel(cfg: ModelConfig & { apiKey?: string }): BaseChatModel`
  - `bedrock` returns `new ChatBedrockConverse({ model: cfg.modelId, region: cfg.region ?? 'us-east-1' })`;
  - `openai-compatible` returns `new ChatOpenAI({ model: cfg.modelId, apiKey: cfg.apiKey ?? 'not-needed', configuration: { baseURL: cfg.baseUrl } })`.
- Constructing either must not touch the network.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/agent/model.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
import { createChatModel } from '../../src/agent/model.js';

describe('createChatModel', () => {
  it('creates a Bedrock Converse model by default provider', () => {
    const m = createChatModel({ provider: 'bedrock', modelId: 'amazon.nova-lite-v1:0', region: 'eu-west-1' });
    expect(m).toBeInstanceOf(ChatBedrockConverse);
    expect((m as ChatBedrockConverse).model).toBe('amazon.nova-lite-v1:0');
  });

  it('creates an OpenAI-compatible model pointed at a custom base URL', () => {
    const m = createChatModel({ provider: 'openai-compatible', modelId: 'llama3.1', baseUrl: 'http://localhost:11434/v1' });
    expect(m).toBeInstanceOf(ChatOpenAI);
    expect((m as ChatOpenAI).model).toBe('llama3.1');
  });

  it('rejects unknown providers', () => {
    expect(() => createChatModel({ provider: 'nope' as never, modelId: 'x' })).toThrow(/provider/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/agent/model.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Implement**

`packages/runtime/src/agent/model.ts`:
```ts
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
import type { ModelConfig } from '../config.js';

export function createChatModel(cfg: ModelConfig & { apiKey?: string }): BaseChatModel {
  switch (cfg.provider) {
    case 'bedrock':
      return new ChatBedrockConverse({ model: cfg.modelId, region: cfg.region ?? 'us-east-1' });
    case 'openai-compatible':
      return new ChatOpenAI({ model: cfg.modelId, apiKey: cfg.apiKey ?? 'not-needed', configuration: { baseURL: cfg.baseUrl } });
    default:
      throw new Error(`Unknown model provider "${(cfg as { provider: string }).provider}"`);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/agent/model.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/agent/model.ts packages/runtime/test/agent/model.test.ts
git commit -m "feat(runtime): add Bedrock and OpenAI-compatible model factory"
```

**Acceptance:** Both providers construct offline with the right model id, and an unknown provider throws.

---

### Task 12: Approval-gated agent graph and demo tools

**Files:**
- Create: `packages/runtime/src/agent/graph.ts`, `packages/runtime/src/agent/tools.ts`, `packages/runtime/test/support/scripted-model.ts`
- Test: `packages/runtime/test/agent/graph.test.ts`

**Interfaces:**
```ts
// graph.ts
export interface ApprovalRequest { kind: 'tool_approval'; toolCalls: ApprovalToolCall[] }   // ApprovalToolCall from notify.ts
export interface ApprovalDecision { approved: boolean; comment?: string }
export interface AgentGraphOptions {
  model: BaseChatModel;                       // graph calls model.bindTools(tools)
  tools: StructuredToolInterface[];
  toolsRequiringApproval: string[];
  checkpointer: BaseCheckpointSaver;
  systemPrompt?: string;
}
export function buildAgentGraph(opts: AgentGraphOptions): CompiledGraph;   // nodes: model, gate, tools
export type AgentGraph = ReturnType<typeof buildAgentGraph>;
export function pendingApproval(state: { tasks: Array<{ interrupts?: Array<{ value?: unknown }> }> }): ApprovalRequest | undefined;
// tools.ts
export const getCurrentTime; export const sendEmail; export const demoTools: StructuredToolInterface[];
```
Gate rules (ADR 0004):
1. If any tool call names an unknown tool, every call gets an error `ToolMessage` and control goes to `model`.
2. If any call is in `toolsRequiringApproval`, call `interrupt({ kind: 'tool_approval', toolCalls: <sensitive calls> })`.
3. Resume value: only `decision?.approved === true` continues to `tools`. Anything else sends rejection `ToolMessage`s for **all** calls of the turn back to `model`, with content `Rejected by human reviewer[: comment]. The tool was not executed.`
4. With no sensitive calls, go to `tools`.

- [ ] **Step 1: Write the scripted model helper and the failing tests**

`packages/runtime/test/support/scripted-model.ts`:
```ts
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/** Deterministic chat model: returns queued AIMessages in order; records inputs. */
export class ScriptedChatModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  private readonly queue: AIMessage[];

  constructor(script: AIMessage[]) {
    super({});
    this.queue = [...script];
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(_tools: unknown[]): any {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const next = this.queue.shift();
    if (!next) throw new Error('ScriptedChatModel: script exhausted');
    return { generations: [{ message: next, text: typeof next.content === 'string' ? next.content : '' }] };
  }
}

export function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): AIMessage {
  return new AIMessage({ content: '', tool_calls: [{ id, name, args, type: 'tool_call' }], usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
}

export function reply(text: string): AIMessage {
  return new AIMessage({ content: text, usage_metadata: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } });
}
```

`packages/runtime/test/agent/graph.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Command } from '@langchain/langgraph';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { buildAgentGraph, pendingApproval } from '../../src/agent/graph.js';
import { demoTools } from '../../src/agent/tools.js';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';
import { ScriptedChatModel, reply, toolCall } from '../support/scripted-model.js';

const EMAIL = { to: 'bob@example.com', subject: 'Hi', body: 'Hello Bob' };

function graphWith(script: AIMessage[], client = new FakeDocumentClient()) {
  const model = new ScriptedChatModel(script);
  const graph = buildAgentGraph({
    model, tools: demoTools, toolsRequiringApproval: ['send_email'],
    checkpointer: new DynamoDBSaver({ client, tableName: 'checkpoints' }),
  });
  return { graph, model, client };
}
const cfg = (thread: string) => ({ configurable: { thread_id: thread } });
const toolMessages = (msgs: unknown[]) => msgs.filter((m): m is ToolMessage => ToolMessage.isInstance(m as never));

describe('agent graph', () => {
  it('runs a safe tool without asking for approval', async () => {
    const { graph } = graphWith([toolCall('get_current_time', {}), reply('It is noon.')]);
    const out = await graph.invoke({ messages: [new HumanMessage('time?')] }, cfg('t1'));
    expect(out.messages.at(-1)?.content).toBe('It is noon.');
    expect(pendingApproval(await graph.getState(cfg('t1')))).toBeUndefined();
  });

  it('pauses before a sensitive tool and the pause survives a fresh graph instance', async () => {
    const client = new FakeDocumentClient();
    const first = graphWith([toolCall('send_email', EMAIL)], client);
    await first.graph.invoke({ messages: [new HumanMessage('email bob')] }, cfg('t2'));
    // Simulates a different Lambda invocation: new saver, same table.
    const second = graphWith([], client);
    const approval = pendingApproval(await second.graph.getState(cfg('t2')));
    expect(approval).toEqual({ kind: 'tool_approval', toolCalls: [{ id: 'call_send_email', name: 'send_email', args: EMAIL }] });
  });

  it('executes the tool after approval', async () => {
    const client = new FakeDocumentClient();
    await graphWith([toolCall('send_email', EMAIL)], client).graph.invoke({ messages: [new HumanMessage('email bob')] }, cfg('t3'));
    const { graph } = graphWith([reply('Sent.')], client);
    const out = await graph.invoke(new Command({ resume: { approved: true } }), cfg('t3'));
    expect(toolMessages(out.messages).map((m) => String(m.content)).join()).toMatch(/Demo stub/);
    expect(out.messages.at(-1)?.content).toBe('Sent.');
  });

  it('feeds a rejection back to the model without executing the tool', async () => {
    const client = new FakeDocumentClient();
    await graphWith([toolCall('send_email', EMAIL)], client).graph.invoke({ messages: [new HumanMessage('email bob')] }, cfg('t4'));
    const { graph } = graphWith([reply('Okay, not sending.')], client);
    const out = await graph.invoke(new Command({ resume: { approved: false, comment: 'not now' } }), cfg('t4'));
    const tools = toolMessages(out.messages);
    expect(tools).toHaveLength(1);
    expect(String(tools[0].content)).toBe('Rejected by human reviewer: not now. The tool was not executed.');
    expect(String(tools[0].content)).not.toMatch(/Demo stub/);
  });

  it('fails closed on a malformed resume value', async () => {
    const client = new FakeDocumentClient();
    await graphWith([toolCall('send_email', EMAIL)], client).graph.invoke({ messages: [new HumanMessage('email bob')] }, cfg('t5'));
    const { graph } = graphWith([reply('ok')], client);
    const out = await graph.invoke(new Command({ resume: { approved: 'yes' } }), cfg('t5'));
    expect(String(toolMessages(out.messages)[0].content)).toMatch(/^Rejected by human reviewer/);
  });

  it('requires approval for the whole turn when safe and sensitive calls are mixed', async () => {
    const mixed = new AIMessage({ content: '', tool_calls: [
      { id: 'a', name: 'get_current_time', args: {}, type: 'tool_call' },
      { id: 'b', name: 'send_email', args: EMAIL, type: 'tool_call' },
    ] });
    const { graph } = graphWith([mixed]);
    const out = await graph.invoke({ messages: [new HumanMessage('both')] }, cfg('t6'));
    expect(toolMessages(out.messages)).toHaveLength(0);
    expect(pendingApproval(await graph.getState(cfg('t6')))?.toolCalls.map((c) => c.name)).toEqual(['send_email']);
  });

  it('rejects unknown tools deterministically', async () => {
    const { graph } = graphWith([toolCall('rm_rf', { path: '/' }), reply('Sorry.')]);
    const out = await graph.invoke({ messages: [new HumanMessage('delete')] }, cfg('t7'));
    expect(String(toolMessages(out.messages)[0].content)).toMatch(/Unknown tool "rm_rf"/);
    expect(out.messages.at(-1)?.content).toBe('Sorry.');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/agent/graph.test.ts`
Expected: FAIL, the import of `../../src/agent/graph.js` cannot be resolved.

- [ ] **Step 3: Implement the tools and the graph**

`packages/runtime/src/agent/tools.ts`:
```ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const getCurrentTime = tool(async () => new Date().toISOString(), {
  name: 'get_current_time',
  description: 'Returns the current UTC time in ISO-8601 format.',
  schema: z.object({}),
});

export const sendEmail = tool(
  async ({ to, subject }) => `Demo stub: email to ${to} with subject "${subject}" was recorded but not sent.`,
  {
    name: 'send_email',
    description: 'Sends an email on the user\'s behalf. Requires human approval before it runs.',
    schema: z.object({ to: z.string().email(), subject: z.string().max(200), body: z.string().max(5000) }),
  },
);

export const demoTools = [getCurrentTime, sendEmail];
```

`packages/runtime/src/agent/graph.ts`:
```ts
import { Command, END, MessagesAnnotation, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ApprovalToolCall } from '../notify.js';

export interface ApprovalRequest { kind: 'tool_approval'; toolCalls: ApprovalToolCall[] }
export interface ApprovalDecision { approved: boolean; comment?: string }

export interface AgentGraphOptions {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  toolsRequiringApproval: string[];
  checkpointer: BaseCheckpointSaver;
  systemPrompt?: string;
}

type State = typeof MessagesAnnotation.State;

function lastAi(state: State): AIMessage | undefined {
  const last = state.messages.at(-1);
  return last && AIMessage.isInstance(last) ? last : undefined;
}

export function buildAgentGraph(opts: AgentGraphOptions) {
  const toolNames = new Set(opts.tools.map((t) => t.name));
  const sensitive = new Set(opts.toolsRequiringApproval);
  const bound = opts.model.bindTools!(opts.tools);

  const callModel = async (state: State, config?: RunnableConfig) => {
    const messages = opts.systemPrompt ? [new SystemMessage(opts.systemPrompt), ...state.messages] : state.messages;
    const response = await bound.invoke(messages, config);
    return { messages: [response] };
  };

  const gate = (state: State) => {
    const calls = lastAi(state)?.tool_calls ?? [];
    const unknown = calls.filter((c) => !toolNames.has(c.name));
    if (unknown.length > 0) {
      return new Command({
        goto: 'model',
        update: {
          messages: calls.map((c) => new ToolMessage({
            tool_call_id: c.id ?? '',
            status: 'error',
            content: toolNames.has(c.name)
              ? 'Not executed: another tool call in this turn was invalid.'
              : `Unknown tool "${c.name}". Available tools: ${[...toolNames].join(', ')}.`,
          })),
        },
      });
    }
    const needsApproval = calls.filter((c) => sensitive.has(c.name));
    if (needsApproval.length === 0) return new Command({ goto: 'tools' });

    const request: ApprovalRequest = {
      kind: 'tool_approval',
      toolCalls: needsApproval.map((c) => ({ id: c.id ?? '', name: c.name, args: c.args as Record<string, unknown> })),
    };
    const decision = interrupt(request) as Partial<ApprovalDecision> | undefined;
    if (decision?.approved === true) return new Command({ goto: 'tools' });

    const reason = typeof decision?.comment === 'string' && decision.comment.length > 0 ? `: ${decision.comment}` : '';
    return new Command({
      goto: 'model',
      update: {
        messages: calls.map((c) => new ToolMessage({
          tool_call_id: c.id ?? '',
          status: 'error',
          content: `Rejected by human reviewer${reason}. The tool was not executed.`,
        })),
      },
    });
  };

  return new StateGraph(MessagesAnnotation)
    .addNode('model', callModel)
    .addNode('gate', gate, { ends: ['tools', 'model'] })
    .addNode('tools', new ToolNode(opts.tools))
    .addEdge(START, 'model')
    .addConditionalEdges('model', (s: State) => ((lastAi(s)?.tool_calls?.length ?? 0) > 0 ? 'gate' : END), ['gate', END])
    .addEdge('tools', 'model')
    .compile({ checkpointer: opts.checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;

export function pendingApproval(state: { tasks: ReadonlyArray<{ interrupts?: ReadonlyArray<{ value?: unknown }> }> }): ApprovalRequest | undefined {
  for (const task of state.tasks) {
    for (const i of task.interrupts ?? []) {
      const v = i.value as ApprovalRequest | undefined;
      if (v?.kind === 'tool_approval') return v;
    }
  }
  return undefined;
}
```
If `AIMessage.isInstance` or `ToolMessage.isInstance` is unavailable, use `m.getType() === 'ai'` / `'tool'`. If the compiler rejects the `ends` option or the `addConditionalEdges` path map, follow the LangGraph 1.4 typings. The behavior must stay exactly as tested.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/agent`
Expected: 10 tests pass (7 graph tests and 3 model tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/agent packages/runtime/test/agent packages/runtime/test/support/scripted-model.ts
git commit -m "feat(runtime): add approval-gated LangGraph agent with demo tools"
```

**Acceptance:**
- A safe tool runs without approval.
- A sensitive tool interrupts, and the interrupt survives a new saver instance.
- Approve runs the tool. Reject and malformed values do not.
- A mixed turn needs approval.
- An unknown tool is rejected.

---

### Task 13: agentStep handler

**Files:**
- Create: `packages/runtime/src/handlers/agent-step.ts`
- Test: `packages/runtime/test/handlers/agent-step.test.ts`

**Interfaces:**
```ts
export interface AgentStepEvent {
  runId: string;
  input: { threadId: string; message?: string; connectionId?: string | null; resume?: ApprovalDecision; [k: string]: unknown };
}
export type AgentStepResult =
  | { status: 'interrupted'; interrupt: ApprovalRequest; usage: TokenUsage; estimatedCostUsd: number }
  | { status: 'completed'; output: string; usage: TokenUsage; estimatedCostUsd: number };
export interface AgentStepDeps {
  getGraph: () => Promise<AgentGraph>;
  notifier: Notifier;
  agentName: string;
  pricing: Pricing;
  recursionLimit?: number;          // default 25
  log?: (line: string) => void;     // default console.log; receives the EMF JSON line
  now?: () => number;
}
export const MAX_OUTPUT_CHARS = 32_000;
export function createAgentStepHandler(deps: AgentStepDeps): (event: AgentStepEvent) => Promise<AgentStepResult>;
```
Behavior:
- If `input.resume !== undefined`, use `new Command({ resume })`. Otherwise use `{ messages: [new HumanMessage(message)] }`. Throw if there is neither.
- Send `run_started` only on a fresh message, not on a resume.
- Stream `graph.stream(input, { configurable: { thread_id }, recursionLimit, streamMode: 'messages' })`. For each `[chunk, meta]` where `meta.langgraph_node === 'model'`, push the text content to a `TokenBatcher` that sends `token` messages.
- Usage covers only the messages added in this step: the state message count before versus after.
- Log one EMF line.
- If interrupted, return `interrupted`. Otherwise send `run_completed` with the truncated output and return `completed`.
- On any error, send `run_failed` with `error: 'Agent step failed'` (never the raw error text), then rethrow.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/handlers/agent-step.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { AIMessage } from '@langchain/core/messages';
import { buildAgentGraph } from '../../src/agent/graph.js';
import { demoTools } from '../../src/agent/tools.js';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { createAgentStepHandler } from '../../src/handlers/agent-step.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';
import { RecordingNotifier } from '../support/recording-notifier.js';
import { ScriptedChatModel, reply, toolCall } from '../support/scripted-model.js';

const PRICING = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 };

function setup(script: AIMessage[], client = new FakeDocumentClient()) {
  const notifier = new RecordingNotifier();
  const logs: string[] = [];
  const graph = buildAgentGraph({ model: new ScriptedChatModel(script), tools: demoTools, toolsRequiringApproval: ['send_email'], checkpointer: new DynamoDBSaver({ client, tableName: 't' }) });
  const handler = createAgentStepHandler({ getGraph: async () => graph, notifier, agentName: 'Agent', pricing: PRICING, log: (l) => logs.push(l), now: () => 1000 });
  return { handler, notifier, logs, client };
}

describe('agentStep handler', () => {
  it('completes a run, streams tokens, reports usage and emits one EMF line', async () => {
    const { handler, notifier, logs } = setup([reply('Hello there')]);
    const out = await handler({ runId: 'r1', input: { threadId: 't1', message: 'hi', connectionId: 'c1' } });
    expect(out).toEqual({ status: 'completed', output: 'Hello there', usage: { inputTokens: 20, outputTokens: 8 }, estimatedCostUsd: (20 * 1 + 8 * 2) / 1e6 });
    expect(notifier.ofType('run_started')).toEqual([{ type: 'run_started', runId: 'r1', threadId: 't1' }]);
    expect(notifier.ofType('token').map((t) => t.text).join('')).toBe('Hello there');
    expect(notifier.ofType('run_completed')).toEqual([{ type: 'run_completed', runId: 'r1', output: 'Hello there' }]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({ AgentName: 'Agent', runId: 'r1', InputTokens: 20, OutputTokens: 8, status: 'completed' });
  });

  it('returns interrupted with the approval request, then completes on resume without double counting', async () => {
    const client = new FakeDocumentClient();
    const first = setup([toolCall('send_email', { to: 'bob@example.com', subject: 's', body: 'b' })], client);
    const paused = await first.handler({ runId: 'r2', input: { threadId: 't2', message: 'email bob', connectionId: 'c1' } });
    expect(paused.status).toBe('interrupted');
    expect(paused.status === 'interrupted' && paused.interrupt.toolCalls[0].name).toBe('send_email');
    expect(paused.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(first.notifier.ofType('run_completed')).toHaveLength(0);

    const second = setup([reply('Sent.')], client);
    const done = await second.handler({ runId: 'r2', input: { threadId: 't2', message: 'email bob', connectionId: 'c1', resume: { approved: true } } });
    expect(done).toMatchObject({ status: 'completed', output: 'Sent.', usage: { inputTokens: 20, outputTokens: 8 } });
    expect(second.notifier.ofType('run_started')).toHaveLength(0);
  });

  it('works with no connection id', async () => {
    const { handler } = setup([reply('quiet')]);
    await expect(handler({ runId: 'r3', input: { threadId: 't3', message: 'hi', connectionId: null } })).resolves.toMatchObject({ status: 'completed' });
  });

  it('notifies run_failed without leaking the error and rethrows', async () => {
    const { handler, notifier } = setup([]);
    await expect(handler({ runId: 'r4', input: { threadId: 't4', message: 'hi', connectionId: 'c1' } })).rejects.toThrow(/script exhausted/);
    expect(notifier.ofType('run_failed')).toEqual([{ type: 'run_failed', runId: 'r4', error: 'Agent step failed' }]);
  });

  it('rejects an event with neither message nor resume', async () => {
    const { handler } = setup([]);
    await expect(handler({ runId: 'r5', input: { threadId: 't5' } })).rejects.toThrow(/message/);
  });

  it('truncates very long outputs', async () => {
    const { handler } = setup([reply('x'.repeat(40_000))]);
    const out = await handler({ runId: 'r6', input: { threadId: 't6', message: 'hi' } });
    expect(out.status === 'completed' && out.output.length).toBe(32_000);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/handlers/agent-step.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Implement**

`packages/runtime/src/handlers/agent-step.ts`:
```ts
import { Command } from '@langchain/langgraph';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { pendingApproval, type AgentGraph, type ApprovalDecision, type ApprovalRequest } from '../agent/graph.js';
import { buildEmfRecord, estimateCostUsd, usageFromMessages, type Pricing, type TokenUsage } from '../metrics.js';
import { TokenBatcher, type Notifier } from '../notify.js';

export interface AgentStepEvent {
  runId: string;
  input: { threadId: string; message?: string; connectionId?: string | null; resume?: ApprovalDecision; [k: string]: unknown };
}

export type AgentStepResult =
  | { status: 'interrupted'; interrupt: ApprovalRequest; usage: TokenUsage; estimatedCostUsd: number }
  | { status: 'completed'; output: string; usage: TokenUsage; estimatedCostUsd: number };

export interface AgentStepDeps {
  getGraph: () => Promise<AgentGraph>;
  notifier: Notifier;
  agentName: string;
  pricing: Pricing;
  recursionLimit?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export const MAX_OUTPUT_CHARS = 32_000;

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: string }).text ?? '') : '')).join('');
  }
  return '';
}

export function createAgentStepHandler(deps: AgentStepDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;

  return async (event: AgentStepEvent): Promise<AgentStepResult> => {
    const started = now();
    const { runId } = event;
    const { threadId, message, connectionId, resume } = event.input;
    if (resume === undefined && (typeof message !== 'string' || message.length === 0)) {
      throw new Error('agentStep: input.message is required when not resuming');
    }
    const notify = deps.notifier;
    try {
      const graph = await deps.getGraph();
      const config = { configurable: { thread_id: threadId }, recursionLimit: deps.recursionLimit ?? 25 };
      const before = ((await graph.getState(config)).values as { messages?: BaseMessage[] }).messages?.length ?? 0;
      const input = resume !== undefined ? new Command({ resume }) : { messages: [new HumanMessage(message as string)] };
      if (resume === undefined) await notify.send(connectionId, { type: 'run_started', runId, threadId });

      const batcher = new TokenBatcher((text) => notify.send(connectionId, { type: 'token', runId, text }));
      const stream = await graph.stream(input as never, { ...config, streamMode: 'messages' });
      for await (const [chunk, meta] of stream as AsyncIterable<[BaseMessage, { langgraph_node?: string }]>) {
        if (meta?.langgraph_node !== 'model') continue;
        const text = textOf(chunk.content);
        if (text) await batcher.push(text);
      }
      await batcher.close();

      const state = await graph.getState(config);
      const messages = ((state.values as { messages?: BaseMessage[] }).messages ?? []);
      const usage = usageFromMessages(messages.slice(before));
      const estimatedCostUsd = estimateCostUsd(usage, deps.pricing);
      const approval = pendingApproval(state as never);
      const status = approval ? 'interrupted' : 'completed';
      log(JSON.stringify(buildEmfRecord({ agentName: deps.agentName, runId, threadId, status, usage, estimatedCostUsd, durationMs: now() - started, timestamp: now() })));

      if (approval) return { status: 'interrupted', interrupt: approval, usage, estimatedCostUsd };
      const output = textOf(messages.at(-1)?.content).slice(0, MAX_OUTPUT_CHARS);
      await notify.send(connectionId, { type: 'run_completed', runId, output });
      return { status: 'completed', output, usage, estimatedCostUsd };
    } catch (err) {
      await notify.send(connectionId, { type: 'run_failed', runId, error: 'Agent step failed' });
      throw err;
    }
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/handlers/agent-step.test.ts`
Expected: 6 tests pass. If the token test fails because a non-streaming model emits no `messages`-mode chunk, check that `@langchain/langgraph` 1.4 emits the final message from `handleLLMEnd`. If it does not, make `ScriptedChatModel` implement `_streamResponseChunks` to yield one `ChatGenerationChunk` per message. Change the test helper, not the handler.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/handlers/agent-step.ts packages/runtime/test/handlers/agent-step.test.ts
git commit -m "feat(runtime): add agent step handler with streaming, usage and failure notices"
```

**Acceptance:**
- Completed and interrupted results have the exact shapes above.
- Usage counts only the new messages.
- There is exactly one EMF line per step.
- `run_failed` hides error details.
- Output is truncated at 32,000 characters.

---

### Task 14: requestApproval handler (waitForTaskToken target)

**Files:**
- Create: `packages/runtime/src/handlers/request-approval.ts`
- Test: `packages/runtime/test/handlers/request-approval.test.ts`

**Interfaces:**
```ts
export interface RequestApprovalEvent {
  taskToken: string;
  runId: string;
  input: { threadId: string; connectionId?: string | null; step: { status: 'interrupted'; interrupt: ApprovalRequest }; [k: string]: unknown };
}
export interface RequestApprovalDeps {
  client: DocumentClientLike; tableName: string; notifier: Notifier;
  approvalBaseUrl?: string;          // e.g. https://abc.execute-api.us-east-1.amazonaws.com ; '' or undefined -> relative URL
  approvalTtlSeconds: number;
  now?: () => number; newApprovalId?: () => string;   // default randomBytes(32).toString('base64url')
}
export function hashApprovalId(id: string): string;   // sha256 hex
export function approvalKey(id: string): { pk: string; sk: 'approval' };   // pk = `approval#${hashApprovalId(id)}`
export function createRequestApprovalHandler(deps): (event) => Promise<{ approvalRequested: true }>;
```
Item: `{ pk, sk:'approval', kind:'approval', taskToken, runId, threadId, toolCalls (JSON string), createdAt (epoch s), expiresAt (epoch s) }`. It uses `ConditionExpression: 'attribute_not_exists(#pk)'`. The URL is `${base without trailing slash}/approvals/${approvalId}`.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/handlers/request-approval.test.ts`:
```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRequestApprovalHandler, hashApprovalId } from '../../src/handlers/request-approval.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';
import { RecordingNotifier } from '../support/recording-notifier.js';

const ID = 'A'.repeat(43);
const event = {
  taskToken: 'token-123', runId: 'run-1',
  input: { threadId: 't1', connectionId: 'c1', step: { status: 'interrupted' as const, interrupt: { kind: 'tool_approval' as const, toolCalls: [{ id: 'x', name: 'send_email', args: { to: 'bob@example.com' } }] } } },
};

function setup(base = 'https://api.example.com/') {
  const client = new FakeDocumentClient();
  const notifier = new RecordingNotifier();
  const handler = createRequestApprovalHandler({ client, tableName: 't', notifier, approvalBaseUrl: base, approvalTtlSeconds: 3600, now: () => 1_700_000_000_000, newApprovalId: () => ID });
  return { client, notifier, handler };
}

describe('requestApproval handler', () => {
  it('stores the task token under the hash of the approval id, never the id itself', async () => {
    const { client, handler } = setup();
    await handler(event);
    const [item] = client.allItems();
    expect(item.pk).toBe(`approval#${createHash('sha256').update(ID).digest('hex')}`);
    expect(item.pk).toBe(`approval#${hashApprovalId(ID)}`);
    expect(item).toMatchObject({ sk: 'approval', taskToken: 'token-123', runId: 'run-1', threadId: 't1', expiresAt: 1_700_003_600 });
    expect(JSON.stringify(item)).not.toContain(ID);
  });

  it('sends the approval URL and tool calls to the WebSocket client', async () => {
    const { notifier, handler } = setup();
    await handler(event);
    expect(notifier.ofType('approval_required')).toEqual([{
      type: 'approval_required', runId: 'run-1', approvalUrl: `https://api.example.com/approvals/${ID}`,
      toolCalls: event.input.step.interrupt.toolCalls, expiresAt: new Date(1_700_003_600_000).toISOString(),
    }]);
  });

  it('uses a relative URL when no API base URL is configured', async () => {
    const { notifier, handler } = setup('');
    await handler(event);
    expect(notifier.ofType('approval_required')[0].approvalUrl).toBe(`/approvals/${ID}`);
  });

  it('generates 256-bit url-safe ids by default', async () => {
    const client = new FakeDocumentClient();
    const notifier = new RecordingNotifier();
    await createRequestApprovalHandler({ client, tableName: 't', notifier, approvalTtlSeconds: 60 })(event);
    const url = notifier.ofType('approval_required')[0].approvalUrl;
    expect(url).toMatch(/^\/approvals\/[A-Za-z0-9_-]{43}$/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/handlers/request-approval.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Implement**

`packages/runtime/src/handlers/request-approval.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ApprovalRequest } from '../agent/graph.js';
import type { DocumentClientLike } from '../checkpointer/dynamodb-saver.js';
import type { Notifier } from '../notify.js';

export interface RequestApprovalEvent {
  taskToken: string;
  runId: string;
  input: { threadId: string; connectionId?: string | null; step: { status: 'interrupted'; interrupt: ApprovalRequest }; [k: string]: unknown };
}

export interface RequestApprovalDeps {
  client: DocumentClientLike;
  tableName: string;
  notifier: Notifier;
  approvalBaseUrl?: string;
  approvalTtlSeconds: number;
  now?: () => number;
  newApprovalId?: () => string;
}

export function hashApprovalId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

export function approvalKey(id: string): { pk: string; sk: 'approval' } {
  return { pk: `approval#${hashApprovalId(id)}`, sk: 'approval' };
}

export function createRequestApprovalHandler(deps: RequestApprovalDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newApprovalId ?? (() => randomBytes(32).toString('base64url'));
  const base = (deps.approvalBaseUrl ?? '').replace(/\/+$/, '');

  return async (event: RequestApprovalEvent): Promise<{ approvalRequested: true }> => {
    const approvalId = newId();
    const nowSec = Math.floor(now() / 1000);
    const expiresAt = nowSec + deps.approvalTtlSeconds;
    const toolCalls = event.input.step.interrupt.toolCalls;
    await deps.client.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        ...approvalKey(approvalId), kind: 'approval',
        taskToken: event.taskToken, runId: event.runId, threadId: event.input.threadId,
        toolCalls: JSON.stringify(toolCalls), createdAt: nowSec, expiresAt,
      },
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'pk' },
    }));
    await deps.notifier.send(event.input.connectionId, {
      type: 'approval_required',
      runId: event.runId,
      approvalUrl: `${base}/approvals/${approvalId}`,
      toolCalls,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    });
    return { approvalRequested: true };
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/handlers/request-approval.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/handlers/request-approval.ts packages/runtime/test/handlers/request-approval.test.ts
git commit -m "feat(runtime): issue single-use approval links for Step Functions task tokens"
```

**Acceptance:**
- Only the hash is stored.
- The URL holds a 43-character base64url id.
- `expiresAt` is exact.
- A relative URL is used when no base is set.

---

### Task 15: approvalCallback handler (HTTPS)

**Files:**
- Create: `packages/runtime/src/handlers/approval-callback.ts`
- Test: `packages/runtime/test/handlers/approval-callback.test.ts`

**Interfaces:**
```ts
export interface ApprovalCallbackDeps { client: DocumentClientLike; tableName: string; sfn: { send(command: any): Promise<any> }; now?: () => number }
export function createApprovalCallbackHandler(deps): (event: APIGatewayProxyEventV2-like) => Promise<{ statusCode: number; headers: Record<string,string>; body: string }>;
```
Responses are JSON with header `content-type: application/json`:

| Status | Body | When |
|---|---|---|
| 200 | `{"status":"approved"\|"rejected","runId":...}` | success |
| 400 | `{"error":"invalid_request","message":...}` | bad body, decision or comment |
| 404 | `{"error":"not_found"}` | malformed id, unknown id or already used |
| 410 | `{"error":"expired"}` | expired item, or SFN `TaskTimedOut`/`TaskDoesNotExist`/`InvalidToken` |
| 502 | `{"error":"upstream_error"}` | any other SFN error, after re-inserting the item |

Validation happens **before** the claim, so a bad request never consumes the approval. The id regex is `^[A-Za-z0-9_-]{43}$`. `comment` is an optional string of at most 1000 characters. The body may be base64-encoded (`isBase64Encoded`).

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/handlers/approval-callback.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { createApprovalCallbackHandler } from '../../src/handlers/approval-callback.js';
import { approvalKey } from '../../src/handlers/request-approval.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

const ID = 'B'.repeat(43);
const NOW = 1_700_000_000_000;

class FakeSfn {
  readonly commands: SendTaskSuccessCommand[] = [];
  failWith?: Error;
  async send(cmd: SendTaskSuccessCommand) {
    this.commands.push(cmd);
    if (this.failWith) throw this.failWith;
    return {};
  }
}

function setup(expiresAt = NOW / 1000 + 600) {
  const client = new FakeDocumentClient();
  client.putRaw({ ...approvalKey(ID), kind: 'approval', taskToken: 'tok', runId: 'run-1', threadId: 't1', expiresAt });
  const sfn = new FakeSfn();
  const handler = createApprovalCallbackHandler({ client, tableName: 't', sfn, now: () => NOW });
  return { client, sfn, handler };
}

const ev = (body: unknown, id = ID, base64 = false) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return { pathParameters: { approvalId: id }, body: base64 ? Buffer.from(raw).toString('base64') : raw, isBase64Encoded: base64 };
};
const json = (r: { body: string }) => JSON.parse(r.body);

describe('approvalCallback handler', () => {
  it('approves: resumes the execution with approved=true and consumes the link', async () => {
    const { handler, sfn, client } = setup();
    const res = await handler(ev({ decision: 'approve' }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ status: 'approved', runId: 'run-1' });
    expect(sfn.commands[0].input).toEqual({ taskToken: 'tok', output: JSON.stringify({ approved: true }) });
    expect(client.allItems()).toHaveLength(0);
  });

  it('rejects with a comment', async () => {
    const { handler, sfn } = setup();
    const res = await handler(ev({ decision: 'reject', comment: 'not now' }));
    expect(json(res)).toEqual({ status: 'rejected', runId: 'run-1' });
    expect(JSON.parse(String(sfn.commands[0].input.output))).toEqual({ approved: false, comment: 'not now' });
  });

  it('is single use', async () => {
    const { handler } = setup();
    await handler(ev({ decision: 'approve' }));
    const again = await handler(ev({ decision: 'approve' }));
    expect(again.statusCode).toBe(404);
  });

  it('accepts base64-encoded bodies', async () => {
    const { handler } = setup();
    expect((await handler(ev({ decision: 'approve' }, ID, true))).statusCode).toBe(200);
  });

  it.each([
    ['non-JSON body', 'nope'],
    ['unknown decision', { decision: 'maybe' }],
    ['non-string comment', { decision: 'approve', comment: 5 }],
    ['overlong comment', { decision: 'approve', comment: 'x'.repeat(1001) }],
  ])('returns 400 for %s without consuming the approval', async (_name, body) => {
    const { handler, client, sfn } = setup();
    const res = await handler(ev(body));
    expect(res.statusCode).toBe(400);
    expect(client.allItems()).toHaveLength(1);
    expect(sfn.commands).toHaveLength(0);
  });

  it('returns 404 for malformed and unknown ids', async () => {
    const { handler } = setup();
    expect((await handler(ev({ decision: 'approve' }, 'short'))).statusCode).toBe(404);
    expect((await handler(ev({ decision: 'approve' }, 'C'.repeat(43)))).statusCode).toBe(404);
  });

  it('returns 410 for an expired approval and does not resume', async () => {
    const { handler, sfn } = setup(NOW / 1000 - 1);
    expect((await handler(ev({ decision: 'approve' }))).statusCode).toBe(410);
    expect(sfn.commands).toHaveLength(0);
  });

  it('returns 410 when Step Functions says the task timed out', async () => {
    const { handler, sfn } = setup();
    sfn.failWith = Object.assign(new Error('timed out'), { name: 'TaskTimedOut' });
    expect((await handler(ev({ decision: 'approve' }))).statusCode).toBe(410);
  });

  it('restores the approval and returns 502 on transient Step Functions errors', async () => {
    const { handler, sfn, client } = setup();
    sfn.failWith = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    expect((await handler(ev({ decision: 'approve' }))).statusCode).toBe(502);
    expect(client.allItems()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/handlers/approval-callback.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Implement**

`packages/runtime/src/handlers/approval-callback.ts`:
```ts
import { SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentClientLike } from '../checkpointer/dynamodb-saver.js';
import { approvalKey } from './request-approval.js';

export interface ApprovalCallbackDeps {
  client: DocumentClientLike;
  tableName: string;
  sfn: { send(command: any): Promise<any> };
  now?: () => number;
}

export interface HttpEvent { pathParameters?: Record<string, string | undefined> | null; body?: string | null; isBase64Encoded?: boolean }
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }

const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const TERMINAL_SFN_ERRORS = new Set(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken']);

const respond = (statusCode: number, body: unknown): HttpResult => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const badRequest = (message: string) => respond(400, { error: 'invalid_request', message });

export function createApprovalCallbackHandler(deps: ApprovalCallbackDeps) {
  const now = deps.now ?? Date.now;

  return async (event: HttpEvent): Promise<HttpResult> => {
    const approvalId = event.pathParameters?.approvalId;
    if (!approvalId || !ID_RE.test(approvalId)) return respond(404, { error: 'not_found' });

    let parsed: unknown;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
      parsed = JSON.parse(raw);
    } catch {
      return badRequest('Body must be JSON: {"decision":"approve"|"reject","comment"?:string}');
    }
    const { decision, comment } = (parsed ?? {}) as { decision?: unknown; comment?: unknown };
    if (decision !== 'approve' && decision !== 'reject') return badRequest('decision must be "approve" or "reject"');
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > 1000)) return badRequest('comment must be a string of at most 1000 characters');

    let item: Record<string, any> | undefined;
    try {
      const out = await deps.client.send(new DeleteCommand({
        TableName: deps.tableName, Key: approvalKey(approvalId),
        ConditionExpression: 'attribute_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' }, ReturnValues: 'ALL_OLD',
      }));
      item = out.Attributes;
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return respond(404, { error: 'not_found' });
      throw err;
    }
    if (!item) return respond(404, { error: 'not_found' });
    if (typeof item.expiresAt === 'number' && item.expiresAt <= Math.floor(now() / 1000)) return respond(410, { error: 'expired' });

    const approved = decision === 'approve';
    const output = comment === undefined ? { approved } : { approved, comment };
    try {
      await deps.sfn.send(new SendTaskSuccessCommand({ taskToken: item.taskToken, output: JSON.stringify(output) }));
    } catch (err) {
      if (TERMINAL_SFN_ERRORS.has((err as Error).name)) return respond(410, { error: 'expired' });
      await deps.client.send(new PutCommand({ TableName: deps.tableName, Item: item }));
      console.warn(`approvalCallback: restored approval for run ${item.runId} after ${(err as Error).name}`);
      return respond(502, { error: 'upstream_error' });
    }
    return respond(200, { status: approved ? 'approved' : 'rejected', runId: item.runId });
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/handlers/approval-callback.test.ts`
Expected: 13 tests pass (9 named tests plus 4 `it.each` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/handlers/approval-callback.ts packages/runtime/test/handlers/approval-callback.test.ts
git commit -m "feat(runtime): add single-use HTTPS approval callback that resumes Step Functions"
```

**Acceptance:**
- Every status-code row in the table above is covered.
- A bad request never consumes an approval.
- A transient error restores the item.

---

### Task 16: WebSocket handler (start runs)

**Files:**
- Create: `packages/runtime/src/handlers/websocket.ts`
- Test: `packages/runtime/test/handlers/websocket.test.ts`

**Interfaces:**
```ts
export interface WebSocketDeps { sfn: { send(command: any): Promise<any> }; stateMachineArn: string; newRunId?: () => string /* randomUUID */ }
export interface WsEvent { requestContext: { routeKey: string; connectionId: string }; body?: string | null }
export function createWebSocketHandler(deps): (event: WsEvent) => Promise<{ statusCode: number; body?: string }>;
```
- `$connect` and `$disconnect` return 200.
- Any other route parses `{ action: 'run', threadId, message }`:
  - `threadId` must match `^[A-Za-z0-9_-]{1,128}$`;
  - `message` must be a string of 1 to 16,000 characters.
- If valid, call `StartExecutionCommand({ stateMachineArn, name: runId, input: JSON.stringify({ threadId, message, connectionId }) })` and return `200 { type: 'run_accepted', runId }`. If invalid, return 400 `{ type: 'error', error }` without calling Step Functions.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/handlers/websocket.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { createWebSocketHandler } from '../../src/handlers/websocket.js';

class FakeSfn {
  readonly commands: StartExecutionCommand[] = [];
  async send(cmd: StartExecutionCommand) { this.commands.push(cmd); return { executionArn: 'arn:exec' }; }
}

function setup() {
  const sfn = new FakeSfn();
  const handler = createWebSocketHandler({ sfn, stateMachineArn: 'arn:sm', newRunId: () => 'run-1' });
  return { sfn, handler };
}
const msg = (body: unknown, routeKey = '$default') => ({ requestContext: { routeKey, connectionId: 'conn-1' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('websocket handler', () => {
  it('accepts connect and disconnect', async () => {
    const { handler } = setup();
    expect((await handler(msg(null, '$connect'))).statusCode).toBe(200);
    expect((await handler(msg(null, '$disconnect'))).statusCode).toBe(200);
  });

  it('starts a Step Functions execution named after the run id with the connection id', async () => {
    const { handler, sfn } = setup();
    const res = await handler(msg({ action: 'run', threadId: 'thread-1', message: 'hello' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ type: 'run_accepted', runId: 'run-1' });
    expect(sfn.commands[0].input).toEqual({ stateMachineArn: 'arn:sm', name: 'run-1', input: JSON.stringify({ threadId: 'thread-1', message: 'hello', connectionId: 'conn-1' }) });
  });

  it.each([
    ['non-JSON', 'oops'],
    ['wrong action', { action: 'delete', threadId: 't', message: 'm' }],
    ['bad threadId', { action: 'run', threadId: 'a#b', message: 'm' }],
    ['empty message', { action: 'run', threadId: 't', message: '' }],
    ['huge message', { action: 'run', threadId: 't', message: 'x'.repeat(16_001) }],
  ])('rejects %s with 400 and does not start a run', async (_n, body) => {
    const { handler, sfn } = setup();
    expect((await handler(msg(body))).statusCode).toBe(400);
    expect(sfn.commands).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/handlers/websocket.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Implement**

`packages/runtime/src/handlers/websocket.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';

export interface WebSocketDeps { sfn: { send(command: any): Promise<any> }; stateMachineArn: string; newRunId?: () => string }
export interface WsEvent { requestContext: { routeKey: string; connectionId: string }; body?: string | null }

const THREAD_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_MESSAGE_CHARS = 16_000;
const error = (e: string) => ({ statusCode: 400, body: JSON.stringify({ type: 'error', error: e }) });

export function createWebSocketHandler(deps: WebSocketDeps) {
  const newRunId = deps.newRunId ?? randomUUID;
  return async (event: WsEvent): Promise<{ statusCode: number; body?: string }> => {
    const { routeKey, connectionId } = event.requestContext;
    if (routeKey === '$connect' || routeKey === '$disconnect') return { statusCode: 200 };
    let body: { action?: unknown; threadId?: unknown; message?: unknown };
    try {
      body = JSON.parse(event.body ?? '');
    } catch {
      return error('Body must be JSON: {"action":"run","threadId":"...","message":"..."}');
    }
    if (body?.action !== 'run') return error('action must be "run"');
    if (typeof body.threadId !== 'string' || !THREAD_RE.test(body.threadId)) return error('threadId must match ^[A-Za-z0-9_-]{1,128}$');
    if (typeof body.message !== 'string' || body.message.length === 0 || body.message.length > MAX_MESSAGE_CHARS) return error(`message must be 1-${MAX_MESSAGE_CHARS} characters`);
    const runId = newRunId();
    await deps.sfn.send(new StartExecutionCommand({
      stateMachineArn: deps.stateMachineArn,
      name: runId,
      input: JSON.stringify({ threadId: body.threadId, message: body.message, connectionId }),
    }));
    return { statusCode: 200, body: JSON.stringify({ type: 'run_accepted', runId }) };
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/handlers/websocket.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/handlers/websocket.ts packages/runtime/test/handlers/websocket.test.ts
git commit -m "feat(runtime): start agent runs from WebSocket messages"
```

**Acceptance:**
- Invalid input never starts an execution.
- The execution name is the runId.
- The connection id is passed through.

---

### Task 17: Lambda entrypoints, runtime exports and the esbuild bundle

**Files:**
- Create: `packages/runtime/src/handlers/index.ts`
- Modify: `packages/runtime/src/index.ts`
- Create: `packages/construct/scripts/bundle-runtime.mjs`
- Modify: `packages/construct/package.json` (restore the `bundle` step in `build` and `test`)
- Test: `packages/construct/test/bundle.test.ts`, `packages/runtime/test/exports.test.ts`

**Interfaces:**
- `handlers/index.ts` exports `agentStep`, `requestApproval`, `approvalCallback` and `wsHandler`. Each one builds its dependencies **lazily on first invocation** from `process.env`, so importing the module with no environment set must not throw.
- Environment variables per handler (the construct sets exactly these in Task 20):

| Handler | Required | Optional |
|---|---|---|
| agentStep | `AGENT_NAME`, `TABLE_NAME`, `MODEL_PROVIDER`, `MODEL_ID` | `MODEL_BASE_URL`, `MODEL_API_KEY_SECRET_ARN`, `PRICE_INPUT_USD_PER_MTOK`, `PRICE_OUTPUT_USD_PER_MTOK`, `CHECKPOINT_TTL_SECONDS`, `TOOLS_REQUIRING_APPROVAL`, `RECURSION_LIMIT` (25), `SYSTEM_PROMPT`, `WEBSOCKET_CALLBACK_URL` |
| requestApproval | `TABLE_NAME`, `APPROVAL_TTL_SECONDS` | `APPROVAL_BASE_URL`, `WEBSOCKET_CALLBACK_URL` |
| approvalCallback | `TABLE_NAME` | (none) |
| wsHandler | `STATE_MACHINE_ARN` | (none) |

- Without `WEBSOCKET_CALLBACK_URL`, the notifier is `NullNotifier`. With it, use `ApiGatewayNotifier(new ApiGatewayManagementApiClient({ endpoint: WEBSOCKET_CALLBACK_URL }))`.
- Bundle output: `packages/construct/assets/runtime/index.mjs`.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/exports.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import * as runtime from '../src/index.js';
import * as handlers from '../src/handlers/index.js';

describe('runtime public surface', () => {
  it('exports the checkpointer, graph builder and handler factories', () => {
    for (const name of ['DynamoDBSaver', 'buildAgentGraph', 'demoTools', 'createChatModel', 'createAgentStepHandler', 'createRequestApprovalHandler', 'createApprovalCallbackHandler', 'createWebSocketHandler', 'ApiGatewayNotifier', 'TokenBatcher', 'estimateCostUsd', 'buildEmfRecord']) {
      expect(runtime, name).toHaveProperty(name);
    }
  });

  it('exposes four lazily configured Lambda entrypoints that import without env vars', () => {
    expect(Object.keys(handlers).sort()).toEqual(['agentStep', 'approvalCallback', 'requestApproval', 'wsHandler']);
    for (const fn of Object.values(handlers)) expect(typeof fn).toBe('function');
  });

  it('fails clearly on first invocation when configuration is missing', async () => {
    const before = process.env.STATE_MACHINE_ARN;
    delete process.env.STATE_MACHINE_ARN;
    await expect(handlers.wsHandler({ requestContext: { routeKey: '$default', connectionId: 'c' }, body: '{}' } as never)).rejects.toThrow('Missing required environment variable STATE_MACHINE_ARN');
    if (before !== undefined) process.env.STATE_MACHINE_ARN = before;
  });
});
```

`packages/construct/test/bundle.test.ts`:
```ts
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNTIME_ASSET_DIR } from '../src/runtime-code';

describe('runtime bundle', () => {
  const file = join(RUNTIME_ASSET_DIR, 'index.mjs');

  it('exists and is a reasonable size', () => {
    expect(existsSync(file)).toBe(true);
    const mib = statSync(file).size / 1024 / 1024;
    expect(mib).toBeGreaterThan(0.1);
    expect(mib).toBeLessThan(40);
  });

  it('exports the four Lambda handlers and imports without environment variables', async () => {
    const mod = await import(pathToFileURL(file).href);
    for (const name of ['agentStep', 'requestApproval', 'approvalCallback', 'wsHandler']) expect(typeof mod[name], name).toBe('function');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/runtime exec vitest run test/exports.test.ts`
Expected: FAIL, `../src/handlers/index.js` is not found.

- [ ] **Step 3: Implement the runtime exports and entrypoints**

`packages/runtime/src/index.ts` (replace the whole file):
```ts
export const RUNTIME_VERSION = '0.1.0';
export * from './checkpointer/dynamodb-saver.js';
export * from './checkpointer/errors.js';
export * from './agent/graph.js';
export * from './agent/tools.js';
export * from './agent/model.js';
export * from './metrics.js';
export * from './notify.js';
export * from './config.js';
export * from './handlers/agent-step.js';
export * from './handlers/request-approval.js';
export * from './handlers/approval-callback.js';
export * from './handlers/websocket.js';
```

`packages/runtime/src/handlers/index.ts`:
```ts
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
```

- [ ] **Step 4: Run the runtime tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/runtime test`
Expected: every runtime test passes, including the 3 new export tests.

- [ ] **Step 5: Implement the bundle script and the runtime-code helper**

`packages/construct/scripts/bundle-runtime.mjs`:
```js
import { build } from 'esbuild';
import { rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../../runtime/src/handlers/index.ts');
const outdir = path.resolve(here, '../assets/runtime');
const outfile = path.join(outdir, 'index.mjs');

rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __sa_createRequire } from 'node:module'; const require = __sa_createRequire(import.meta.url);" },
});
const mib = statSync(outfile).size / 1024 / 1024;
console.log(`bundled runtime -> ${path.relative(process.cwd(), outfile)} (${mib.toFixed(2)} MiB)`);
```

`packages/construct/src/runtime-code.ts`:
```ts
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/** Directory of the prebundled runtime (ADR 0008). Same path from src/ (tests) and lib/ (published). */
export const RUNTIME_ASSET_DIR = path.join(__dirname, '..', 'assets', 'runtime');

export function runtimeCode(): lambda.Code {
  if (!existsSync(path.join(RUNTIME_ASSET_DIR, 'index.mjs'))) {
    throw new Error(`ServerlessAgent runtime bundle not found in ${RUNTIME_ASSET_DIR}. Run "pnpm --filter @serverless-agent/construct run bundle" first.`);
  }
  return lambda.Code.fromAsset(RUNTIME_ASSET_DIR);
}
```

Restore the construct scripts in `packages/construct/package.json`:
```json
    "build": "pnpm run bundle && tsc -p tsconfig.build.json",
    "test": "pnpm run bundle && vitest run"
```

- [ ] **Step 6: Run the construct tests (they bundle first) and confirm they pass**

Run: `pnpm --filter @serverless-agent/construct test`
Expected: the output contains `bundled runtime -> assets/runtime/index.mjs (N MiB)`. The bundle and smoke tests pass (3 tests). Record N for the handoff. If esbuild warns about `import.meta` or fails to resolve an optional dependency of LangChain or the AWS SDK, mark only that specific package as `external` in the script, with a comment explaining why. The bundle test must still import cleanly.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src packages/runtime/test/exports.test.ts packages/construct/scripts packages/construct/src/runtime-code.ts packages/construct/test/bundle.test.ts packages/construct/package.json
git commit -m "build(construct): bundle runtime Lambda handlers with esbuild"
```

**Acceptance:**
- 4 lazily configured entrypoints.
- A missing environment variable gives a clear error on first call.
- The bundle exists, is under 40 MiB and imports cleanly.

---

### Task 18: AgentModel (provider choice plus least-privilege grants)

**Files:**
- Create: `packages/construct/src/agent-model.ts`
- Modify: `packages/construct/src/index.ts`
- Create: `packages/construct/test/support/template-helpers.ts`
- Test: `packages/construct/test/agent-model.test.ts`

**Interfaces:**
```ts
export interface ModelPricing { readonly inputUsdPerMillionTokens: number; readonly outputUsdPerMillionTokens: number }
export interface BedrockModelOptions { readonly pricing?: ModelPricing }
export interface OpenAiCompatibleModelProps { readonly baseUrl: string; readonly modelId: string; readonly apiKeySecret?: secretsmanager.ISecret; readonly pricing?: ModelPricing }
export interface AgentModelBinding { readonly environment: { [key: string]: string } }
export abstract class AgentModel {
  static readonly DEFAULT_BEDROCK_MODEL_ID = 'amazon.nova-lite-v1:0';
  static readonly DEFAULT_BEDROCK_PRICING: ModelPricing;              // 0.06 / 0.24 USD per 1M tokens (ESTIMATE)
  static bedrock(modelId?: string, options?: BedrockModelOptions): AgentModel;
  static openAiCompatible(props: OpenAiCompatibleModelProps): AgentModel;
  abstract readonly modelId: string;
  abstract bind(grantee: iam.IGrantable): AgentModelBinding;          // grants + env vars
}
```
Environment variables returned:
- `MODEL_PROVIDER` (`bedrock` | `openai-compatible`)
- `MODEL_ID`
- `MODEL_BASE_URL` (OpenAI-compatible only)
- `MODEL_API_KEY_SECRET_ARN` (when a secret is given)
- `PRICE_INPUT_USD_PER_MTOK`, `PRICE_OUTPUT_USD_PER_MTOK`

- [ ] **Step 1: Write the template helpers (shared by every construct test)**

`packages/construct/test/support/template-helpers.ts`:
```ts
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ServerlessAgent, type ServerlessAgentProps } from '../../src';

export function synthAgent(props?: ServerlessAgentProps) {
  const app = new App();
  const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const agent = new ServerlessAgent(stack, 'Agent', props);
  return { app, stack, agent, template: Template.fromStack(stack) };
}

/** Flattens CFN intrinsics into a readable string so tests can match ARNs. */
export function flat(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(flat).join(',');
  if (v && typeof v === 'object') {
    const o = v as Record<string, any>;
    if (o['Fn::Join']) return (o['Fn::Join'][1] as unknown[]).map(flat).join(o['Fn::Join'][0]);
    if (o.Ref) return `{${o.Ref}}`;
    if (o['Fn::GetAtt']) return `{${([] as string[]).concat(o['Fn::GetAtt']).join('.')}}`;
    return JSON.stringify(o);
  }
  return String(v);
}

export interface Stmt { Effect: string; Action?: string | string[]; NotAction?: unknown; Resource?: unknown; roles: string[] }

export const actionsOf = (s: Stmt): string[] => ([] as string[]).concat(s.Action ?? []);

export function allStatements(t: Template): Stmt[] {
  const out: Stmt[] = [];
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
    const roles = (p.Properties.Roles ?? []).map((r: any) => r.Ref);
    for (const s of p.Properties.PolicyDocument.Statement) out.push({ ...s, roles });
  }
  for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role')) as [string, any][]) {
    for (const pol of r.Properties.Policies ?? []) for (const s of pol.PolicyDocument.Statement) out.push({ ...s, roles: [id] });
  }
  return out;
}

export function roleOfFunction(t: Template, handler: string): string {
  const fns = Object.values(t.findResources('AWS::Lambda::Function', { Properties: { Handler: handler } })) as any[];
  if (fns.length !== 1) throw new Error(`expected exactly one function with handler ${handler}, found ${fns.length}`);
  return fns[0].Properties.Role['Fn::GetAtt'][0];
}

export function statementsForFunction(t: Template, handler: string): Stmt[] {
  const role = roleOfFunction(t, handler);
  return allStatements(t).filter((s) => s.roles.includes(role));
}

export function definitionOf(t: Template): any {
  const sm = Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0] as any;
  const ds = sm.Properties.DefinitionString;
  const text = typeof ds === 'string' ? ds : (ds['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('');
  return JSON.parse(text);
}
```

- [ ] **Step 2: Write the failing tests**

`packages/construct/test/agent-model.test.ts`:
```ts
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
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/construct exec vitest run test/agent-model.test.ts`
Expected: FAIL, `AgentModel` is not exported (an import error or `undefined`).

- [ ] **Step 4: Implement**

`packages/construct/src/agent-model.ts`:
```ts
import { Aws, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface ModelPricing {
  /** USD per 1M input tokens (used for ESTIMATED cost metrics only). */
  readonly inputUsdPerMillionTokens: number;
  /** USD per 1M output tokens (used for ESTIMATED cost metrics only). */
  readonly outputUsdPerMillionTokens: number;
}

export interface BedrockModelOptions { readonly pricing?: ModelPricing }

export interface OpenAiCompatibleModelProps {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKeySecret?: secretsmanager.ISecret;
  readonly pricing?: ModelPricing;
}

export interface AgentModelBinding { readonly environment: { [key: string]: string } }

const ZERO: ModelPricing = { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };
const priceEnv = (p: ModelPricing) => ({
  PRICE_INPUT_USD_PER_MTOK: String(p.inputUsdPerMillionTokens),
  PRICE_OUTPUT_USD_PER_MTOK: String(p.outputUsdPerMillionTokens),
});

export abstract class AgentModel {
  public static readonly DEFAULT_BEDROCK_MODEL_ID = 'amazon.nova-lite-v1:0';
  /** ESTIMATE of Amazon Nova Lite on-demand pricing (verify on the Bedrock pricing page). */
  public static readonly DEFAULT_BEDROCK_PRICING: ModelPricing = { inputUsdPerMillionTokens: 0.06, outputUsdPerMillionTokens: 0.24 };

  public static bedrock(modelId?: string, options?: BedrockModelOptions): AgentModel {
    return new BedrockModel(modelId ?? AgentModel.DEFAULT_BEDROCK_MODEL_ID, options ?? {});
  }

  public static openAiCompatible(props: OpenAiCompatibleModelProps): AgentModel {
    return new OpenAiCompatibleModel(props);
  }

  public abstract readonly modelId: string;
  public abstract bind(grantee: iam.IGrantable): AgentModelBinding;
}

class BedrockModel extends AgentModel {
  constructor(public readonly modelId: string, private readonly options: BedrockModelOptions) {
    super();
    if (!modelId) throw new Error('AgentModel.bedrock: modelId must not be empty');
  }

  public bind(grantee: iam.IGrantable): AgentModelBinding {
    const profile = /^(us|eu|apac|us-gov|global)\.(.+)$/.exec(this.modelId);
    const resourceArns = profile
      ? [
          `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/${this.modelId}`,
          `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${profile[2]}`,
        ]
      : [`arn:${Aws.PARTITION}:bedrock:${Aws.REGION}::foundation-model/${this.modelId}`];
    iam.Grant.addToPrincipal({ grantee, actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resourceArns });
    const pricing = this.options.pricing ?? (this.modelId === AgentModel.DEFAULT_BEDROCK_MODEL_ID ? AgentModel.DEFAULT_BEDROCK_PRICING : ZERO);
    return { environment: { MODEL_PROVIDER: 'bedrock', MODEL_ID: this.modelId, ...priceEnv(pricing) } };
  }
}

class OpenAiCompatibleModel extends AgentModel {
  public readonly modelId: string;

  constructor(private readonly props: OpenAiCompatibleModelProps) {
    super();
    if (!Token.isUnresolved(props.baseUrl) && !/^https?:\/\//.test(props.baseUrl)) {
      throw new Error(`AgentModel.openAiCompatible: baseUrl must start with http:// or https:// (got "${props.baseUrl}")`);
    }
    if (!props.modelId) throw new Error('AgentModel.openAiCompatible: modelId must not be empty');
    this.modelId = props.modelId;
  }

  public bind(grantee: iam.IGrantable): AgentModelBinding {
    const environment: { [key: string]: string } = {
      MODEL_PROVIDER: 'openai-compatible', MODEL_ID: this.modelId, MODEL_BASE_URL: this.props.baseUrl,
      ...priceEnv(this.props.pricing ?? ZERO),
    };
    if (this.props.apiKeySecret) {
      this.props.apiKeySecret.grantRead(grantee);
      environment.MODEL_API_KEY_SECRET_ARN = this.props.apiKeySecret.secretArn;
    }
    return { environment };
  }
}
```

`packages/construct/src/index.ts`:
```ts
export const CONSTRUCT_VERSION = '0.1.0';
export * from './agent-model';
```
(Task 19 adds `export * from './serverless-agent';`. `template-helpers.ts` imports `ServerlessAgent`, which does not exist yet. Vitest strips types, so the import resolves to `undefined` and the agent-model tests still run. If the type-only import of `ServerlessAgentProps` breaks typecheck, leave typecheck until Task 19.)

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/construct exec vitest run test/agent-model.test.ts`
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/construct/src packages/construct/test
git commit -m "feat(construct): add pluggable AgentModel with least-privilege grants"
```

**Acceptance:**
- Bedrock grants are scoped to the model, or to the profile plus the model.
- OpenAI-compatible grants only the secret, or nothing.
- Pricing environment variables are set.
- A bad URL is rejected.

---

### Task 19: ServerlessAgent core (table, functions, environment, tags, validation)

**Files:**
- Create: `packages/construct/src/serverless-agent.ts`
- Modify: `packages/construct/src/index.ts` (add `export * from './serverless-agent';`)
- Test: `packages/construct/test/serverless-agent-core.test.ts`

**Interfaces:**
```ts
export interface ServerlessAgentProps {
  readonly agentName?: string;                 // default: construct id; /^[A-Za-z0-9-]{1,40}$/
  readonly model?: AgentModel;                 // default AgentModel.bedrock()
  readonly toolsRequiringApproval?: string[];  // default ['send_email']
  readonly systemPrompt?: string;
  readonly approvalTimeout?: Duration;         // default 24h; must be < maxRunDuration
  readonly maxRunDuration?: Duration;          // default 7 days (Task 20)
  readonly checkpointTtl?: Duration;           // default 30 days
  readonly agentTimeout?: Duration;            // default 5 min
  readonly agentMemorySize?: number;           // default 1024
  readonly recursionLimit?: number;            // default 25
  readonly webSocketApi?: boolean;             // default true
  readonly architecture?: lambda.Architecture; // default ARM_64
  readonly lambdaRuntime?: lambda.Runtime;     // default NODEJS_24_X
  readonly logRetention?: logs.RetentionDays;  // default ONE_MONTH
  readonly removalPolicy?: RemovalPolicy;      // table; default RETAIN
}
export class ServerlessAgent extends Construct {
  readonly agentName: string;
  readonly table: dynamodb.Table;
  readonly agentFunction: lambda.Function;            // handler index.agentStep
  readonly requestApprovalFunction: lambda.Function;  // handler index.requestApproval
  readonly approvalCallbackFunction: lambda.Function; // handler index.approvalCallback
  readonly webSocketApi?: apigwv2.WebSocketApi;
  readonly webSocketStage?: apigwv2.WebSocketStage;
  readonly webSocketUrl?: string;
  // Task 20 adds: readonly stateMachine: sfn.StateMachine
  // Task 21 adds: readonly webSocketHandlerFunction?: lambda.Function; readonly approvalApi: apigw.RestApi; readonly approvalBaseUrl: string
}
```

- [ ] **Step 1: Write the failing tests**

`packages/construct/test/serverless-agent-core.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/construct exec vitest run test/serverless-agent-core.test.ts`
Expected: FAIL, `ServerlessAgent is not a constructor`.

- [ ] **Step 3: Implement**

`packages/construct/src/serverless-agent.ts`:
```ts
import { Duration, RemovalPolicy, Tags, Token } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
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

    Tags.of(this).add('serverless-agent:agent-name', this.agentName);
    Tags.of(this).add('serverless-agent:managed-by', 'serverless-agent-construct');
  }
}
```
Add `export * from './serverless-agent';` to `src/index.ts`.

If `WebSocketStage.callbackUrl` causes a dependency cycle at synth time, replace it with `` `https://${this.webSocketApi.apiId}.execute-api.${Stack.of(this).region}.${Stack.of(this).urlSuffix}/live` ``.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/construct test`
Expected: all construct tests pass. The core file contributes 10 tests. Fix the oddly named last test so its name reads `allows an empty approval list`. It is a deliberate check that `[]` disables approvals.

- [ ] **Step 5: Commit**

```bash
git add packages/construct/src packages/construct/test
git commit -m "feat(construct): add ServerlessAgent table, functions and cost tags"
```

**Acceptance:**
- Table: TTL, PITR, on-demand, retained.
- Three functions with exact handlers and environment variables.
- Overrides for the LocalStack profile work.
- Validation errors fire.

---

### Task 20: Step Functions run state machine with the waitForTaskToken approval loop

**Files:**
- Modify: `packages/construct/src/serverless-agent.ts`
- Test: `packages/construct/test/state-machine.test.ts`

**Interfaces:**
- Adds `public readonly stateMachine: sfn.StateMachine` (type STANDARD, timeout = `maxRunDuration`, logs at level ERROR without execution data).
- States:
  - `RunAgent`: LambdaInvoke, payload `{ runId: $$.Execution.Name, input: $ }`, `payloadResponseOnly`, resultPath `$.step`, catch everything to `RunFailed`.
  - `NeedsApproval?`: Choice, `$.step.status == "interrupted"` goes to `WaitForApproval`, otherwise `RunCompleted`.
  - `WaitForApproval`: LambdaInvoke `WAIT_FOR_TASK_TOKEN`, payload `{ taskToken, runId, input: $ }`, resultPath `$.resume`, `TimeoutSeconds = approvalTimeout`. Catches: `States.Timeout` to `ApprovalTimedOut`, all others to `RunFailed`. Next is `RunAgent`.
  - `RunCompleted` (Succeed), `RunFailed` (Fail, error `AgentRunFailed`), `ApprovalTimedOut` (Fail, error `ApprovalTimedOut`).
- `stateMachine.grantTaskResponse(approvalCallbackFunction)`.

- [ ] **Step 1: Write the failing tests**

`packages/construct/test/state-machine.test.ts`:
```ts
import { Duration } from 'aws-cdk-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { definitionOf, synthAgent } from './support/template-helpers';

describe('run state machine', () => {
  let def: any;
  let t: ReturnType<typeof synthAgent>['template'];
  beforeAll(() => { t = synthAgent().template; def = definitionOf(t); });

  it('is a STANDARD state machine starting at RunAgent', () => {
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD' });
    expect(def.StartAt).toBe('RunAgent');
    expect(def.TimeoutSeconds).toBe(7 * 24 * 3600);
  });

  it('passes run id and whole state to the agent and stores the result under $.step', () => {
    const s = def.States.RunAgent;
    expect(s.Parameters.Payload).toEqual({ 'runId.$': '$$.Execution.Name', 'input.$': '$' });
    expect(s.ResultPath).toBe('$.step');
    expect(s.Next).toBe('NeedsApproval?');
    expect(s.Catch[0].Next).toBe('RunFailed');
  });

  it('branches on interrupted', () => {
    const c = def.States['NeedsApproval?'];
    expect(c.Choices[0]).toMatchObject({ Variable: '$.step.status', StringEquals: 'interrupted', Next: 'WaitForApproval' });
    expect(c.Default).toBe('RunCompleted');
  });

  it('waits for a human with a task token, a timeout, and loops back to RunAgent', () => {
    const w = def.States.WaitForApproval;
    expect(w.Resource).toMatch(/:states:::lambda:invoke\.waitForTaskToken$/);
    expect(w.Parameters.Payload['taskToken.$']).toBe('$$.Task.Token');
    expect(w.Parameters.Payload['runId.$']).toBe('$$.Execution.Name');
    expect(w.TimeoutSeconds).toBe(86400);
    expect(w.ResultPath).toBe('$.resume');
    expect(w.Next).toBe('RunAgent');
    expect(w.Catch).toEqual(expect.arrayContaining([
      expect.objectContaining({ ErrorEquals: ['States.Timeout'], Next: 'ApprovalTimedOut' }),
      expect.objectContaining({ ErrorEquals: ['States.ALL'], Next: 'RunFailed' }),
    ]));
  });

  it('has terminal states', () => {
    expect(def.States.RunCompleted.Type).toBe('Succeed');
    expect(def.States.RunFailed).toMatchObject({ Type: 'Fail', Error: 'AgentRunFailed' });
    expect(def.States.ApprovalTimedOut).toMatchObject({ Type: 'Fail', Error: 'ApprovalTimedOut' });
  });

  it('honours approvalTimeout and maxRunDuration props', () => {
    const d = definitionOf(synthAgent({ approvalTimeout: Duration.hours(1), maxRunDuration: Duration.days(2) }).template);
    expect(d.States.WaitForApproval.TimeoutSeconds).toBe(3600);
    expect(d.TimeoutSeconds).toBe(2 * 24 * 3600);
  });

  it('lets only the approval callback send task responses', () => {
    const stmts = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(stmts).toContain('states:SendTaskSuccess');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/construct exec vitest run test/state-machine.test.ts`
Expected: FAIL, the template has no `AWS::StepFunctions::StateMachine` (`Cannot read properties of undefined`).

- [ ] **Step 3: Implement (append to the constructor, before the Tags lines)**

Add imports:
```ts
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
```
Add the field `public readonly stateMachine: sfn.StateMachine;` and this code:
```ts
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
```
If CDK rejects the `Payload` shape (the `.$` key naming) or adds `Retry` blocks with different keys, adjust the **test** expectations only where CDK's rendering differs cosmetically. The semantics (paths, timeout, loop, catches) must stay as specified.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/construct test`
Expected: all construct tests pass, 7 new.

- [ ] **Step 5: Commit**

```bash
git add packages/construct/src/serverless-agent.ts packages/construct/test/state-machine.test.ts
git commit -m "feat(construct): add Step Functions run loop with waitForTaskToken approval"
```

**Acceptance:**
- The exact state graph above.
- A task-token wait with a timeout.
- The loop back to `RunAgent`.
- `SendTaskSuccess` granted to the callback.

---

### Task 21: WebSocket API routes (IAM auth) and the REST approval API

**Files:**
- Modify: `packages/construct/src/serverless-agent.ts`
- Test: `packages/construct/test/apis.test.ts`

**Interfaces:**
- Adds:
  - `public readonly webSocketHandlerFunction?: lambda.Function` (handler `index.wsHandler`, environment `STATE_MACHINE_ARN`, `grantStartExecution`);
  - `public readonly approvalApi: apigw.RestApi`;
  - `public readonly approvalBaseUrl: string` (= `approvalApi.url`).
- WebSocket routes:
  - `$connect` uses `WebSocketIamAuthorizer`;
  - `$disconnect`;
  - `$default` with `returnResponse: true`.
- REST API:
  - `cloudWatchRole: false`, REGIONAL;
  - stage `v1` with throttling (rate 10, burst 20);
  - `POST /approvals/{approvalId}` with a Lambda proxy integration to `approvalCallbackFunction`;
  - `requestApprovalFunction` gets `APPROVAL_BASE_URL = approvalApi.url`.

- [ ] **Step 1: Write the failing tests**

`packages/construct/test/apis.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @serverless-agent/construct exec vitest run test/apis.test.ts`
Expected: FAIL, no `$connect` route and no `AWS::ApiGateway::RestApi`.

- [ ] **Step 3: Implement (after the state machine, before the Tags lines)**

Add imports:
```ts
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import { WebSocketIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
```
Add the fields `public readonly webSocketHandlerFunction?: lambda.Function; public readonly approvalApi: apigw.RestApi; public readonly approvalBaseUrl: string;` and this code:
```ts
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
    this.requestApprovalFunction.addEnvironment('APPROVAL_BASE_URL', this.approvalApi.url);
```

- [ ] **Step 4: Run all construct tests and confirm they pass**

Run: `pnpm --filter @serverless-agent/construct test`
Expected: all construct tests pass, 7 new.

- [ ] **Step 5: Commit**

```bash
git add packages/construct/src/serverless-agent.ts packages/construct/test/apis.test.ts
git commit -m "feat(construct): add IAM-authorized WebSocket API and throttled REST approval endpoint"
```

**Acceptance:**
- `$connect` uses `AWS_IAM`.
- The WebSocket API can be toggled off.
- The REST approval route is POST-only with a proxy integration and throttling.
- No API Gateway account role.

---

### Task 22: IAM least-privilege and scale-to-zero invariants

**Files:**
- Test: `packages/construct/test/invariants.test.ts`
- Modify (only if a test exposes a real over-grant): `packages/construct/src/serverless-agent.ts`

**Interfaces:**
- `STAR_RESOURCE_ALLOWLIST`: the CloudWatch Logs delivery actions that Step Functions logging needs (`logs:CreateLogDelivery`, `logs:GetLogDelivery`, `logs:UpdateLogDelivery`, `logs:DeleteLogDelivery`, `logs:ListLogDeliveries`, `logs:PutResourcePolicy`, `logs:DescribeResourcePolicies`, `logs:DescribeLogGroups`). Do not add to it without writing the reason in an ADR.

- [ ] **Step 1: Write the tests**

`packages/construct/test/invariants.test.ts`:
```ts
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
```

- [ ] **Step 2: Run them**

Run: `pnpm --filter @serverless-agent/construct exec vitest run test/invariants.test.ts`
Expected: PASS if Tasks 19–21 were implemented as written. These tests pin invariants, so they may pass on the first run. **Prove each one can fail:** temporarily add `actions: ['dynamodb:*']` via `this.agentFunction.addToRolePolicy(...)` in `serverless-agent.ts`, run the file, see `never uses a wildcard in an action` FAIL, then remove the line. Do the same with `resources: ['*']` on `dynamodb:GetItem` to see the Resource test fail.

If a test fails for real (for example `wsHandler` also gets `logs:*` from somewhere, or the managed-policy test finds another policy), fix the construct, never the test, unless the extra action is genuinely required. In that case document it in ADR 0008 and add it to the allowlist with a comment.

- [ ] **Step 3: Run the full construct suite**

Run: `pnpm --filter @serverless-agent/construct test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/construct/test/invariants.test.ts packages/construct/src
git commit -m "test(construct): enforce least-privilege IAM and scale-to-zero invariants"
```

**Acceptance:**
- No `*` actions.
- `Resource: "*"` only for the allowlist.
- Each function has only its own grants.
- No always-on resources.
- Each invariant was seen to fail once when deliberately broken.

---

### Task 23: Example app (two stacks) and `cdk synth`

**Files:**
- Create: `examples/basic/package.json`, `examples/basic/tsconfig.json`, `examples/basic/cdk.json`, `examples/basic/bin/app.ts`

**Interfaces:**
- Stack `ServerlessAgentExample` (AWS-shaped). Outputs: `WebSocketUrl`, `ApprovalApiUrl`, `StateMachineArn`, `TableName`.
- Stack `ServerlessAgentLocal` (LocalStack Hobby profile, ADR 0009):
  - synthesizer `CliCredentialsStackSynthesizer({ fileAssetsBucketName: 'serverless-agent-local-assets', bucketPrefix: 'assets/', generateBootstrapVersionRule: false })`;
  - outputs `StateMachineArn`, `TableName`, `AgentFunctionName`, `ApprovalCallbackFunctionName`, `ApprovalApiId`, `ApprovalApiStage`, `ApprovalApiUrl`.

This task is configuration plus an app entry point. Verification is the synth command.

- [ ] **Step 1: Write the example**

`examples/basic/package.json`:
```json
{
  "name": "@serverless-agent/example-basic",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "synth": "cdk synth --no-notices --quiet"
  }
}
```

Install from the repo root:
```bash
pnpm --filter @serverless-agent/example-basic add aws-cdk-lib@2.272.0 constructs@10.8.1 "@serverless-agent/construct@workspace:*"
pnpm --filter @serverless-agent/example-basic add -D aws-cdk@2.1144.0 tsx typescript@5.9.3 @types/node@24 @aws-sdk/client-s3 @aws-sdk/client-cloudformation fflate
```

`examples/basic/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "Node16", "moduleResolution": "Node16", "noEmit": true },
  "include": ["bin"]
}
```

`examples/basic/cdk.json`:
```json
{
  "app": "npx tsx bin/app.ts",
  "context": {}
}
```

`examples/basic/bin/app.ts`:
```ts
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
        generateBootstrapVersionRule: false,
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
```

- [ ] **Step 2: Build and synth**

Run: `pnpm build && pnpm synth`
Expected: exit 0. Then check:
```bash
node -e "for (const s of ['ServerlessAgentExample','ServerlessAgentLocal']) { const t=require('./examples/basic/cdk.out/'+s+'.template.json'); const types={}; for (const r of Object.values(t.Resources)) types[r.Type]=(types[r.Type]||0)+1; console.log(s, Object.keys(t.Resources).length, 'resources', JSON.stringify(types)); }"
```
Expected:
- `ServerlessAgentExample` includes `AWS::ApiGatewayV2::Api`, 4 `AWS::Lambda::Function`, 1 `AWS::StepFunctions::StateMachine`, 1 `AWS::DynamoDB::Table` and 1 `AWS::ApiGateway::RestApi`.
- `ServerlessAgentLocal` has no `AWS::ApiGatewayV2::*` and 3 functions.

Record the resource counts and the template sizes (`wc -c examples/basic/cdk.out/*.template.json`) for the handoff. If `npx tsx` is slow or fails on Windows, change `cdk.json` `app` to `"node --import tsx bin/app.ts"`.

- [ ] **Step 3: Commit**

```bash
git add examples/basic pnpm-lock.yaml
git commit -m "feat(examples): add AWS and LocalStack example stacks that synth offline"
```

**Acceptance:** `pnpm synth` produces both templates with the resource shapes listed above, with no credentials and no network.

---

### Task 24: Deterministic mock LLM and docker-compose

**Files:**
- Create: `docker/mock-llm/package.json`, `docker/mock-llm/script.mjs`, `docker/mock-llm/server.mjs`, `docker/mock-llm/server.test.mjs`
- Modify: `pnpm-workspace.yaml` (add `"docker/*"`)
- Create: `docker-compose.yml`
- Modify: root `package.json` (add the `local:up` and `local:down` scripts)

**Interfaces:**
- `decide(messages) => { content: string } | { toolCalls: Array<{ name: string; arguments: object }> }`:
  1. The last message has role `tool`. If its content starts with `Rejected by human reviewer`, return `{ content: 'Understood. I did not send the email.' }`. Otherwise return `{ content: 'Done. Tool result: ' + content }`.
  2. The last user text contains `email`: return the tool call `send_email({ to:'bob@example.com', subject:'Hello', body:'Hi Bob, this is a test.' })`.
  3. It contains `time`: return the tool call `get_current_time({})`.
  4. Otherwise return `{ content: 'mock-llm says hello. You said: <text>' }`.
- The server listens on `PORT` (default 8080) and serves:
  - `GET /health` returning 200 `{"ok":true}`;
  - `POST /v1/chat/completions` in OpenAI Chat Completions format, non-streaming and streaming (SSE; with `stream_options.include_usage`, a final usage chunk). Usage = ceil(chars/4).

- [ ] **Step 1: Write the failing test**

`docker/mock-llm/package.json`:
```json
{
  "name": "@serverless-agent/mock-llm",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": { "test": "vitest run", "start": "node server.mjs" }
}
```
Run: `pnpm --filter @serverless-agent/mock-llm add -D vitest@4.1.11` after adding `"docker/*"` to `pnpm-workspace.yaml`.

`docker/mock-llm/server.test.mjs`:
```js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decide } from './script.mjs';
import { createServer } from './server.mjs';

describe('decide', () => {
  it('asks to send an email for email requests', () => {
    expect(decide([{ role: 'user', content: 'Please email Bob' }])).toEqual({ toolCalls: [{ name: 'send_email', arguments: { to: 'bob@example.com', subject: 'Hello', body: 'Hi Bob, this is a test.' } }] });
  });
  it('asks for the time', () => {
    expect(decide([{ role: 'user', content: [{ type: 'text', text: 'What TIME is it?' }] }])).toEqual({ toolCalls: [{ name: 'get_current_time', arguments: {} }] });
  });
  it('summarises tool results and rejections', () => {
    expect(decide([{ role: 'user', content: 'email' }, { role: 'tool', content: 'Demo stub: ok' }])).toEqual({ content: 'Done. Tool result: Demo stub: ok' });
    expect(decide([{ role: 'tool', content: 'Rejected by human reviewer: no. The tool was not executed.' }])).toEqual({ content: 'Understood. I did not send the email.' });
  });
  it('echoes otherwise', () => {
    expect(decide([{ role: 'user', content: 'hi' }])).toEqual({ content: 'mock-llm says hello. You said: hi' });
  });
});

describe('server', () => {
  let server; let base;
  beforeAll(async () => {
    server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('answers health checks', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('returns OpenAI-shaped tool calls with usage (non-streaming)', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-llm', messages: [{ role: 'user', content: 'email bob' }] }) });
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({ type: 'function', function: { name: 'send_email' } });
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments).to).toBe('bob@example.com');
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('streams SSE chunks ending with [DONE] and a usage chunk', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-llm', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }) });
    const text = await res.text();
    const events = text.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('mock-llm says hello. You said: hi');
    expect(chunks.at(-1).usage.completion_tokens).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @serverless-agent/mock-llm test`
Expected: FAIL, `./script.mjs` is not found.

- [ ] **Step 3: Implement**

`docker/mock-llm/script.mjs`:
```js
const textOf = (content) => (Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : String(content ?? ''));

export function decide(messages) {
  const last = messages.at(-1) ?? {};
  if (last.role === 'tool') {
    const content = textOf(last.content);
    if (content.startsWith('Rejected by human reviewer')) return { content: 'Understood. I did not send the email.' };
    return { content: `Done. Tool result: ${content}` };
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const said = textOf(lastUser?.content);
  const lower = said.toLowerCase();
  if (lower.includes('email')) return { toolCalls: [{ name: 'send_email', arguments: { to: 'bob@example.com', subject: 'Hello', body: 'Hi Bob, this is a test.' } }] };
  if (lower.includes('time')) return { toolCalls: [{ name: 'get_current_time', arguments: {} }] };
  return { content: `mock-llm says hello. You said: ${said}` };
}

export const tokens = (s) => Math.max(1, Math.ceil(String(s).length / 4));
```

`docker/mock-llm/server.mjs`:
```js
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { decide, tokens } from './script.mjs';

let counter = 0;

function completion(req) {
  const decision = decide(req.messages ?? []);
  const id = `chatcmpl-mock-${++counter}`;
  const toolCalls = (decision.toolCalls ?? []).map((c, i) => ({ id: `call_${counter}_${i}_${c.name}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
  const content = decision.content ?? null;
  const usage = { prompt_tokens: tokens(JSON.stringify(req.messages ?? [])), completion_tokens: tokens(content ?? JSON.stringify(toolCalls)) };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return { id, content, toolCalls, usage, model: req.model ?? 'mock-llm' };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return send(res, 404, { error: 'not found' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
    const c = completion(body);
    const created = Math.floor(Date.now() / 1000);
    const finish = c.toolCalls.length ? 'tool_calls' : 'stop';
    if (!body.stream) {
      return send(res, 200, {
        id: c.id, object: 'chat.completion', created, model: c.model,
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: c.content, ...(c.toolCalls.length ? { tool_calls: c.toolCalls } : {}) } }],
        usage: c.usage,
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: c.id, object: 'chat.completion.chunk', created, model: c.model };
    emit({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (c.content) {
      const mid = Math.ceil(c.content.length / 2);
      for (const part of [c.content.slice(0, mid), c.content.slice(mid)]) emit({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
    }
    c.toolCalls.forEach((tc, index) => emit({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] }));
    emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    if (body.stream_options?.include_usage) emit({ ...base, choices: [], usage: c.usage });
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  createServer().listen(port, '0.0.0.0', () => console.log(`mock-llm listening on :${port}`));
}
```
Note: in the streaming test, the final usage chunk has `choices: []`, so `c.choices[0]?.delta?.content ?? ''` must tolerate it. The test already does.

`docker-compose.yml`:
```yaml
name: serverless-agent

services:
  localstack:
    image: localstack/localstack:${LOCALSTACK_VERSION:-latest}
    ports:
      - "127.0.0.1:4566:4566"
    environment:
      # LocalStack 2026.03+ refuses to start without a token (ADR 0009). Free Hobby plan = non-commercial use.
      LOCALSTACK_AUTH_TOKEN: ${LOCALSTACK_AUTH_TOKEN:?LOCALSTACK_AUTH_TOKEN is not set. LocalStack 2026.03+ requires it; create a free Hobby token at app.localstack.cloud and export it.}
      LAMBDA_DOCKER_NETWORK: serverless-agent-net
      DEBUG: "0"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock"
    networks: [net]
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:4566/_localstack/health"]
      interval: 5s
      timeout: 3s
      retries: 30

  mock-llm:
    image: node:24-alpine
    working_dir: /app
    command: ["node", "server.mjs"]
    environment:
      PORT: "8080"
    volumes:
      - "./docker/mock-llm:/app:ro"
    ports:
      - "127.0.0.1:18080:8080"
    networks: [net]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health"]
      interval: 5s
      timeout: 3s
      retries: 10

networks:
  net:
    name: serverless-agent-net
```

Root `package.json` scripts, added:
```json
    "local:up": "docker compose up -d --wait",
    "local:down": "docker compose down -v"
```

- [ ] **Step 4: Run the tests and confirm they pass; validate compose**

Run: `pnpm --filter @serverless-agent/mock-llm test`
Expected: 7 tests pass.

Run: `docker compose config --quiet`
Expected, with no token: it fails with `LOCALSTACK_AUTH_TOKEN is not set...`. That is the correct fail-fast behavior. Record it.

Run with a dummy value to check syntax only, never committing it: in PowerShell `$env:LOCALSTACK_AUTH_TOKEN='dummy'; docker compose config --quiet; Remove-Item Env:LOCALSTACK_AUTH_TOKEN`. In Git Bash: `LOCALSTACK_AUTH_TOKEN=dummy docker compose config --quiet`.
Expected: exit 0.

Run: `docker compose up -d --wait mock-llm` fails the same way without a token, because compose interpolates the whole file. This is expected. As a standalone check, run `docker run --rm -d --name sa-mock -p 127.0.0.1:18080:8080 -v "$PWD/docker/mock-llm:/app:ro" -w /app node:24-alpine node server.mjs`, then `curl -s http://127.0.0.1:18080/health`, then `docker rm -f sa-mock`.
Expected: `{"ok":true}`. If the Docker volume path fails on Windows, note it and skip; the unit tests already cover the server.

- [ ] **Step 5: Commit**

```bash
git add docker docker-compose.yml pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "feat(local): add deterministic OpenAI-compatible mock LLM and LocalStack compose file"
```

**Acceptance:**
- The mock is deterministic and covered by tests.
- Compose fails fast without a token and is valid with one.
- The token is never committed.

---

### Task 25: Bootstrap-free LocalStack deploy script

**Files:**
- Create: `scripts/with-localstack-env.mjs`
- Create: `examples/basic/scripts/deploy-local.mjs`
- Modify: root `package.json` (add `local:deploy`)
- Modify: `.gitignore` (already ignores `examples/basic/cdk.local-outputs.json`)

**Interfaces:**
- `node scripts/with-localstack-env.mjs <command...>` does the following:
  1. forces `AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test`, `AWS_REGION=us-east-1` (unless set), and `AWS_ENDPOINT_URL=${LOCALSTACK_ENDPOINT ?? 'http://localhost:4566'}`;
  2. checks `${endpoint}/_localstack/health` and exits 2 with a blocker message if it is unreachable;
  3. spawns the command with inherited stdio and exits with its code.
- `deploy-local.mjs` (run under the wrapper):
  1. reads `examples/basic/cdk.out/ServerlessAgentLocal.assets.json`;
  2. creates every destination bucket (ignoring "already owned");
  3. uploads each asset (directory sources zipped with `fflate`, file sources raw);
  4. creates or updates the CloudFormation stack `ServerlessAgentLocal` with `CAPABILITY_IAM` and `CAPABILITY_NAMED_IAM`, using `TemplateBody` up to 51,200 bytes and the uploaded template's S3 URL otherwise;
  5. waits up to 10 minutes;
  6. on failure prints `*_FAILED` stack events and exits 1;
  7. writes `examples/basic/cdk.local-outputs.json` (an `{ OutputKey: OutputValue }` map).

There is no unit test for these scripts: they are thin glue over the AWS SDK and are exercised end to end by `pnpm local:deploy` and Task 26. Keep them small.

- [ ] **Step 1: Write the env wrapper**

`scripts/with-localstack-env.mjs`:
```js
import { spawn } from 'node:child_process';

const endpoint = process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566';
const env = {
  ...process.env,
  AWS_ENDPOINT_URL: endpoint,
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
  AWS_DEFAULT_REGION: process.env.AWS_REGION ?? 'us-east-1',
};

try {
  const res = await fetch(`${endpoint}/_localstack/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`BLOCKER: LocalStack is not reachable at ${endpoint} (${err.message}).`);
  console.error('Start it with "pnpm local:up". LocalStack 2026.03+ requires LOCALSTACK_AUTH_TOKEN in your environment (free Hobby plan for non-commercial use). See docs/adr/0009.');
  process.exit(2);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: node scripts/with-localstack-env.mjs <command> [args...]'); process.exit(64); }
const child = spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 1));
```

- [ ] **Step 2: Write the deploy script**

`examples/basic/scripts/deploy-local.mjs`:
```js
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CloudFormationClient, CreateStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand,
  waitUntilStackCreateComplete, waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';

const STACK = 'ServerlessAgentLocal';
const here = path.dirname(fileURLToPath(import.meta.url));
const cdkOut = path.resolve(here, '..', 'cdk.out');
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const common = { endpoint, region: process.env.AWS_REGION ?? 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
const s3 = new S3Client({ ...common, forcePathStyle: true });
const cfn = new CloudFormationClient(common);

function zipDirectory(dir) {
  const files = {};
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files[rel] = [readFileSync(full), { mtime: new Date('2026-01-01T00:00:00Z') }];
    }
  };
  walk(dir, '');
  return zipSync(files, { level: 6 });
}

async function ensureBucket(Bucket) {
  try { await s3.send(new CreateBucketCommand({ Bucket })); }
  catch (err) { if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(err.name)) throw err; }
}

async function publishAssets() {
  const manifest = JSON.parse(readFileSync(path.join(cdkOut, `${STACK}.assets.json`), 'utf8'));
  let templateUrl;
  for (const [hash, asset] of Object.entries(manifest.files ?? {})) {
    const src = path.join(cdkOut, asset.source.path);
    const body = asset.source.packaging === 'zip' || statSync(src).isDirectory() ? zipDirectory(src) : readFileSync(src);
    for (const dest of Object.values(asset.destinations)) {
      await ensureBucket(dest.bucketName);
      await s3.send(new PutObjectCommand({ Bucket: dest.bucketName, Key: dest.objectKey, Body: body }));
      console.log(`uploaded ${asset.source.path} -> s3://${dest.bucketName}/${dest.objectKey} (${body.length} bytes)`);
      if (asset.source.path === `${STACK}.template.json`) templateUrl = `${endpoint}/${dest.bucketName}/${dest.objectKey}`;
    }
    void hash;
  }
  if (Object.keys(manifest.dockerImages ?? {}).length > 0) throw new Error('Docker image assets need ECR, which LocalStack Hobby does not include (ADR 0009).');
  return templateUrl;
}

async function stackExists() {
  try { const out = await cfn.send(new DescribeStacksCommand({ StackName: STACK })); return out.Stacks?.[0]?.StackStatus !== 'DELETE_COMPLETE'; }
  catch (err) { if (String(err.message).includes('does not exist')) return false; throw err; }
}

async function printFailures() {
  const out = await cfn.send(new DescribeStackEventsCommand({ StackName: STACK }));
  for (const e of (out.StackEvents ?? []).filter((x) => String(x.ResourceStatus).endsWith('FAILED')).slice(0, 20)) {
    console.error(`${e.LogicalResourceId} ${e.ResourceType} ${e.ResourceStatus}: ${e.ResourceStatusReason}`);
  }
}

const templateUrl = await publishAssets();
const templateBody = readFileSync(path.join(cdkOut, `${STACK}.template.json`), 'utf8');
const source = Buffer.byteLength(templateBody) <= 51_200 ? { TemplateBody: templateBody } : { TemplateURL: templateUrl };
if (!source.TemplateBody && !source.TemplateURL) throw new Error('Template exceeds 51,200 bytes and was not uploaded as an asset.');
const params = { StackName: STACK, Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'], ...source };

try {
  if (await stackExists()) {
    try {
      await cfn.send(new UpdateStackCommand(params));
      await waitUntilStackUpdateComplete({ client: cfn, maxWaitTime: 600 }, { StackName: STACK });
    } catch (err) {
      if (!String(err.message).includes('No updates are to be performed')) throw err;
      console.log('stack unchanged');
    }
  } else {
    await cfn.send(new CreateStackCommand(params));
    await waitUntilStackCreateComplete({ client: cfn, maxWaitTime: 600 }, { StackName: STACK });
  }
} catch (err) {
  console.error(`deploy failed: ${err.message}`);
  await printFailures().catch(() => {});
  process.exit(1);
}

const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
const outputs = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
writeFileSync(path.resolve(here, '..', 'cdk.local-outputs.json'), `${JSON.stringify(outputs, null, 2)}\n`);
console.log(`deployed ${STACK} to LocalStack:`, outputs);
```

Root `package.json` scripts, added:
```json
    "local:deploy": "pnpm build && pnpm synth && node scripts/with-localstack-env.mjs node examples/basic/scripts/deploy-local.mjs"
```

- [ ] **Step 3: Verify the behavior without LocalStack**

Run: `node scripts/with-localstack-env.mjs node -e "console.log('should not run')"`
Expected, with no LocalStack running: exit code 2 and the `BLOCKER: LocalStack is not reachable ...` message. `should not run` must not print.

If `LOCALSTACK_AUTH_TOKEN` **is** set: run `pnpm local:up && pnpm local:deploy`.
Expected: `deployed ServerlessAgentLocal to LocalStack:` with all 7 outputs. If the stack fails, the printed `*_FAILED` events say why. Common fixes:
- a CDK resource property LocalStack does not implement: report it and do not hack around it silently;
- Lambda image pull time.

Record the exact outcome either way.

- [ ] **Step 4: Commit**

```bash
git add scripts examples/basic/scripts package.json
git commit -m "feat(local): deploy the example stack to LocalStack without bootstrap or ECR"
```

**Acceptance:**
- The wrapper fails fast with a clear blocker when LocalStack is down.
- With a token, the stack deploys and outputs are written.
- No real AWS endpoint can be hit: credentials are forced to `test` and the endpoint is forced.

---

### Task 26: LocalStack integration tests

**Files:**
- Create: `packages/integration/package.json`, `packages/integration/tsconfig.json`, `packages/integration/vitest.config.ts`
- Create: `packages/integration/test/support/localstack.ts`
- Create: `packages/integration/test/checkpointer.int.test.ts`, `packages/integration/test/invoke.int.test.ts`, `packages/integration/test/approval-flow.int.test.ts`
- Modify: root `package.json` (add `test:integration`)

**Interfaces:**
- `packages/integration` depends on the **built** runtime (`@serverless-agent/runtime` via `workspace:*`, so `pnpm build` first). It needs LocalStack, the deployed `ServerlessAgentLocal` and `examples/basic/cdk.local-outputs.json`.
- Every test file's `beforeAll` calls `assertLocalStackReady()`, which **throws** a blocker error when LocalStack is not reachable. Never `skip`.

- [ ] **Step 1: Scaffold the package**

`packages/integration/package.json`:
```json
{
  "name": "@serverless-agent/integration-tests",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```
Install:
```bash
pnpm --filter @serverless-agent/integration-tests add -D vitest@4.1.11 typescript@5.9.3 @types/node@24 @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-sfn @aws-sdk/client-lambda @langchain/langgraph-checkpoint-validation@1.1.1 @langchain/langgraph-checkpoint@1.1.5 @langchain/core@1.2.14 "@serverless-agent/runtime@workspace:*"
```

`packages/integration/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "noEmit": true },
  "include": ["test", "vitest.config.ts"]
}
```

`packages/integration/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.int.test.ts'], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false },
});
```

Root `package.json` scripts, added:
```json
    "test:integration": "node scripts/with-localstack-env.mjs pnpm --filter @serverless-agent/integration-tests run test"
```

`packages/integration/test/support/localstack.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
export const clientConfig = { endpoint: ENDPOINT, region: process.env.AWS_REGION ?? 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };

const here = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS = path.resolve(here, '../../../../examples/basic/cdk.local-outputs.json');

export async function assertLocalStackReady(): Promise<void> {
  let health: { services?: Record<string, string> };
  try {
    const res = await fetch(`${ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(3000) });
    health = await res.json();
  } catch (err) {
    throw new Error(`BLOCKER: LocalStack not reachable at ${ENDPOINT} (${(err as Error).message}). Run "pnpm local:up" with LOCALSTACK_AUTH_TOKEN set (ADR 0009).`);
  }
  for (const svc of ['dynamodb', 'lambda', 'stepfunctions', 'apigateway', 'cloudformation']) {
    const state = health.services?.[svc];
    if (state && !['available', 'running'].includes(state)) throw new Error(`BLOCKER: LocalStack service ${svc} is "${state}" (license/plan?)`);
  }
}

export interface LocalOutputs {
  StateMachineArn: string; TableName: string; AgentFunctionName: string; ApprovalCallbackFunctionName: string;
  ApprovalApiId: string; ApprovalApiStage: string; ApprovalApiUrl: string;
}

export function loadOutputs(): LocalOutputs {
  if (!existsSync(OUTPUTS)) throw new Error(`BLOCKER: ${OUTPUTS} missing. Run "pnpm local:deploy" first.`);
  return JSON.parse(readFileSync(OUTPUTS, 'utf8'));
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000, intervalMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** LocalStack REST API invoke URL (no DNS needed). */
export const restApiUrl = (apiId: string, stage: string, p: string) => `${ENDPOINT}/restapis/${apiId}/${stage}/_user_request_${p}`;
```

- [ ] **Step 2: Write the checkpointer integration test (the conformance suite against real LocalStack DynamoDB)**

`packages/integration/test/checkpointer.int.test.ts`:
```ts
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { validate } from '@langchain/langgraph-checkpoint-validation';
import { DynamoDBSaver } from '@serverless-agent/runtime';
import { assertLocalStackReady, clientConfig } from './support/localstack.js';

const raw = new DynamoDBClient(clientConfig);
const doc = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
const tables = new WeakMap<DynamoDBSaver, string>();
let n = 0;

validate({
  checkpointerName: 'DynamoDBSaver (LocalStack DynamoDB)',
  beforeAll: assertLocalStackReady,
  beforeAllTimeout: 30_000,
  async createCheckpointer() {
    const tableName = `conformance-${Date.now()}-${n++}`;
    await raw.send(new CreateTableCommand({
      TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    }));
    await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName: tableName });
    const saver = new DynamoDBSaver({ client: doc, tableName, ttlSeconds: 3600 });
    tables.set(saver, tableName);
    return saver;
  },
  async destroyCheckpointer(saver) {
    const name = tables.get(saver);
    if (name) await raw.send(new DeleteTableCommand({ TableName: name }));
  },
});
```

- [ ] **Step 3: Write the invoke-path test**

`packages/integration/test/invoke.int.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertLocalStackReady, clientConfig, loadOutputs, type LocalOutputs } from './support/localstack.js';

const lambda = new LambdaClient(clientConfig);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig));
let out: LocalOutputs;

async function invoke(payload: unknown): Promise<any> {
  const res = await lambda.send(new InvokeCommand({ FunctionName: out.AgentFunctionName, Payload: Buffer.from(JSON.stringify(payload)) }));
  const body = JSON.parse(Buffer.from(res.Payload ?? new Uint8Array()).toString('utf8') || 'null');
  if (res.FunctionError) throw new Error(`${res.FunctionError}: ${JSON.stringify(body)}`);
  return body;
}

describe('invoke path (agentStep Lambda on LocalStack, mock LLM)', () => {
  beforeAll(async () => { await assertLocalStackReady(); out = loadOutputs(); });

  it('completes a run that uses a safe tool and reports usage', async () => {
    const threadId = `inv-time-${randomUUID()}`;
    const res = await invoke({ runId: `run-${randomUUID()}`, input: { threadId, message: 'What time is it?', connectionId: null } });
    expect(res.status).toBe('completed');
    expect(res.output).toMatch(/^Done\. Tool result: \d{4}-\d{2}-\d{2}T/);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('pauses before send_email and persists checkpoints with TTL in the stack table', async () => {
    const threadId = `inv-email-${randomUUID()}`;
    const res = await invoke({ runId: `run-${randomUUID()}`, input: { threadId, message: 'Please email Bob', connectionId: null } });
    expect(res.status).toBe('interrupted');
    expect(res.interrupt.toolCalls[0]).toMatchObject({ name: 'send_email', args: { to: 'bob@example.com' } });
    const items = await doc.send(new QueryCommand({ TableName: out.TableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': threadId } }));
    const checkpoints = (items.Items ?? []).filter((i) => String(i.sk).startsWith('cp#'));
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const c of checkpoints) expect(typeof c.expiresAt).toBe('number');
  });
});
```

- [ ] **Step 4: Write the Step Functions approval-callback test**

`packages/integration/test/approval-flow.int.test.ts`:
```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { DescribeExecutionCommand, GetExecutionHistoryCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { hashApprovalId } from '@serverless-agent/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertLocalStackReady, clientConfig, loadOutputs, restApiUrl, waitFor, type LocalOutputs } from './support/localstack.js';

const sfn = new SFNClient(clientConfig);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig));
let out: LocalOutputs;

async function startRun(message: string) {
  const runId = randomUUID();
  const threadId = `flow-${runId}`;
  const { executionArn } = await sfn.send(new StartExecutionCommand({ stateMachineArn: out.StateMachineArn, name: runId, input: JSON.stringify({ threadId, message, connectionId: null }) }));
  return { runId, threadId, executionArn: executionArn! };
}

/** The real approval id is only sent over WebSocket (disabled locally) and only its hash is stored, so the
 *  test re-keys the real task token under a known id. See ADR 0009 for what this does and does not cover. */
async function seedKnownApprovalId(runId: string): Promise<string> {
  const item = await waitFor('approval item', async () => {
    const res = await doc.send(new ScanCommand({ TableName: out.TableName, FilterExpression: '#k = :k AND runId = :r', ExpressionAttributeNames: { '#k': 'kind' }, ExpressionAttributeValues: { ':k': 'approval', ':r': runId } }));
    return res.Items?.[0];
  });
  const id = randomBytes(32).toString('base64url');
  await doc.send(new PutCommand({ TableName: out.TableName, Item: { ...item, pk: `approval#${hashApprovalId(id)}` } }));
  await doc.send(new DeleteCommand({ TableName: out.TableName, Key: { pk: item.pk, sk: item.sk } }));
  return id;
}

async function post(id: string, body: unknown) {
  const res = await fetch(restApiUrl(out.ApprovalApiId, out.ApprovalApiStage, `/approvals/${id}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}

async function finished(executionArn: string) {
  return waitFor('execution to finish', async () => {
    const d = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    return d.status === 'RUNNING' ? undefined : d;
  });
}

describe('Step Functions approval callback on LocalStack', () => {
  beforeAll(async () => { await assertLocalStackReady(); out = loadOutputs(); });

  it('approve: HTTPS callback resumes the execution, the tool runs, the run succeeds', async () => {
    const run = await startRun('Please email Bob hello');
    const id = await seedKnownApprovalId(run.runId);
    const res = await post(id, { decision: 'approve' });
    expect(res).toEqual({ status: 200, json: { status: 'approved', runId: run.runId } });
    const exec = await finished(run.executionArn);
    expect(exec.status).toBe('SUCCEEDED');
    const state = JSON.parse(exec.output!);
    expect(state.resume).toEqual({ approved: true });
    expect(state.step).toMatchObject({ status: 'completed' });
    expect(state.step.output).toMatch(/^Done\. Tool result: Demo stub: email to bob@example\.com/);
    const history = await sfn.send(new GetExecutionHistoryCommand({ executionArn: run.executionArn, maxResults: 200 }));
    expect(history.events?.some((e) => e.stateEnteredEventDetails?.name === 'WaitForApproval')).toBe(true);
  });

  it('reject: the model is told, the tool never runs, the run still succeeds', async () => {
    const run = await startRun('Please email Bob hello');
    const id = await seedKnownApprovalId(run.runId);
    expect((await post(id, { decision: 'reject', comment: 'not today' })).status).toBe(200);
    const exec = await finished(run.executionArn);
    expect(exec.status).toBe('SUCCEEDED');
    const state = JSON.parse(exec.output!);
    expect(state.resume).toEqual({ approved: false, comment: 'not today' });
    expect(state.step.output).toBe('Understood. I did not send the email.');
  });

  it('links are single use and bad input never consumes them', async () => {
    const run = await startRun('Please email Bob hello');
    const id = await seedKnownApprovalId(run.runId);
    expect((await post(id, { decision: 'maybe' })).status).toBe(400);
    expect((await post(id, { decision: 'approve' })).status).toBe(200);
    expect((await post(id, { decision: 'approve' })).status).toBe(404);
    expect((await finished(run.executionArn)).status).toBe('SUCCEEDED');
  });
});
```

- [ ] **Step 5: Run the integration suite (expected to be blocked without a token)**

Run: `pnpm test:integration`
- Without LocalStack (no token): exit code 2 with `BLOCKER: LocalStack is not reachable ...`. That is the expected, honest result on this machine. Record it verbatim in the handoff.
- With a token and after `pnpm local:up && pnpm local:deploy`: all 3 files pass (the conformance suite plus 2 invoke tests plus 3 approval tests). Fix real failures in product code. If a LocalStack emulation gap is the cause (for example a REST URL format difference), adjust only the test helper (`restApiUrl`) and note it.

Also run `pnpm --filter @serverless-agent/integration-tests typecheck`. Expected: exit 0. This works without LocalStack, after `pnpm build`.

- [ ] **Step 6: Commit**

```bash
git add packages/integration package.json pnpm-lock.yaml
git commit -m "test(integration): cover checkpointer, invoke path and approval callback on LocalStack"
```

**Acceptance:**
- The three integration files exist, typecheck, and either pass on LocalStack or fail with the explicit blocker.
- No skips.
- No fake success.

---

### Task 27: Local runner against Ollama (optional developer convenience)

**Files:**
- Create: `packages/runtime/src/local/chat.ts`

**Interfaces:** `pnpm --filter @serverless-agent/runtime run local -- "What time is it, then email Bob?"`
- Runs the same graph with `MemorySaver` and `createChatModel({ provider: 'openai-compatible', baseUrl: process.env.MODEL_BASE_URL ?? 'http://localhost:11434/v1', modelId: process.env.MODEL_ID ?? 'llama3.1' })`.
- Prompts `approve? [y/N]` on stdin at each interrupt.

This is a thin manual script over tested pieces, so it gets no unit test. Verification is typecheck. The real run needs Ollama with a tool-capable model, so mark it "not run" if none is available.

- [ ] **Step 1: Implement**

`packages/runtime/src/local/chat.ts`:
```ts
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Command, MemorySaver } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { buildAgentGraph, pendingApproval } from '../agent/graph.js';
import { createChatModel } from '../agent/model.js';
import { demoTools } from '../agent/tools.js';
import { textOf } from '../handlers/agent-step.js';

const message = process.argv.slice(2).join(' ') || 'What time is it? Then email bob@example.com to say hi.';
const graph = buildAgentGraph({
  model: createChatModel({ provider: 'openai-compatible', baseUrl: process.env.MODEL_BASE_URL ?? 'http://localhost:11434/v1', modelId: process.env.MODEL_ID ?? 'llama3.1' }),
  tools: demoTools,
  toolsRequiringApproval: ['send_email'],
  checkpointer: new MemorySaver(),
});
const config = { configurable: { thread_id: `local-${Date.now()}` } };
const rl = createInterface({ input: stdin, output: stdout });

let input: unknown = { messages: [new HumanMessage(message)] };
for (;;) {
  const state = await graph.invoke(input as never, config);
  const approval = pendingApproval(await graph.getState(config));
  if (!approval) {
    console.log(`\nassistant: ${textOf(state.messages.at(-1)?.content)}`);
    break;
  }
  console.log('\nThe model proposes:', JSON.stringify(approval.toolCalls, null, 2));
  const answer = (await rl.question('approve? [y/N] ')).trim().toLowerCase();
  input = new Command({ resume: { approved: answer === 'y', comment: answer === 'y' ? undefined : 'declined locally' } });
}
rl.close();
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @serverless-agent/runtime typecheck`
Expected: exit 0.

Optional: with Ollama running (`curl -s http://localhost:11434/api/tags`) and a tool-capable model, run `MODEL_ID=<model> pnpm --filter @serverless-agent/runtime run local -- "email bob"`. Record whether it was run.

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/src/local
git commit -m "feat(runtime): add local chat runner for Ollama with interactive approvals"
```

**Acceptance:** It typechecks. It is documented as optional and is not part of CI.

---

### Task 28: README and cost estimate

**Files:**
- Create: `README.md`, `docs/cost-estimate.md`

**Interfaces:** None (docs). Every number is labelled **estimate**. Copy the architecture diagram from `docs/DEVDOCS.md` (section "Architecture").

- [ ] **Step 1: Write `docs/cost-estimate.md`**

Required content, in this order:
1. Title and a bold banner: "**All numbers are estimates** from public us-east-1 list prices as remembered on 2026-10-03; verify on the AWS pricing pages before relying on them. Nothing here was measured on a real AWS bill."
2. Price assumptions table (estimates):

   | Item | Price |
   |---|---|
   | Lambda arm64 | $0.0000133334 per GB-s; $0.20 per 1M requests |
   | DynamoDB on-demand | $0.625 per 1M write request units; $0.125 per 1M read request units; storage $0.25/GB-month; PITR $0.20/GB-month |
   | Step Functions Standard | $0.025 per 1,000 state transitions |
   | API Gateway WebSocket | $1.00 per 1M messages; $0.25 per 1M connection-minutes |
   | API Gateway REST | $3.50 per 1M requests |
   | CloudWatch Logs ingestion | $0.50/GB |
   | Amazon Nova Lite | $0.06 per 1M input tokens; $0.24 per 1M output tokens |

3. Scenario "one run with one approval", with the arithmetic shown:
   - Step Functions: 6 transitions × $0.000025 = **$0.00015**
   - Lambda agentStep: 2 invocations × 4 s × 1 GB = 8 GB-s × $0.0000133334 = **$0.000107**. Small handlers: 3 × 0.2 s × 0.25 GB ≈ 0.15 GB-s ≈ $0.000002. Requests: 5 × $0.0000002 = $0.000001.
   - DynamoDB: about 32 item writes × about 4 WRU = 128 WRU × $0.000000625 = **$0.00008**. Reads: about 20 RRU, about $0.0000025.
   - WebSocket: about 50 batched messages × $0.000001 = **$0.00005**. Without the TokenBatcher, about 300 messages would cost about $0.0003.
   - REST approval call: 1 × $0.0000035 = $0.0000035.
   - Bedrock Nova Lite: 3 model calls, 6,000 input tokens total × $0.06/1M = $0.00036, plus 600 output tokens × $0.24/1M = $0.000144. Total **$0.000504**.
   - Logs: about 10 KB × $0.50/GB = $0.000005.
   - **Total ≈ $0.0009 per run (estimate), about $0.90 per 1,000 runs.** The model is about 55% of it.
4. Sensitivity: the same run on a Claude-Sonnet-class model at $3/$15 per 1M tokens (estimate) costs ≈ $0.018 + $0.009 = **$0.027 per run**. The model then dominates, and the infrastructure is about 1.5%.
5. Idle cost: $0 compute. Storage only: DynamoDB GB-month plus PITR, plus log storage. A small table and logs come to well under $0.10/month (estimate).
6. How to see real numbers:
   - the EMF metric `ServerlessAgent/EstimatedCostUsd` by `AgentName`;
   - a Logs Insights query: `fields runId, EstimatedCostUsd | stats sum(EstimatedCostUsd) as usd by runId`;
   - activate the cost allocation tag `serverless-agent:agent-name` in Billing.

- [ ] **Step 2: Write `README.md`**

Required structure:
1. Line 1: `# ServerlessAgent`
2. Line 3, the headline: `**≈ $0.001 per agent run and $0 when idle (estimate, Nova Lite; [assumptions](docs/cost-estimate.md)).** A CDK construct that deploys a LangGraph.js agent on AWS Lambda with durable DynamoDB checkpoints, WebSocket token streaming and Step Functions human approval.`
3. One paragraph on the thesis: "the model proposes, the deterministic core disposes". A sensitive tool call pauses the graph (`interrupt()`). Step Functions holds a task token until a human approves via a single-use link. Unknown tools and malformed approvals fail closed.
4. `## Architecture`: the mermaid diagram (from DEVDOCS) in a ```` ```mermaid ```` fence.
5. `## Usage`, with this snippet:
```ts
import { App, Duration, Stack } from 'aws-cdk-lib';
import { AgentModel, ServerlessAgent } from '@serverless-agent/construct';

const app = new App();
const stack = new Stack(app, 'AgentStack');
const agent = new ServerlessAgent(stack, 'SupportAgent', {
  model: AgentModel.bedrock('amazon.nova-lite-v1:0'),
  toolsRequiringApproval: ['send_email'],
  approvalTimeout: Duration.hours(4),
});
// agent.webSocketUrl, agent.approvalBaseUrl, agent.stateMachine, agent.table
```
   Also the WebSocket protocol in brief: the client sends `{"action":"run","threadId":"t1","message":"..."}`, the server replies `run_accepted`, and then `token`, `approval_required`, `run_completed`/`run_failed` arrive. Approve with `curl -X POST <approvalUrl> -d '{"decision":"approve"}'`.
6. `## What gets deployed`: a table of resources and why each one scales to zero.
7. `## Security`: no `*` IAM actions (enforced by tests); IAM-auth WebSocket; hashed single-use approval ids; POST-only; throttled; fail-closed gate.
8. `## Local development (LocalStack)`:
   - Prerequisites: Docker, and `LOCALSTACK_AUTH_TOKEN` (LocalStack 2026.03+ requires it; the Hobby plan is free for non-commercial use).
   - Port: **serverless-agent uses LocalStack on 4566.**
   - Commands: `pnpm local:up`, `pnpm local:deploy`, `pnpm test:integration`, `pnpm local:down`.
   - Explain the Hobby-plan profile: no WebSocket API, a mock LLM instead of Bedrock, an SDK deploy instead of `cdk bootstrap` (ECR is not in Hobby). Link ADR 0009.
9. `## Testing`: `pnpm test` (offline unit tests, the official LangGraph checkpointer conformance suite, CDK assertion invariants), `pnpm synth`, `pnpm test:integration`. Put real pass counts here **only after** running them (Task 30).
10. `## Decisions`: a linked list of `docs/adr/0001`–`0009`, one line each saying what was given up.
11. `## Status`: v0.1. No real AWS deploy has been done yet; synth and LocalStack only. Link `docs/handoff.md` and `docs/DEVDOCS.md`.

- [ ] **Step 3: Verify the docs contain the required pieces**

Run:
```bash
head -3 README.md
grep -c "estimate" README.md docs/cost-estimate.md
grep -n '```mermaid' README.md
grep -n "4566" README.md
```
Expected: the headline appears on line 3, each file has at least one "estimate" match, a mermaid fence exists, and the port is stated.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/cost-estimate.md
git commit -m "docs: add README with architecture, usage and estimated cost per run"
```

**Acceptance:**
- The headline number is labelled as an estimate on line 3.
- There is a mermaid diagram, a usage snippet, ADR links and LocalStack instructions with the port.
- The cost arithmetic is shown.

---

### Task 29: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

This is configuration. It cannot be run locally; validate the YAML syntax only.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
      - run: pnpm synth

  integration:
    runs-on: ubuntu-latest
    needs: unit
    env:
      LOCALSTACK_AUTH_TOKEN: ${{ secrets.LOCALSTACK_AUTH_TOKEN }}
    steps:
      - name: Report missing LocalStack token
        if: env.LOCALSTACK_AUTH_TOKEN == ''
        run: echo "::warning::LOCALSTACK_AUTH_TOKEN secret is not set; LocalStack integration tests were NOT run (LocalStack 2026.03+ requires a token, see docs/adr/0009)."
      - uses: actions/checkout@v4
        if: env.LOCALSTACK_AUTH_TOKEN != ''
      - uses: pnpm/action-setup@v4
        if: env.LOCALSTACK_AUTH_TOKEN != ''
      - uses: actions/setup-node@v4
        if: env.LOCALSTACK_AUTH_TOKEN != ''
        with:
          node-version: 24
          cache: pnpm
      - if: env.LOCALSTACK_AUTH_TOKEN != ''
        run: pnpm install --frozen-lockfile
      - if: env.LOCALSTACK_AUTH_TOKEN != ''
        run: pnpm local:up
      - if: env.LOCALSTACK_AUTH_TOKEN != ''
        run: pnpm local:deploy
      - if: env.LOCALSTACK_AUTH_TOKEN != ''
        run: pnpm test:integration
      - if: always() && env.LOCALSTACK_AUTH_TOKEN != ''
        run: docker compose logs --no-color localstack | tail -200
```

- [ ] **Step 2: Validate the syntax**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/jobs:\n  unit:/.test(y)) process.exit(1); console.log('ok')"`
Expected: `ok`. Optionally run `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest` if Docker can pull it; record whether that was run.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run build, unit tests, synth and token-gated LocalStack integration"
```

**Acceptance:**
- The unit job mirrors the local verification commands.
- The integration job runs only with the secret and warns loudly when it is missing.

---

### Task 30: Final verification, DEVDOCS results and handoff

**Files:**
- Modify: `docs/DEVDOCS.md` (the "Results" section: real numbers only), `README.md` (the "Testing" section counts)
- Modify: `docs/handoff.md` (append an entry)

Use superpowers:verification-before-completion. Run each command fresh and copy the real output. Do not claim anything you did not run.

- [ ] **Step 1: Run the full verification from a clean state**

```bash
git status --short
rm -rf packages/*/lib packages/construct/assets examples/basic/cdk.out
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm synth
pnpm --filter @serverless-agent/integration-tests typecheck
pnpm test:integration
```
Expected:
- everything passes up to `synth`;
- the integration typecheck passes;
- `pnpm test:integration` either passes (token present and LocalStack deployed) or exits 2 with the BLOCKER line (no token).

Capture for each command: exit code, test file and test counts per package, the bundle size in MiB (from the `bundled runtime ->` line), and the resource counts and template sizes for both stacks.

- [ ] **Step 2: Run the IAM invariant spot-check against the synthesized example templates**

```bash
node -e "for (const s of ['ServerlessAgentExample','ServerlessAgentLocal']) { const t=require('./examples/basic/cdk.out/'+s+'.template.json'); const acts=[]; for (const r of Object.values(t.Resources)) { if (r.Type==='AWS::IAM::Policy') for (const st of r.Properties.PolicyDocument.Statement) acts.push(...[].concat(st.Action)); } console.log(s, 'actions:', acts.length, 'wildcards:', acts.filter(a=>a.includes('*'))); }"
```
Expected: `wildcards: []` for both stacks.

- [ ] **Step 3: Update `docs/DEVDOCS.md` "Results (v0.1)" with measured facts only**

Record:
- the test counts per package;
- conformance suite pass/total;
- bundle MiB;
- resource counts and template bytes for both stacks;
- the IAM wildcard spot-check;
- the integration outcome: the pass counts, or the exact BLOCKER line and the date.

Keep the cost section labelled as estimates. Update the README "Testing" section with the same counts.

- [ ] **Step 4: Append to `docs/handoff.md`**

Append (do not overwrite earlier entries):
```markdown
## <YYYY-MM-DD> · Claude (builder) · branch main
**Changed:** <one line per task group: runtime, construct, example, local env, docs, CI>
**Verified:** <exact commands and real results, with counts>
**Not done / left:**
- Real AWS deploy NOT done (no credentials by design; synth + LocalStack only).
- <LocalStack integration: passed N/N | BLOCKED: LOCALSTACK_AUTH_TOKEN not set (exit 2, BLOCKER message)>
- jsii/projen + Construct Hub publish (v0.2), custom user graphs/tools via props, S3 offload for >350 KB checkpoints, approver identity (Cognito/JWT), SNS/Slack approval notifier, per-thread run locking.
**How to verify:** `pnpm install && pnpm build && pnpm test && pnpm synth`; with a token: `pnpm local:up && pnpm local:deploy && pnpm test:integration`.
```

- [ ] **Step 5: Commit**

```bash
git add docs/DEVDOCS.md docs/handoff.md README.md
git commit -m "docs: record v0.1 verification results and handoff"
```

**Acceptance:**
- Every claim in DEVDOCS, README and the handoff is backed by a command run in this step.
- The blocker, if any, is stated verbatim.

---

## Final verification checklist

- [ ] `pnpm install --frozen-lockfile` succeeds; there is a single Vitest 4.1.11 (`pnpm why vitest -r`).
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm build` exits 0 and prints `bundled runtime -> ... (N MiB)` with N under 40.
- [ ] `pnpm test` passes with no network and no Docker: runtime (fake, checkpointer, conformance, metrics, notify, config, model, graph, 4 handlers, exports), construct (smoke, bundle, agent-model, core, state machine, APIs, invariants) and mock-llm.
- [ ] The conformance suite is green with no skips.
- [ ] `pnpm synth` writes `ServerlessAgentExample.template.json` and `ServerlessAgentLocal.template.json`.
- [ ] There are no IAM wildcard actions in either template.
- [ ] `docker compose config` fails fast without a token and validates with a dummy token (nothing committed).
- [ ] `pnpm test:integration` passes with LocalStack, **or** exits 2 with the BLOCKER message, recorded verbatim.
- [ ] README line 3 has the headline estimate, plus mermaid, usage, LocalStack port 4566 and ADR links.
- [ ] `docs/cost-estimate.md` shows the arithmetic and labels everything as an estimate.
- [ ] `docs/handoff.md` has a new entry stating "Real AWS deploy NOT done".
- [ ] `git status` is clean, or every uncommitted change is listed in the report. No `.env`, tokens or `cdk.out` are committed.

## Self-review notes (planner)

- **Spec coverage:**

  | Spec item | Task(s) |
  |---|---|
  | Checkpointer | 3–7 (fake: 2; LocalStack: 26) |
  | Gate and interrupt | 12 |
  | Handlers | 13–17 |
  | Model factory | 11 |
  | Cost metrics | 8 |
  | Construct | 18–22 |
  | Example and synth | 23 |
  | LocalStack compose, mock LLM, deploy, integration | 24–26 |
  | Ollama local runner | 27 |
  | README and cost doc | 28 |
  | CI | 29 |
  | Handoff and DEVDOCS results | 30 |

- **Review Focus:** pagination is covered in Tasks 4 and 5; hostile approval input in 12 and 15; unknown or mixed tools in 12; a gone or absent connection in 9 and 13; key characters and size in 3, 6 and 16.
- **Type consistency:** `ApprovalToolCall` (`notify.ts`) is used by `ApprovalRequest` (`graph.ts`), `requestApproval` and the mock. The `DocumentClientLike` structural type is identical in the fake and the saver. The handler names `index.agentStep|requestApproval|approvalCallback|wsHandler` match across Tasks 17, 19, 21 and 22. The env var names match between Task 17's table and Tasks 18–21. `approvalKey`/`hashApprovalId` are exported in Task 14 and used in Tasks 15 and 26.
