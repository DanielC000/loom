# cee17efe — `scanDirectDistImporters` is a separate function, never a widening of `scanTestImporterClosure`

`orchestration/dist-importer-check.ts` holds every piece of this advisory's logic that can be reasoned
about WITHOUT a real git repo, worktree or child process (src->dist path mapping, the corpus-relative
cap, the coalescing queue, every nudge format) — the daemon-process glue (cutting the isolated worktree,
building it, admitting the gate run, pushing the nudge) lives in `sessions/service.ts` instead, the same
split `merge-gate-interval.ts` already uses. This module never calls `recordMergeGateOutcome`/
`applyGatePass`/`applyGateFail`/`applyGateNext`/`putMergeGateState`, and never will — that absence is
what makes "never counts as a gate pass, the interval counter, or `gateOwed`" true BY CONSTRUCTION, not
by a flag that could be set wrong.

Card cee17efe (design card 71a77fb2, Option B) needed a DIRECT (non-transitive) counterpart to
`scanTestImporterClosure`: for every `packages/daemon/test/**/*.mjs` file, does any of its own import/
dynamic-import specifiers resolve to a touched `dist/**/*.js` module. No BFS, no reverse-edge graph —
Option B is explicitly a direct-importer scan only (71a77fb2 §5: a transitive src-graph walk is deferred
as Option C, and the measured n=4/8-file sample never needed it — §2).

