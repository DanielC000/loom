# 91ac2b79 — keep a halted recycle successor that reached ready and then crashed

## The bug

`watchHaltedRecycleSuccessor` (`packages/daemon/src/sessions/service.ts`, armed only from
`recycleManager`'s HALT branch, `@decision f1969787`) checks `!pty.isAlive(freshId)` **before**
`pty.hasReachedReady(freshId)` on every poll — the opposite order from its sibling
`settleRecycleHandoff`. `hasReachedReady` reads `this.live.get(sessionId)?.ready`
(`packages/daemon/src/pty/host.ts`), a monotonic latch: a claude session's `Live` entry is **never**
deleted on exit (`onExit` sets `alive:false` and keeps the entry), so once `ready` is observed true it
reads true forever, dead or alive.

Because the loop is a pure `setTimeout` poll (250ms fast / 15s slow once the unresolved-alert deadline at
`RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` ≈55s passes) and checks `!isAlive` first, the only way it ever takes
the "leave alone" (ready) branch is if some poll tick catches the successor alive **and** ready
simultaneously. If reaching ready and dying both happen inside one poll gap — plausible for a successor
that boots slowly (near the 45s `READY_FALLBACK_ABSOLUTE_CEILING_MS`/`CODEX_BOOT_READY_TIMEOUT_MS` ceiling)
and then crashes shortly after finally reaching ready, within the 15s slow-cadence window — no poll ever
observes that intermediate state, and the very next tick reclaims a successor that may have had real,
delivered context (a completed turn) — discarding it.

This is a narrower instance of the shape `docs/decisions/09b14f15-recycle-reattempt-false-resume-promise.md`
already fixed for `reattemptManagerOwnershipTransfer` (the `recycle_reattempt` tool): never treat
`isDurablyResumable` alone as evidence of real context, and never promise "wait for automatic recovery"
without checking `willRecoverAutomatically` (which itself checks a real trigger is on record and not
already resolved). That record explicitly named this card as the un-ported follow-up for
`watchHaltedRecycleSuccessor`'s own symmetric branch.

It is a **different** bug from `docs/decisions/6e5af155-recycle-successor-down-resumable-event.md`, which
explored and rejected the same leave-alone shape for `settleRecycleHandoff`/`watchHaltedRecycleSuccessor`'s
**pre-ready** death case. That record's round 3 proved the kickoff/handoff is delivered only
post-`markReady`, so a successor that never reached ready never received any instruction — reclaiming it
is correct, and nothing in this card revisits that. This card is scoped exactly to the sub-case 6e5af155's
own "halted-branch wrinkle" section named as real but out of scope: a successor that **did** reach ready
(kickoff delivered, possibly a completed turn) and then died, inside `watchHaltedRecycleSuccessor`
specifically — unreachable for `settleRecycleHandoff` (ready-first check order there makes its not-alive
branch unreachable once ready was ever true), but reachable here because the check order is reversed.

## The fix

Inside the `!isAlive(freshId)` branch, before reclaiming, read the successor row fresh off the DB
(`this.db.getSession(freshId)`, never in-memory `hasReachedReady`/`live` state) and gate on the exact same
shape `reattemptManagerOwnershipTransfer` already uses — reused directly, not forked:

- Row gone, `turnSeq === 0`, or not `isDurablyResumable`: reclaim exactly as before (no real context to
  lose).
- `turnSeq > 0` AND `isDurablyResumable` AND `willRecoverAutomatically(db, control, successor)` is true: a
  genuine resume is (or will be) attempted by the real `CrashRecoveryWatcher` — do **not** reclaim this
  tick. Fall through to the loop's existing shared alert/sleep tail and re-evaluate fresh next tick.
- Otherwise (an intended stop, exhausted attempts, abandoned, or a superseded lineage —
  `willRecoverAutomatically(db, control, successor, { ignorePause: true })` false): reclaim, same as always.
  **Never merely "human-paused"** — see "Pause does not end the wait" below.

No separate latch is introduced for the "waiting" state — the same `turnSeq`/`isDurablyResumable`/
`willRecoverAutomatically` check simply re-runs on every subsequent tick where the successor is still not
alive. This closes the exact MAJOR defect 6e5af155's round 2 Code Review found in an earlier, now-retracted
design (a `downResumableNoted` latch that could not re-arm after a later timeout) without reintroducing it:
there is nothing here that fires once and then stops checking.

**Termination of the "waiting" state** (requested explicitly, so it's recorded rather than left implicit):
while `willRecoverAutomatically` keeps returning true, the loop keeps polling at the slow cadence
indefinitely. It ends exactly one of three ways:
1. The successor comes back alive and reaches ready — caught by the existing, unchanged
   `hasReachedReady(freshId)` branch once `isAlive` is observed true again. This stops the **watch loop**
   only (`return`), never the predecessor — `watchHaltedRecycleSuccessor` has no "stop M1" branch on any
   path, by `@decision f1969787`'s own invariant, and this card does not add one despite the original
   kickoff's wording to the contrary (see "Contradiction surfaced and resolved" below).
2. The successor dies again before reaching ready — the not-alive branch re-fires and re-evaluates the
   same gate fresh (no latch to go stale).
3. `willRecoverAutomatically(..., { ignorePause: true })` flips false (the attempt cap is exhausted, the
   episode is abandoned, or a restart's boot reconcile doesn't cover this exact shape) — the next tick
   reclaims. **A human pause alone never flips this** — see "Pause does not end the wait" below.

**Daemon restart mid-"waiting"**: `watchHaltedRecycleSuccessor` is in-process only and does not survive a
restart (same as `settleRecycleHandoff`, `@decision e07b1b1a`'s own doc). On the next boot,
`reconcileHaltedRecycleSuccessorsEarly` (`packages/daemon/src/sessions/halted-recycle-reconcile.ts`) runs
first and explicitly skips a successor that is still `isDurablyResumable` (`if (isDurablyResumable(fresh))
continue;`), deferring to the ordinary `resumeFleetOnBoot`/crash-recovery paths — exactly the successor
this card's "waiting" branch would also have left alone. There is no double-reclaim: nothing in-process
survives the restart to race the boot-time reconcile, and the boot-time reconcile's own `isDurablyResumable`
check is *more* lenient than this card's `turnSeq > 0` gate (it does not check `turnSeq` at all), so it
never reclaims something this card's in-process watch would have kept waiting on. A resume failure after
that boot-time deferral is the SAME accepted, pre-existing residual `reconcileHaltedRecycleSuccessorsEarly`'s
own doc comment already names ("a later resume FAILURE here is a known, narrow residual this early-only
design accepts") — not a new gap this card introduces.

## Race safety (ruling 4)

Two distinct overlap questions, both closed:

**A reclaim racing a resume actually in flight.** `CrashRecoveryWatcher.tick()`'s resume path
(`packages/daemon/src/orchestration/crash-recovery-watcher.ts`) is synchronous end to end: it records the
`session_resume_attempt` event, then calls `resume()`, which synchronously flips `processState` to `"live"`
(`sessions/service.ts`, the "M5: flip to live BEFORE wiring the pty" comment) and calls `pty.spawn()`, which
synchronously does `this.live.set(opts.sessionId, { alive: true, ... })` (`pty/host.ts`) — with no `await`
anywhere in that chain. Node's single-threaded event loop guarantees a `setTimeout`-scheduled callback (this
watch loop's own poll) can only run between macrotasks, never mid-synchronous-execution — so this loop can
only ever observe the state fully before this sequence starts or fully after it completes, never a torn
intermediate where the attempt counter has moved but the pty isn't registered alive yet. There is
therefore no scenario where this loop reclaims a successor a real resume is actively reviving.

**A reclaim racing a concurrent `recycle_reattempt` call reaching the same conclusion.** Both
`watchHaltedRecycleSuccessor` and `reattemptManagerOwnershipTransfer`'s not-alive branch can, in principle,
independently decide to reclaim the same `(oldId, freshId)` pair (e.g. a human calls `recycle_reattempt` at
the moment this loop's own poll also lands on "nothing will revive it"). The guard here is **NOT**
`db.hasSuccessor(oldId)` — a first implementation of this fix used exactly that and immediately regressed
every existing "dies before ever reaching ready" scenario (`recycle-manager-halted-successor-dies.mjs`
scenarios A/A3/B/G/G'/H), caught by running the full file, not just the new scenarios. Root cause: the
pre-existing `reconcileNeverStartedRecycleSuccessor` (`@decision f349f5cb`) already nulls `freshId`'s
`recycled_from` **synchronously, at `pty.onExit`**, for *any* successor that dies before reaching ready —
completely independent of whether a reclaim (the worker/wakes reparent this method actually exists to do)
has happened yet. `hasSuccessor(oldId)` was already false by the time this loop's very first post-death
tick ran, for the ordinary no-context case, long before any reclaim occurred — wrongly short-circuiting it
every time. The correct guard checks `db.hasWorkerEventKind(freshId, "recycle_successor_retired")` instead
— that event has exactly one write site (`unlinkAndArchiveDeadRecycleSuccessor`, reached only via a
completed `recoverFleetAfterFailedRecycleSuccessor` call), so it is immune to the unrelated f349f5cb unlink
and precisely answers "has a full reclaim already happened for this successor" — the SAME marker `resume()`
itself already treats as a permanent "administratively retired" signal. If true, the lineage was already
resolved by the other path and this loop simply returns rather than double-reclaiming (a second
`unlinkAndArchiveDeadRecycleSuccessor`/reparent pass would otherwise be a harmless but noisy no-op — a
duplicate `recycle_fleet_recovered` event and a duplicate, confusing nudge to M1 — this guard avoids even
that).

## Pause does not end the wait (ruling 4)

A human pause (`OrchestrationControl.pause`) is **reversible** — it gates new work only and can simply be
undone. Reclaiming a successor that completed a turn is **not** reversible — it permanently discards that
context. So a pause must never, by itself, end the "waiting" state: the keep-waiting decision is gated on
the attempt cap, the trigger, `crashRecoveryMaxAttempts`, and a superseded lineage — the same inputs
`isCrashRecoveryEligible`/`willRecoverAutomatically` already check for every other caller — but **not** on
pause.

Implemented as a toggle on the SAME shared check, not a forked copy of its logic: `isCrashRecoveryEligible`
takes an optional `opts.ignorePause` (default `false`, so every pre-existing caller — the tick loop itself,
`notifyManagerOfExitedWorker`, `reattemptManagerOwnershipTransfer`'s own wait-vs-escalate call — is
byte-identical) that skips only the pause check; every other gate still applies unchanged.
`willRecoverAutomatically` takes the same `opts` and passes it straight through.
`watchHaltedRecycleSuccessor`'s keep-waiting call is the one call site that passes
`{ ignorePause: true }`. This is deliberately *not* a change to `willRecoverAutomatically`'s default
behavior — `reattemptManagerOwnershipTransfer`'s own "wait for automatic recovery" vs. "escalate: a human
must resume" refusal still treats a paused successor as "escalate", unchanged; that call site was not
named in this ruling and widening it was out of scope.

Proven by a new scenario, `(A6)`: a successor dies after reaching ready (turnSeq>0, durably resumable, a
real trigger on record) while the **global** scope is paused — the watch loop keeps waiting (no
`recycle_fleet_recovered` event, M1 never stopped), exactly like (A4). Unpausing and driving a real
`CrashRecoveryWatcher.tick()` then genuinely attempts (and, in the test, revives) the successor — the SAME
honest-wait proof (A4) uses. A behavioural negative control (`ignorePause: true` reverted to the bare
`willRecoverAutomatically(db, control, successor)` call) reclaims the paused successor instead of waiting,
confirming the scenario actually exercises the toggle rather than passing vacuously.

## Alert/nudge text (ruling 2)

The existing unresolved-alert tail (fires once, past `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS`, then switches to
the slow poll cadence) now distinguishes two states it can be reached from, since the not-alive branch no
longer always reclaims-and-returns before reaching it:
- Still alive, not yet ready (the pre-existing case; `detail.reason: "timeout"`): unchanged text — "never
  confirmed reaching SessionStart or dying... its fate is unknown".
- Down but durably resumable with a completed turn and genuinely awaiting automatic recovery (new;
  `detail.reason: "halted-waiting-crash-recovery"`): a new, honest text naming what will actually happen —
  Loom's crash-recovery watchdog is expected to resume it, and `recycle_reattempt` remains available to M1
  either once it's back or if nothing resumes it. Mirrors `docs/decisions/6e5af155-…`'s round 2 Minor 3
  lesson: claim only what will actually happen, never a generic "fate unknown" for a state we can actually
  characterize.

Both reasons keep `halted: true`, so `latestMatchingUnresolvedSettleEvent`
(`packages/daemon/src/orchestration/crash-orphaned-workers.ts`) — which filters out every `halted: true`
event unconditionally — continues to exclude both from its match, exactly as before. 6e5af155 round 2's
Minor 3 ("an already-alerted settle must not leave `latestMatchingUnresolvedSettleEvent`/the `question_ask`
carve-out pointing at a hard-stop that no longer reclaims") does not recur here: that whole mechanism
(`currentUnresolvedSettleSuccessor`/`unresolvedSettleEscalationHint`) is scoped to `settleRecycleHandoff`'s
own non-halted unresolved case by construction, never to a halted one.

`companion/attention-push.ts`'s `classify()` maps `recycle_fleet_unresolved` → `"worker-crashed"`
regardless of `detail.reason`, so the new reason value needs no change there. Its `alertLine()` DOES key on
`detail.reason === "timeout"` vs. an else branch that reads "successor died before SessionStart... fleet
may be stranded, unowned" — accurate for the pre-existing case, actively wrong for the new one (the
successor did reach SessionStart, and the predecessor is always still live in the halted branch). The new
reason value needs its own case there with its own, accurate text.

## Contradiction surfaced and resolved

The original kickoff asked for a plan that "stops the predecessor when the successor recovers to ready" —
carried over by analogy from `docs/decisions/6e5af155-…` round 2's design for `settleRecycleHandoff` (where
"stop M1" is the literal, correct action). `watchHaltedRecycleSuccessor`'s own doc comment and
`@decision f1969787`'s own "Do not" list state the opposite for this function: "a halted predecessor is
never stopped, period" — the halt is resolved only by an explicit `recycle_reattempt`, never by this
background watch. Verified `recoverFleetAfterFailedRecycleSuccessor` never calls `pty.stop(oldId, ...)`
either. The lead confirmed this was the kickoff's error (f1969787 governs) before any code was written —
"recovers to ready" in this fix means only that the watch loop returns (stops watching), exactly as it
already did before this card.

## Do not

- Do not reclaim on bare `!pty.isAlive(freshId)` without first checking `turnSeq`/`isDurablyResumable`/
  `willRecoverAutomatically` — see "The bug" above for the exact window this reopens.
- Do not re-derive `willRecoverAutomatically`'s trigger/position logic independently — import and reuse the
  one in `crash-recovery-watcher.ts` (same rule `09b14f15` already states; a second copy can only drift
  from the real watchdog's own gating).
- Do not add a second, separate latch for the "waiting for automatic recovery" state — re-evaluate the gate
  fresh every tick instead (the exact MAJOR defect 6e5af155 round 2 found and this fix avoids).
- Do not add a "reached ready → stop the predecessor" branch to `watchHaltedRecycleSuccessor` — `@decision
  f1969787` forbids it unconditionally; "recovers to ready" here means the watch loop stops watching, never
  that M1 is touched.
- Do not re-check `db.hasSuccessor(oldId)` as the "already reclaimed" guard before committing to reclaim —
  the pre-existing f349f5cb `reconcileNeverStartedRecycleSuccessor` onExit unlink already nulls `freshId`'s
  `recycled_from` for *any* never-reached-ready death, independent of a reclaim, so that check is already
  false long before a reclaim has actually happened and wrongly short-circuits the ordinary no-context case
  (measured regression: scenarios A/A3/B/G/G'/H all broke). Check
  `db.hasWorkerEventKind(freshId, "recycle_successor_retired")` instead — see "Race safety" above.
- Do not read `turnSeq` off in-memory `pty`/`live` state — read the DB row's `turnSeq` field, which survives
  a daemon restart (mirrors `09b14f15`'s own rule).
- Do not let a human pause end this wait — reclaiming is irreversible, a pause is not; see "Pause does not
  end the wait" above.
- Do not fork `isCrashRecoveryEligible`'s pause check into a separate copy to get this — add the
  `opts.ignorePause` toggle to the one shared function instead, defaulting to `false` so every pre-existing
  caller stays byte-identical.
- Do not widen `ignorePause` to `reattemptManagerOwnershipTransfer`'s own wait-vs-escalate call — that call
  site was not named in this ruling; it still treats a paused successor as "escalate", unchanged.

## Verification (`test/recycle-manager-halted-successor-dies.mjs`, scenarios (A4)/(A5)/(A6))

- (A4) WAITING then RESUME → READY: `turnSeq > 0`, durably resumable, `!isAlive`, a real trigger on record
  and eligible (`recordUnexpectedExit`) ⇒ does NOT reclaim — the PROOF is anchored to the watch loop's own
  `watchPromise` resolving naturally (after reviving the successor to alive+ready), then asserting no
  `recycle_fleet_recovered` event exists for the loop's whole lifetime; M1's pty is never touched/stopped
  either. Also asserts the real `CrashRecoveryWatcher.tick()` (mirroring `recycle-reattempt.mjs`'s own
  `tickAttempts` helper) genuinely attempts M2 while down — "wait" is an honest claim, not just the right
  word in a log line. A SHORT, bounded sleep (4x the test's own shortened poll interval) sits between the
  kill and the manual revival, but it backs nothing directly — the one check immediately after it is
  POSITIVE-polarity ("M2 is genuinely alive again"), and `fixed-wait-negative-guard.mjs` passed clean on it.
  It exists only to let the REAL watch loop's own poll genuinely run and react BEFORE the scenario
  continues — first measured necessary the hard way: an earlier draft called `sessions.resume(m2.id)`
  synchronously, with NO yield between killing M2 and reviving it, so the watch loop's own first post-death
  poll (scheduled on its own `setTimeout`, and therefore gated behind this synchronous block regardless of
  which code was running) never got a chance to observe the dead state before the scenario had already
  un-done it — this passed identically with the OLD, unconditional-reclaim code reverted in, making (A4)
  vacuous in BOTH directions until this sleep was added. Caught only by actually running the negative
  control (reverting to the pre-fix commit) and seeing it pass when it should have failed — a race that
  lets a test's own setup code run ahead of the mechanism under test can make a new scenario pass for the
  wrong reason even with the bug still present; proving the gate matters requires giving the production
  code a genuine turn first, which here means a real yield, not just correct-looking assertions.
  **ROUND 2 ADDITION:** before the simulated `resume()` call, a REGRESSION GUARD checks whether M2 was
  already reclaimed (`recycle_fleet_recovered` fired, or M2 already archived) — a regression here would
  otherwise make `sessions.resume(m2.id)` throw "session was administratively retired", UNCAUGHT at this
  file's module top level, silently skipping (A5) and every scenario after it (see "Negative controls"
  below for what that actually looks like). The guard turns that crash into a single named FAIL and lets
  the rest of the file keep running.
- (A5) INTENDED STOP: same post-ready-crash shape as (A4), but no trigger is ever filed (an intended stop)
  ⇒ `willRecoverAutomatically` is false and the fix RECLAIMS, exactly as the no-context case always did.
  Also asserts the real tick does NOT attempt M2 — "escalate" (here, reclaim) is equally honest.
- (A6) LEAD RULING (ruling 4): same post-ready-crash shape as (A4), but the **global** scope is paused
  before M2 ever dies. The real `CrashRecoveryWatcher.tick()` (driven against the SAME `sessions.control`
  instance the watch loop itself holds, via a new `tickAttemptsWithControl` helper — `tickAttempts`'
  own always-fresh, never-paused `OrchestrationControl` can't see a pause set elsewhere) genuinely does
  NOT attempt M2 while paused — a pause blocks new work fleet-wide, and that is correct, not a bug. The
  fix's own keep-waiting gate must still treat this as "wait", never "nothing will ever revive it": proven
  both by the same `watchPromise`-anchored end-state as (A4) (no reclaim, M1 never stopped, across the
  WHOLE paused interval) and by a BEHAVIOURAL NEGATIVE CONTROL that calls the real, exported
  `willRecoverAutomatically` directly, against the exact same `db`/`control`/successor row the watch loop
  is using at that moment: `{ ignorePause: true }` returns `true` while paused; the identical call WITHOUT
  it returns `false` — proving the toggle itself, not some other gate, is what keeps this scenario waiting.
  After unpausing, a real tick genuinely attempts M2, and the scenario resolves exactly like (A4). Carries
  the SAME regression guard as (A4), for the same reason.

## Negative controls (actually run, not just described)

- **Reverted to the pre-fix merge-base** (`node packages/daemon/scripts/negative-control.mjs --file
  packages/daemon/src/sessions/service.ts --file packages/daemon/src/orchestration/crash-recovery-watcher.ts
  --test packages/daemon/test/recycle-manager-halted-successor-dies.mjs --ref 3d2c945b`). **`--ref
  3d2c945b` is the merge-base with `main` (`git merge-base main HEAD`), not `HEAD~2`** — at this branch's
  tip, `HEAD~2` names the FIX commit itself (this branch has exactly 3 commits over that merge-base), so a
  recipe written against `HEAD~2` can never go RED; always compute the merge-base fresh rather than count
  commits back from HEAD, since every later commit on this branch shifts what `HEAD~N` means while the
  merge-base does not. Observed RED is exactly 4 named failures, every later scenario still running to
  completion (B through H all still PASS) — never an uncaught crash:
  - `(A4) REGRESSION GUARD: M2 was NOT already reclaimed before the simulated resume` — the old
    unconditional `!isAlive` reclaim archives M2 on the watch loop's own first post-death poll, before the
    scenario ever reaches the simulated `resume()` call. (Without the round-2 guard, that same state is
    exactly what makes `sessions.resume(m2.id)` throw "session was administratively retired" — an uncaught
    throw that silently skips (A5)/(A6)/every later scenario. Verified directly: the SAME revert run with
    the guard's `if (!alreadyReclaimed)` temporarily removed — real `resume()` call restored unconditionally
    — throws exactly that error and the file exits on an uncaught rejection with nothing after (A4) ever
    printed; restored immediately after confirming it.)
  - `(A6) NEGATIVE CONTROL: willRecoverAutomatically(..., {ignorePause:true}) is true while paused` — at
    the merge-base, `willRecoverAutomatically`/`isCrashRecoveryEligible` have no `opts` param at all, so
    the pause check always applies; while paused this returns `false`, not `true`.
  - `(A6) UNPAUSED: the real tick NOW attempts M2` — by the time this check runs, the old code's watch
    loop has ALREADY reclaimed + archived M2 (same mechanism as the (A4) finding above, on the SAME
    unconditional `!isAlive` branch) and marked it `resumability:"dead"`, so `isCrashRecoveryEligible`
    correctly refuses it — there's no longer a live candidate for the tick to attempt.
  - `(A6) REGRESSION GUARD: M2 was NOT already reclaimed before the simulated resume` — same mechanism as
    the (A4) finding, for the same reason.

  GREEN after restore (all scenarios pass); tree confirmed byte-identical for both files.
- **`willRecoverAutomatically` replaced with an unconditional `true`** (manual mutation, rebuilt, re-run,
  then `git checkout --` to restore): RED on exactly (A5)'s four checks (the intended-stop death now
  wrongly "waits" instead of reclaiming) and nothing else — confirming the mutation's effect is precisely
  scoped to the trigger-check, not a broader break.
- **`{ ignorePause: true }` removed from `watchHaltedRecycleSuccessor`'s own call** (manual mutation —
  `willRecoverAutomatically(this.db, this.control, successor)` with no third argument — rebuilt, re-run,
  then restored): RED on exactly 2 named checks, both (A6)'s, and nothing else — `(A6) UNPAUSED: the real
  tick NOW attempts M2` and `(A6) REGRESSION GUARD: M2 was NOT already reclaimed before the simulated
  resume`. Mechanism: with the toggle gone, the pause makes the gate read "nothing will ever revive it"
  while STILL paused, so the watch loop reclaims + archives M2 immediately — before the scenario ever gets
  to unpause — leaving nothing left for the tick to attempt and nothing left for the simulated `resume()`
  to safely act on. (A6's two direct `willRecoverAutomatically(...)` negative-control calls, and the
  earlier "does NOT attempt M2 while paused" check, are unaffected by this mutation and still pass — they
  exercise the function directly, independent of this one call site.) Confirms the mutation's effect is
  precisely scoped to the pause toggle, not a broader break.
