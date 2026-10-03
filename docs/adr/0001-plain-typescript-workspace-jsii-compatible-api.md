# ADR 0001: Plain TypeScript pnpm workspace with a jsii-compatible API (no projen/jsii in v0.1)

Status: accepted, 2026-10-03

## Context

Construct Hub only indexes packages built with jsii. projen plus jsii adds a generated toolchain (Jest, its own task runner, a `.projenrc`) and limits which TypeScript and dependency versions we can use. v0.1 has to be built offline by an agent and proven by tests. Publishing is out of scope.

## Decision

- Use a pnpm workspace with `packages/runtime` (ESM), `packages/construct` (CommonJS) and `examples/basic`. Build with plain `tsc`, test with Vitest 4.
- Keep the construct's public API inside jsii rules so a later move to jsii is mechanical:
  - props are `interface` types with `readonly` fields;
  - no TypeScript union types or type aliases in public signatures;
  - provider choice uses an abstract class with static factories (`AgentModel.bedrock()`);
  - plain `{ [key: string]: string }` maps.
- Do not expose the runtime package (LangGraph, AWS SDK) through the construct's public API. The runtime is only a prebundled Lambda asset (ADR 0008).

## Consequences

- What we gave up: a Construct Hub listing and Python/Java/Go/.NET bindings in v0.1. v0.2 moves the construct package to projen `AwsCdkConstructLibrary` and runs `jsii` in CI.
- TypeScript is pinned to 5.9.x because jsii tracks TypeScript 5.x and TypeScript 7 is the new native compiler.
