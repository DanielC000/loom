# 0d4effab — keep a halted-recycle `recovered` nudge durable across a restart

## Narrative

Found by Code Review `daf19b4c` on `54434e27` (pre-existing, not a regression of that card). In
`SessionService.finishReconcilingHaltedRecycleSuccessors`'s `recovered` branch, the predecessor P's
`[loom:recycle-failed]` nudge was enqueued via `enqueueDurableNudge`, and
`db.finishHaltedRecyclePending` (files the `recycle_fleet_recovered` completion event + clears the
`halted_recycle_pending_for` marker, in one transaction — `54434e27`) was then called unconditionally,
right after.

For a `"manager"` recipient, `enqueueDurableNudge` does not persist anything itself — it only ARMS
`this.pty.waitForMcpSeen(predecessorId).then(dispatch, ...)` and returns immediately; the actual durable
write happens only once `dispatch()` finally runs, via the private `enqueueDurableMessage`, which
persists a `session_message_queued` row (or delivers live) only in its `!r.delivered` branch. So
`finishHaltedRecyclePending`'s transaction — the ONLY durable trace that "this lineage is resolved" —
used to commit before any guarantee the nudge had ever been durably recorded anywhere. A crash between
that commit and `dispatch()` actually running lost the nudge permanently: the marker is gone (so no
future boot retries it) and the completion event already says "done" (so the duplicate guard would
refuse to re-fire it even if something did retry).

Traced against the real boot order (`index.ts`): `runBootRecoveryPrefix` (DB-only, sets the marker) runs
before `new PtyHost(...)` even exists; `finishReconcilingHaltedRecycleSuccessors` runs before any resume
path (`resumeFleetOnBoot`/`recoverCrashOrphanedWorkers`). So P is never live in PtyHost at the point this
nudge is enqueued in production today — `waitForMcpSeen` hits its `!live?.alive` short-circuit and
resolves `false` immediately, so `dispatch()` runs as a microtask right after, not after a real
multi-second MCP handshake wait. The window today is narrow (a few synchronous statements / one
microtask-flush), not the wide "P resumed but not yet MCP-seen" window the bug's own framing suggests —
but it is real, and not guaranteed to stay narrow if this call site's ordering ever changes. The fix (and
its test) deliberately exercise the WIDER, realistic version of the race (P genuinely live, `markMcpSeen`
never called) rather than relying on today's incidental timing.

## Mechanism

Don't call `db.finishHaltedRecyclePending` unconditionally right after `enqueueDurableNudge` returns.
Instead, pass it `opts.onOutcome` (already built for exactly this — card `a21f5c9e`) and call
`finishHaltedRecyclePending` ONLY from inside that callback, gated on `outcome.dispatched === true`
(delivered live, or durably persisted via `enqueueDurableMessage` — the SAME meaning `a21f5c9e`'s own
record already establishes: "dispatched:true is not delivered:true", but it IS durable). On
`outcome.dispatched === false` (a genuine total loss — nothing was ever recorded anywhere), log loudly
and do nothing else: the marker stays set, so the NEXT boot's `reconcileHaltedRecycleSuccessorsEarly` /
`finishReconcilingHaltedRecycleSuccessors` re-discovers and retries the whole `recovered` branch for this
predecessor. Every side effect that already ran before this point (`retiredRecycleSuccessorIds.add`,
`carryPendingToSuccessor`, `unlinkAndArchiveDeadRecycleSuccessor`, the stale-banner clear) is already
idempotent by `54434e27`'s own design; the existing `alreadyCompleted` check (keyed on the completion
EVENT, not the marker) and `isHaltedRecyclePendingMarkerStale` staleness logic already handle "the marker
survived a throw" generically — this fix adds one more cause of that same, already-correct shape. No new
mechanism, no new marker, no second parallel durability path.

`recovered.push(predecessorId)` moves WITH the completion — pushed in the `alreadyCompleted` branch
exactly as before (synchronous), or inside `onOutcome`'s `dispatched:true` branch, AFTER
`finishHaltedRecyclePending` has actually succeeded (never pushed if that call throws — scenario (F5c)'s
own atomicity check depends on this: it stubs the marker-clear statement to throw and asserts the branch
"did NOT recover M1"). `enqueueDurableNudge`'s `.then(dispatch)` is a REAL promise continuation — even
when `waitForMcpSeen` resolves already-settled (`Promise.resolve(false)`, the common case for this call
site — see "Narrative"), `.then()` is specified to always defer its callback to a microtask, never call it
synchronously — so every caller that inspects `recovered` must first let that microtask run.
`runRealBootSequenceUpToResume` (the shared test harness in `recycle-manager-halted-successor-dies.mjs`)
now `await`s a small `flushMicrotasks()` helper before returning, so every scenario routed through it
(B/C/E/F/F2/F8, etc.) sees the settled value; a scenario that calls
`finishReconcilingHaltedRecycleSuccessors` directly (F5c) flushes microtasks itself before asserting. The
only consumer of the return value in PRODUCTION is `index.ts`'s boot console.log count, which is
cosmetic; nothing load-bearing reads it.

