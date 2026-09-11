# 5e3ebc80 — factor per-run FAILURES: line-building into pure, exported functions

## Narrative

The `FAILURES:` epilogue's per-run rendering was factored out into three pure, exported functions so a
test can drive each directly (including against a REAL `spawnWithTimeout` result reshaped into a row)
without running the whole hermetic suite:

- **`computeFailureTail(stdout, stderr)`** — the single line worth surfacing inline on a failing run's
  bullet line (last non-empty stdout line, else last non-empty stderr line).
- **`describeExitShape(f)`** — names WHAT KIND of nonzero termination a run had (numeric exit code, OS
  signal, or — rare — neither ever observed), so a reader doesn't have to re-derive it from
  `f.status`/`f.signal` by hand. Only actually printed on the zero-output branch (see
  `buildFailureEntryLines` below) — the bullet line above it already shows a numeric exit code, so this
  would be pure noise there; it earns its place only where there's no captured output to show instead.
- **`buildFailureEntryLines(f)`** — builds the full `FAILURES:` block for ONE failing run. Every
  non-empty-output branch is byte-identical to the code this replaced. The ONLY new behaviour is an
  explicit marker on the branch where both streams are empty/whitespace-only: before this card that
  branch emitted NOTHING, so "the child genuinely produced no output" and "we failed to capture the
  output it produced" were the same bytes on the page.

`signal` (from the child's own `exit` event, captured by `spawnWithTimeout`) is carried through on BOTH
the errored and non-errored `runOne` return shapes — on the errored path purely for shape-consistency
(always null there; the child never started, so `exit` never fired) — so `describeExitShape` can name a
signal kill, not just a numeric exit code, wherever it is read from.

## Do not

- Do not inline `computeFailureTail`/`describeExitShape`/`buildFailureEntryLines` back into the epilogue
  printer — they exist specifically so a test can drive each directly without re-deriving the formula a
  second time and risking drift between a test copy and the real one.
- Do not let the zero-output branch fall silent again — the explicit marker is the fix for the exact
  ambiguity ("no output" vs. "failed to capture output") this card closes.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs`: above `computeFailureTail` (~1112-1114),
`describeExitShape` (~1120-1124), and `buildFailureEntryLines` (~1132-1137), plus the `runOne` shape-
consistency comments (~1193-1195, ~1207-1209) and the `FAILURES:` epilogue's own anchor (~1857-1858) —
all as of this tranche. Card `5e3ebc80`. Introduced by commit `b2e6fb88`.
