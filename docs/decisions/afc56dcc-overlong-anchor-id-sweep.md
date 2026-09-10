# afc56dcc — OVERLONG_ANCHOR_ID_RE's narrow shape, and the measured zero-hit sweep behind it

## Narrative

Card `afc56dcc` added `OVERLONG_ANCHOR_ID_RE` to `comment-anchor-lint.mjs`: a same-line hex run of
9+ characters after `@decision` (optionally `sha:`-sigil'd) — a third anchor-shape defect, distinct
from `BROKEN_ANCHOR_RE`'s EOL-wrap shape. `ANCHOR_RE` requires exactly 8 hex chars followed by a
word boundary, so a 9+-hex run never matches it at all: no anchor, no `orphanAnchors` entry, no
`brokenAnchors` entry, no injection, no error — a silent, total no-op. This became the natural
authoring mistake once card `969b0e1c` told authors to source a `sha:` id off `git blame`/`git
log`, which hand back a full 40-hex sha, not the 8-hex prefix the grammar actually wants.

**The measured sweep (worker card `afc56dcc` DoD-1, base sha `41336cdb`, 2026-09-10):** this
pattern returns **ZERO** real hits against every one of this repo's **540** `@decision`
occurrences across **36 files** (`git grep`, case-insensitive) — MEASURED, not inferred.
Positive-controlled first, to prove the pattern can fire at all: run against a synthetic fixture
line, a synthetic `sha:`-sigil'd 40-hex line and a synthetic bare 10-hex line both matched; a
well-formed 8-hex anchor (both bare and `sha:`-sigil'd) did not. So the zero is a real zero, not an
artifact of a broken pattern — see card `ad3a9a85`'s own warning that a clean zero from an unproven
pattern is exactly what this project keeps cataloguing.

**Why the narrow shape, not the broad one:** this pattern is deliberately narrower than "`@decision`
not followed by a valid id anywhere on the line" — that broader form is exactly what
`BROKEN_ANCHOR_RE`'s own doc already rejected (card `ad3a9a85`): swept against this repo it produced
**26 real false positives**, every one a mid-line mention of the literal token `@decision` — this
file's own doc comments describing the convention, and the `ANCHOR_RE`-family regex literal
definitions themselves. `OVERLONG_ANCHOR_ID_RE` instead requires an ACTUAL match of 9+ hex
characters immediately after the keyword (plus optional whitespace / `sha:` sigil) — the reviewer's
argument (card `afc56dcc`) is that this shape has no legitimate population, and the sweep above
tests that argument rather than assuming it.

## Do not

- Do not widen this pattern back toward the broad "`@decision` not followed by a valid id anywhere
  on the line" form — that was already tried (card `ad3a9a85`) and produced 26 false positives on
  this exact repo.
- Do not treat the zero-hit sweep as evidence the pattern is inert or unnecessary — it is a
  positive-controlled zero (the pattern is shown able to fire), meaning the defect shape has not
  happened yet, not that it cannot.

## Source

`packages/daemon/assets/comment-anchor-lint.mjs` — `OVERLONG_ANCHOR_ID_RE` and the `overlongAnchorIds`
check (card `afc56dcc`); the rejected broader form lives in `BROKEN_ANCHOR_RE`'s own doc (card
`ad3a9a85`); the `sha:` sourcing convention that created this authoring mistake is card `969b0e1c`.
