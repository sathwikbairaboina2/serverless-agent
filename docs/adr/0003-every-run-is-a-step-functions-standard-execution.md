# ADR 0003: Every run is a Step Functions Standard execution

Status: accepted, 2026-10-03

## Context

Runs can pause for hours waiting for a human, which a single Lambda invocation (15-minute cap) cannot do. Alternatives considered:

- Lambda-only runs, with a separate resume Lambda triggered by the approval.
- Step Functions Express. Its 5-minute cap rules out human waits, and it has no `.waitForTaskToken`.
- Lambda durable functions. They are newer and less familiar to reviewers, and the shortlist names Step Functions explicitly.

## Decision

One code path: the WebSocket `$default` handler calls `StartExecution` on a STANDARD state machine (execution name = runId). The machine is `RunAgent` (Lambda) → `NeedsApproval?` (Choice on `$.step.status`) → `WaitForApproval` (`lambda:invoke.waitForTaskToken`, `TaskTimeout = approvalTimeout`) → `RunAgent` → … → `RunCompleted`.

- Failures route to `RunFailed`.
- Approval timeouts route to `ApprovalTimedOut`.
- The state machine timeout defaults to 7 days.

## Consequences

- Durability, visual execution history and a native approval primitive come at about $0.025 per 1,000 state transitions (estimate), roughly 6 transitions for a run with one approval.
- What we gave up: roughly 100–300 ms of start latency on every run (estimate, not measured), even for runs that never need approval. A fast-path Lambda-only mode can come later if measurements justify it.
- Payloads passed between states must stay under 256 KB. `agentStep` truncates `output` to 32,000 characters.
- Step retry after a Lambda timeout (re-entering the graph from the last checkpoint) is not implemented. A timed-out step fails the run.
