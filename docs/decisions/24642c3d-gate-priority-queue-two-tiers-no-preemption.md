# 24642c3d — the gate queue is two priority tiers, FIFO within each, with no preemption of a running gate

## Narrative

Card 24642c3d: queued `GateSemaphore` callers wait on TWO tiers — `highWaiters` (merge/deploy) drain fully before `lowWaiters` (a worker's own `run_gate` self-check), FIFO within each tier. This is what stops a low-priority worker's timing-out `run_gate` retries from head-of-line-blocking a higher-priority merge that arrives later — the exact starvation pattern this card was filed against. It reorders the QUEUE only: there is no preemption of an already-RUNNING gate. `runExclusive`'s `priority` param defaults to `"high"` so an untouched/future call site behaves exactly as before this card — every caller was implicitly equal-priority FIFO before the two-tier split existed.

Preemption was deliberately never added: killing a healthy in-flight gate to make room would waste the work it's already done and risks leaking a process tree. A `"high"` caller only ever jumps ahead of ALREADY-QUEUED `"low"` waiters; same-tier order always stays FIFO.

## Do not

- Do not add preemption of a running gate to fix a starvation complaint — killing an in-flight gate wastes its progress and risks leaking a process tree; the fix is the two-tier queue order, not interrupting what's already admitted.
- Do not assume a `"high"` caller can jump ahead of another already-admitted `"high"` caller, or of a `"low"` caller that's already running — the tiers only ever reorder the QUEUE.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (module-level doc, lines 21-24; `GatePriority`'s own doc, lines 109-115), commit `252d25bb51`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
