# a0735d53 — the `giveUpLineages` content-match release must never be gated on `composerDirtyLenClearedByGen`

Code Review round 5 Minor on card `844ca34e` (see that card's own record, Round 6, for the full saga this
continues). `UserPromptSubmit`'s `giveUpLineages` release loop —
`for (const id of purgeResult.contentMatchedLogicalIds) live.giveUpLineages.delete(id)` — was placed
INSIDE `if (live.composerDirtyLenClearedByGen === live.submitGeneration)` (`packages/daemon/src/pty/host.ts`).
That gate answers a different question (did THIS hook's own generation's clear-prefix land) than the one
the release actually depends on (did `purgeConfirmedGiveUpRequeueCore` just prove a positive content
match). The clean-composer plain-paste branch in `submit()` (`composerDirtyLen === 0` at write time) never
touches `composerDirtyLenClearedByGen` at all, so a lineage whose first-ever write was a clean-composer
paste could content-match during the bounded `GIVE_UP_HOLD` — before any Enter-only redelivery ever ran —
and still have its mark left stuck, because the unrelated gate read `null !== submitGeneration`.

## The fix

Hoist the release loop out of that gate entirely, so it runs unconditionally whenever
`purgeResult.contentMatchedLogicalIds` is non-empty. This is safe because
`purgeConfirmedGiveUpRequeueCore`'s own content-match branch (the one that populates
`contentMatchedLogicalIds`) already acts unconditionally on that same gate for every OTHER consequence of
a content match — it already deletes the `ambiguousDispatches`/`retiredGiveUpSignatures` entry, calls
`clearComposerDirtyOnConfirm(…, decisive: true)` directly, purges duplicate FIFO entries, and fires
`onGiveUpConfirmed`, all before this hook's gated reset block (the `composerDirtyLen`/`composerOwnerLineage`
reset, unrelated to the lineage release) is ever reached. Nesting only the lineage release under that
gate was inherited shape from round 4's own placement, never a deliberate dependency.

## Known pre-existing limitation — FIXED by card 7a64f16b

This limitation (a content match resolving on signature uniqueness alone, with no check on whether the
confirming hook actually belongs to the matched lineage) was carded as `7a64f16b` and fixed there with a
content-ancestry check — see
`docs/decisions/7a64f16b-content-ancestry-for-lone-giveup-signature-match.md` for the mechanism, the real
consequence (a genuine, window-dependent loss, not merely cosmetic), and why a bare generation-number
comparison is NOT a safe substitute for it. This card's own hoist is unaffected either way — it only
changed WHERE the already-proven-by-this-mechanism release runs, never the strength of the proof itself.

## Tests

`pty-giveup-content-match-release-ungated.mjs`:
- (1) THE FIX, probe C shape: a fresh message gives up on a genuinely clean composer, is requeued into the
  hold, and a late wrapped echo arrives DURING the hold (no redelivery has run, so
  `composerDirtyLenClearedByGen` was never stamped for this generation) — the mark is released anyway. RED
  on the pre-hoist code — confirmed via a surgical revert/rebuild/restore of just the hoist hunk (revert,
  clear `tsconfig.tsbuildinfo`, rebuild, observe the assertion fail, restore the hunk byte-identically via
  the same captured patch, rebuild again).
- (2) BOUNDARY: two genuinely distinct give-ups (two logicalIds, two batchIds) sharing byte-identical text
  hit `bc0774c4`'s AMBIGUOUS-decline path — `contentMatchedLogicalIds` comes back empty and NEITHER mark is
  released. This pins the AMBIGUOUS-decline boundary itself; it passes with or without this card's hoist
  (the decline lives entirely in `purgeConfirmedGiveUpRequeueCore`, which this card never touches), and is
  included here for completeness alongside (1), not as evidence the hoist changed this path's behavior.

`pty-giveup-round3-minors.mjs`'s MINOR4b fixture now sends a wrapped echo (the real engine shape) instead
of a bare prompt, matching the discipline every other confirming-hook fixture in this card's lineage uses.

## Do not

- Do not re-gate the `giveUpLineages` release on `composerDirtyLenClearedByGen` (or any other condition
  tied to THIS hook's own generation's clear-prefix landing) — a positive content match from
  `purgeConfirmedGiveUpRequeueCore` is independent proof of delivery and must release unconditionally.
- Do not treat the single-stale-entry coincidental-match gap (see above) as something THIS card fixes, or
  as newly introduced by this hoist — it was a pre-existing property of the content-match mechanism
  itself, fixed separately by card `7a64f16b` (see that record).
