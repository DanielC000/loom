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

## `spawnWorkerTracked`'s dedup key: keyed on the RAW caller-supplied taskId string, not the resolved id

Card fb8df559 (Part 1, `sessions/service.ts` site): `spawnWorkerTracked` is the CLIENT-TIMEOUT-RESILIENT
entry point for the `worker_spawn` MCP tool — the ONLY caller-visible change is at this outer layer;
`spawnWorker` itself (worktree provisioning, the per-taskId mutex, the concurrency cap) is completely
untouched. Keyed on the RAW (trimmed) `opts.taskId` string the caller passed — not the resolved/
prefix-matched task id — so a genuine retry (which replays the identical args) attaches to the SAME
in-flight op; two calls using two DIFFERENT prefix strings for the same underlying task simply don't
dedupe against each other at THIS layer, but `spawnWorker`'s own mutex still prevents a double-spawn (the
second gets that mutex's existing "already has a spawn in flight" error, unchanged) — no correctness
regression, only a narrower dedup-by-string-identity than a full task-id resolution would give.

A taskless spawn (card `2514e6e1`) gets a FRESH per-call dedup key (`spawn:taskless:<uuid>`) instead of
the degenerate `spawn:` every taskless call would otherwise share — two DISTINCT taskless spawns (two
spikes, or two read-only reviewers on two different author branches) must never attach to each other's
in-flight op. The cost: a client-timeout retry of a taskless spawn can't dedupe against its own prior
attempt (no stable identity to key off without a real taskId) and may start a second taskless worker
instead of attaching — a strictly lesser failure than the alternative (unrelated taskless spawns
colliding), and one the manager can resolve with an ordinary `worker_stop`. A tasked spawn's key is
BYTE-IDENTICAL to before.

### Do not (2)

- Do not key `spawnWorkerTracked`'s dedup on the RESOLVED/prefix-matched task id — key on the raw caller
  string, so a genuine retry (identical args) attaches to the same in-flight op.
- Do not give every taskless spawn the same degenerate dedup key — mint a fresh per-call key
  (`spawn:taskless:<uuid>`), or unrelated taskless spawns collide on the same in-flight op.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, above `spawnWorkerTracked`: lines
6281-6300, as of main `1cbc0d74`. Relocated by card `61632c05` (tranche 15); no wording changed, wrapped
source lines joined into a flowing paragraph and the `*` comment markers stripped.
