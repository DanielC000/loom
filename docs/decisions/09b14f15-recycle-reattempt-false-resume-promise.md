# 09b14f15 — `recycle_reattempt` stop promising a resume no trigger will run

## The bug

`reattemptManagerOwnershipTransfer`'s not-alive branch (`sessions/service.ts`) used to gate its choice
between "wait for automatic recovery" and "escalate: a human must resume" on `isDurablyResumable(successor)`
followed by `isCrashRecoveryEligible(db, control, successor)` alone. Both predicates have documented,
narrower contracts than this call site assumed:

- `isDurablyResumable` (`recycle-settle-reconcile.ts`) only proves a `SessionStart` hook landed — a
  captured engine id + a transcript file that may still be completely empty. It never proves any
  instruction was delivered or acted on. `docs/decisions/6e5af155-recycle-successor-down-resumable-event.md`
  explored and rejected exactly this reasoning for `settleRecycleHandoff`/`watchHaltedRecycleSuccessor`,
  for the same reason.
- `isCrashRecoveryEligible` (`orchestration/crash-recovery-watcher.ts`) deliberately never checks whether
  a recovery trigger (`session_died` / `worker_report_undelivered`) was ever filed — its own doc says so,
  "without requiring a trigger to already be filed." That's correct for its two sanctioned uses
  (`notifyManagerOfExitedWorker`'s near-simultaneous race with the trigger write, and
  `listCrashRecoveryEligibleSessionIds`'s boot-time protect-from-GC decision — see
  `docs/decisions/5439b7d2-boot-protects-fleet-wide-crash-recovery-eligible-worktrees.md`, which says
  outright that being lenient on a tie is "the conservative direction for a PROTECTION decision but the
  wrong direction for gating a real resume"). `recycle_reattempt` IS gating a real resume decision — the
  wrong-direction use that record warns against.

Concretely: if the successor died from an INTENDED stop, `recordUnexpectedExit` never files a trigger at
all. `isCrashRecoveryEligible` can still return `true` (role/engine-id/resumability/project/pause/attempt
checks all pass with zero `session_resume_attempt` events on record), so the old code told the predecessor
to "wait for its automatic recovery" — but the watchdog tick's own candidate query
(`db.listWorkerSessionIdsWithEventKind(RECOVERY_TRIGGER_KINDS)`) never even considers a session with no
trigger event. Nothing would ever resume it. A false promise.

## The fix

Two independent, composable changes:

1. **Gate reclaim on a durable "a turn actually completed" signal (`session.turnSeq`, read off the DB
   row), never on `hasReachedReady`/`isDurablyResumable` alone.** `turnSeq === 0` ⇒ reclaim
   unconditionally via the same `recoverFleetAfterFailedRecycleSuccessor` path already used for a
   non-durably-resumable successor — there is no real context to lose, so reclaiming (which fails toward
   the predecessor, still live and still holding the full context) is strictly better than any wait.
   This also reclaims a successor that DID receive its kickoff but crashed mid-first-turn (still
   `turnSeq === 0`) — accepted deliberately: a kickoff landing with no completed turn is not meaningfully
   different from one that never landed at all, for the purpose of "is there context worth preserving."
2. **Added `willRecoverAutomatically` (`orchestration/crash-recovery-watcher.ts`), exported, next to
   `lastTriggerOf`.** It reuses the tick's own `lastTriggerOf`/`lastOfKind`/`isCrashRecoveryEligible`
   rather than re-deriving any of their logic: a real trigger must be on record, not already resolved
   (mirrors the tick's own position-safe `lastRecovered.index >= lastTrigger.index` check, card
   `bcdea586` — never a raw `.ts` comparison), then `isCrashRecoveryEligible`. `recycle_reattempt` now
   calls this instead of `isCrashRecoveryEligible` alone when `turnSeq > 0` (real context exists) to
   choose between "wait" and "escalate." Deliberately does NOT also check `session_recovery_abandoned`
   separately — the tick only ever consults that event INSIDE its own `attempts >= maxAttempts` branch (to
   decide whether to re-file it, never whether to resume: it `continue`s past the cap unconditionally
   either way), so `isCrashRecoveryEligible`'s own `attempts < maxAttempts` already mirrors the tick's real
   gate exactly. A separate abandoned check would DIVERGE from the tick the moment a human raises
   `crashRecoveryMaxAttempts` after an abandonment was recorded: the tick resumes again (attempts now under
   the new cap), while a stale abandoned-check would keep saying no.

Card `91ac2b79` ("keep a halted recycle successor that crashed after ready", backlog) needs the exact same
shape for `watchHaltedRecycleSuccessor`'s own symmetric not-alive branch — it should reuse
`willRecoverAutomatically` and the same `turnSeq` gate, not fork a second copy.

## Verification (`test/recycle-reattempt.mjs`)

`R3a` through `R3a-v` exercise every branch of `willRecoverAutomatically` through the real
`reattemptManagerOwnershipTransfer` call (black-box), plus two things a black-box assertion on the error
text alone can't prove:

- **The position check matters, not just exists.** `R3a-v` records a real trigger, then appends a LATER
  `session_recovered` (closing that episode) with no new trigger after it — `willRecoverAutomatically`
  must say "escalate", never "wait", even though `lastTriggerOf` alone would still find the old trigger.
  Removing the `lastRecovered.index >= lastTrigger.index` check turns this RED (verified: swapping it out
  makes `recycle_reattempt` wrongly say "wait").
- **"Wait" and "escalate" are honest, not just the right words.** `R3a-iii`, `R3a-iv`, and `R3a-v` each
  also build a REAL `CrashRecoveryWatcher` (a stub `resume`, a fresh `OrchestrationControl`) against the
  SAME `db` and call `tick()` directly, asserting whether it actually attempted to resume M2 — not merely
  that the thrown message used the word "wait". `R3a-iii` (genuine trigger, eligible) asserts the tick DID
  attempt it; `R3a-iv` (no trigger) and `R3a-v` (trigger already resolved) assert it did NOT.

## Do not

- Do not treat `isDurablyResumable(successor)` as evidence of real context on its own — it only proves
  `SessionStart` landed. Gate on `turnSeq > 0` as well.
- Do not gate a "wait for automatic recovery" promise on `isCrashRecoveryEligible` alone — it is `true`
  even with no trigger filed at all (an intended stop). Use `willRecoverAutomatically`.
- Do not re-derive `willRecoverAutomatically`'s trigger/position logic independently at a new call site
  (e.g. for card `91ac2b79`) — import and reuse the one in `crash-recovery-watcher.ts`, so it can never
  drift from the tick's own real gating.
- Do not add a separate `session_recovery_abandoned` check to `willRecoverAutomatically` —
  `isCrashRecoveryEligible`'s own `attempts < maxAttempts` already mirrors the tick's real gate; a separate
  check would diverge from the tick the moment a human raises the project's cap after an abandonment.
- Do not read `turnSeq` off in-memory `pty.hasReachedReady`/live state — read the DB row's `turnSeq`
  field (`incrementTurnSeq`, fired from the real Stop-hook turn-completion chokepoint), which survives a
  daemon restart; `hasReachedReady` does not.
