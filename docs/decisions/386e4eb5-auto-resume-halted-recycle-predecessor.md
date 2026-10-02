# 386e4eb5 — auto-resume a halted recycle predecessor through one superseded predicate keyed to its current successor

## Background

f1969787 made `recycleManager` retry a failed ownership-transfer handoff once, then HALT instead of
retiring the predecessor if it's still failing: the predecessor stays live, split ownership persists (some
categories moved to the successor, some stayed). f1969787's own ROUND 3 found a CRITICAL in an earlier fix
round's carve-out: it keyed `resume()`/`deriveCrashOrphanedManagers` on the bare PRESENCE of a
`recycle_ownership_transfer_failed` event — but that event is PERMANENT, so a predecessor that halted once,
was later cleanly reclaimed (its halted successor died, ownership came back), and was then cleanly
re-recycled to a BRAND NEW successor still carries the old event and would wrongly auto-resume ALONGSIDE
the new successor (two live managers). That carve-out was removed; this card reintroduces the SAME idea,
correctly scoped.

## The predicate

`currentHaltedSuccessor(db, sessionId)` (packages/daemon/src/orchestration/crash-orphaned-workers.ts)
returns the session's CURRENT successor (`db.getSuccessor`) only when it is EXACTLY the successor named by
the session's LATEST `recycle_ownership_transfer_failed` event — same id AND same `gen`. `isSupersededByRecycle`
is superseded (refuse auto-resume) unless this returns a match.

"Still unresolved" needs no separate flag: every reclaim path that exists today
(`reconcileHaltedRecycleSuccessorsEarly`, sessions/halted-recycle-reconcile.ts; the in-process
`recoverFleetAfterFailedRecycleSuccessor` via `unlinkAndArchiveDeadRecycleSuccessor`, sessions/service.ts)
unconditionally NULLS the successor's `recycled_from` the instant it reclaims, which flips
`db.hasSuccessor(predecessorId)` to false for that pair — `currentHaltedSuccessor` already returns
`undefined` once that happens (the `getSuccessor` check at the top). The only other way `hasSuccessor` can
stay true is a clean re-recycle to a brand-new successor, which the id/gen match correctly rejects — the
CURRENT successor is a DIFFERENT session than the one the halt event named (an id mismatch; the exact
ROUND 3 bug class). `gen` is checked too, but only as a defensive secondary check — ⛔ never simplify the
match to gen-only: a real round-2 lineage (halt → reclaim → clean re-recycle) can mint a new successor
with the SAME `gen` as the stale, dead one the halt event named (both are `predecessor.gen + 1`), so gen
alone cannot discriminate it; only the id half can. If card `dfc3b014` (a future manual re-attempt/reunite
tool) is ever built and can settle a halted lineage WITHOUT unlinking `recycled_from`, it will need to
extend this match with an explicit resolution marker — there is no such path today.

`recycle_ownership_transfer_failed` is filed ONLY by `recycleManager` — never `recyclePlatformLead` (no
ownership-transfer/halt branch exists there: it reparents wakes/questions unconditionally, with no
retry-then-halt step) and never a worker recycle (that event's `workerSessionId` is always the retiring
manager's id, never a worker's). So the carve-out is a guaranteed no-op for a platform or worker session id
— by construction, not by a role check in the predicate itself.

## Verified at source (not assumed)

- **Event order**: `db.listEventsForSession` is `ORDER BY ts, rowid` (db.ts) — genuinely chronological, so
  `.at(-1)` is the latest event, not merely the last-inserted row. A dedicated test
  (`packages/daemon/test/is-superseded-by-recycle.mjs`) inserts two halt events OUT of insertion order
  (the real/matching one inserted FIRST with a LATER `ts`, a stale/non-matching one inserted SECOND with an
  EARLIER `ts`) and confirms the predicate still picks the ts-latest one — discriminating "ordered by ts"
  from "ordered by rowid/insertion", not just trusting the SQL text.
