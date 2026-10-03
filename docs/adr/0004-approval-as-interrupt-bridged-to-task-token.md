# ADR 0004: Human approval = LangGraph interrupt() bridged to a Step Functions task token, via a capability URL

Status: accepted, 2026-10-03

## Context

The thesis is "the model proposes, the deterministic core disposes". The model must never be the component that decides whether a sensitive tool runs.

## Decision

- A deterministic `gate` node runs after every model turn that contains tool calls:
  - If any call names an unknown tool, every call in that turn gets an error `ToolMessage` and control returns to the model. No tool runs.
  - If any call names a tool in `toolsRequiringApproval`, the gate calls `interrupt({ kind: "tool_approval", toolCalls })`.
  - On resume, only a value whose `approved` field is exactly `true` lets the tools run. Anything else, including malformed input, counts as a rejection (fail closed). A rejection feeds a "Rejected by human reviewer" `ToolMessage` back to the model.
- `agentStep` returns `{ status: "interrupted", interrupt }`. Step Functions enters `WaitForApproval`, which calls `requestApproval` with the task token.
- `requestApproval` does the following:
  - generates `approvalId = randomBytes(32).toString("base64url")` (256 bits, 43 characters);
  - stores `{ taskToken, runId, threadId, expiresAt }` under `pk = approval#<sha256hex(approvalId)>`;
  - sends `approval_required { approvalUrl }` over the run's WebSocket connection.
- The approval endpoint is an API Gateway **REST API** (v1, stage `v1`, throttled to 10 rps / burst 20). A REST API rather than an HTTP API because it is available on LocalStack's free plan (ADR 0009). `POST /approvals/{approvalId}` with `{ "decision": "approve" | "reject", "comment"?: string }` atomically deletes the item (`ConditionExpression attribute_exists(#pk)`, `ReturnValues ALL_OLD`), so each id works once. It then calls `SendTaskSuccess` with `{ approved, comment }`.
  - Expired items return 410.
  - A Step Functions `TaskTimedOut`, `TaskDoesNotExist` or `InvalidToken` error also returns 410.
  - Any other failure re-inserts the item and returns 502.
- The route is POST-only, so link prefetchers and scanners cannot approve by issuing a GET.

## Consequences

- What we gave up: approver identity. Anyone holding the URL can decide. That is acceptable for v0.1 because the URL goes only to the IAM-authenticated WebSocket client that started the run. v0.2 options: a Cognito/JWT authorizer, or a Slack signed request.
- The raw approval id never touches the database or logs. A table dump cannot be replayed as approvals.
- If the client has no live WebSocket connection, nobody receives the URL and the run times out into `ApprovalTimedOut`. v0.2 adds an SNS/Slack notifier.
