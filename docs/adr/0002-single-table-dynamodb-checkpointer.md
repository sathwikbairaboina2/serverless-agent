# ADR 0002: Single-table DynamoDB checkpointer with TTL

Status: accepted, 2026-10-03

## Context

LangGraph needs a `BaseCheckpointSaver` that persists checkpoints and pending writes per thread and namespace, returns the latest checkpoint quickly, and lists history newest first. Lambda is stateless, so `MemorySaver` cannot carry an interrupted run across invocations.

## Decision

- One table: `pk` (S) and `sk` (S), on-demand billing, TTL attribute `expiresAt`, PITR on.
- Checkpoint item: `pk = <thread_id>`, `sk = cp#<checkpoint_ns>#<checkpoint_id>`.
- Pending write item: `pk = <thread_id>`, `sk = wr#<checkpoint_ns>#<checkpoint_id>#<task_id>#<idx>`.
- Approval item (ADR 0004): `pk = approval#<sha256(approvalId)>`, `sk = approval`.
- Channel blob item (added during the build, because the official conformance suite requires that unchanged channel values are not re-stored): `pk = <thread_id>`, `sk = bl#<checkpoint_ns>#<channel>#<version>` (channel and version URL-encoded). The checkpoint item stores only the skeleton, and `getTuple` rebuilds `channel_values` from `channel_versions`. Unchanged-channel blobs get their TTL refreshed on each `put` (one `UpdateItem` per unchanged channel per checkpoint, a small write-unit cost), so they cannot expire while the latest checkpoint still references them.
- Checkpoint ids are uuid6 strings, which sort by time. "Latest" is therefore `Query begins_with(sk, "cp#<ns>#")` with `ScanIndexForward=false, Limit=1`.
- Serialized bytes come from the saver's `serde.dumpsTyped` (async in `@langchain/langgraph-checkpoint` 1.x). They are stored as DynamoDB Binary, with the type tag kept next to them.
- `thread_id`, `checkpoint_ns`, `checkpoint_id` and `task_id` must not contain `#`. The saver validates this and throws.
- TTL: if `ttlSeconds` is set, every item gets `expiresAt = now + ttlSeconds` when it is written. The default in the construct is 30 days.
- A serialized checkpoint over 350 KB throws `CheckpointTooLargeError` (the DynamoDB item limit is 400 KB).
- `list()` without a `thread_id` uses `Scan`. This is documented as an admin/debug path only.

## Consequences

- What we gave up:
  - Very large states (no S3 offload until v0.2).
  - Cheap cross-thread listing.
  - Complete history for long-lived threads: TTL expires old checkpoints one by one, so the parent chain of a thread older than the TTL can have gaps. The latest checkpoint is always fresh because it was just written.
- Tests use an in-memory fake that understands exactly the expressions the saver emits and throws on anything else (ADR 0007).
