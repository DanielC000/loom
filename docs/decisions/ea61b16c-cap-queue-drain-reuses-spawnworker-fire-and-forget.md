# sha:ea61b16c — the cap-queue drain replays through the same `spawnWorker` a manual spawn uses, fire-and-forget, bounded by construction

Source: commit `ea61b16c`, no board card ("fix(orchestration): a cap-queued worker_spawn never
auto-fires when a concurrency slot frees").

## Narrative

`maybeDrainCapQueue` drains a manager's cap-queue: while a concurrency slot is free and an entry is
queued, it pops the OLDEST one (FIFO) and replays it through the SAME `spawnWorker` a manual
`worker_spawn` call uses — so the atomic per-taskId claim and the atomic cap-admit (both proven
race-free there) apply to an auto-fired spawn exactly as they do to a manual one; nothing here
re-implements either guarantee, and a drain can never race a concurrent fresh `worker_spawn` past the
cap because they share that one admission chokepoint. Called from every point a worker's slot actually
frees: the pty `onExit` hook (manual `worker_stop`, `confirmWorkerMerge`'s own hard-stop of the merged
worker, a crash), the no-commit auto-retire block, `retireSiblingSessionsForTask`, and the end of
`finalizeMerge`. Fire-and-forget by every caller (never awaited) — a real spawn (worktree + pty) is as
slow as a manual one, and none of those retirement paths should block on it.

SUPPRESSED while `recycleDrainSuppressed` holds this manager: `recycleWorker` is the one retirement path
that re-claims its own just-freed slot directly, bypassing `spawnWorker`'s cap-admit — an auto-drain
racing into that window could push the manager over cap.

Bounded by construction: each loop iteration either returns (queue empty, cap genuinely full again, or
the manager is paused) or permanently disposes of exactly one popped entry (a successful spawn, a
transient-condition requeue-and-stop, or a dropped+notified failure) — so it can't wedge or loop forever
on a broken entry, and a repeatedly-failing entry costs at most one attempt per drain call.

## Do not

- Do not re-implement the atomic per-taskId claim or cap-admit check inside the drain loop — replay the
  popped entry through the same `spawnWorker` a manual spawn uses, or the two paths can race past the cap.
- Do not await `maybeDrainCapQueue` from a retirement path — it is fire-and-forget by design; a real spawn
  is as slow as a manual one and none of those paths should block on it.
- Do not let an auto-drain race a manager's own slot-reclaim during `recycleWorker` — it must stay
  suppressed while `recycleDrainSuppressed` holds that manager.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `maybeDrainCapQueue`: lines 6521-6541,
as of main `055e96ce`. Relocated by card `c7ca6c08` (tranche 16); no wording changed, wrapped source
lines joined into a flowing paragraph and the `*` comment markers stripped.
