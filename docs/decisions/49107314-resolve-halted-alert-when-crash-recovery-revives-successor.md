# 49107314 — resolve a halted recycle alert when crash recovery revives the successor across a restart

## The bug

`d9512de7`'s boot-time observer (`waitForHaltedSuccessorReadyThenResolve`, armed once from
`finishReconcilingHaltedRecycleSuccessors`) only ever waits `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` (~55s)
from the moment boot arms it. A successor that was already `exited` (not `live`/`starting`) at the moment
of the restart — the `reason:"halted-waiting-crash-recovery"` alert shape — is invisible to both
`liveFleetResumeSet` (filters `processState === "live"`, `service.ts:5909`) and `recoverStaleSessions`
(`SELECT * FROM sessions WHERE process_state IN ('live','starting')`, `db.ts:6240`), so neither boot-resume
path (`resumeFleetOnBoot`'s captured-live set, nor `deriveCrashOrphanedWorkers`/`Managers`, both of which
only consume `recoverStaleSessions`'s own returned snapshot) ever revives it. The only mechanism that
revives such a successor is `CrashRecoveryWatcher`, whose candidate set comes from a durable trigger-event
query (`session_died`/`worker_report_undelivered`), independent of this-boot's live/starting snapshot.

**CORRECTED (ROUND 2, Code Reviewer b19b191f) — do not carry the paragraph this replaces.** It used to
claim the watcher's first tick (`setInterval`, no immediate call, ≥60s after `.start()`) always lands
*after* the d9512de7 observer's ~55s bound has already expired, as if that ordering were structural. It is
not: `index.ts` runs `crashRecoveryWatcher.start()` (line ~1516) BEFORE two real `await`s
(`startVaultVersioners`, `logVaultPushStatus`) that precede `finishReconcilingHaltedRecycleSuccessors`'s own
arm (line ~1643) — real wall-clock time elapses in between, so the watcher's tick can land *inside* the
observer's own window, not only after it. The same is true, independent of the watcher entirely, for ANY
other early revival (a human's manual resume) or a project configured with a short
`crashRecoveryWatchMs`. See "ROUND 2" below for the defect this produced and the fix.

The in-process (no-restart) shape of this same scenario is already fully closed: `91ac2b79`'s
`watchHaltedRecycleSuccessor` "waiting" branch doesn't reclaim a successor `willRecoverAutomatically`
covers, and when it eventually comes back alive+ready, the loop's own unchanged `hasReachedReady` branch
fires — `db4b778c` already routes that branch through `openUnresolvedRecycleFleetAlert` before filing
`recycle_fleet_resolved`. `watchHaltedRecycleSuccessor` is in-process only, though (`91ac2b79`'s own
"Daemon restart mid-waiting" section), so none of that survives a restart — this card is strictly the
restart shape.

## The fix

Rather than extending the shared `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` (it's reused by
`settleRecycleHandoff`/`watchHaltedRecycleSuccessor`/the d9512de7 observer, and widening it to cover
`CrashRecoveryWatcher`'s own interval would stretch every one of those unrelated live-watch alert
thresholds too — plus the correct bound would need to account for a retry across several watcher ticks,
not just one), `waitForHaltedSuccessorReadyThenResolve` is now armed from a SECOND call site:
`armHaltedSuccessorReadyObserverIfRevived`, called from BOTH of `SessionService.resume()`'s successful-
revival return points (the ordinary `--resume` path, and `resumeForcedRoleAsFreshClaude`'s codex-forced-
fresh-start redirect). `resume()` is the one real chokepoint every revival of a stopped session funnels
through — `CrashRecoveryWatcher.tick()`'s own resume call, `resumeFleetOnBoot`, and a human's manual
`/resume` — so hooking it there covers all three with one hook, not watcher-specific plumbing.

`armHaltedSuccessorReadyObserverIfRevived(sessionId)` reads the just-resumed row, and arms the SAME
bounded `waitForHaltedSuccessorReadyThenResolve(predecessorId, sessionId)` only when `sessionId` is the
CURRENT halted successor (`currentHaltedSuccessor`, the same id+gen-matched discriminator `386e4eb5`'s
own guard uses) for a predecessor with a still-open unresolved alert (`openUnresolvedRecycleFleetAlert`).
It is a no-op for every ordinary (non-halted) session — both checks fail fast on `session.recycledFrom`
being unset. The arm itself gives the full ~55s window measured from the ACTUAL revival (not from boot
time, when a watcher-driven revival may not even have started yet), which is strictly more generous than
the boot-time observer's own window for this same successor.

The in-flight ownership (`SessionService.haltedSuccessorReadyWaitDeadlines`, a `Map<freshId, deadline>`)
lives INSIDE `waitForHaltedSuccessorReadyThenResolve` itself — the map entry is written synchronously at
entry, re-read by the one owning loop on EVERY iteration (never captured once into a local `const`), and
deleted in a `finally` once the loop settles (resolved, stood down, or timed out) — rather than at either
call site. This is what makes "a boot resume through `resume()` doesn't double-arm the boot-armed observer"
true for free: `finishReconcilingHaltedRecycleSuccessors` (line ~1643 in `index.ts`) runs, and so arms its
`early.pendingResolution` entries, strictly BEFORE `resumeFleetOnBoot` (line ~1662) can call `resume()` for
any of those same successors — so by the time `resume()`'s hook would try to arm the identical pair, the
map entry the boot-reconcile call already wrote synchronously is already in place, and the hook's own arm
attempt only EXTENDS it (see "ROUND 2" below for why extending, not dropping, is required) rather than
spawning a second real poller. Deleting on EVERY settle path (not just the resolved one) is what lets a
LATER, genuinely new revival (e.g. a revive-fail-revive retry sequence) re-arm cleanly instead of being
permanently blocked by a stale entry from an earlier, already-finished wait.

## ROUND 2 (Code Reviewer b19b191f) — MAJOR, reproduced: a later arm must EXTEND, never DROP

The original design (round 1) treated a later arm for an already-in-flight `freshId` as a pure no-op: the
guard was a bare `Set<freshId>`, and a second call just checked membership and returned, leaving the FIRST
call's own, earlier-computed deadline as the only one that mattered. The Code Reviewer reproduced the
resulting defect directly: the boot-armed observer was armed, a tick revived the successor at t=450ms
(bound 600ms) — a revival landing INSIDE the boot window, per the corrected premise above — and the
successor reached ready 300ms later, at t=750ms. The SECOND arm (from the tick's own `resume()` call) saw
`has(freshId) === true` and no-opped; the FIRST (owning) poller's own deadline, fixed at t=600ms since the
moment boot armed it, had ALREADY expired and given up by the time readiness arrived — so **no
`recycle_fleet_resolved` was ever filed**, despite a revival having genuinely happened well inside what
should have been a fresh ~55s-equivalent window.

**Fixed:** the guard is now `haltedSuccessorReadyWaitDeadlines: Map<freshId, deadline>`, not a `Set`. Every
arm — the owning one AND every later one for the same `freshId` — writes
`now + RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` into the map UNCONDITIONALLY, before checking whether it is the
owner (`isOwner = !map.has(freshId)`, checked BEFORE the write). Only the owner (the first arm to find no
existing entry) actually runs the polling loop; every later arm's write just pushes the deadline out and
returns immediately. The one owning loop re-reads `map.get(freshId)` on every iteration (never a local
`const deadline` captured once) — so a later arm's extension is visible to it on its very next poll,
without spawning a second concurrent poller. See (M1) in the verification test for the exact race,
reproduced and proven fixed.

## ROUND 3 (Code Reviewer cb74fc3b) — test-only: make (M1) deterministic, not just "margin-generous"

`cb74fc3b` found (M1) MERGEABLE (the Map lifecycle itself has no hole; all 5 behavioural mutations go RED),
but flagged (M1)'s own anti-vacuity check as unsound: it compared `Date.now()` against `armedAt`, a
timestamp captured BEFORE `runBootRecoveryPrefix`/`finishReconcilingHaltedRecycleSuccessors` even ran — so
"`Date.now() - armedAt > 1200`" was true BY CONSTRUCTION (measuring elapsed time since an earlier, unrelated
origin, not against the mechanism's own deadline), and the real `sleep(800)` pacing before it had only
~400ms of margin before the extended deadline under system load — a real flake risk for a scenario that now
runs in every future gate.

**Fixed (test-only, no source change):** (M1) now reads `D0 = haltedSuccessorReadyWaitDeadlines.get(freshId)`
directly off the map right after the boot-arm, and `D1 = ...get(freshId)` right after the later revival —
`D1 > D0` is PROVEN WITH NO TIMING AT ALL (a direct read of the mechanism's own state, never an elapsed-time
inference). The wait before delivering readiness is now `waitUntil(() => Date.now() > D0 + 2*pollMs)` —
anchored to the REAL D0 the mechanism computed, not a guessed duration — and the revival itself was moved
to 75% through the window (mirroring the Code Reviewer's own 450/600 repro ratio) rather than 500/1200,
widening the margin before the extended deadline D_ext to ~900ms (previously ~400ms under the old 500/800
split) even though D0 is now reached with LESS total wait than before.

## Residual (NOT fixed here — accepted, named explicitly)

A successor that takes longer than `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` (~55s) to reach ready AFTER the
LATEST arm (the most recent extension, whichever call produced it) still leaves the alert open — this card
narrows the window in which the gap can occur (down from "the whole rest of the daemon's uptime" to "a slow
boot past the ready ceiling, measured from the most recent revival") — it does not eliminate it. No new
timeout logic is introduced to cover this; the existing d9512de7 "logs once and leaves the alert open"
outcome is unchanged and still the correct, honest behavior for a wait that genuinely exceeds the bound.

## Do not

- Do not raise `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` (or add a parallel constant) to try to span
  `CrashRecoveryWatcher`'s own tick interval — that constant is shared with `settleRecycleHandoff` and
  `watchHaltedRecycleSuccessor`'s own unrelated alert thresholds, and the correct bound would have to cover
  a multi-attempt retry sequence, not one interval — see "The fix" above for why the resume()-hook design
  was chosen instead.
- Do not add a CrashRecoveryWatcher-specific callback/dependency to arm this observer — `resume()` is the
  shared chokepoint every revival path already funnels through; a watcher-only hook would miss a manual
  human resume and `resumeFleetOnBoot`.
- **ROUND 2: do not treat a later arm for an already-in-flight `freshId` as a no-op that drops the new
  deadline** — see "ROUND 2" above for the exact reproduced defect (a revival inside the boot window whose
  readiness then lands after the FIRST arm's own, earlier, never-extended deadline). A later arm must
  EXTEND the shared deadline; only skip spawning a SECOND poller, never skip the write.
- Do not move the in-flight ownership (`haltedSuccessorReadyWaitDeadlines`) out of
  `waitForHaltedSuccessorReadyThenResolve` into either call site — the boot-arm-before-resume-hook ordering
  this card relies on to avoid a second real poller only holds because the map write happens synchronously
  at the START of the shared function, before its first `await`.
- **ROUND 2: do not capture the loop's deadline into a local `const` once** — the one owning loop must
  re-read `haltedSuccessorReadyWaitDeadlines.get(freshId)` on EVERY iteration, or a later arm's extension is
  invisible to it and the original (round 1) defect reopens under a different guise.
- Do not skip deleting the map entry on the timeout/stand-down paths, only on the resolved path — a later
  genuine revival (a revive-fail-revive retry) must be able to re-arm; a guard that only clears on success
  would wrongly block every subsequent attempt after a single timeout.
- Do not let `armHaltedSuccessorReadyObserverIfRevived` throw into `resume()`, await anything, or change
  `resume()`'s return value/timing — it is deliberately wrapped end-to-end in try/catch and fires the
  observer with `void ...catch(...)`, never `await`.
- Do not assume this closes the ">bound" residual above — see "Residual" section; a successor slower than
  ~55s to reach ready after the latest arm still leaves the alert open, by design, same as every other
  caller of this function.

## Verification

`test/resume-arms-halted-successor-observer.mjs` drives the real `resume()`/`waitForHaltedSuccessorReadyThenResolve`
against a simulated restart (closing and reopening the same on-disk `Db`, mirroring
`recycle-fleet-resolved-after-halted-boot-reconcile.mjs`'s own technique), varying revival path (a real
`CrashRecoveryWatcher.tick()`, a direct `resume()` call, and `resumeFleetOnBoot`), ready-within-window vs.
never-ready (bounded timeout, alert left open, deadline-map entry cleared), a revive-fail-revive retry
(asserts exactly one `recycle_fleet_resolved` event, no stacked observers), a `resume()` of a non-halted
session (asserts zero behavior change — no observer armed, no extra event), and the full restart shape
(alert opened pre-restart, successor exited before restart, revived post-restart via the real
`CrashRecoveryWatcher` tick) — R1/R2/R3/R4/R5/R6. **ROUND 2 additions:** (M1) reproduces the exact
inside-the-boot-window race the Code Reviewer found — a revival lands well before the boot-armed observer's
own original deadline, readiness then arrives after that original deadline but within the deadline the
revival should have bought, and exactly one `recycle_fleet_resolved` is still filed (the round-1 design
would have left the alert open here); (Minor m1) pins the `currentHaltedSuccessor` pre-check directly — an
ORDINARY (non-halted) successor's open settle-timeout alert (reason:"timeout", which
`openUnresolvedRecycleFleetAlert` matches just as readily, by db4b778c's own deliberate no-filter design)
must NOT arm an observer; (Minor m1b) drives the SAME ordinary-successor exclusion through the REAL
`resume()` chokepoint via a genuine `CrashRecoveryWatcher.tick()`, rather than a direct call to the gating
function; (Minor m2) exercises the OTHER successful-revival return point, `resumeForcedRoleAsFreshClaude`'s
codex-redirect, via a real fake codex rollout fixture (mirrors `forced-role-resume-retry-safety.mjs`'s own
technique). **ROUND 3:** (M1) is now fully deterministic — see "ROUND 3" above. A behavioural negative
control (the `armHaltedSuccessorReadyObserverIfRevived` call removed from both `resume()` call sites in
`dist/`, rebuilt, re-run, then restored) turns every restart-revival scenario RED by name, never the
non-halted (R6)/(m1)/(m1b) ones; restoring the build turns it green again.
