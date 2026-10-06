# 92c20eb9 — refuse fleet writes from a manager being retired by recycle

## Context

`insertRecycleSuccessor` (sessions/service.ts, called from `recycleManager`/`reattemptManagerOwnershipTransfer`)
links a fresh successor's `recycled_from` to the predecessor SYNCHRONOUSLY, well before the predecessor's
pty is actually hard-stopped. `settleRecycleHandoff` is fire-and-forget (`void this.settleRecycleHandoff(...)`)
and only stops the predecessor after `RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS` plus the successor reaching
ready — the predecessor's row stays `role:"manager"`, `processState:"live"` the whole time. The same shape
exists for `recycle_reattempt`'s RESOLVED branch. In that window, the predecessor can still receive and
execute MCP tool calls.

Two distinct defects were found in this window, both keyed off the same `isSupersededByRecycle` predicate
(orchestration/crash-orphaned-workers.ts) — never a bare `hasSuccessor`, which would also refuse the one
case that must stay live: a halted predecessor whose ownership-transfer handoff is still genuinely
unresolved (decision `386e4eb5`/`f1969787`).

1. **`spawnWorker`** (and `reviveWorker`, which wraps it) had no check at all — a worker spawned/revived by
   the retiring predecessor during this window was parented to a manager about to be stopped.
2. **`selfHealWorkerLink`** (mcp/orchestration.ts) is called from every manager-surface per-worker tool. It
   uses `workerReadableByManager`, which is lineage-scoped (same `lineageRootId` root), not exact-parent —
   so if the retiring predecessor called ANY of those tools on a worker `attemptManagerOwnershipTransfer`
   had already reparented onto the successor, the self-heal would relink the worker's `parentSessionId`
   BACK onto the dying predecessor, undoing the correct reparent and orphaning the worker from the
   successor's `worker_list` (an exact-parent-match query) right before the predecessor is hard-stopped.

## Fix

- `spawnWorker` refuses up front (`isSupersededByRecycle(this.db, managerSessionId)`) before any side
  effect — covers `worker_revive` for free since it calls `spawnWorker` internally.
- `selfHealWorkerLink` skips the relink (returns the row unchanged) when the caller is superseded —
  `callerSupersededError()`, mcp/orchestration.ts.
- The write tools among `selfHealWorkerLink`'s callers that mutate fleet state on behalf of the caller —
  `worker_stop`, `worker_message`, `worker_redirect`, `worker_recycle`, `worker_merge_confirm`,
  `merge_batch`, `worker_set_mode`, `worker_flush`, `worker_reap`, `worker_relink` — refuse outright with
  the same error text when the caller is superseded, via the same `callerSupersededError()` helper.
- Error text (both chokepoints): `you are being retired (recycled); your successor <id> owns the fleet`.

## Do not

- Do not use a bare `hasSuccessor` check in place of `isSupersededByRecycle` anywhere in this fix — it
  would wrongly refuse a halted predecessor whose handoff is genuinely unresolved and must stay live (see
  `386e4eb5`/`f1969787`).
- Do not refuse the three pure-read callers of `selfHealWorkerLink` (`worker_status`, `worker_transcript`,
  `worker_report_get`) or `worker_merge` (a dry-run review, not a mutation) — only the self-heal's
  RELINK side effect was ever unsafe for a read; the reads themselves stay available to a retiring
  predecessor.
- Do not compute `isSupersededByRecycle` once at server-build time and cache it — the caller's own
  supersession status can change mid-session (the predecessor's MCP server is built while it is NOT yet
  superseded); it must be re-evaluated on every call.
- Do not duplicate the `isSupersededByRecycle`/`getSuccessor`/error-text logic at each of the ten write
  call sites — route them all through the one `callerSupersededError()` helper (mcp/orchestration.ts) so
  the error text and predicate can't drift apart across sites.

## Halted-predecessor relink-back (Code Review round 1)

A HALTED predecessor (the `386e4eb5`/`f1969787` carve-out above) is deliberately NOT superseded, but can
already have had a worker reparented onto its successor (halting only blocks RETIRING, not the "workers"
step). `callerSupersededError()` never fires for it, so it hit the same relink-back bug as the superseded
case (`recycle-refuses-fleet-writes.mjs`'s Part B: `liveW` on `m2` while `m1` stays unsuperseded).

Fix: `selfHealWorkerLink` also skips the relink whenever the worker's `parentSessionId` already equals the
caller's own successor (`db.getSuccessor(managerSessionId)?.id`) — unconditionally, independent of
`isSupersededByRecycle`. Once the relink stops, a write tool's own downstream exact-match guard in
`sessions.*` correctly refuses "not your worker" for that one worker.

### Do not

- Do not gate this check on `isSupersededByRecycle` — false by design for exactly the case this covers.
- Do not extend the 10 write-tool refusals to also check "does this worker belong to my successor" — a
  halted predecessor still legitimately owns the REST of its fleet; the downstream exact-match guard
  already refuses the ONE worker that moved, once this fix stops masking that it moved.
