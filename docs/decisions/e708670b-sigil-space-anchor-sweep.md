# e708670b — the sibling shape afc56dcc's own card named but shipped unhandled, and its widening

## Narrative

Card `afc56dcc` named TWO anchor-shape defects in one card: the over-long-id shape
(`OVERLONG_ANCHOR_ID_RE`) and a second, sibling shape — a `sha:` sigil with whitespace adjacent to
its colon. Only the first shipped. The worker fixed the over-long-id shape and the lead approved
that fix without noticing the same card had named a second shape too. Card `e708670b` was filed to
close that gap: `SIGIL_SPACE_RE` catches a `sha:` sigil with one or more whitespace characters
adjacent to its colon — after it, before it, or both (e.g. `sha` then a space then the colon, or the
colon then a space then the hex run, instead of the colon sitting directly between `sha` and the hex
with nothing in between). `ANCHOR_RE`'s `sha:` alternative requires the colon to sit directly between
the literal `sha` and the hex run with no intervening whitespace on either side, and the bare
alternative can't match either (the literal text `sha` isn't hex) — so there is no position in the
line the global scan can match, and the anchor vanishes: no anchor, no `orphanAnchors` entry, no
`brokenAnchors` entry (that check is EOL-only, a different shape), no `overlongAnchorIds` entry
(that pattern also requires the hex to immediately follow the sigil) — silent, total no-op.

**The widening, and who caught the gap:** `SIGIL_SPACE_RE` was first written to catch only
whitespace AFTER the colon. The lead independently re-verified that original after-only version,
first-party, in the same Node session (positive-controlled against the two well-formed forms) and
found the space-BEFORE-the-colon shape is ALSO silent under `ANCHOR_RE` and was NOT caught by the
after-only version — leaving a second documented-but-unhandled silent shape on a card filed
specifically because a documented shape had already shipped unhandled once. The pattern was widened,
in the same pass, to cover both sides. Requiring at least one whitespace character adjacent to the
colon (never `\s*` on both sides, which would also match the well-formed form) is what keeps a
well-formed `sha:` anchor resolving normally while catching every whitespace placement around it.
The pattern also matches any hex run of 8+ chars adjacent to the malformed sigil (not just exactly
8), so a combined space-AND-overlong paste is caught by this one pattern rather than needing a
second.

**The measured sweep (worker card `e708670b` DoD-1, base sha `6550f347` for the after-only version;
re-swept after widening, 2026-09-10):** this pattern returns **ZERO** real hits against every one of
this repo's **484** `@decision` occurrences across **328** `SOURCE_ROOTS` files, both before and
after the widening — MEASURED, not inferred (matches this card's own hypothesis: both shapes need a
hand-typed space, so neither has existing damage to repair). Positive-controlled first, against
synthetic fixture lines, in every configuration the card required: space-after-only,
space-before-only, space both sides, a tab either side, double-space either side, and
space-plus-overlong all matched; a well-formed sigil'd anchor (no space either side) and a
well-formed bare anchor did not.

## Do not

- Do not read "the lead approved the first fix" as evidence review caught this — it didn't; the gap
  survived review once already, which is the reason this file's own header now warns that a
  self-match/omission on this exact file has happened more than once.
- Do not loosen the whitespace requirement to `\s*` on both sides of the colon — that also matches
  the well-formed form and would misclassify every ordinary `sha:` anchor as malformed.

## Source

`packages/daemon/assets/comment-anchor-lint.mjs` — `SIGIL_SPACE_RE` and the `sigilSpaceAnchors`
check (card `e708670b`, widened from the originating card `afc56dcc`).
