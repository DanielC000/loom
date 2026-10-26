# f9ccdcb1 — orphanAnchors now scans test/tests/e2e, scoped to real comments only

`comment-anchor-lint.mjs` used to exclude `test`/`tests`/`e2e` outright (`EXCLUDE_SEGMENTS`): test
fixtures commonly plant synthetic anchor ids (`aaaaaaaa`, `deadbeef`, `cafebabe`, ...) with no matching
record by design, and the tool had no way to tell those apart from a genuine `@decision <id>` a worker
wrote in a real test-file comment. The result was a vacuous `orphanAnchors.count: 0` for any file under
those directories — two workers read that zero as a verified pass for a real orphan anchor (card 6cf10d10,
`branch-gone-ledger-cutover-gate.mjs:127`) that in fact was never scanned at all.

## The classification rule, and how it was verified

A synthetic fixture id always lives inside a quoted string or template literal (an array element, a
`check()` label, a `fs.writeFileSync(..., "// @decision aaaaaaaa — ...")` call) — never inside a real
`//`/`/* */` comment. `extractCommentBlocks` already classifies exactly this distinction for its own
per-line `isComment` detection (used to group `unanchoredLongBlocks`/`guardClassBlocks`). The fix reuses
that existing classification: `isAnchorInBlock(a, blocks)` — an anchor only counts if its line falls
inside one of `extractCommentBlocks`'s returned block ranges.

Verified by a full survey of every `@decision`-shaped occurrence in `packages/daemon/test` (578 sites
across 204 files, via `findFileAnchors` against each file's real on-disk text): every synthetic-fixture
occurrence (179 total, concentrated in the lint tool's own fixture-heavy test files —
`comment-anchor-lint.mjs`, `comment-anchor-lint-hook.mjs`, `anchor-re-parity.mjs`, `decision-records.mjs`,
`decisions-for-tool.mjs`, `extraction-loss-scan.mjs`) sat OUTSIDE every block; every genuine decision-site
occurrence (399 total) sat INSIDE one. Zero exceptions. 8 files mixed both shapes (a real anchor in a real
comment, plus the SAME id quoted again in a `check()` label elsewhere in the file) — inspected all 8;
every "filtered" occurrence was a prose citation of an id already anchored for-real elsewhere, never a
site that would have needed resolving on its own.

Positive control (scratch file, outside the repo, deleted after): a brand-new orphan anchor in a real
test-file comment is flagged; the same real file text for `comment-anchor-lint.mjs` (182 raw `@decision`
mentions) and `_guard.mjs` (23 real, already-recorded anchors) produce zero false orphans either way.

## Scope: orphanAnchors/orphanRecords only — not the other 9 anchor-grammar checks

A naive "just stop excluding test/tests/e2e" is NOT safe on its own. Two separate measured risks, both
avoided by keeping the widening narrowly scoped to `orphanAnchors`/`orphanRecords`:

- `unanchoredLongBlocks`/`guardClassBlocks`/`distribution` are computed from `extractCommentBlocks`'s
  block list directly (not filtered by anchor resolution) — widening THESE into test/ measured **1654
  newly-flagged blocks / 48,805 lines** across `packages/daemon/test` alone (test fixtures are long,
  deliberately-unanchored prose by design: `check()` setup narration, fixture rationale, etc.). Flooding
  this check was never this card's goal.
- `findBrokenAnchors`/`findOverlongAnchorIds`/`findSigilSpaceAnchors` scan raw file lines directly, with
  NO comment-vs-string-literal distinction at all (unlike `findFileAnchors`'s block-filtered path above) —
  running them against `comment-anchor-lint.mjs`'s own test-file text (which deliberately crafts malformed-
  shape fixtures to test THESE exact detectors) measured **8 false overlongAnchorIds + 21 false
  sigilSpaceAnchors**. `findPointerAnchors` run against ALL anchors in that same file measured 11 false
  hits; rerun with anchors pre-filtered to comment-block membership, 0.

So the fix is: `isTestScopedSegments` decides, per file, whether it is under `test`/`tests`/`e2e`. A
test-scoped file contributes its comment-scoped anchors to `allAnchors` (feeding `orphanAnchors` and,
through the same `anchorIdSet`, `orphanRecords`) and NOTHING else — no `blocks` into `allBlocks`, and none
of its anchors into the `bareCommitAnchors`/`pointerAnchors`/`overlongAnchorParagraphs`/
`midSentenceAnchors`/`embeddedAnchors`/`splitAnchorParagraphs` aggregates, nor into
`findBrokenAnchors`/`findOverlongAnchorIds`/`findSigilSpaceAnchors`. A non-test file is completely
unaffected — byte-identical behavior to before this card. The hook (`computeFileReport`/`isInScope`) gets
the identical branch, so a worker editing a test file sees the same live orphan signal the CLI scan now
gives, with every other field in its report staying an empty array exactly as if the file were still
excluded.

Extending the other 9 checks into test/ (with the SAME comment-scoping, which the measurements above show
would fix their fixture-noise risk too) is explicitly deferred to a follow-up card, not done here.

## `assets/` was already in scope today — and that's fine

`packages/daemon/assets/**` was never excluded by `EXCLUDE_SEGMENTS`/`ROOT_EXCLUDED_DIRS` — it has always
been scanned by the production walk. Checked whether the three false-positive-prone checks above are
therefore ALREADY live against the asset file's own text (it documents these exact malformed shapes in
its header comments): running the real CLI scan against this repo measured 0 `overlongAnchorIds`, 0
`sigilSpaceAnchors` repo-wide, and 0 `pointerAnchors` under `assets/` specifically — the asset's own doc
examples (e.g. `"sha: deadbeef"`) are worded without the literal `@decision` token immediately adjacent,
so they never trip the regexes. No live incident there; the false positives measured above are specific
to the TEST-FILE copies of those same example strings, which only matter once test/ is in scope for those
checks — i.e. not from this card.

## Do not

- Do not widen `unanchoredLongBlocks`/`guardClassBlocks`/`distribution`, or any of the other 9
  anchor-grammar checks, into `test`/`tests`/`e2e` without re-deriving the fixture-noise measurement fresh
  first — the numbers above are a point-in-time survey of this repo's test corpus, not a permanent
  property of it.
- Do not drop the `isAnchorInBlock` comment-block filter for test-scoped anchors "since it's probably
  fine" — it is the entire mechanism that tells a real anchor apart from a synthetic fixture id, and it
  was verified across 578 real occurrences with zero exceptions, not assumed.
- Do not read `orphanRecords`'s new test-file-aware zero as proof a record is referenced from PRODUCTION
  source — it may now resolve solely through a test-file comment, which is correct (the anchor is real),
  but is a different claim than "cited from shipped code."
