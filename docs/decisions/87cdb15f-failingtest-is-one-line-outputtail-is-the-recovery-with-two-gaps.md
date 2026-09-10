# 87cdb15f — `failingTest` is STRUCTURALLY ONE LINE; `outputTail` is the recovery, with two known gaps

## Narrative

`GateStepResult.failingTest` is a constraint on every test's failure OUTPUT, not just on this field: `createFailingTestTracker` deliberately keeps only the single winning line per tier (never the whole output), so a test whose decisive diagnostic genuinely spans multiple lines (a timeline, a stack, a stdout/stderr dump) has that content EITHER cut down to its first matching line, OR — for a failure shape that matches none of `FAILING_TEST_PATTERNS` at all (e.g. a plain `throw new Error(multiLineMessage)` with no `AssertionError`/`UNCAUGHT`/`FAIL`/`error TS` marker text) — this field is `undefined` ENTIRELY, not a truncated fragment.

Card 63664129 confirmed both shapes exist in this suite today: the `commitAll` test helper (`test/_git-commit.mjs`) throws a 3-line message on failure that matches no tier here (`failingTest` is always `undefined` for it), and the `console.error(`... UNCAUGHT — ${err.stack}`)` idiom used by several test files has a multi-line `.stack` of which only line 1 is ever kept.

The recovery path for either shape is `outputTail`, NOT this field — specifically its front-anchored `FAILURES:`-block capture (see `createFailureBlockTracker`), which echoes a failing `test:daemon` file's FULL captured stdout/stderr up to a 16KB budget. A test author whose assertion failure isn't legible from `failingTest` alone should read `outputTail` before assuming the diagnostic was lost — it usually wasn't.

Two known, unproven-either-way gaps in that recovery path, tracked as card 87cdb15f (gap 1 = its DoD-1, gap 2 = its DoD-2): (1) several failing files in the SAME run share that one 16KB budget, so an earlier file's echo can starve a later file's own diagnostic; (2) if the run never reaches its own `FAILURES:` epilogue at all (e.g. the step times out first — card `9966c52d` records exactly this shape for `kickoff-real-spawn`), there is no fallback recovery for a multi-line diagnostic — only whatever single line (or nothing, for the `commitAll` shape) `failingTest` itself already holds.

## Do not

- Do not treat `failingTest === undefined` as "no diagnostic exists" — read `outputTail` before concluding the diagnostic was lost; a multi-line or unmatched-shape failure is a normal, expected case for this field, not a bug.
- Do not assume `outputTail`'s `FAILURES:`-block recovery is complete — it can starve under a shared 16KB budget across multiple failing files, and it has no fallback at all when the run never reaches its own `FAILURES:` epilogue (e.g. a step-level timeout, per card `9966c52d`'s `kickoff-real-spawn` specimen).
- Do not re-derive the two gaps' status by hand — they're tracked as card 87cdb15f's own DoD-1/DoD-2.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `GateStepResult.failingTest`: originally lines 454-482, as of tranche 1's HEAD (commit `18bb69e3`). Extracted by tranche 2; no wording changed, wrapped source lines joined into flowing paragraphs and `⚠️`/`➡️` markers stripped.
