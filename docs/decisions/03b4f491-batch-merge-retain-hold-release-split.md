# 03b4f491 — split batch-merge-retain-hold-release.mjs by scenario to keep runtime down

## Why

`packages/daemon/test/batch-merge-retain-hold-release.mjs` was SIGTERM-killed at the 120s per-file
ceiling in an advisory ~695-file check on a loaded host, while solo/serial on main it measured 24-33s
across 6 runs (10 PASS each) — load-sensitive, not a fixed failure. Unlike its sibling `a2717148`
(43-81s solo, ~2x load needed to kill), this file's own solo baseline was only ~0.25x the ceiling, so a
plain linear slowdown under load was judged a weak explanation on its own.

Per-scenario instrumented timing (2 solo runs, `env -u LOOM_DEV -u LOOM_SUPERVISED`, quiet host; totals
29.4s/29.6s, identical shape) found 87-89% of the file's wall time concentrated in its four real
`mergeBatchTracked` calls: "first" setup batch 11.5-11.7s, "(gone)" refire 6.2-6.4s, "(release
precondition)" refire 2.0-2.2s, "(release)" refire 5.7-6.1s. `createWorktree` and all other setup
together cost under 2s. No single fixed wall-clock wait or tight shared `gitOpMs` budget was in play:
`this.gitOpMs` is `undefined` in this test (only `syncAttachBudgetMs` is overridden), so every downstream
git call falls through to the production 15s `GIT_OP_TIMEOUT_MS` default, and the file's own
`UNION_MERGE_TIMEOUT_FLOOR_MS` (45s)-bounded owed-landing retry ladder was verified UNREACHABLE on this
file's scenario shape — A's retain always takes the cheap `pre-stop` branch (`liveTip !== assembledTip`
→ `continue`, service.ts), never `finishAlreadyMerged`/`mergeMainIntoWorktree`.

A candidate raised early in the investigation — the test's own `refire()` helper falling into its
`!r.settled` branch (a 90s bounded poll plus a second full `mergeBatchTracked` call, a real non-linear
amplifier if it ever fired) — was traced to source and confirmed UNREACHABLE for this file as written.
`PendingOpRegistry.attach()`'s `this.entries.delete(key)` runs synchronously inside the SAME `.then()`/
`.catch()` handler whose resolution is what makes `attach()`'s own `Promise.race([e.settle, sleep(waitMs)])`
resolve at all — so a key can never still read "running" once `settled:true` has been returned to a
caller for it (verified with a deterministic in-process seam: `PendingOpRegistry` minted twice back to
back, no induced host load). The mechanism IS real in general (reproduced: a short `waitMs` relative to a
still-running `run()` genuinely yields `attachedToInFlight:true`) — but this file's `mk()` pins
`syncAttachBudgetMs: 600_000` specifically to defeat it, and no real batch call here (even catastrophically
slow) can plausibly exceed 600s within this file's own 120s kill ceiling. So the cost here is proportional
to real git/node-subprocess volume per scenario (each `mergeBatchTracked` call spawns a real gate-command
`node` process plus a sequence of real git children for squash/rollback bookkeeping), load-sensitive
because every real child spawn slows under host contention, with no single point of failure to fix —
the same shape `a2717148`'s own investigation found, just with a different (and initially more
surprising) margin.

## Do not

- Do not re-combine the three files to "simplify" — the split exists purely to keep each file's wall
  time comfortably clear of the merge gate's per-file ceiling under load; recombining reintroduces the
  near-ceiling risk this card measured.
- Do not add a `TEST_TIMEOUT_OVERRIDES` entry below the default 120s ceiling for any of the three — the
  failure mode here is load-driven kills, so a *tighter* ceiling only makes a kill more likely. None of
  the three needed an override (max observed across 18 serial runs — 3x each file, both env states — was
  64s, 53% of the ceiling).
- Do not re-derive the split boundary by filename pattern or by re-profiling from scratch if this
  recurs — the boundary follows the file's own existing comment-block scenario grouping: the core setup
  + hand-deleted-branch case (`batch-merge-retain-hold-release.mjs`), the synthetic held/release case
  (`-synthetic-retain.mjs`), and the standalone `finalizeMerge` CAS-skip unit (`-cas-skip.mjs`, fully
  independent of the other two — no shared setup at all).
- Do not assume the synthetic-retain and cas-skip files need the real mixed-batch setup re-asserted —
  `-synthetic-retain.mjs` duplicates the IDENTICAL setup code (to produce a real, already-landed B) but
  deliberately does NOT re-run the setup's own three `check()` calls (those are asserted once, in the
  core file) — re-asserting them would inflate the total past the original's 10 PASS-equivalents.
- Do not treat "the refire helper's slow-path branch is unreachable here" as a general claim about
  `mergeBatchTracked`/`PendingOpRegistry` — it is unreachable ONLY because `syncAttachBudgetMs` is pinned
  far above any plausible real run duration within this file's own kill ceiling. A caller that does NOT
  pin it that way (production's own default, or a future test that doesn't override it) can genuinely hit
  `attachedToInFlight:true` once a real batch run exceeds the budget — the mechanism itself is real and
  was reproduced with a deterministic in-process seam, not a guess.

## Result

Split into `batch-merge-retain-hold-release.mjs` (setup + the hand-deleted-branch `(gone)` case, 5
checks), `batch-merge-retain-hold-release-synthetic-retain.mjs` (the `(release precondition)`/`(release
control)` synthetic-retain case, 2 checks, setup duplicated but not re-asserted), and
`batch-merge-retain-hold-release-cas-skip.mjs` (the standalone `finalizeMerge` CAS-skip unit, 3 checks,
fully independent). All 10 original `check()` executions preserved exactly (the file's own `untouched()`
helper, defined but never invoked anywhere in the original file, was dropped as dead code — it asserted
nothing on any actual run). No `TEST_TIMEOUT_OVERRIDES` added to any of the three.

Measured (3x serial per file, both env states — `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`,
18 runs total, 18/18 PASS): `batch-merge-retain-hold-release.mjs` 15-38s; `-synthetic-retain.mjs` 19-64s;
`-cas-skip.mjs` 2-3s. Wide run-to-run variance on an ambiently-loaded shared host, consistent with the
subprocess-spawn-volume explanation above — but every observed run stayed well clear of the ceiling.