- **Multiple successors**: NOT reachable for either role that can ever file this event. `recycleManager`
  and `recyclePlatformLead` both refuse a second recycle attempt via a BARE, synchronous
  `if (this.db.hasSuccessor(oldId)) throw ...` check (sessions/service.ts) with ZERO `await` between that
  check and the new successor's `insertRecycleSuccessor` call — JS's single-threaded execution means a
  second concurrent call's synchronous prefix cannot even begin running until the first call's own
  synchronous prefix (which includes the insert) has already run to its first `await`, which sits AFTER
  the insert. So two rows can never simultaneously share `recycled_from = <same predecessor>` for a
  manager/platform lineage. `db.getSuccessor`'s own "newest wins" `ORDER BY created_at DESC, rowid DESC`
  tiebreak remains as pre-existing defense-in-depth for a lineage that somehow forked before these guards
  existed, independent of this predicate.
- **Legacy/malformed events**: a `recycle_ownership_transfer_failed` event with no `detail.gen` (or a
  non-numeric one) FAILS CLOSED — `typeof haltGen !== "number"` is checked explicitly rather than relying
  on `fresh.gen !== undefined` (which would wrongly treat two unrelated rows that both happen to lack a gen
  as "equal"). Covered by `is-superseded-by-recycle.mjs`.
- **Deliberately-stopped predecessor stays dead**: unaffected by this predicate — `recordUnexpectedExit`
  (orchestration/crash-recovery-watcher.ts) returns `false` on `intended === true` BEFORE ever reaching the
  superseded check, and every `pty.stop()` (graceful or hard, human-initiated or not) sets `intended:true`
  at exit, so a deliberately-ended halted predecessor never records a `session_died` trigger and is never
  even considered a watcher candidate. Likewise a graceful stop flips `processState` away from `live`
  before any later crash/restart snapshot, so it never enters `deriveCrashOrphanedManagers`'s `recovered`
  set or `liveFleetResumeSet`'s capture either. Covered by a negative-control case in
  `crash-recovery-watcher.mjs`.

## Both-dead split lineage (the triage note on this card)

This predicate changes nothing for the case where the predecessor is ALSO unresumable this boot.
`resume()`'s earlier checks (missing engine id / transcript / worktree) already refuse it before the code
ever reaches the superseded check, identical before and after this change. The "workers stranded on the
dead, archived successor" residual is a pre-existing, deliberately-accepted gap in a SIBLING mechanism
(`reconcileHaltedRecycleSuccessorsEarly`'s own NEVER RESURRECT gate, `@decision 08c81809`/`f1969787`) — it
answers "can the successor's fleet come back to the predecessor", not "is the predecessor itself eligible
to auto-resume". Recorded on card `dfc3b014` by the manager, not fixed here.

## Do not

- Do not key this (or any sibling check) on the bare PRESENCE of a `recycle_ownership_transfer_failed`
  event — it is permanent and will wrongly match a predecessor that was already cleanly reclaimed and
  re-recycled to an unrelated successor. Always require the exact current-successor id+gen match.
- Do not treat a missing/non-numeric `detail.gen` on either side as a match — fail closed.
- ⛔ Do not simplify the match to gen-only (dropping the id check) — a real round-2 lineage (halt →
  reclaim → clean re-recycle) mints a new successor with the SAME `gen` as the stale, dead one the halt
  event named (both are `predecessor.gen + 1`), so id is the real discriminator and gen is only a
  defensive secondary check.
- Do not add a role check (platform/worker) to `currentHaltedSuccessor`/`isSupersededByRecycle` to "skip"
  non-manager sessions as an optimization — the no-op is already structural (the event can't exist for
  those roles), and a role check would just be dead code that could silently go stale.
- Do not apply this carve-out to `deriveCrashOrphanedWorkers`'s own `hasSuccessor` check
  (crash-orphaned-workers.ts) — that's a WORKER's own `worker_recycle` lineage, unrelated to a manager
  ownership-transfer halt; leave it as bare `hasSuccessor`.
