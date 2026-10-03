# ADR 0005: WebSocket token streaming by postToConnection from the agent Lambda

Status: accepted, 2026-10-03

## Context

Runs execute inside Step Functions, not inside a client request, so HTTP response streaming (Lambda function URLs) cannot reach the client. API Gateway WebSocket lets any Lambda push to a connection id.

## Decision

- Clients connect to the WebSocket API. `$connect` uses `AWS_IAM` auth (SigV4-signed URL). To start a run, a client sends `{ "action": "run", "threadId": "...", "message": "..." }`. The connection id travels in the execution input.
- `agentStep` streams LangGraph `streamMode: "messages"` chunks from the `model` node through a `TokenBatcher`, which flushes at 64 characters or at the end of the step. This cuts WebSocket message count, and so cost, by about 10x compared with sending each token (estimate).
- Streaming is best effort. Notifier errors are logged and swallowed. After a `GoneException` the connection is marked dead and skipped. The run result never depends on delivery.
- Server messages: `run_accepted` (route response), `run_started`, `token`, `approval_required`, `run_completed`, `run_failed`.

## Consequences

- What we gave up: browser clients cannot connect without a SigV4 signer (for example Cognito Identity Pool credentials). v0.2 may add a Lambda/JWT authorizer.
- There is no connections table. A client that reconnects mid-run gets no more tokens for that run. The final state can always be read from the checkpoint.
