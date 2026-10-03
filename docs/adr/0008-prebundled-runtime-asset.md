# ADR 0008: Prebundle the runtime with esbuild into the construct package

Status: accepted, 2026-10-03

## Context

`NodejsFunction` bundles at synth time on the consumer's machine. That needs esbuild or Docker there, and an entry path that exists inside the published package.

## Decision

- `packages/construct/scripts/bundle-runtime.mjs` bundles `packages/runtime/src/handlers/index.ts` into `packages/construct/assets/runtime/index.mjs`:
  - ESM, `platform: node`, `target: node24`, minified;
  - a `createRequire` banner so CommonJS dependencies work in ESM;
  - all dependencies bundled, including AWS SDK v3, so versions are pinned and not taken from whatever the Lambda runtime ships.
- All four functions share the one asset and select a handler by name: `index.agentStep`, `index.requestApproval`, `index.approvalCallback`, `index.wsHandler`.
- The construct uses `lambda.Code.fromAsset(assets/runtime)` and throws a clear error if the bundle is missing. The `assets/` directory is git-ignored and listed in the package's `files`.
- Handlers read environment variables lazily, on the first invocation and not at import, so the bundle can be imported in a smoke test without any environment set.

## Consequences

- What we gave up: per-function tree-shaking. Each function ships the full bundle (a few MB), which costs a little cold-start time. v0.2 can split the entry points if cold starts measure badly.
- The Lambda execution roles keep the AWS-managed `AWSLambdaBasicExecutionRole` policy, whose log actions use `Resource: "*"`. It is not in the template, so the IAM tests do not see it. v0.2 can replace it with an inline policy scoped to each function's log group.
