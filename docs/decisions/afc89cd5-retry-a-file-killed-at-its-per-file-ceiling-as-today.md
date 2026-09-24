# afc89cd5 — keep retrying a test file that was killed at its per-file ceiling (no policy change)

DECISION: **retry as today.** Do not skip the single/multi-file retry for a ceiling-killed file, and do not raise the ceiling on the retry. No behaviour change, so no code and no new test.

## What the card's premise gets right

A per-file ceiling kill by `test-daemon.mjs` prints `FAIL  <file>  (exit timeout (killed (exited via signal SIGTERM after kill)))`, but the gate STEP itself exits with a clean non-zero code, so `classifyGateFailure` (`orchestration/gate-runner.ts`) returns `"genuine"` (it only returns `"timeout"`/`"kill"` when the STEP's own bound or an external signal killed the step). That "genuine" failure then feeds `identifyRetriableTestFiles`, the single/multi-file retry. Verified at source; the card's description matches the code. Card `9966c52d` already special-cases the *wording* of the retry warning for this shape (`formatWeakerPassWarning`), but never measured the retry outcome.

## Measurement (2026-09-24, read-only against `~/.loom/loom.db`, `orchestration_events`)

Population: every `build_gate_single_file_retry` event (one per attempted retry), **158 events / 137 distinct `opId`s**, 2026-08-06T08:34Z → 2026-09-24T07:13Z. Verdict field: `retryPassed`. (The same facts are also mirrored onto the `build_gate` event as `retriedFile`/`retryPassed`; those 137 rows are duplicates of this population and are NOT added to it.)

How a ceiling kill was identified: the event's `priorFailingTest` matches `\(exit timeout` (it holds attempt 1's first failing line, which for a ceiling kill is the `FAIL <file> (exit timeout (killed …))` wrapper line). **Limit:** `priorFailingTest` is only the FIRST failing line, so a multi-file retry whose first failure was an assertion but whose second was a timeout is counted as non-ceiling (33 of the 158 events retried more than one file). The full attempt-1 tail is not persisted on these events; the `gate-output/` files were not joined (only 125 exist, well short of 158 events).

| population | retries | passed | failed |
|---|---|---|---|
| all retries (raw) | 158 | 120 (75.9%) | 38 |
| ceiling-killed only (filtered) | 29 (23 distinct opIds) | 26 (89.7%) | 3 |
| all other retries | 129 | 94 (72.9%) | 35 |
| ceiling-killed, non-codex files | 10 | 10 | 0 |
| ceiling-killed, `codex-*` real-spawn files | 19 | 16 | 3 |

Codex quota: the store does not record whether a codex usage-limit outage was in force, so the exclusion is by proxy and reported separately, not asserted. Excluding every `codex-*` file leaves 10/10 ceiling-killed retries passing. The only 3 failures are all `codex-prompt-ascii-fold-real-spawn` / `codex-submit-confirmation-real-spawn` on 2026-09-23 (a 16-event burst of the same two codex files that day), which is the codex real-spawn population, not evidence about ordinary files.

## Why "retry as today"

- The retry is **useful, not futile**: a ceiling-killed file passes on retry at least as often as any other failed file (89.7% vs 72.9%). A skip policy analogous to `73a847f5` would forfeit ~26 recovered merges out of 29 to avoid ~3 wasted retries. `73a847f5` skips because the retry provably cannot pass (the auto-extend that saved attempt 1 is unavailable to it); nothing comparable holds here, since the retry runs the file alone with less contention.
- "Retry with a raised ceiling" is unsupported: the 26 passes all fit inside the existing ceiling, and the three failures are one codex burst that a longer ceiling would only make slower.

## Bounds on this decision

Small n (29 events, 3 failures, one burst). A different sample could reverse the codex-only stratum; it would not obviously reverse the non-codex one (10/10). Revisit if a re-measure over a larger population puts the ceiling-killed pass rate materially below the non-ceiling rate. The smallest change that would make that re-measure exact (not done here): persist the full set of timeout-killed names on the retry event instead of only `priorFailingTest`.
