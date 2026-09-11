# 09e655d5 — a late give-up confirmation correlates against `live.giveUpConfirmQueue`, never `live.submitGeneration`

## Narrative

Card 09e655d5: `requeueGiveUpOrigin` also pushes the failed submit's generation onto `live.giveUpConfirmQueue` — a FIFO — whenever something was actually kept/requeued (a budget-exhausted drop has nothing left to purge later, so it is never pushed for that case). `purgeConfirmedGiveUpRequeue` correlates a late confirming hook against that queue, not against `live.submitGeneration`.

## Do not

- Do not correlate a late give-up confirmation against `live.submitGeneration` — use `live.giveUpConfirmQueue` instead.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`requeueGiveUpOrigin`'s own method doc). Relocated by card `c959773d` (tranche 40 on `pty/host.ts`); condensed, not verbatim.