## Marker-reader audit (required before implementing — every reader of `halted_recycle_pending_for`)

The marker now stays SET for longer within the same boot (until the nudge is confirmed dispatched, which
for a manager recipient can in principle run after `resumeFleetOnBoot`/`recoverCrashOrphanedWorkers`).
Grepped the whole daemon `src/` for `halted_recycle_pending_for`/`HaltedRecyclePending`/
`HaltedRecycleEarlyResult` — every reader, and why none behaves differently or wrongly:

- **`Db.listHaltedRecyclePending()`** (db.ts) — read exactly ONCE per boot, at the very start of
  `reconcileHaltedRecycleSuccessorsEarly`, before `PtyHost`/`SessionService` even exist. Nothing in the
  SAME boot re-reads this column after that. Its only sensitivity to "staying set longer" is across a
  NEXT restart — the intended retry-safety behavior.
- **`isHaltedRecyclePendingMarkerStale`** (halted-recycle-reconcile.ts) — only called from inside the
  function above, on a LATER boot. Checks `db.hasSuccessor` (reads `recycled_from`, already nulled
  synchronously by the EARLY phase's `reparentHaltedRecycleLineage` transaction regardless of this fix)
  and the latest `recycle_ownership_transfer_failed` event's named successor. Neither depends on how long
  the nudge took to resolve.
- **`finishReconcilingHaltedRecycleSuccessors`'s `alreadyCompleted` check** (service.ts) — reads the
  EVENT table (`recycle_fleet_recovered` naming this exact `freshId`), not the marker column. Correctly
  reads `false` on a retry after a `dispatched:false` outcome (the event was never filed), so it redoes
  the nudge+event exactly as `54434e27` already designed for "the marker survived a throw."
- **`retiredRecycleSuccessorIds` / `consolidatedPredecessorIds`** (in-memory `Set`s, consulted by
  `resumeFleetOnBoot` and `recoverCrashOrphanedWorkers`) — populated synchronously, BEFORE the now-deferred
  nudge/completion sequence (unchanged line, unchanged timing). The resume paths see the exact same
  exclusion set regardless of whether the marker/event clear sooner or later.
- **Banners / web UI / REST projections** — nothing outside `db.ts`, `sessions/service.ts`,
  `sessions/halted-recycle-reconcile.ts`, `sessions/boot-backstop.ts` (plus tests and an unrelated
  test-scanner comment in `git/worktrees.ts`) references this column at all. The one banner this branch
  touches (`setLastError(predecessorId, null)`, clearing a prior partial `consolidated` attempt's stale
  text) already runs BEFORE the nudge/event sequence, unaffected by deferring what comes after it.
- **`attention-push.ts`'s owner-paging for `recycle_fleet_recovered`** — a per-companion tail-poll over
  the durable `orchestration_events` log, keyed on a monotonic `seq` watermark; it picks the event up
  whenever it's appended, however late. This fix still files that event EXACTLY once (the whole point of
  gating it on `dispatched:true`), so delaying when it fires only delays the page, never duplicates it.
- **`reparentHaltedRecycleLineage` / the early phase's `recovered.push`/`consolidated.push`
  classification** — run only in the EARLY phase, strictly before this fix's call site; untouched.
