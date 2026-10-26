# 04d9f322 — `extractCommentBlocks` recognizes JSX `{/* ... */}` comments as blocks

Deferred out of card `0c474dda`'s investigation: `extractCommentBlocks` didn't recognize a JSX
`{/* ... */}` comment as a block at all, so a `@decision` anchor sitting inside one was invisible to
every check keyed off block membership (`pointerAnchors`, `overlongAnchorParagraphs`, `embeddedAnchors`,
`splitAnchorParagraphs`, `bareCommitAnchors`), and a long JSX comment with no anchor was invisible to
`unanchoredLongBlocks`. `midSentenceAnchors` was the one exception — it never reads block membership at
all, so it already caught the one known JSX site (`PresetPrompts.tsx:184`) without this fix.

A `{` immediately followed by `/*` can never legitimately be anything but a comment opener in valid
JS/TS/JSX: an object-literal value position can't start with a bare comment token, and a regex literal
can't start with `*`. So this is a widening of the existing "`/*` opens a block" rule — treat a trimmed
`{/*` exactly like a bare `/*` — not a new comment grammar, and closing needs no change at all (the
existing `includes("*/")` check already matches a trailing `*/}` for free).

## Measured impact (investigation, before any edit)

The card's own kickoff hypothesized a "WIDE ripple" — 372 lines across 53 web files (re-measured; the
card's own text said 51) open this way, newly feeding five downstream checks repo-wide. Prototyping the
widening in a scratch copy and running the real, unmodified CLI against the same repo root refuted that:
widening added 372 new comment blocks (proving no existing block merged with a new one — the delta is
exactly the opener-line count) but only **2 new findings total** across the whole repo: one
`unanchoredLongBlocks` site and one `embeddedAnchors` site. Every other downstream check
(`pointerAnchors`, `overlongAnchorParagraphs`, `splitAnchorParagraphs`) measured a zero delta. Of the 6
`@decision` anchors newly pulled into block membership, only 1 tripped a violation; the other 5 —
including the already-known `PresetPrompts.tsx:184` site — passed every grammar check cleanly.

## Do not

- Do not special-case this per check. The widening lives entirely in `extractCommentBlocks`; every
  downstream check inherits it for free, and the measured ripple (above) doesn't justify a per-check
  carve-out.
- Do not widen `extractCommentBlocks` to recognize a `{` with a SPACE before `/*` (e.g. `{ /*`) without
  re-measuring first — this repo's own corpus has zero occurrences of that variant today, so it was
  never exercised by this card's own measurement.
- Do not treat the file's own header doc (the numbered check list) as stale without reading it — the two
  sites that previously said "JSX recognition is deferred, separately" were updated by this same card;
  if either still says that after a later edit, it has regressed.
