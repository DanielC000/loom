# a2717148 — split merge-landing-aborted-batch-refusal.mjs by refusal-shape boundary

## Why

`packages/daemon/test/merge-landing-aborted-batch-refusal.mjs` was SIGTERM-killed at the 120s per-file
ceiling twice on 2026-10-18 under load (once in a RED full gate, once in an advisory dist-importer check
running 116 files), while solo on main it measured 43-81s across 6 runs — load-sensitive, not a fixed
failure.

Per-scenario instrumented timing (3 solo runs: 2x `env -u LOOM_DEV -u LOOM_SUPERVISED`, 1x `LOOM_DEV=1`;
totals 45.5s/50.5s/57.2s) found no single fixed wall-clock wait and no tight shared `gitOpMs` budget in
play (this file's `boot()` never overrides `gitOpMs`, unlike card 3a34fc76's unrelated file, which did).
The cost is proportional to real git-subprocess volume per scenario — load-sensitive because every real
`git` child spawn slows under host contention, with no single point of failure to fix. Scenario (A)
FORFEITED was consistently the heaviest (13-14.4s of the file's 45.5-57.2s total) because it is the only
scenario whose refusal shape starts a REAL per-candidate solo fallback merge-confirm
(`runFallback` → `confirmWorkerMergeTracked`) for both workers — a much git-op-denser flow than the
single ff-only batch-landing attempt every other scenario exercises.

## Do not

- Do not re-combine the two files to "simplify" — the split exists purely to keep each half's wall time
  comfortably clear of the merge gate's per-file ceiling under load; recombining reintroduces the
  near-ceiling risk this card measured.
- Do not add a `TEST_TIMEOUT_OVERRIDES` entry below the default 120s ceiling for either half — the
  failure mode here is load-driven kills, so a *tighter* ceiling only makes a kill more likely. Neither
  half needed an override at all (both measured well under 50% of the ceiling solo).
- Do not re-derive the split boundary by filename pattern or by re-profiling from scratch if this
  recurs — the boundary follows the file's own existing comment-block grouping (the three shapes that
  DO write `merge_landing_aborted`: forfeited/branchDiverted/ff-quarantined, vs. the three
  `mayHaveLanded` shapes where it's deliberately excluded and resolved via attribution instead), which
  also happens to be the cost driver (scenario A's real solo-fallback path lives in the first group).

## Result

Split into `merge-landing-aborted-batch-refusal.mjs` ((A)(B)(C), the shapes that write
`merge_landing_aborted`) and `merge-landing-aborted-batch-refusal-mayhavelanded.mjs` ((D)(E)(F), the
`mayHaveLanded`-excluded shapes). All 57 original `check()` executions preserved exactly (27 in the
first file, 30 in the second — 36 call sites total, 18 per file, some inside `for` loops that execute
twice). No `TEST_TIMEOUT_OVERRIDES` added to either file.