- **`waitForHaltedSuccessorReadyThenResolve`** (the `pendingResolution` bucket's observer) — operates on
  a completely separate bucket (`early.pendingResolution`); never touches this marker or the `recovered`
  branch's nudge/event.

Verdict: nothing behaves differently or wrongly from the marker staying set longer within one boot,
because nothing else re-reads it during that boot — the only consumer of its live value is the NEXT
boot's early phase, which is exactly the retry-safety net `54434e27` already proved correct for every
other "marker survives a throw" cause.

## Accepted, narrow residual (take (a), per `08c81809`'s own precedent)

`dispatch()`'s own `enqueueDurableMessage` write and `finishHaltedRecyclePending`'s transaction are two
back-to-back synchronous DB statements with no I/O/await between them (`onOutcome` fires synchronously
from inside `fire()`). If the process dies in EXACTLY that gap — after the nudge has been durably
persisted (or delivered live) but before `finishHaltedRecyclePending` commits — the marker survives
uncleared and the completion event stays unfiled, so the next boot's retry calls `enqueueDurableNudge`
AGAIN, persisting a SECOND durable record with the same text (a fresh `msgId` each time). P would then
receive the nudge twice. This is the same *shape* of residual `08c81809` already accepted elsewhere in
this subsystem (a real but vanishingly narrow synchronous-adjacent crash window, documented rather than
engineered away) — and, critically, it can only ever produce a DUPLICATE, never a LOSS: the realistic,
reproducible race this card exists to fix (crash while the nudge is still genuinely pending behind
`waitForMcpSeen`) is fully closed by the mechanism above. Lead ruling: accept and document this residual
rather than build a dedupe check for it (the (b) option considered and rejected) — it would add surface
for an edge case this card's own test cannot even reliably reach.

**This residual does NOT require an actual process crash — a plain write failure reaches the identical
shape within a SINGLE boot.** If `finishHaltedRecyclePending`'s own transaction throws for an ordinary
reason (e.g. `SQLITE_BUSY`, exactly what scenario (F5c) injects to prove atomicity) AFTER the nudge has
already dispatched (`onOutcome`'s `dispatched:true` already fired, `enqueueDurableMessage` already
persisted the durable row), the `catch` inside `onOutcome` logs and leaves the marker set, same as any
other post-dispatch failure. The marker-driven retry (this same boot's own later reconcile pass, or the
next boot) then redrives the SAME lineage: `recoverUndeliveredMessagesOnBoot` independently redrives the
already-persisted row once its recipient is live, AND the retry re-runs `enqueueDurableNudge`, minting a
SECOND durable record with identical text. Same duplicate-only outcome as the crash case above, same
acceptance — just reachable without any restart at all.

## Do not

- Do not call `db.finishHaltedRecyclePending` right after `enqueueDurableNudge` returns, unconditionally
  — the nudge is only ARMED at that point for a manager recipient, not yet durable. Gate the call on
  `enqueueDurableNudge`'s `onOutcome` reporting `dispatched: true`.
- Do not treat `outcome.dispatched: false` as a reason to retry inline or throw — leave the marker set
  (do nothing else) and let the next boot's existing marker-driven retry loop (`54434e27`) rediscover it.
- Do not build a dedupe check for the back-to-back-statement residual above — Lead ruling: accept (a), not
  (b). The residual is a duplicate-only, vanishingly narrow window, not a loss.
- Do not push `recovered.push(predecessorId)` unconditionally, right after calling
  `enqueueDurableNudge` — scenario (F5c) asserts the branch did NOT recover the predecessor when
  `finishHaltedRecyclePending` itself throws (its own atomicity proof). Push it only once that call has
  actually succeeded — in the `alreadyCompleted` branch, or inside `onOutcome`'s `dispatched:true` branch.
- Do not assume a caller can read `recovered`/`consolidated` synchronously right after calling
  `finishReconcilingHaltedRecycleSuccessors` — `enqueueDurableNudge`'s `.then(dispatch)` always defers to
  a microtask, even when `waitForMcpSeen` resolves already-settled. Flush microtasks first (see
  `runRealBootSequenceUpToResume`'s own `flushMicrotasks()` call, or do it inline for a direct call like
  (F5c)'s).
- Do not widen this fix to the `consolidated` branch — it never calls `enqueueDurableNudge` at all (the
  predecessor is also dead there; nothing to nudge), so it was never exposed to this gap and needs no
  change.

## Source

`packages/daemon/src/sessions/service.ts` (`finishReconcilingHaltedRecycleSuccessors`'s `recovered`
branch). Tests: `packages/daemon/test/recycle-manager-halted-successor-dies.mjs` scenarios (M) (restart
while the nudge is still pending behind `waitForMcpSeen` — RED on main, GREEN after, no duplicate), (N)
(`dispatched:false` leaves the marker set; a later boot completes it exactly once), (O) (the normal
no-crash path still files exactly one event and exactly one nudge); RED→GREEN proven directly via
`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/sessions/service.ts --test
packages/daemon/test/recycle-manager-halted-successor-dies.mjs --ref HEAD`. Landed by card `0d4effab`.
