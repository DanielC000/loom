# 45a23c27 — echo a failing test's FULL captured stdout/stderr, not just the tail

## Narrative

Before this card, the `FAILURES:` epilogue printed only a one-line tail (the last non-empty line of a
failing test's own stdout/stderr). A Linux-only failure shipped completely undiagnosable from CI output
alone: its decisive detail was buried inside the test file's own internal `check()` failures, which
never reached that tail line and were therefore invisible in the CI log.

**The fix:** echo each failed test's FULL captured stdout/stderr in the `FAILURES:` epilogue, not just
the last line — see `buildFailureEntryLines` (card `5e3ebc80`) for the per-run rendering this feeds.

## Do not

- Do not revert to a tail-only summary in the `FAILURES:` epilogue — reintroduces exactly the
  undiagnosable-CI-output failure mode this card fixes.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, at the top of the `FAILURES:` epilogue
block (~1849-1850 as of this tranche). Card `45a23c27`. Introduced by commit `760aa084` (worker-merge
subject carries no independent narrative beyond the card). Related: `5e3ebc80` (the per-run line-building
this echo feeds), `63664129` (why this echo is the only surviving surface for multi-line detail).
