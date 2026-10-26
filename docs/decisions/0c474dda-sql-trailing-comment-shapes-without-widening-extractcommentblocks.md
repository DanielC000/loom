# 0c474dda — teach the anchor lint SQL and trailing-comment shapes without widening `extractCommentBlocks`

Card `298a1390` found `midSentenceAnchors` false-flagging 5 real sites in `db.ts` — a SQL `--` comment inside the `SCHEMA` template literal — because `stripCommentMarkers`/`extractCommentBlocks` only ever recognized `//` and `/* */` at the start of a line. It also found 2 sites (`pty/host.ts`) where a trailing same-line `// @decision <id>` after real code (`return; // @decision 710a34fa — ...`) got the same false-positive treatment, and left both unresolved rather than risk silently dropping the one GENUINE mid-sentence violation in the corpus (a JSX `{/* */}` comment in `PresetPrompts.tsx`) by comment-scoping the check before the recognition gap was closed.

This card closes the SQL and trailing-comment gaps. The JSX `{/* */}` gap is deliberately **not** touched here — see "Do not" below.

## Why `extractCommentBlocks` itself was NOT widened for `--`

Measured on this repo: real `--flag` CLI-usage-text lines live inside multi-line template-literal help strings in `packages/daemon/scripts/extraction-loss-scan.mjs`, `negative-control.mjs`, and `rotation-gate.mjs` (e.g. `--range Git range passed to...`). A bare "a line starting with `--` opens a comment" rule has no way to tell a SQL comment apart from this — both are plain string content — so widening `extractCommentBlocks` would wrongly sweep these CLI-help lines into comment blocks. The fix instead widens `isMidSentenceAnchorLine`'s own per-anchor prefix check (and, for it, `stripCommentMarkers`'s leading-marker strip) — a change that only ever matters at the exact column of a real `@decision` anchor, never at an arbitrary line with no anchor on it at all.

## The trailing-same-line-comment decision

`return; // @decision 710a34fa — ...` is not flagged as mid-sentence. This is a style decision, not a narrower detection fix: a terse one-line guard annotated directly on the code line it explains is at least as visible as the same text on the line above, and the real corpus has exactly 2 such sites (both citing the same id). The implementation is narrow by construction — it only exempts an anchor that opens its OWN trailing comment (nothing but whitespace between a `//`/`/*`/`/**` and the anchor); an anchor following real prose inside that trailing comment (`// see @decision <id> for why`) is still flagged, because there IS non-empty prose between the comment-open and the anchor.

## `isDecorativeSeparatorLine`'s missing ASCII `=`

A `====... <label> ====...` banner (this repo's own `test/recycle-settle-lost-to-restart.mjs` section-divider convention, used repeatedly in that file and a couple of others) was not recognized as a decorative divider, because the character class only had the box-drawing `═` (U+2550), never ASCII `=`. This caused 7 real `embeddedAnchors` false positives (every anchor immediately after one of these banners) out of the 16 raw test-corpus hits measured before this fix — only 9 were genuine. Fixed by adding ASCII `=` to the class.

## Test/tests/e2e extension

`sigilSpaceAnchors`, `pointerAnchors`, `overlongAnchorParagraphs`, `midSentenceAnchors`, and `embeddedAnchors` now also run against `test`/`tests`/`e2e` files, comment-scoped (`isAnchorInBlock`/`isLineInBlock`) — the same mechanism `f9ccdcb1` established for `orphanAnchors` and `298a1390` extended to `brokenAnchors`. Measured, comment-scoped, on this repo's test corpus at the time of this card (AFTER the `=` fix above, which is why `embeddedAnchors` reads 9, not the raw 16): sigilSpaceAnchors 3 (all 3 sites are this lint's own test-file doc-example prose, reworded below), midSentenceAnchors 156, pointerAnchors 30, overlongAnchorParagraphs 231, embeddedAnchors 9 genuine (7 of the raw 16 were the `=`-banner false positive fixed above). `unanchoredLongBlocks`/`guardClassBlocks`/`distribution`, `overlongAnchorIds`, `bareCommitAnchors`, and `splitAnchorParagraphs` stay non-test-only — not part of this card's DoD, and not re-measured here.

## Do not

- Do not widen `extractCommentBlocks` to recognize a bare `--`-led line as a comment-block opener — measured unsafe (real `--flag` CLI-help-text lines inside template-literal strings would be wrongly swept into a comment block).
- Do not widen `extractCommentBlocks` for JSX `{/* */}` as part of this id — deferred as its own, separate, larger follow-up (the manager is filing it as its own card) because of its wide ripple (measured 372 JSX-comment-open lines across 51 web files, needing a full re-measurement of every block-dependent check before shipping). `midSentenceAnchors` needs no such widening — it already correctly flags the one genuine JSX site via its unfiltered, raw per-anchor prefix check.
- Do not re-flag a trailing same-line `// @decision <id>` that opens its own comment as mid-sentence — this is a deliberate style decision (see above), not an unfixed detection gap. Do not revert it without a fresh decision.
- Do not treat `isMidSentenceAnchorLine`'s trailing-comment escape as license to recognize a trailing comment ANYWHERE else in this file (e.g. as its own one-line block in `extractCommentBlocks`) — it is deliberately narrow, scoped to this one per-anchor check, specifically to avoid the "a `//` could be inside a string (e.g. a URL)" hazard a block-level rule would have to rule out separately.
- Do not extend `overlongAnchorIds`, `bareCommitAnchors`, or `splitAnchorParagraphs` into `test`/`tests`/`e2e` on the strength of this card — they were not measured here and are a separate decision.