The obvious shortcut would have been to widen `scanTestImporterClosure` itself (it already parses every
test file's specifiers via `extractModuleSpecifiers`) to also capture an edge resolving into `dist/`
instead of discarding it. The LEAD ruled against this on cee17efe: `scanTestImporterClosure` is the
decision-recorded (`@decision 72769424`), test-to-test-only reduced-gate mechanism — touching it to grow
a second, unrelated capability risks the exact classifier/soundness regressions that record's own "Do
not" list exists to prevent, for a feature (an advisory, non-blocking post-landing signal) that has none
of that function's correctness stakes. `scanDirectDistImporters` is therefore a brand-new, standalone
function that duplicates the small AST-walk shape rather than extending the existing one.

It inherits ONE piece of that function's own reasoning by design, not by accident: a test file whose
dynamic `import()` argument is non-literal (`hasUnresolvedDynamicImport`) is reported as a wildcard match
— folded into the run set — rather than silently dropped, mirroring the same fail-closed posture
`@decision 72769424` established for the transitive scan. The reasoning carries over exactly: we cannot
rule out that file importing a touched module either, and a false "safe" (silently excluding it) is worse
than an over-inclusive advisory run. This signal never blocks a merge (see `computeDirectDistImporterRunSet`'s
caller in `sessions/service.ts`), so the cost of over-inclusion here is strictly lower than it is for the
reduced gate — there was no tension to weigh against keeping the same rule.

## Do not

- Do not add a call from `orchestration/dist-importer-check.ts` to `recordMergeGateOutcome`/
  `applyGatePass`/`applyGateFail`/`applyGateNext`/`putMergeGateState` — that absence is what makes "never
  counts as a gate pass, the interval counter, or `gateOwed`" true by construction, not by a flag.
- Do not fold this function's logic into `scanTestImporterClosure`/`foldInTestImporters` "to avoid
  duplication" — the LEAD ruling above is deliberate: those two functions stay untouched by this card, on
  purpose, regardless of how similar their AST-walk shape looks.
- Do not drop a non-literal dynamic import (`hasUnresolvedDynamicImport`) as unmatched — fold it into
  `wildcardImporters` exactly as `@decision 72769424` requires for the transitive scan, for the identical
  reason.
- Do not call `scanDirectDistImporters` from the host's own event loop — it is exported ONLY so
  `scanDirectDistImportersInChildProcess` can `import()` and call it from a killable child process, the
  same corpus-wide-AST-walk hazard `@decision 72769424`'s own record covers for the transitive scan.

## `--only-file=` — the cmd.exe command-line-length fix (LEAD round-2 ruling, item 1, CRITICAL)

`runOneDistImporterCheck` builds its own `test:daemon --only=<names>` gate command from the ranked/capped
run set. For the two historical incident commits (`service.ts`/`host.ts`), that names list alone measured
~13-16K chars — `gate-runner.ts` spawns every gate command with `shell:true`, which on win32 means cmd.exe,
whose command-line length ceiling is ~8191 chars. The spawn fails before `test-daemon.mjs` even starts,
with a "command line too long"-shaped OS error — no FAILURES: block, no recognizable test name — and a
caller that doesn't special-case this reports a false RED for what is actually a harness/OS mechanism
failure. `--only-file=<path>` (`test-daemon.mjs`) is the fix: the SAME `--only=` selection, delivered via a
newline-separated file instead of an argv value, so the generated command line stays short (just the file
path) regardless of how many names are selected. The check writes that file INSIDE its own isolated
worktree (so it is cleaned up with everything else when the worktree is removed, and never touches a
shared/host-wide temp dir — see this project's own CLAUDE.md on shared-temp-dir hazards).

## Do not (2)

- Do not go back to an inline `--only=<names.join(",")>` for the dist-importer check's own gate command —
  that is the exact regression this fix exists to close; use `--only-file=` with the names written to a
  file inside the check's own isolated worktree.
- Do not combine `--only=` and `--only-file=` in `test-daemon.mjs`'s `classifyCliArgs` — ambiguous which
  source wins; refuse loudly (`unrecognized`), same posture as the existing `--codex-real-spawn`/
  `--only=` mutual-exclusion refusal.
- Do not classify every non-zero gate exit from this check as a real test red. A harness/usage-level
  failure (`gateResult.harnessNotExecutedDetected`, or `!gateResult.passed && !gateResult.failingTest` —
  i.e. nothing recognizable was found) must route to `formatDistImporterMechanismFailureNudge`, never
  `formatDistImporterResultNudge`'s failed branch with an "(unnamed)" placeholder.

## LEAD round-2 rulings 2, 3, 5, 8 — `runOneDistImporterCheck`'s own structure

**Ruling 2 (queue stuck on throw):** `runDistImporterCheckLoop`'s own `drainFollowUp(q)` call must run even
when `runOneDistImporterCheck` throws — wrap that call in its own try/catch inside the loop. Before this
fix, an unexpected throw propagated straight out of the loop, so `drainFollowUp` never ran and
`state.running` stayed `true` forever: every later landing on that (project,repo) silently folded into a
batch nobody would ever run again, with no error and no nudge.

**Ruling 3 (unbounded build + admission):** the worktree cut (`createWorktree`) and build
(`defaultDistImporterCheckBuild`) now run INSIDE the `GateSemaphore.runExclusive` callback, not before
it — so the heavy work is admitted through, and counts against, the SAME concurrency cap the test run
itself uses. Both are bounded by `DIST_IMPORTER_CHECK_PROVISION_TIMEOUT_MS` (300s, picked from a measured
~6.5s forced `turbo build` on this host — see that constant's own doc).

**Ruling 5 (gate-env contract):** the real test run uses `gateOpIdEnvOverride(opId, 0, gateCap,
WORKER_GATE_ENV_OVERRIDE)` (pins `LOOM_GATE_TEST_CONCURRENCY`, matching `runWorkerGate`'s own pin) and
`gateSpillPath(opId)` (durable output spill), and forwards the semaphore's own `hooks` into `runGateSeq`
so `gate_queue`/`gate_status` see this run's real liveness — the SAME shape `runWorkerGate` already uses
for a real worker self-check, never a second, weaker convention invented for this advisory.

**Ruling 8 (no silent cancel):** a `GateCancelledError` from `runExclusive` — a manager (or this session)
deciding the advisory run is no longer worth running — pushes a short, explicit `[loom:dist-importer-check]`
nudge naming the landing and that nothing further is needed, rather than returning silently. The pending
gate op is always minted BEFORE admission (not after the run set is computed) so a crash during cut/build
still leaves a durable breadcrumb `sweepOrphanedDistImporterCheckWorktrees` (boot) can re-derive the
worktree path from.

## Do not (3)

- Do not move the worktree cut/build back to BEFORE `gateSemaphore.runExclusive` — ruling 3 requires them
  inside the admitted callback, or the heavy work never counts against the shared cap.
- Do not let `runDistImporterCheckLoop` call `runOneDistImporterCheck` without its own try/catch — a
  throw must never skip `drainFollowUp`.
- Do not return silently from the `GateCancelledError` branch — push the short cancelled-nudge (ruling 8).
- Do not mint the pending gate op AFTER computing the run set — mint it before `runExclusive`, so a crash
  during cut/build still leaves a row `sweepOrphanedDistImporterCheckWorktrees` can act on.

## LEAD round-3 ruling 1 — a cancel or a timeout is a different outcome than a mechanism failure

Round-2's `mechanismLike` classification (`!gateResult.passed && (harnessNotExecutedDetected ||
!failingTest)`) never accounted for two outcomes the harness's own `GateSequentialResult` can carry:
`cancelled` (the harness resolved normally rather than rejecting, per `@decision 8d585277`) and
`failedTimedOut` (a real test run that genuinely spawned and genuinely exceeded its budget). Both satisfy
"no identifiable failing test" just as often as a genuine harness/usage error, so without an explicit
check first, a RUNNING cancel was misreported as a harness/usage-error mechanism failure instead of a
clean cancel, and a timeout was misreported the identical way instead of being named as a timeout.

`runOneDistImporterCheck` now checks `gateResult.cancelled` BEFORE computing `mechanismLike` at all (same
priority order `gateOutcomeFromDetail`, db.ts, already uses for every OTHER gate kind — `@decision
3a6f04cc`) and settles a distinct `"cancelled"` outcome via `formatDistImporterCancelledNudge`, shared
with the QUEUED-cancel (`GateCancelledError`) and mid-phase-cancel (`cancelSignal.aborted`, checked after
cut, after build, and after the scan — so a cancel frees this check's slot promptly instead of running
the remaining phases to completion) cases. `gateResult.failedTimedOut` is excluded from `mechanismLike`
next, so a timeout falls through to the ordinary fail branch and gets its own `formatDistImporterResultNudge`
wording (`timedOut`) instead of either an "(unnamed)" failing-file placeholder or a harness/usage-error
mechanism-failure nudge. Both `cancelled`/`timedOut` are stamped onto the `worker_gate` event detail
unconditionally (ruling 1's own "stamp cancelled/timedOut" requirement) so `gateOutcomeFromDetail` can
project them correctly — see ruling 2 below.

## Do not (4)

- Do not compute `mechanismLike` before checking `gateResult.cancelled`/`gateResult.failedTimedOut` — both
  satisfy "no identifiable failing test" exactly like a genuine harness/usage error, so checking order
  matters here the same way it does in `gateOutcomeFromDetail` (`@decision 3a6f04cc`).
- Do not invent a second, differently-worded cancel nudge for the mid-phase or running-cancel case — reuse
  `formatDistImporterCancelledNudge`, the same text the QUEUED `GateCancelledError` case already used.
- Do not skip the `cancelSignal.aborted` check after any of cut/build/scan on the theory that the harness's
  own per-step check (inside `runGateSequential`) already covers it — that only fires once the gate command
  itself is about to spawn; a cancel arriving during the cut or the build must be observed at that phase's
  own boundary or it runs to completion anyway.

## LEAD round-3 ruling 2 — `gate_history`/`countGateEvents` must agree with `gate_status` on a mechanism-like run

`gateOutcomeFromDetail` (db.ts) used to fall through to `"reject"` for a `worker_gate` row whose detail
carried `mechanismLike: true` — the SAME row `settlePendingGateOp` had already settled with verdict kind
`"error"`. A reader comparing the two (gate_status for one op vs. gate_history's aggregate) saw them
disagree with no indication either was wrong. `gateOutcomeFromDetail` now checks `detail.mechanismLike ===
true` (new outcome `"error"`, added to the shared `GateOutcome` union) immediately after the existing
`cancelled`/`skipped` checks and before the `passed`/`timedOut`/`kill` checks — mechanism-like failures
never reach "reject" again. Every settle path in `runOneDistImporterCheck` (the two cut/build/scan
mechanism-failure branches, the generic catch, and the cancelled branches) now also appends its own
`worker_gate` event — before this round, only a real gate pass/fail ever reached `gate_history` at all, so
a cut/build/scan mechanism failure or a cancel was invisible to `gate_history`/`countGateEvents`/the Gates
UI even though `gate_status`/`pending_gate_ops` had a full settled row for it.

## Do not (5)

- Do not let `gateOutcomeFromDetail` fall through to `"reject"` for `detail.mechanismLike === true` — check
  it explicitly, mapped to the dedicated `"error"` `GateOutcome`, before the ordinary pass/timeout/kill
  checks.
- Do not leave a cut/build/scan mechanism failure, or any cancel branch, without its own `worker_gate`
  event — `gate_history`/`countGateEvents`/the Gates UI must see every outcome this check can settle
  EXCEPT `"nothing-to-run"` (nothing directly imports the touched module(s) — recorded as a bare
  `pass`-kind `pending_gate_ops` tombstone with no event and no nudge; there is genuinely nothing to
  report), not only a real pass/fail.

## LEAD round-3 ruling 4 — boot sweep: wedged removal, count only real removal, a branch survives its dir

`sweepOrphanedDistImporterCheckWorktrees` used to (a) never inspect `removeWorktree`'s own
`{removed,wedged}` result at all — it just awaited the call and always incremented `swept`, whether or
not anything was actually removed, and never routed a genuinely wedged handle into the SAME
`recordWorktreeWedgeAttempt`/`armWedgeSweep` retry machinery `runOneDistImporterCheck`'s own cleanup
already uses; and (b) skipped the branch delete ENTIRELY whenever the worktree DIR was already gone
(`if (!fs.existsSync(worktreePath)) continue;`), so a leftover branch with no worktree dir — a partial
prior cleanup, or an operator clearing the dir by hand — was silently stranded forever. The sweep now
checks the dir and the branch (via `branchExistsInRepo`) independently, routes a wedged dir removal into
the wedge-retry machinery, and only counts a row as swept when something was actually removed.

## LEAD round-3 ruling 5 — a timed-out cut can still land a worktree in the background; clean it up anyway

`withTimeout(createWorktree(...))` RACES the underlying call, it never cancels it (see
`DIST_IMPORTER_CHECK_PROVISION_TIMEOUT_MS`'s own doc, sessions/service.ts). Before this ruling, a cut that
raced past its timeout left `worktreePath`/`branch` both `undefined` in `runOneDistImporterCheck`'s own
scope, so its `finally` block's cleanup did nothing — the ONLY cleanup left was the next boot's sweep.
The `finally` block now also computes the DETERMINISTIC path/branch this check would have cut
(`dist-importer-check-${opId}`, the same formula `resolveWorktreePath`/`taskKey` always produce) and
attempts ONE bounded, non-retrying removal/delete against it when `worktreePath` was never captured — the
boot sweep remains the backstop for whatever this same-session attempt itself can't clear (e.g. the
underlying `createWorktree` call is still mid-flight at the moment this check's OWN process exits).

## LEAD round-3 ruling 9 — accepted: an admitted check can delay the next merge gate by one run (now including cut+build)

Round 2 already accepted that an admitted dist-importer check (LOW tier, but still occupying a real
`maxConcurrentGates` slot) can delay the NEXT merge/deploy gate on this project by one run's worth of
wall-clock time — bounded (one check per repo at a time, via the coalescing queue; a HIGH-tier
merge/deploy waiter is still served before any QUEUED low-tier check, so it only ever delays a gate that
arrives WHILE the check is already RUNNING, never one that was already waiting). Round 3's own ruling 3
(worktree cut + build now run INSIDE the admitted `runExclusive` callback, not before it) makes that
window LONGER than round 2's own acceptance covered — the delay now includes the ~6.5s measured build
time (see `DIST_IMPORTER_CHECK_PROVISION_TIMEOUT_MS`'s own doc) plus the cut, not just the test run. Still
accepted: in `mergeGateInterval` mode, only the gated landing itself, a `run_gate` self-check, or a deploy
ever need a slot — the LEAD is expected to fire a gated landing against a quiet queue, not one racing a
just-landed ungated commit's own advisory check. No change requested.

## LEAD round-3, info only — the unbounded boot-sweep tombstone rescan

`sweepOrphanedDistImporterCheckWorktrees` rescans EVERY `pending_gate_ops` row ever keyed
`dist-importer-check:*`, unbounded by age or count, on every boot. Accepted for now (same posture as
`listPendingGateOps`'s other boot-time full scans) — the population this check mints is bounded by actual
ungated-landing volume, not by request volume, so it cannot grow unboundedly the way an agent-facing list
endpoint could. Revisit only if boot time on a project with a very long `mergeGateInterval` history is
ever observed to be affected; no measurement exists yet either way.

## LEAD round-4 ruling 4a — accepted: a cancel during the cut holds the slot until the cut finishes (≤300s)

A `gate_cancel` landing WHILE `runOneDistImporterCheck` is still inside `createWorktree` (the cut) does
NOT interrupt that git operation — `cancelSignal.aborted` is only checked AFTER the cut returns (see
round-3 ruling 1's own section). The admitted slot is therefore held for the cut's full duration
regardless of the cancel request, bounded only by `DIST_IMPORTER_CHECK_PROVISION_TIMEOUT_MS` (300s).
ACCEPTED: `createWorktree` has no cancellation hook of its own to thread a signal into (unlike
`runBuildStep`, round-4 ruling 5, which DOES get one), and a real git worktree-add is normally fast; the
300s ceiling is the same backstop every other caller of this constant already relies on. No change
requested.

## LEAD round-4 ruling 1(b) — `gate_history`/`countGateEvents` is now assertable, not just the raw event

Round-3's own tests asserted the raw `worker_gate` event detail directly (`e.detail.mechanismLike`,
`e.detail.cancelled`, etc.) — a correct but WEAKER claim than asserting the actual projection
`db.listGateEvents`/`countGateEvents` produces, which is what a human/agent reader of `gate_history`
actually sees. Scenarios (9)/(14)/(16)/(17) now ALSO assert the real `GateHistoryRow.outcome`/`gateRan`
and `GateHistoryCounts.byOutcome`/`byGateType` for their own settled op, closing the gap between "the
event detail is correct" and "the page/tool built from it projects that detail correctly" — the exact gap
round-4 ruling 2 (the `gateOutcomeFromDetail` fix) was filed to close in the first place.

## LEAD round-4 ruling 2 — boot sweep's branch leg: `deleteBranch` never throws, so the OLD try/catch always counted it as swept

`deleteBranch` (`git/worktrees.ts`) is written to NEVER throw on a generic failure — its own catch logs a
warning and returns `true` regardless (see that function's own doc: "not found" is treated as idempotent
success, and a CAS-mismatch refusal is the only path that returns `false`). The boot sweep's branch leg
used to wrap the call in a bare `try { await deleteBranch(...); removedSomething = true; } catch {...}` —
since the call essentially never throws, this unconditionally counted the branch leg as swept whether or
not anything was actually removed (a branch still checked out by a real, un-removed worktree — e.g. round-
4's own wedged-removal path — silently inflated the swept count). The fix re-checks
`branchExistsInRepo` AFTER the delete attempt and counts the leg only when the branch is confirmed gone.

## LEAD round-4 ruling 3 — `gateSpawned` is now stamped explicitly on every distImporterCheckOnly event

`gateRanFromDetail` (db.ts) already prefers an explicit `detail.gateSpawned` boolean over its own
heuristic fallbacks. Before this ruling, the dist-importer check's own `worker_gate` events never stamped
it at all, so every settle fell through to the generic `return true` default — including a cut/build/scan
mechanism failure, where NOTHING ever spawned. `gate_history`'s `gateRan` therefore read `true` for a run
that never got anywhere near a real test process, and Gates.tsx's `nonRunReason("error")` text (added
round-3) could never actually surface, since it is only rendered when `!gateRan`. Every `recordEvent` call
in `runOneDistImporterCheck` now stamps `gateSpawned` explicitly: `false` for a queued cancel, a mid-phase
(cut/build/scan) cancel, a cut/build/scan mechanism failure, and the generic catch; `true` only once
`runGateSequential` has genuinely been entered (the "gate" outcome branches — both a RUNNING cancel
discovered there, and the ordinary pass/fail/mechanismLike settle).

## LEAD round-4 ruling 4b — `gate_cancel`'s RUNNING-cancel verification is now REAL for this op, not vacuous

`cancelGateOp`'s RUNNING-cancel branch verifies a kill by waiting on `PendingOpRegistry.waitBriefly(\`gate:
${entry.sessionId}\`, ...)` — correct for an ordinary worker self-check (which DOES register under that
key via `runWorkerGate`'s own `pendingOps.attach` call), but `runOneDistImporterCheck` NEVER calls
`pendingOps.attach` at all (see this record's own opening section — this module is deliberately kept out
of that machinery). `waitBriefly` returns `true` IMMEDIATELY when nothing is registered under its key —
so this verification was vacuous for a distImporterCheckOnly entry: `cancelGateOp` reported
`outcome:"cancelled"` the instant `cancelRunning` issued the abort, regardless of whether the underlying
`runOneDistImporterCheck` closure had actually stopped — exactly the dishonest-verification shape
`@decision 8d585277` forbids ("never report a RUNNING cancel as cancelled unless the kill was actually
VERIFIED").

Rather than force this op through the full `PendingOpRegistry.attach` machinery (owner checks, retention
caching, the until-superseded verdict cache — none of which this advisory needs or wants; see the "Do
not" list in this record's opening section), `GateSemaphore`'s OWN registry entry now carries a `settle:
Promise<void>` (resolved from `runExclusive`'s `finally`, in the SAME synchronous step that deletes the
entry from `registry` — the real, authoritative "has this op's `fn` actually finished" signal for EVERY
gate kind, not just this one) and a new `waitForSettleBriefly(id, ms)` method that mirrors
`PendingOpRegistry.waitBriefly`'s exact contract against that signal instead. `cancelGateOp` now branches
on `entry.distImporterCheckOnly` to pick the right wait. Proven both ways: a negative-control scenario
synthesizes a RUNNING distImporterCheckOnly entry whose `fn` never settles even after `cancelSignal`
aborts — `cancelGateOp` must report `outcome:"not_cancelled"` (the pre-fix vacuous wait could only ever
report `"cancelled"` here, since nothing was ever registered under the key it waited on).

## Do not (6)

- Do not route a distImporterCheckOnly op's RUNNING-cancel verification through
  `PendingOpRegistry.waitBriefly`'s `gate:<sessionId>` key — nothing is ever registered there for this op
  kind; use `GateSemaphore.waitForSettleBriefly(entry.id, ...)` instead.
- Do not wrap `runOneDistImporterCheck` in `PendingOpRegistry.attach` just to make the cancel verification
  work — that machinery's owner checks/retention caching/until-superseded cache are not wanted here (see
  this record's opening "Do not" list); `GateSemaphore`'s own per-entry `settle` promise is the narrower,
  correct fix.
- Do not count the boot sweep's branch leg as swept from `deleteBranch` not throwing — it practically
  never throws; re-check `branchExistsInRepo` afterward.
- Do not leave `gateSpawned` unstamped on a distImporterCheckOnly event — `gateRanFromDetail`'s fallback
  defaults to `true`, which is wrong for every mechanism-failure/cancel-before-the-gate-call outcome.
