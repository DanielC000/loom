# 2d36337e — the paste-recovery notice asks "does something you've done SINCE assume this?", not "have you already acted?"

## Narrative

`buildPasteRecoveryText`'s wording originally asserted the content "was lost ... before you could see it"
— a claim about ENGINE/RECIPIENT VISIBILITY. `detectBarePastePlaceholderTripwire` has no access to that: it
only OBSERVES that the transcript recorded a placeholder in place of the submitted text. Card 4af5aefa (two
live false positives observed by peer managers — see
[[4af5aefa-paste-recovery-age-annotates-never-suppresses]] for the sibling age-disclosure fix from the same
incident) corrected this: evidence is a proxy for the claim, not the claim itself, so the wording was
changed to state only what was observed, and hands the recipient the cheap own-artifact check (a reply
they sent, a memory write, a turn count) instead of asserting something the notice cannot actually see —
the wording became "did you already act on that message?"

Card 2d36337e found that framing still had a discriminating-question gap: a real near-miss showed a
recipient can truthfully answer "yes, I acted" about a LATER message that built on this one's content,
while never having seen THIS message at all. "Have I acted?" and "does something I've done SINCE assume
this?" are different questions; only the second one catches a missed premise instead of reading a
recovered predecessor as a redundant repeat. The wording now asks the second one.

## Do not

- Do not word the notice as a claim about whether the content reached/was seen by the recipient — the
  detector only observes a placeholder in the transcript, never actual recipient visibility.
- Do not ask "have you already acted on this?" alone — a recipient can truthfully say yes about a LATER
  message that built on this one's content while never having seen this one; ask whether anything done
  SINCE assumes this content instead.

## Source

Inline comment in `packages/daemon/src/orchestration/paste-tripwire.ts` (`buildPasteRecoveryText`'s
function doc). Relocated by card 26afc9eb (tranche 1 on `orchestration/paste-tripwire.ts`); no wording
changed beyond compressing wrapped source lines into flowing paragraphs and stripping `/** */`/`*` comment
markers.
