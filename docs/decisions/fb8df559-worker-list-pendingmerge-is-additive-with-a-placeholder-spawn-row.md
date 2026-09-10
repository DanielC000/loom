# fb8df559 — worker_list's `pendingMerge` field is additive, plus an additive placeholder row for a pending spawn

## Narrative

Card fb8df559 (Part 1) — CLIENT-TIMEOUT RESILIENCE: each real worker row in the fleet view (shared by `worker_list` and the no-arg `worker_status` call, which aliases to it rather than throwing a schema-validation error) gains a `pendingMerge` field, non-null while a `worker_merge_confirm` for it is still IN FLIGHT. Read-only — never consumed by this view, only projected. `pendingMerge.state:"running"` flips the instant the op is minted (see `withGatePhase`/card 008f33f1 for why that's NOT the same as the gate actually executing) and stays briefly after the op settles (PendingOpRegistry's own "RETAINED TERMINAL VIEW" doc, card d1aee5f1 follow-up).

`worker_list`'s TOP-LEVEL shape stays a BARE ARRAY — no breaking change. A pending `worker_spawn` has no worker row yet (inserted only once `createWorktree` resolves), so it's appended as an ADDITIVE PLACEHOLDER row instead: `workerSessionId:null`, `pendingSpawn` set, `processState:"starting"`, `reportedState:null`, `awaitingReview:false` — shaped so an existing "count live workers" / "find one awaiting review" consumer skips it rather than miscounting a phantom worker.

## Do not

- Do not read `pendingMerge.state:"running"` as "the gate is executing" — it flips the instant the op is minted, well before admission (see card `008f33f1`).
- Do not change `worker_list`'s top-level return shape to accommodate a pending spawn — represent it as an additive placeholder row instead, never a second array or a breaking shape change.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, above `withGatePhase`): lines 2594-2604, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
