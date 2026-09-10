# 8af2b9bd — a giveUpGen-tagged entry is excluded from same-sender coalescing, always drains alone

## Narrative

`drainPending`'s same-sender coalescing (card eac3464d) excludes any entry carrying `giveUpGen` — a
give-up/re-mint redelivery (framed `[loom:possible-duplicate root:...]`) — both as an extension
candidate via the run's own loop guard, and as a head that can extend a run at all, via the
`head.giveUpGen === undefined` gate.

Card eac3464d's own DoD-0 measured these redeliveries arriving 10-40s AFTER the original attempt
already drained or parked, so nothing is ever actually adjacent to coalesce them with — excluding
them gives up no real coalescing opportunity. Folding them in anyway would only stack a BIGGER write
onto exactly the unconfirmed-write path that produced them in the first place (this defect, 8af2b9bd,
counted alongside cards c23e2869/3ce3fa39 as one of the confirmation-loss family cited by
`AGENT_COALESCE_MAX_COUNT`/`AGENT_COALESCE_MAX_BYTES`'s own doc) — a live, unresolved risk this
exclusion deliberately declines to add exposure to. A giveUpGen-tagged head therefore always drains
alone, byte-identical to pre-eac3464d behavior: this is not a coverage regression, it is the same
drain a giveUpGen entry always got before same-sender coalescing existed.

Regression-guarded (a different file, not this record's own source site) by
`packages/daemon/test/pty-agent-coalesce-giveup-exclusion.mjs`, which proves the exclusion against a
REAL give-up (not a synthesized flag): (1) a giveUpGen-tagged HEAD drains alone even with fresh
same-sender messages queued right behind it; (2) those fresh messages, enqueued while the giveUpGen
entry still occupies the queue, do not reorder onto or around it; (3) once the giveUpGen entry is
gone for good, the fresh messages behind it coalesce normally on the next drain — the exclusion is
scoped to the giveUpGen entry itself, not a general breakage of that sender's coalescing going
forward.

## Do not

- Do not fold a giveUpGen-tagged entry into a same-sender coalesced run, as either an extension
  candidate or an extendable head — it must always drain alone.
- Do not read the "nothing is ever actually adjacent to coalesce with" timing finding as merely an
  optimization footnote — it is *why* this exclusion costs nothing, which is what makes it the
  correct call rather than a tradeoff against throughput.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`drainPending`'s same-sender branch, the
EXCLUDED paragraph), commit `8d4f9a086` (2026-08-28), landed as part of card eac3464d's same-sender
coalescing change. Relocated by card `82444fa7` (tranche 30 on `pty/host.ts`); no wording changed
beyond joining wrapped source lines into flowing paragraphs and stripping `//` comment markers.
