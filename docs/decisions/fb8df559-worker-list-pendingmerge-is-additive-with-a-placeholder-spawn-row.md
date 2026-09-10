# fb8df559 — worker_list's `pendingMerge` field is additive, plus an additive placeholder row for a pending spawn

## Narrative

Card fb8df559 (Part 1) — CLIENT-TIMEOUT RESILIENCE: each real worker row in the fleet view (shared by `worker_list` and the no-arg `worker_status` call, which aliases to it rather than throwing a schema-validation error) gains a `pendingMerge` field, non-null while a `worker_merge_confirm` for it is still IN FLIGHT. Read-only — never consumed by this view, only projected. `pendingMerge.state:"running"` flips the instant the op is minted (see `withGatePhase`/card 008f33f1 for why that's NOT the same as the gate actually executing) and stays briefly after the op settles (PendingOpRegistry's own "RETAINED TERMINAL VIEW" doc, card d1aee5f1 follow-up).

`worker_list`'s TOP-LEVEL shape stays a BARE ARRAY — no breaking change. A pending `worker_spawn` has no worker row yet (inserted only once `createWorktree` resolves), so it's appended as an ADDITIVE PLACEHOLDER row instead: `workerSessionId:null`, `pendingSpawn` set, `processState:"starting"`, `reportedState:null`, `awaitingReview:false` — shaped so an existing "count live workers" / "find one awaiting review" consumer skips it rather than miscounting a phantom worker.

## A queued gate's client-timeout wait is not a special case (unrelated decision, same card id, `orchestration/gate-semaphore.ts`)

Card fb8df559 (Part 2 — CLIENT-TIMEOUT RESILIENCE, `GateSemaphore` side): a caller that can't immediately acquire a `GateSemaphore` slot QUEUES (awaits) rather than being rejected — merge correctness is unaffected, it just may wait behind another in-flight gate. This composes cleanly with the existing client-timeout resilience mechanism above: `PendingOpRegistry.attach` already wraps the WHOLE `confirmWorkerMerge`/`deploy`/`run_gate` call and degrades to a pending handle once it runs past its sync-wait budget, so a gate that sits queued for a while is handled exactly like a gate that just runs long — no separate handling was needed in the semaphore itself. `GateSemaphore` mirrors `CapQueueRegistry`'s simplicity: daemon-local, in-memory, no persistence. Resetting on a daemon restart is fine — a queued waiter only ever exists inside a live, in-flight call; there is nothing durable to lose.

## Do not

- Do not read `pendingMerge.state:"running"` as "the gate is executing" — it flips the instant the op is minted, well before admission (see card `008f33f1`).
- Do not change `worker_list`'s top-level return shape to accommodate a pending spawn — represent it as an additive placeholder row instead, never a second array or a breaking shape change.
- Do not add separate client-timeout handling for a QUEUED gate — `PendingOpRegistry.attach` already degrades to a pending handle for any call past its sync-wait budget, queued or running alike.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, above `withGatePhase`): lines 2594-2604, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).

Also `packages/daemon/src/orchestration/gate-semaphore.ts` (module-level doc, lines 10-19), commit `70cb11506c`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
