# c684d00d — createWorktree's onPhase diagnostic seam must mark EVERY exit, not just step starts

## Narrative

Card c684d00d investigated dist-importer-check-glue.mjs scenarios (14)/(20) genuinely exceeding their
own 240s (2x budget) wait ceiling on `createWorktree`'s real git chain, under real host contention — a
recurrence of a stall first seen on card 69dc8fcd.

### Bound audit

No single sub-step in the admission→createWorktree→stubbed-gate-call chain is unbounded, but
`killableCanonicalRaw`'s kill-grace doubling (`withTimeoutKillingChild`'s `killGraceMs` defaults to the
SAME `ms` passed in, `git/bounded.ts`) means each lock-serialized call's REAL ceiling is 2x its nominal
one:

- `git rev-parse --show-toplevel` / `git rev-parse HEAD` — flat `withTimeout`, 15,000ms each (no doubling;
  these two sit outside `withCanonicalIndexLock`).
- `git worktree prune` / `git branch --list` — `killableCanonicalRaw`, nominal 15,000ms (`GIT_OP_TIMEOUT_MS`)
  → real ceiling 30,000ms each.
- `git worktree add` — nominal 60,000ms (`WORKTREE_ADD_TIMEOUT_MS`) → real ceiling 120,000ms.
- (on an add failure only) `git worktree remove -f -f` cleanup — nominal 15,000ms → real ceiling 30,000ms.

Sequential sum through a clean add: 15,000 + 15,000 + 30,000 + 30,000 + 120,000 = 210,000ms. Adding the
add-failure cleanup's own ceiling reaches 240,000ms — matching the wait's own 240,000ms (2x budget) grace
ceiling almost exactly. No step is individually wrong; the SUM of several "individually safe" sub-ceilings
is what lands at the observed limit.

### Round-1 misreading, and why it was wrong

Round 1 shipped `createWorktree`'s `gitDeps.onPhase(phase, atMs)` seam, firing at the START of each named
sub-step. Verification runs then genuinely reproduced the real stall twice, and BOTH times the diagnostic
named the same last-observed phase: `"add-failure-cleanup"`. That reading — "the cleanup itself doesn't
settle within its own ~30s ceiling" — was WRONG, caught by Code Review (CR f2998211) on the round-1
commit: `onPhase` only fired at step STARTS, never on exit, so a step that had already finished and was
followed by an un-marked `throw addErr` (the add-failure-cleanup catch block's own rethrow) looked
IDENTICAL to that step still being hung. There was no way to tell "cleanup is stuck" apart from "cleanup
finished fine, then something later threw."

### Corrected mechanism

`git worktree add` fails almost instantly (~200ms in) under this host's contention; the add-failure
cleanup settles fine within its own bound; `runOneDistImporterCheck` (sessions/service.ts) converts that
cut failure into a `{kind:"mechanism-failure", reason:"could not cut the isolated check worktree
(<addErr>)"}` outcome that NEVER sets `ctx.gate.lastDistCall`/`buildState.entered` — the two conditions
(14)/(20) were polling for. So the test was burning its WHOLE ~240s budget waiting for an event that
could never arrive, while the real outcome had already been decided in under a second.

## Fix

`createWorktree`'s entire cut body now runs inside one outer try/catch (not a per-throw-site hand-added
call): on success it still ends with a `"done"` phase; on ANY throw it fires
`firePhase(`threw:${ErrorClass}:${message.slice(0,160)}`)` before rethrowing — a throw can never again be
misread as a hang in whatever step happened to run last, and a future throw site added to the body can't
silently skip this (nothing to remember to call). `(14)`/`(20)` (test/dist-importer-check-glue.mjs) were
also switched from a bare `waitUntil` to a new `waitForRealConditionOrMechanismFailure` helper that races
the real condition against this check's own `worker_gate`/`distImporterCheckOnly` mechanism-failure event
— the moment one appears, the wait fails IMMEDIATELY naming the real `reason` text, instead of waiting
out the full budget to report a bare "didn't resolve." `withPhaseDiagnosticsOnFailure`'s own give-up dump
also now prints those events.

