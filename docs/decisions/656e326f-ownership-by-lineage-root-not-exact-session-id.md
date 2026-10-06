# 656e326f — ownership checks on an attach()-reachable op compare by LINEAGE ROOT, never exact session id

`PendingOpRegistry.attach()` can hand a caller the result of an op it did not mint — an already-RUNNING
op, a TTL'd `retained` hit, or (for merge) the never-expiring `untilSupersededVerdicts` cache hit. None of
those paths ever re-enters the real operation's own body, so an ownership check written only inside that
body (e.g. `confirmWorkerMerge`'s `NotYourWorkerError` throw) never runs for an attach — a manager holding
a `workerSessionId`/`taskId` it does not own could attach to another manager's in-flight or cached op and
receive its full result.

The fix hoists an ownership check before `pendingOps.attach()` is ever called, so it gates an attach
identically to a fresh mint. That check must compare by LINEAGE ROOT (`lineageRootId`), not by exact
session id: `mergeBatchTracked`'s own `runFallback` calls `confirmWorkerMergeTracked` with a worker's
CURRENT resolved owner (via `resolveLineageOwnerForWorker`), which can legitimately differ from whichever
manager id an external caller still holds after a recycle. An exact-id comparison would wrongly refuse
that fallback call (or any legitimate recycle predecessor/successor of the true owner); comparing lineage
roots instead — the same primitive `buildBatchDedupeKey` and `workerReadableByManager` already use —
lets the owner, any predecessor, or any successor in the same recycle chain through, while still refusing
an unrelated manager.

## Round 2 — `foreignSpawnGuard` false-refusing a settled, unusable retained op

`spawnWorkerTracked`/`reviveWorkerTracked`'s `foreignSpawnGuard` refused an unrelated manager's call on
ANY non-expired `pendingOps.peek(key)` hit with a different lineage root — including a RETAINED
(already-settled) view whose cached worker had since exited or been reassigned. `peek()` applies no
usability filtering at all (it only checks expiry), so for up to `SPAWN_OP_RETAIN_MS` (10 min) after
settle, an unrelated manager was refused as "in-flight" for an op that, had the call actually reached
`pendingOps.attach()`, would have been treated as a MISS (via `isRetainedResultUsable`) and allowed to
mint a genuinely fresh spawn.

The fix factors `attach()`'s own retained-hit decision (expiry + `NEVER_CACHED_OUTCOMES` + usability) into
`PendingOpRegistry.usableRetainedHit`, and adds `peekAttachable(key, { isRetainedResultUsable })` — a
read-only query built on that SAME helper, never a second copy of the decision. `foreignSpawnGuard` now
calls `peekAttachable` (passing the identical `isRetainedResultUsable` closure the matching
`pendingOps.attach()` call site uses for that key's kind) instead of the raw, unfiltered `peek()` — so it
refuses only a genuinely RUNNING op, or a retained view `attach()` would itself still serve as a cache
hit. The refusal message also now distinguishes the two: "in flight" only for a running op, "already
spawned by another manager's recent op" for a usable retained one — `peek()` itself is unchanged and
still used by every OTHER caller (worker_list's display surfaces) that wants the raw, unfiltered view.

## Round 2 — the "normalise the spawn key to the resolved full task id" item was descoped

The original card's DoD also asked to normalise `spawnWorkerTracked`'s dedupe key (`spawn:${taskRef}`) to
the resolved full task id, so a full id and its 8-char prefix would dedupe together. The lead descoped
this: it conflicts with `@decision fb8df559` (dedupe deliberately on the RAW caller `taskId` string, not
the resolved one — see that decision's own "Do not (2)"), and the reviewer verified the prefix/full-id
mismatch is harmless on the ownership side — no cross-attach ever occurs between a full id and its prefix,
since `foreignSpawnGuard`/`sameManagerLineage` key off `managerSessionId`, never the task-id string. Not
implemented; left as-is.

## Do not

- Do not compare ownership by exact `managerSessionId === worker.parentSessionId` on an attach-reachable
  path — use `lineageRootId` equality (`sameManagerLineage`), or a legitimate recycle predecessor/successor
  (including a merge-batch fallback acting on the worker's current resolved owner) is wrongly refused.
- Do not skip this check for spawn/revive on the theory that "there's no worker row yet to own" — the
  PendingOpRegistry entry/retained view itself already carries the minting call's `managerSessionId`
  (`PendingOpView.managerSessionId`); compare the caller's lineage root against THAT instead.
- Do not have `foreignSpawnGuard` (or any other ownership guard reachable before `attach()`) re-derive its
  own copy of the retained-hit usability decision — call `PendingOpRegistry.peekAttachable` with the SAME
  `isRetainedResultUsable` predicate the matching `attach()` call site uses, or the two can silently drift.
  `peekAttachable` only answers "running + TTL-retained" — it is NOT valid for a key using
  `opts.retainVerdictUntilSuperseded`/`opts.bypassRetained` (no visibility into `untilSupersededVerdicts`,
  identity matching, or a bypass escalation); a guard for such a key needs its own answer to that question.
- Do not implement "normalise the spawn key to the resolved full task id" — descoped per the above;
  `@decision fb8df559` keeps the raw-taskId dedupe key on purpose.
