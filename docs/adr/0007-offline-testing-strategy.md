# ADR 0007: Offline testing with CDK assertions, an in-memory DynamoDB fake and the official checkpointer suite

Status: accepted, 2026-10-03

## Context

Tests must run with no AWS credentials, no network and no Docker. DynamoDB Local needs a Docker image pull, and Docker availability in CI and on this machine is not guaranteed.

## Decision

- The construct is tested with `aws-cdk-lib/assertions` (`Template.fromStack`), plus helpers that walk all IAM statements to enforce invariants: no `*` actions, an allowlist for `Resource: "*"`, and per-function grants.
- `FakeDocumentClient` (in `packages/runtime/test/support/`) implements `send()` for `Get`, `Put`, `Delete`, `Query`, `Scan` and `BatchWrite` from `@aws-sdk/lib-dynamodb`. It parses only the exact expression shapes the saver uses and throws on anything else, so a change to the saver cannot silently pass against a too-forgiving fake. It mimics real behavior where bugs hide:
  - it rejects `undefined` attribute values;
  - it paginates (`maxPageSize`) and returns `LastEvaluatedKey`;
  - it throws `ConditionalCheckFailedException`;
  - it can return `UnprocessedItems` once.
- `DynamoDBSaver` must pass `validate()` from `@langchain/langgraph-checkpoint-validation@1.1.1` against the fake. That suite is LangChain's own conformance spec for checkpointers.
- Models are faked with `ScriptedChatModel` (a queue of `AIMessage`s), so graph, interrupt and resume tests are deterministic.

## Consequences

- What we gave up: fidelity to real DynamoDB, such as exact error shapes, the 1 MB query page limit, consistency and real TTL deletion. A v0.2 integration suite can run the same saver tests against DynamoDB Local (Docker) or a real table in a sandbox account.
- Vitest is pinned to 4.x because the validation package depends on `vitest@^4.1.10`. Two Vitest copies would break `describe` registration.
