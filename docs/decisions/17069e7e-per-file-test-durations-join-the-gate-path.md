# 17069e7e — per-file test durations join the gate path; most of the card was already built as an investigation rig

## Narrative

Filed as a 4-part investigation into gate slowness, then substantially scope-corrected the same day: a per-file timing rig already existed and was merged (`docs/investigations/6c1aadf7-daemon-suite-timing/scripts/measure-per-file-timing.mjs`, flagged "reusable rig — do not rebuild" by card `6185fbfc`), and 3,748 rows of NDJSON timing data already sat on main. DoD-1 (per-file duration), DoD-3 (NDJSON artifact), and DoD-4 (records `lane`) were already satisfied as data. The actual remaining scope was DoD-2 only: promote the existing rig into first-class emission on the *normal gate path*, no flag required, using the *same* NDJSON schema (`kind:"file"`/`kind:"run-summary"`) so the new rows stay concatenable with the 3,748 existing ones — never invent a new shape.

Two premise errors in the original card body were caught before building: (1) "a grep for `durationMs`/`elapsed`/`hrtime` returns nothing" was false — it returns 3 hits, the max-inter-event-gap series from card `e6e55f7a`; the runner was instrumented, just not per-file. (2) "674 test files" is the *discovered*-file count, not what the gate runs — measured on one commit: 630 hermetic (the gate's real population) + 24 not-hermetic (never run) + 20 underscore-prefixed helpers = 674. This count moves constantly (628→629→630 in four hours) and must never be inherited, only counted fresh.

**Measured findings, written into `LOOM_HOME`-relative NDJSON (not the worktree — a worktree is force-removed on merge, so anything written inside it dies with it):**

- Build vs. test split, three real gate runs: `pnpm build` 2s/3s/2s; `test:daemon` 21m17s/20m37s/22m52s. Build is ≈0.2% of the gate; the suite is effectively all of it.
- Top-20 slowest files (standalone run, 627 files, 0 failures) sum to 652.0s = 36.6% of 1782.0s total test time — the long tail across 607 remaining files is 63%, so no single fix reaches it. Slowest single file: `merge-confirm-completion-nudge` at 85.4s.
- Lane-efficiency finding that **refuted** the card's own DoD-4 hypothesis (idle lanes waiting on a straggler): SUM 1782.0s ÷ 2 lanes = 891.0s ideal vs. ACTUAL wall 894.6s ⇒ 99.6% efficiency, only 3.6s of slack. Wall-clock is set by SUM ÷ LANES, not the critical path — added lanes convert ~linearly to wall-clock until host contention bites; killing the entire top-20 buys at most 36.6%.
- **Unattributed, deliberately not explained:** standalone run 894.6s vs. the same suite inside a real merge gate the same day, 1237s/1277s/1374s — ~40-50% more wall-clock inside the gate, ~6-8 minutes unaccounted for by test content alone. The standalone run had a recorded host state; the gate runs had concurrent gates and live workers — a *different* condition, so the delta was left unattributed pending a contrast case rather than assigned a cause (see project memory `corroborating-a-premise-is-not-corroborating-the-inference`).

## Why LOOM_HOME-relative, and why it's a different file from the investigation snapshot

The writer duplicates `packages/daemon/src/paths.ts`'s own `LOOM_HOME` constant (`process.env.LOOM_HOME || path.join(os.homedir(), ".loom")`) rather than importing it — this script is plain JS, run standalone before any build, and importing the TS source (or a maybe-stale `dist/`) would be its own footgun. This resolves correctly for every zero-argv caller: `run_gate`/the merge gate (the gate child inherits the daemon's full `process.env` unconditionally — see `gate-runner.ts`'s `runGateStep` — so the daemon's real `LOOM_HOME` is just there), a human's local `pnpm --filter @loom/daemon test:daemon` (their own real `~/.loom`), and CI (`ci.yml`/`release.yml` — lands in the runner's own ephemeral home; harmless, just not persisted, since CI isn't this artifact's consumer). Writing anywhere in the worktree instead was rejected: a worker's (or the merge gate's) worktree is force-removed (`git worktree remove --force`, `git/worktrees.ts`'s `removeWorktree`) on the ordinary successful-merge path (`SessionService`'s `gcWorktreeDir`), so anything written there is destroyed the moment the task merges.

The live NDJSON file is deliberately a *different filename* from the investigation's own committed snapshot (`docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson`): that file is a point-in-time, git-tracked artifact; this one is live-accumulating gate telemetry, and the two must never be confused with each other — even though they share the same per-row schema and field names, deliberately, so the two stay trivially concatenable for comparison.

## Do not

- Do not invent a new NDJSON schema for gate-path emission — reuse the existing `kind:"file"`/`kind:"run-summary"` shape so old and new rows stay concatenable.
- Do not cite "674 test files" as a stable denominator — it moves within hours; count it fresh every time.
- Do not name a cause for the standalone-vs-in-gate wall-clock gap without a genuine contrast case (host state recorded for both conditions).

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, module-header decision-history block (originally lines 60-71), as of this tranche's HEAD. Card `17069e7e`, filed by the Platform Lead 2026-08-01 on an owner directive; sequenced behind card `6185fbfc` (same file, `--only=`/`--exclude=`/`--concurrency=` flags).
