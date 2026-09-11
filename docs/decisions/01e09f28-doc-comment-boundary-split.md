# 01e09f28 — a second block boundary at an abutting doc-comment seam

## Narrative

`extractCommentBlocks` (`packages/daemon/assets/comment-anchor-lint.mjs`) originally split
comment blocks on one rule only: a blank line, or a non-comment line, ends a block — mirroring
`decision-records.mjs`'s own `expandStartToBlock` convention. That rule misses a second, real
seam: a `*/` that closes a `/* ... */` comment (single- or multi-line), immediately followed, with
no blank line, by a fresh `//`, `/*`, or `/**` starting the next comment. Two abutting doc comments
of that shape merged into one block.

The consequence was a hiding failure, not just a mis-grouping: anchoring the FIRST of two abutting
doc comments made the SECOND vanish from `unanchoredLongBlocks` entirely — not because it was
itself anchored, but because it was contiguous with a now-anchored neighbour, and the check only
ever looks at whole blocks. Card `01e09f28` added the second boundary to fix this.

**Measured, base commit `8d9fe59d` (before this card's own commit), repo-wide sweep, cross-verified
via two independent code paths** (a raw `extractCommentBlocks` loop and the CLI's own
`computeReport`, identical numbers both ways):
- Before: 328 files, 10779 comment blocks, `unanchoredLongBlocks` = 534.
- After: 328 files, 10816 comment blocks, `unanchoredLongBlocks` = 535 (net +1).
- 13 files contained at least one doc-comment-abutting boundary (their block count changed):
  `codescape/supervisor.ts`, `companion/capabilities.ts`, `deploy-staleness.ts`,
  `git/worktrees.ts`, `mcp/orchestration.ts`, `mcp/platform.ts`, `mcp/tasks.ts`,
  `orchestration/gate-runner.ts`, `pty/claude-settings.ts`, `pty/host.ts`, `sessions/service.ts`,
  `vault/versioner.ts`, `scripts/temp-reaper.mjs`.
- The actual question this card's DoD asked — a previously-anchored run that, once split, reveals a
  newly-unanchored long (>=15-line) sub-block — measured as a real ZERO across the whole corpus:
  validated as a genuine zero, not a vacuous check, by first confirming the same measurement script
  finds exactly 1 hit against a known-positive synthetic fixture built to the expected shape, before
  running it against the real repo.

**Unanticipated, found while validating the before/after diff, not asked for by the card's own
DoD:** the split can also make a violation VANISH — the mirror image of "hidden by an anchor". A
previously-flagged (>=15-line, already unanchored) merged run can split into two pieces each
individually under `minLines`, so neither half is flagged anymore even though neither ever had an
anchor. Two real, both borderline (16-17 lines total before splitting into <15-line halves), sites
at the time of measurement:
- `packages/daemon/src/mcp/orchestration.ts:1071-1087` (17 lines -> 10 + 7) — two unrelated
  architecture-doc comments (the Orchestration MCP server, and Loom Companion hooks) that happen to
  abut with no blank line.
- `packages/daemon/src/pty/host.ts:6238-6252` (15 lines -> 9 + 6) — a JSDoc for `createPty`
  immediately followed (no blank line) by an informal `//` note about the same method's
  `hookToken` param; arguably one logical unit split by this change.

Neither site has an anchor either way, so this is not new backlog hidden by an anchor — it is a
pure detection-surface loss inherent to counting per-block against a fixed line threshold, once a
block gets subdivided. Out of card `01e09f28`'s own DoD scope to fix (the DoD only asked to split
and measure); recorded here so a future decision to chase a "cumulative narrative in a contiguous
group" metric instead of strict per-block counting has the concrete sites and magnitude on hand.

## Do not

- Do not read a moved `unanchoredLongBlocks` count, in either direction, against an older tranche's
  own note as a regression or a broken lint — this boundary change is a known, deliberate source of
  that movement (`docs/extraction-program.md` carries the same caveat for future tranches).
- Do not widen the boundary to also split two abutting `//` lines (an ordinary multi-line `//`
  run) — that shape never closes a `/* ... */` comment, so it is deliberately excluded; only a
  transition OUT of `/* ... */` form triggers this second boundary.

## Source

`packages/daemon/assets/comment-anchor-lint.mjs` — `extractCommentBlocks` (card `01e09f28`). The
measured before/after numbers and the two vanished-detection specimens above are carried over from
project memory `doc-comment-boundary-split-01e09f28`, which recorded them at measurement time.
