# 6e5af155 — REJECTED: leaving a dead-but-resumable recycle successor alone instead of reclaiming it

**Status: retracted, round 3. No code anchors this record any more** — `settleRecycleHandoff` and
`watchHaltedRecycleSuccessor` (`packages/daemon/src/sessions/service.ts`) are back to main's original,
unconditional reclaim. This record stands alone, linked from the two tests that exist specifically to
keep the rejected design from quietly coming back:
`packages/daemon/test/recycle-manager-fleet-recovery.mjs` (scenario F) and
`packages/daemon/test/recycle-manager-halted-successor-dies.mjs` (scenario A3).

## The shape that was explored

A recycle successor (M2) can die before ever reaching ready while still carrying a real engine id +
empty transcript (`isDurablyResumable`, `recycle-settle-reconcile.ts`) — e.g. it reached SessionStart,
then crashed during its mode-cycle climb, before `settleRecycleHandoff`'s poll ever confirmed it dead.
Rounds 1 and 2 of this card explored leaving such a successor's row untouched instead of reclaiming the
predecessor's (M1's) fleet back — reasoning, by analogy with `dfc3b014`'s `recycle_reattempt` refusal,
that a captured engine id meant real context worth preserving, and (round 2) gating that leave-alone on
`isLiveCrashRecoveryCandidate` (resumable AND a live, trigger-backed crash-recovery candidate) so it
wouldn't fire for an intended stop or an exhausted/disabled recovery cap.

## Why it's wrong: there is no context to preserve

The kickoff/handoff text is delivered **only post-ready** —
`scheduleKickoffGuarantee` (`packages/daemon/src/pty/host.ts`) is invoked from inside `markReady`,
strictly *after* `live.ready = true` is already set, never before. And once `live.ready` is set, it
**never un-sets** — the comment at `pty/host.ts` (`pty.onExit`'s own handler) states plainly that "a
claude session's own live entry is NEVER removed from `this.live` on exit... it survives in the map with
`alive:false` instead," so `hasReachedReady()` keeps reading `true` forever once it was ever `true`,
regardless of a later crash.

`settleRecycleHandoff`'s loop checks `hasReachedReady(freshId)` **before** `!isAlive(freshId)`, every
iteration (this ordering is pre-existing, from card `e07b1b1a`, unrelated to this card). Combine the two
facts: for ANY M2 whose ready flag was ever `true` — a strict prerequisite for the kickoff ever being
scheduled, let alone delivered — the settle loop's very next poll (or the same poll) takes the ready
branch and stops M1, **before the not-alive branch could ever run**. The not-alive branch is reachable
only when ready was **never** true. So every leave-alone decision this design could ever make, for the
settle branch, is for a successor that structurally never received any instruction at all — there is
nothing to lose by reclaiming it, and reclaiming is strictly better: it keeps the fleet with M1, which
(being the session actually recycled *because* it was context-heavy, not context-empty) still knows what
it's doing, instead of waiting on crash-recovery to resurrect a blank M2 (its own `resume()` call,
`sessions/service.ts`, passes no `startupPrompt` at all) that then reaches "ready" via nothing more than
the mode-cycle fallback timer, with nothing to do — and the settle loop then hard-stops M1 anyway, having
gained nothing.

## The halted-branch wrinkle (out of scope, not fixed by this revert)

`watchHaltedRecycleSuccessor` has the **opposite**, pre-existing check order (card `f1969787`, unrelated
to this card): it checks `!isAlive` **before** `hasReachedReady`. That means, in principle, a halted
successor that genuinely reached ready (kickoff delivered, maybe even a completed turn) and then crashed
moments later *could* still land in the not-alive branch — unlike the settle branch, where this is
structurally impossible. In that narrow sub-case, "leave it alone" would actually be the *correct* call
(real context would exist to preserve) — but neither round of this card's gate ever checked for that
distinction (it only ever checked `isDurablyResumable`, which can't tell "bare SessionStart" apart from
"a completed turn"), and the card's own originally-reported bug, plus every test either round wrote
(including this round's own scenario A3), only ever exercises the *other* sub-case: a halted successor
that dies before ever reaching ready at all. Building a correct, narrower gate for that genuine sub-case
— keyed on a durable "a turn actually completed" signal (`session.turnSeq`, incremented via
`onTurnCompleted` off the real Stop-hook turn-completion chokepoint — see `db.ts`'s `incrementTurnSeq`
and `index.ts`'s wiring of it — never `hasReachedReady` alone) — is a separate, narrower, not-yet-filed
follow-up, not part of this revert.

## What this revert removed

- `SessionService.isLiveCrashRecoveryCandidate` and `recordDownResumableSuccessor`, and the gate check at
  both call sites (`settleRecycleHandoff`'s and `watchHaltedRecycleSuccessor`'s not-alive branches) —
  both branches are back to main's unconditional `recoverFleetAfterFailedRecycleSuccessor` call.
- The `recycle_successor_down_resumable` `OrchestrationEventKind` (and its membership-record entry).
- Its two `companion/attention-push.ts` cases (`classify()`/`alertLine()`).
- `latestMatchingUnresolvedSettleEvent`'s filter widening (`orchestration/crash-orphaned-workers.ts`) —
  back to its original 4-kind set.
- `cancelStaleEscalationQuestions`'s `reason` parameter — back to its original hardcoded,
  ready-branch-only text (there is no second caller any more).

## Do not

- Do not re-add a bare `isDurablyResumable` (or any resumability-only) leave-alone gate to either
  `settleRecycleHandoff`'s or `watchHaltedRecycleSuccessor`'s not-alive branch without first threading in
  a durable "a turn actually completed" signal — see the halted-branch wrinkle above for why resumability
  alone is not that signal, and for the settle branch specifically, see why no such gate can ever matter
  there in the first place (the ready-first check order makes the not-alive branch unreachable for a
  kickoff-delivered successor, period).
- Do not treat `isDurablyResumable(successor)` as evidence of "real context" on its own — it only proves
  a `SessionStart` hook landed (an engine id + possibly-empty transcript), never that any instruction was
  ever delivered or acted on.
