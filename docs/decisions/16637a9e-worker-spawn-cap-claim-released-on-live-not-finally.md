# 16637a9e — `worker_spawn`'s cap claim releases on the row going live, not in the outer `finally`

## Narrative

Card `c2cf86f8` made the concurrency-cap admit atomic: `liveWorkers + inFlightForManager >= cap`, checked
before the per-taskId claim is added and before `await createWorktree`. That fix is correct as far as it
goes, but it left the OTHER half of the claim's lifecycle wrong: `inFlightSpawnCountByManager`'s claim for
a given spawn was released only in the outer `finally`, well after the worker row had already been
flipped `processState:"live"` (`this.db.setProcessState(worker.id, "live")`, `spawnWorker`).

Between that `setProcessState('live')` call and the `finally`, `spawnWorker` still awaits at least one
real async operation for a tasked spawn — the wasted-dispatch advisory's `await
findShippedCardMatch(...)`, a real git-log read via `GitReader`. During that window, the SAME spawn was
counted TWICE by any OTHER concurrent `worker_spawn` call's own cap check: once via `liveWorkers` (the DB
already says this row is live) and once via `inFlightForManager` (the claim was still held). A concurrent
spawn's check could therefore see `live + inFlight` one higher than the true number of slots actually in
use, and reject a spawn that should have been admitted. Card `16637a9e`'s two live specimens showed
exactly this shape: a refusal at "cap reached (6)" while `worker_list` showed only 5 real live workers and
one free slot.

The fix: release this manager's `inFlightSpawnCountByManager` claim SYNCHRONOUSLY, immediately after
`setProcessState('live')` returns — the same tick, no `await` in between — via a small idempotent closure
(`releaseCapSlotClaim`) called there AND (as a no-op once already released) from the existing `finally`.
From the instant the row goes live, `liveWorkers` already reflects it; releasing the claim in the same
tick means the slot is always counted by exactly one of the two terms, never both and never neither.

A companion fix was required, or this alone introduces a new under-count: `getWorkerCapacity`'s one
success-path call site (`const capacity = this.getWorkerCapacity(managerSessionId, true)`) passed
`excludeOwnClaim:true` because, before this fix, the caller's OWN claim was still held at that point
(so `inFlight` had to subtract 1 to avoid double-counting it against the `live` count that already
includes it). After this fix, the claim is already released by the time that line runs, so `rawInFlight`
no longer includes this call's own claim at all — `excludeOwnClaim:true` would then wrongly subtract 1
from a count that might belong entirely to an UNRELATED, genuinely-still-in-flight sibling spawn,
under-counting `capacity.inFlight` by 1 whenever one exists. The `excludeOwnClaim` PARAMETER WAS REMOVED
from `getWorkerCapacity` entirely (not merely left at its `false` default) — after the release moved
earlier, no caller has any legitimate use for it, and a grep at the time confirmed exactly one call site
existed daemon-wide.

`inFlightSpawnTaskIds` (the separate, deliberately-global same-taskId duplicate-spawn mutex) is untouched
— it still releases only in the `finally`. The two claims are therefore no longer released in lockstep on
every path: they still release together, both from the `finally`, on any failure BEFORE the row goes
live; only on the success path does the cap-count claim now release earlier.

## Do not

- Do not move `inFlightSpawnCountByManager`'s release back into the outer `finally` alone — that reopens
  this exact over-count window between `setProcessState('live')` and whatever the outer `finally` waits
  on.
- Do not reintroduce an own-claim exclusion (an `excludeOwnClaim`-shaped argument) on
  `getWorkerCapacity`'s success-path call site unless the claim's release ALSO moves back to the
  `finally` — the two must change together, or `capacity.inFlight` under-counts a genuinely-still-in-flight
  sibling spawn (an own-claim exclusion is only ever correct while the caller's own claim is STILL held at
  read time; this fix's whole point is that it no longer is).
- Do not fold this claim back into `inFlightSpawnTaskIds` on the theory that they should release
  together — they guard different things (a per-manager cap count vs. a global same-taskId mutex) and,
  since this fix, release on different schedules on the success path.
- The idempotence guard on `releaseCapSlotClaim` (`if (capSlotClaimReleased) return;`) is LOAD-BEARING,
  not defensive boilerplate — do not remove or bypass it. Without it, a spawn that releases early at
  `setProcessState('live')` and is then released AGAIN from the outer `finally` decrements
  `inFlightSpawnCountByManager` twice for its own single claim; the second decrement has nothing of that
  spawn's own left to consume, so it eats into a SIBLING spawn's still-genuinely-open claim instead — one
  spawn's double release silently drops the fleet-wide in-flight count by 1, reopening `c2cf86f8`'s
  overshoot for whichever concurrent spawn happens to be relying on that count. Verified by removing the
  guard and rebuilding: `worker-spawn-cap-inflight-live-double-count.mjs`'s scenario (2) assertion that
  the sibling's claim survives spawnD's own release fails exactly this way.

## Source

Inline `@decision 16637a9e` anchor in `packages/daemon/src/sessions/service.ts`, on the
`inFlightSpawnCountByManager` field's own doc comment (~line 2027).
