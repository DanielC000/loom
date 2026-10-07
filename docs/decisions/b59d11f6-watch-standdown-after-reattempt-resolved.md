# b59d11f6 — `watchHaltedRecycleSuccessor` stands down for good once a `recycle_reattempt` resolves

Code Review of `91ac2b79` flagged a suspected race, unverified at the time: `recycle_reattempt` reaching
`"resolved"` fires `settleRecycleHandoff` unawaited, which stops M1. If M2 then crashes before
`watchHaltedRecycleSuccessor`'s next poll, the watch loop — still running independently in the
background, armed once from `recycleManager`'s HALT branch (`@decision f1969787`) — could reclaim the
fleet onto M1 while M1 is being (or already was) stopped by `settleRecycleHandoff`.

## The race, confirmed at source

`reattemptManagerOwnershipTransfer` (service.ts) has zero `await` points in its body: it checks the
successor's health, runs the ownership transfer, files `recycle_ownership_transfer_resolved`
(`workerSessionId: predecessorId`) synchronously, enqueues the handoff nudge, then does
`void this.settleRecycleHandoff({...}).catch(...)` — unawaited (`@decision dfc3b014`) — and returns.

`settleRecycleHandoff` is `async`; its body runs synchronously up to its first `await` (a ~3s flush-delay
`setTimeout`), then its loop checks `hasReachedReady(freshId)` FIRST. That flag (`pty/host.ts`'s
`live.ready`) is a MONOTONIC LATCH — set once, never cleared on exit — so once the successor reached
ready (a precondition of reaching "resolved" at all), this check is true on the very first iteration,
and `settleRecycleHandoff` calls `pty.stop(oldId, "hard")` UNCONDITIONALLY, independent of whatever has
happened to the successor since.

`watchHaltedRecycleSuccessor` loops independently on its own timer (250ms before its own unresolved-alert
bound, 15s after). It has no visibility into `recycle_reattempt` having resolved anything. If the
successor dies in the window between "resolved" and `settleRecycleHandoff`'s eventual stop, and nothing
will automatically revive it, the watch's existing reclaim branch (`recoverFleetAfterFailedRecycleSuccessor`)
fires — checking only `pty.isAlive(oldId)`, which:

- reads **true** if the watch's tick lands before `settleRecycleHandoff`'s stop has even been issued (the
  common case, since the watch's fast poll is 250ms, far shorter than the 3s flush delay) — the reclaim
  then "succeeds" onto a fully-alive M1, which `settleRecycleHandoff` kills moments later anyway, once its
  own flush delay elapses and it reads the stale ready-latch — stranding the just-reclaimed fleet.
- can ALSO read stale-**true** even after `pty.stop(oldId, "hard")` has been called: `stop()` sets
  `live.killed = true` and calls `live.pty.kill()`, but `live.alive` does not flip to `false` until the
  async `'exit'` event fires later (`pty/host.ts`, documented in ~15 places as a recognized write-safety
  hazard elsewhere in that file). A watch tick landing in that window reclaims onto a predecessor that is
  already mid-termination.

Both orderings strand the fleet: M1 ends up killed (by `settleRecycleHandoff`, which has no idea a reclaim
happened) moments after "recovering" ownership it was never meant to keep once `recycle_reattempt`
resolved things onto M2.

## The fix

`watchHaltedRecycleSuccessor` checks, as the FIRST statement of every loop iteration — before the
`isAlive`/`hasReachedReady` branches — whether a `recycle_ownership_transfer_resolved` event for `oldId`
carries `detail.successorId === freshId`. If one does, the loop returns immediately: once a reattempt
has resolved THIS lineage, `settleRecycleHandoff` is the sole authority over `oldId`'s fate, and this
loop must never act on `freshId`'s state again, regardless of what that state is.

Code Review (final round) flagged the first cut of this fix as lineage-blind: it matched on the bare
presence of a resolved marker for `oldId`, ignoring which successor it actually resolved onto. The
marker's `detail` carries `successorId` (verified at source — `reattemptManagerOwnershipTransfer`'s
`appendEvent` call, `detail: { successorId: successor.id, gen: successor.gen }`), so the check now
requires that id to match `freshId` exactly, mirroring `currentHaltedSuccessor`'s own id-match discipline
(`crash-orphaned-workers.ts`) rather than treating "ever resolved, for any successor" as sufficient.

This can never be stale: the marker is a durable DB row, written with no event-loop yield before
`settleRecycleHandoff` is even fired — no tick of the watch loop (a macrotask) can ever observe
"not yet resolved" after it genuinely is. It closes BOTH orderings above: the watch never again reaches
the `isAlive(oldId)` read at all for this lineage once resolved, so the mid-kill staleness of that read
is moot here (though it remains open generally — see Residual below).

## Residual (NOT fixed here — separate follow-up)

The underlying `pty.isAlive` staleness through the `kill()` → `'exit'` async window, inside
`recoverFleetAfterFailedRecycleSuccessor`'s own NEVER-RESURRECT check, is a narrower, pre-existing hazard
independent of `recycle_reattempt` — it could in principle affect the watch's own unprompted reclaim too
(no reattempt involved at all), if a death observation happens to land in that exact window relative to
some OTHER stop of the predecessor. `PtyHost` exposes no public "is stopping" / "is killed" accessor
today; closing this fully needs new `PtyHost` surface. Carded separately; not addressed by this fix.

## Do not

- Do not have `watchHaltedRecycleSuccessor` itself call `pty.stop` on the predecessor to "fix" this —
  `@decision f1969787` forbids it unconditionally; the fix here is to make the loop return earlier, never
  to give it stopping authority.
- Do not key the stand-down check's LOOKUP (the `workerSessionId` column filter) on `freshId` — the
  marker is filed with `workerSessionId: predecessorId` (`oldId`), not the successor; querying that
  column by `freshId` would never match. This is distinct from the `detail.successorId === freshId`
  equality check inside the match predicate (below) — that check is required, not forbidden; only the
  outer column lookup must stay keyed on `oldId`.
- Do not drop the `detail.successorId === freshId` match and stand down on the bare presence of a
  resolved marker for `oldId` — a resolution filed for a DIFFERENT successor of `oldId` (a separate
  lineage) must never stand down this watch; see the "lineage-blind" correction in "The fix" above.
- Do not move the check anywhere other than the very first statement of the loop body — it must preempt
  both the `isAlive` and `hasReachedReady` branches, since either one is already wrong to act on once
  resolution exists.
- Do not treat this as closing the general `isAlive`-through-kill staleness — see Residual above; that is
  a separate, broader fix needing new `PtyHost` surface.
