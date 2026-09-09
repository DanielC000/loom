# 09d68835 — a first-hand specimen: ~13,300 chars replaced by one sentence, silently, successfully

## Narrative

A manager passed a one-sentence annotation as the FULL replacement `body` on a ~13,300-character card and
silently destroyed it. `body` is documented as a full replace with no undo — that documented behavior is
not what this guard fixes; field-level PATCH semantics are correct as they are. What was missing is
friction in front of the one catastrophic shape: a substantial existing body reduced to a sliver in one
silent, successful write. The card was recovered only because a scratch copy happened to exist.

`MIN_SUBSTANTIAL_BODY_CHARS`/`MAX_SURVIVING_FRACTION` are PROPOSALS (the card's own words), not derived
from any measurement — 1 KB is "large enough that losing it is a real loss", and 25% is "small enough
that no genuine rewrite lands there by accident" (see project memory
`shipping-a-detector-is-not-someone-reading-it`: a blocking precondition on the ACTION is the only remedy
shown to work here — a louder tool description would sit in the attention path and get read past, same as
it did for the manager who filed this card).

The same two thresholds are reused as-is (not a second pair) by the sibling `deferredReason`-truncation
guard (card `a53b24ce`) — one destructive-replace shape, one set of numbers, regardless of which field it
fires on.

## Do not

- Do not treat this guard's thresholds as measured constants — they are deliberately-chosen proposals
  ("large enough to matter" / "small enough no genuine rewrite hits it"), not derived from data. Don't
  cite them as empirically validated.
- Do not add a second pair of thresholds for a sibling truncation guard (e.g. on another field) — reuse
  `MIN_SUBSTANTIAL_BODY_CHARS`/`MAX_SURVIVING_FRACTION` as the one destructive-replace shape.
- Do not rely on a louder tool description instead of a blocking guard for this class of mistake — that
  was tried implicitly (the description already said "full replace, no undo") and a manager still read
  past it.

## Source

Inline comment in `packages/daemon/src/mcp/tasks.ts` (`updateProjectTask`'s destructive-body-truncation
guard, lines 1474-1477 as of this tranche's HEAD).
