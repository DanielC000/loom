# 63664129 — the FAILURES: echo is the only surviving surface for multi-line failure detail

## Narrative

`orchestration/gate-runner.ts`'s own `outputTail` capture (`GateStepResult.failingTest`) keeps just ONE
line per failure tier, or `undefined` entirely when a thrown message matches no recognized marker — see
that field's own doc in `gate-runner.ts` for the full constraint and its known gaps; don't restate it
here, it drifts. For a test whose decisive failure detail is genuinely multi-line (a stack trace, a
timeline, a stdout/stderr dump), `failingTest` structurally cannot carry it.

This file's own `FAILURES:` echo (card `45a23c27`) is front-anchored by that same `outputTail` capture —
of the two surfaces, it is the ONLY one that survives with the multi-line detail intact, because it
reads this file's own bytes directly rather than `gate-runner.ts`'s single-line summary.

## Do not

- Do not rely on `GateStepResult.failingTest` for multi-line failure detail — it structurally cannot
  carry it. Read `gate-runner.ts`'s own doc for the current constraint rather than trusting a
  restatement here.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, inside the `FAILURES:` epilogue block
(~1851-1852 as of this tranche). Card `63664129`. Introduced by commit `9a02163c` (a docs-only commit
adding this exact comment — `git show` confirms no code change). Related: `45a23c27`
(the echo this depends on being the surviving surface for), `14e733fb` (the synchronous flush that keeps
this echo from being lost entirely on a POSIX gate host).
