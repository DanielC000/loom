# 2c58bdd3 — `detectBarePastePlaceholderTripwire`'s `gen` discriminator matches the WHOLE token, never magnitude alone

## Narrative

Investigation `773b3914` (see [[773b3914-recovery-collapse]]) traced 3 of 4 "RECOVERY re-injection ALSO
collapsed" escalations — and, structurally, the 4th — to a false-positive shape `detectBarePastePlaceholderTripwire`
had no guard against: concurrent traffic on a session (a peer/manager message, or Loom's own
`[loom:prompt-mismatch]` diagnostic, landing near the same moment) can leave a placeholder-shaped token —
from an EARLIER, already-delivered generation's own collapse — sitting in the recorded text of a LATER,
unrelated, correctly-delivered turn. That token is CLI-side re-render noise, not a loss of THIS turn's
content; the tripwire's existing condition (3) can't tell it apart from a genuine fresh collapse, because
it only compares against `submittedText` (this SAME turn's own write), never against what a PRIOR turn's
own recorded text already contained.

Card 2c58bdd3 closed that gap with a fourth condition: the placeholder token must not already have been
observed, verbatim, in an OLDER generation's own recorded turn (`Live.recentPlaceholderTokens`).

This is the exact same STRUCTURE the sibling detector `detectPastePlaceholderLengthLoss` was already
hardened against via its own `gen` discriminator (card `abeac33a` — see
[[abeac33a-gen-discriminator-explains-current-and-older-gen-matches]]): a bounded, `gen`-ordered history a
later turn's placeholder can be "explained" against. But it's a DELIBERATELY DIFFERENT KEY.
`abeac33a`'s sibling matches on the placeholder's STATED LINE COUNT against Loom's own WRITE history —
reasonable there, because it's comparing a placeholder's claimed magnitude against what Loom is
independently certain it wrote. Reusing that same magnitude match here would over-suppress: two UNRELATED
genuine collapses (or an unrelated full resolve and a real collapse — see the regression this card's own
test suite caught, PART 2 test (b)/(c), both submitting `longPaste`) routinely share the same line count
by pure coincidence, especially at the SMALL end (`+3 lines` is common) — exactly the magnitude band
`abeac33a` itself flagged as "where a real defect would live." A magnitude collision would silently
swallow a genuine, independent loss, which is exactly the narrowing-into-blindness this card's own DoD-3
forbids.

The CLI's own placeholder id (`#N`) has no such collision risk: it is assigned once per collapse event and
never reused within a session (a real transcript specimen ran `#1`...`#91` monotonically) — two DIFFERENT
collapses can never share BOTH the same `#N` and `+M`, so an EXACT token match can only mean "this literal
artifact was already seen," never "two different losses happened to be the same size." Matching on the
whole token (id + count together), rather than the count alone, is what makes this guard collision-safe
where the sibling's magnitude match is not.

Same asymmetry as the sibling regardless of key choice: a match at the CURRENT gen must NOT suppress —
`detectPastePlaceholderLengthLoss` explicitly defers current-gen collapses to `detectBarePastePlaceholderTripwire`;
that function IS the current-gen detector and must not defer to itself. Only a token seen at a generation
STRICTLY OLDER than `currentGen` counts as "already observed."

`Live.recentPlaceholderTokens` is populated UNCONDITIONALLY, regardless of whether
`detectBarePastePlaceholderTripwire` itself fired for this turn — even a token this same check already
ruled benign (its own guard (1)/(3), the submitted-text/embedded-match conditions) is still direct evidence
the literal placeholder string existed in the transcript at this `gen`, which is exactly the fact a LATER
turn's own stale CLI-side re-render needs explained. Recording only on a positive detection would leave
every benign occurrence unrecorded, reopening the same false-positive gap for the very re-render this
history exists to catch.

## Do not

- Do not reuse the sibling `abeac33a` discriminator's magnitude-only (`+M lines`) match here — two
  unrelated genuine collapses routinely share the same small line count, which would silently swallow an
  independent loss.
- Do not let a CURRENT-gen match count as "already observed" — that would make this function defer to
  itself instead of owning the current-gen case.

## Source

Inline comment in `packages/daemon/src/orchestration/paste-tripwire.ts`
(`detectBarePastePlaceholderTripwire`'s condition-(4) rationale). Relocated by card 26afc9eb (tranche 1 on
`orchestration/paste-tripwire.ts`); no wording changed beyond compressing wrapped source lines into flowing
paragraphs and stripping `/** */`/`*` comment markers.
