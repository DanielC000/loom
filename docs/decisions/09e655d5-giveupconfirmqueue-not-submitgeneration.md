# 09e655d5 — a late give-up confirmation correlates against `live.giveUpConfirmQueue`, never `live.submitGeneration`

## Narrative

Card 09e655d5: `requeueGiveUpOrigin` also pushes the failed submit's generation onto `live.giveUpConfirmQueue` — a FIFO — whenever something was actually kept/requeued (a budget-exhausted drop has nothing left to purge later, so it is never pushed for that case). `purgeConfirmedGiveUpRequeue` correlates a late confirming hook against that queue, not against `live.submitGeneration`.

## Do not

- Do not correlate a late give-up confirmation against `live.submitGeneration` — use `live.giveUpConfirmQueue` instead.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`requeueGiveUpOrigin`'s own method doc). Relocated by card `c959773d` (tranche 40 on `pty/host.ts`); condensed, not verbatim.

## Correlating against the FIFO front — the misattribution this card fixed

Card 09e655d5 (fixing a gap in the 441499ee safety net): a hook carries NO generation of its own, so WHICH generation it confirms has to be derived. The original approach compared a requeued entry's `giveUpGen` against the CURRENT `live.submitGeneration` — correct only until a SECOND generation has ALSO given up (and so ALSO advanced `submitGeneration`) before the FIRST generation's late hook arrives: that hook would misattribute to the CURRENT (second) generation and purge the WRONG requeued entry, leaving the actually-redundant one to double-deliver.

THE FIX: `live.giveUpConfirmQueue` (pushed in `requeueGiveUpOrigin`) tracks every generation that gave up and is still awaiting a possible late confirmation, OLDEST first. A hook always correlates against the QUEUE FRONT, never the live generation — the front is reliably the oldest still-ambiguous generation because real turns run serially through the one pty stream, so confirming hooks resolve in the same order their generations were submitted (a second generation's Enter can only actually reach the engine after the first's turn — if it was a false negative — has finished running). `UserPromptSubmit` purges the front's matching entry but does NOT advance the queue: it fires first for a real turn, and leaving the front unchanged means a still-outstanding `Stop` for that SAME turn is a safe no-op instead of misattributing to whatever generation is next in the queue. Only `Stop`/`StopFailure` — the definitive, one-per-real-turn end signal — advances past the front, purging FIRST (covering the case where `UserPromptSubmit` was itself lost, per this file's "either hook is definitive" convention).

## Do not (2)

- Do not correlate a late confirming hook against `live.submitGeneration` directly, and do not let `UserPromptSubmit` advance the queue past the front — only `Stop`/`StopFailure` may do that.

## Source (2)

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`purgeConfirmedGiveUpRequeue`'s own method doc, the paragraph explaining this card). Extracted by card `1c218980` (tranche 43 on `pty/host.ts`); condensed and reworded, not verbatim.