`(25)` deliberately does NOT get the same fail-fast racing — see its own "Do not" below.

## Verification — the surgical control's sample output

A temporary test scenario (reverted byte-identical afterward — confirmed via `git diff` against the prior
commit and a `grep` for leftover control-block text) forced a REAL `git worktree add` failure, through the
real `createWorktree`, via a fake `gitFactory` on the existing `distImporterCheckCreateWorktree` seam.
Captured output:

```
[c684d00d-diagnostic] (CTL) gave up. Phase history (7 entries): toplevel-guard@0ms -> rev-parse-HEAD@1ms ->
  prune@1ms -> branch-list@1ms -> worktree-add@2ms -> add-failure-cleanup@2ms ->
  threw:Error:fatal: '<worktreePath>' already exists @2ms
[c684d00d-diagnostic] (CTL) last phase: "threw:Error:fatal: '<worktreePath>' already exists" (at 2ms into
  createWorktree) — createWorktree had ALREADY SETTLED (threw) by then; this is NOT evidence of a hang in
  an earlier step
[c684d00d-diagnostic] (CTL) this check's own worker_gate/distImporterCheckOnly events (1):
  {"mechanismLike":true,"reason":"could not cut the isolated check worktree (fatal: '<worktreePath>'
  already exis"}
PASS  (CTL) the wait threw (the mechanism-failure fail-fast, never a pass/skip)
PASS  (CTL) it failed FAST, not after the ~240s budget (elapsed 0ms)
PASS  (CTL) the phase history's LAST entry is a terminal threw: mark, not a bare step name
```

Phase history ending in a `threw:` mark, the event dump naming the real reason, and a ~0ms failure
instead of ~240s — all three fixes proven in one control.

## Do not

- Do not read "last observed phase" from a diagnostic that only fires at step STARTS as proof a step is
  hung — it is equally consistent with that step having finished and something LATER throwing with no
  marker of its own. Always pair a start-phase diagnostic with a terminal mark on every exit (success AND
  throw), or treat "last phase" readings from one as unverified.
- Do not add a new throw path inside `createWorktree`'s cut body that bypasses the outer try/catch (e.g. a
  nested `process.exit`, an unhandled rejection escaping via a detached promise, or a callback invoked
  outside the awaited chain) — the terminal-phase guarantee holds only for a throw that actually
  propagates out through the wrapped call.
- Do not raise `DIST_IMPORTER_REAL_GIT_OP_WAIT_MS` (or any sibling wait budget) in response to this
  specific failure shape — the fix here is observing the mechanism-failure event sooner, not giving the
  wait more time to not-observe it.
- Do not apply `waitForRealConditionOrMechanismFailure` to scenario (25)'s own wait — its mechanism-failure
  event (an intentionally engineered timeout, asserted via `op25.verdict==="error"`) already exists in the
  DB BEFORE that later wait even starts, so racing against "a mechanism-failure event exists" would fire
  on the very first poll and fail the scenario immediately, every run. That later wait is deliberately
  observing something else: a backgrounded, deliberately-still-running REAL cut eventually landing on
  disk, which is not "an event that can never arrive," just a slow one.
- Do not consider the underlying `git worktree add` failure itself root-caused by this card — WHY it
  fails under this host's contention is still open, flagged as a sharper lead for a follow-up card.

## Source

`BoundedGitDeps.onPhase`'s own doc comment and `createWorktree`'s try/catch wrap
(`packages/daemon/src/git/worktrees.ts`), and `test/dist-importer-check-glue.mjs`'s own header note +
`withPhaseDiagnosticsOnFailure`/`waitForRealConditionOrMechanismFailure` helpers. Project memory key
`dist-importer-check-glue-240s-stall-unreproduced` carries the same corrected reading for cross-session
recall.
