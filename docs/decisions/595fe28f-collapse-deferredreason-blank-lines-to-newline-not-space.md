# 595fe28f — collapse a released deferral's blank-line breaks to `\n`, never to a space

## Narrative

`foldReleasedDeferralIntoBody` collapses `reason`'s BLANK-LINE (paragraph) breaks to a single newline
before folding it into the card body. In practice `deferredReason` is often multi-KB structured markdown
(headings, lists), not the "short string" the field is documented as. Collapsing to a SPACE ran every
section together into one unreadable blob, with headings surviving as literal inline `## text`.

Collapsing to a single `\n` instead keeps every line/heading/section on its own physical line — this
repo's own board (`Board.tsx`'s `TaskDrawer` / `SessionTaskCard`'s `ReadOnlyTaskDrawer`) renders `body`
as plain pre-wrap text with no markdown engine involved, so a real line break is the entire readability
fix; no heading-escaping trick is needed on top of it.

## Do not

- Do not collapse `deferredReason`'s blank-line breaks to a space — a multi-section reason renders as one
  unreadable blob with literal `## heading` markers surviving inline.
- Never collapse to `\n\n` (2+) either — that is exactly what `foldReleasedDeferralIntoBody`'s own
  strip-before-append split keys off of; reintroducing it would fragment the note into multiple
  paragraphs on a later fold and break the function's idempotence guarantee.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`foldReleasedDeferralIntoBody`'s own doc, lines
283-292 as of this tranche's HEAD).
