# 9bdc8ea5 — `formatRetryAlsoFailedWarning` is a SEPARATE function, never a `passed` argument on its sibling

## Narrative

Card 9bdc8ea5: `formatRetryAlsoFailedWarning` is the SIBLING of `formatWeakerPassWarning` for a retry that ALSO failed — kept a distinctly-named function rather than a `passed` argument on that one (Code Review + manager override of the review's own first-offered remedy; see that function's own decision record for why). Three defects Code Review found in an earlier version that folded this case into `formatWeakerPassWarning` via a boolean — all three are just this ONE return statement, fixed together:

[1] NO batch "ALL N land" clause: on a rejected batch retry NOTHING lands (`ok:false`, every candidate falls back to individual solo gating). `deriveBatchGateVerdict` (`sessions/service.ts`) stamps `batchBranchCount` on BOTH a pass and a fail — it's `landedCount`, branches assembled into the batch WORKTREE during assembly, not branches landed on main — so blindly reusing the pass-side batch clause here would relocate this same card's own defect class (prose contradicting `passed:false` on the same record) into this new branch. States the true fact instead.

[2] "NOT an order-dependent/cross-test-pollution bug" is UNSOUND for N>1, scoped by `names.length`: `identifyRetriableTestFiles` issues ONE `--only=a,b,c` command, and `test-daemon.mjs`'s sequential isolation phase (`ISOLATED_REAL_SPAWN_PHASE_ENABLED`) is opt-in and default OFF (`LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE=1`) — so by default all N retried files run SIMULTANEOUSLY in one pool. A failure there rules out pollution from the REST of the suite, never pollution AMONG the N retried files themselves. Not hypothetical: both real specimens card 67030bb9 measured were N>1 (2 and 3 files) — the single-file case (nothing else ran alongside it) keeps the unqualified claim.

[3] The `allTimeoutKills` caveat (attempt 1's OWN classification, `isTimeoutKillEntry`) applies here exactly as it does on the pass side — a `"genuine"`-classified attempt 1 can still carry a per-file `(exit timeout` entry (card 9966c52d, two measured specimens); a still-failing retry under the same host-load conditions may be host contention, not a reproducing assertion bug, and an earlier wording said so unconditionally without checking `outputTail` at all.

## Do not

- Do not fold this failed-retry case into `formatWeakerPassWarning` via a `passed` boolean — a defaultable/forgettable arg there previously produced a false claim with no compiler catch, across eight untyped `.mjs` call sites.
- Do not render "NOT an order-dependent/cross-test-pollution bug" unqualified for N>1 — by default all N retried files run in one pool, so the retry only rules out pollution from the rest of the suite, never pollution among the retried files themselves.
- Do not skip the `allTimeoutKills`/`isTimeoutKillEntry` check on a still-failing retry — a "genuine"-classified attempt 1 can still carry a per-file timeout-kill entry that means host contention, not a reproducing bug.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `formatRetryAlsoFailedWarning`: originally lines 1591-1617, as of this tranche's HEAD. Relocated by card `b80a2d76` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
