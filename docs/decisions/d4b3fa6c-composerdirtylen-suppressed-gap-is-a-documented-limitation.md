# d4b3fa6c — `composerDirtyLen`'s GIVE-UP SUPPRESSED gap: a documented limitation, deliberately not "fixed"

## Narrative

`composerDirtyLen` (card `3ce3fa39`) is a cumulative count of characters that MAY still be physically sitting in the composer from an earlier `submit()` whose give-up (RECOVERY or SUPPRESSED) or heal-if-stuck clear was never CONFIRMED to have actually landed.

NOT AUTHORITATIVE ALONE — a documented limitation: a GIVE-UP SUPPRESSED mark (`fireEnterAndVerify`'s "engine produced output after the final Enter write" branch) never calls `requeueGiveUpOrigin`, so it seeds neither `ambiguousDispatches`/`giveUpConfirmQueue` nor `composerDirtyLenClearedByGen` — meaning BOTH of this field's clear paths (`clearComposerDirtyOnConfirm` via `purgeConfirmedGiveUpRequeue`, and the `composerDirtyLenClearedByGen === submitGeneration` gate) are structurally UNREACHABLE for a SUPPRESSED-only mark on its own generation. The field then reads stale-nonzero against a GENUINELY EMPTY composer — confirmed twice in production, in two different lifecycle states (idle post-turn; busy mid-first-turn, `turnSeq` still 0) — and clears ONLY once some wholly UNRELATED, LATER `submit()` (a fresh message) issues its own defensive clear-prefix and that gets confirmed. See `pty-giveup-suppressed-composerdirty-sticky.mjs` for the reproduction: the staleness survives BOTH the same generation's own UserPromptSubmit confirm AND its later Stop.

A CANDIDATE FIX (enrolling the SUPPRESSED mark into `ambiguousDispatches`/`giveUpConfirmQueue` the same way, minus the `live.pending` requeue) was evaluated and REJECTED: `healIfStuck`'s own backstop unconditionally calls `requeueGiveUpOrigin` for a still-unconfirmed generation regardless of whether it was already marked dirty (only the dirty-MARK is gated on `composerDirtyMarkedGens`, not the requeue call) — so an already-enrolled SUPPRESSED generation would get double-enrolled into `giveUpConfirmQueue`, corrupting its FIFO-position correlation and risking a LATER, unrelated confirming hook being misattributed to an already-resolved generation.

## Do not

- Do not enroll a GIVE-UP SUPPRESSED mark into `ambiguousDispatches`/`giveUpConfirmQueue` as a fix for this staleness — `healIfStuck`'s unconditional `requeueGiveUpOrigin` call would double-enroll the generation, corrupting the queue's FIFO-position correlation.
- Do not treat a non-zero `composerDirtyLen` read as proof — the safe direction is fail-toward-DIRTY: consumers must treat it as a SUSPICION and call `worker_flush`'s submit-only, write-nothing recheck before trusting it or reaching for a destructive remedy (`worker_recycle`/`worker_stop`).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `composerDirtyLen` field doc), lines 2232-2248 as of this tranche's HEAD (commit `1d2e8e78`). Relocated by card `60cd72ad` (tranche 5 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. The field's own base doc (card `3ce3fa39`) and its consumer-facing fail-toward-DIRTY guard remain inline at the same location — see `worker_list`/`worker_status`/`my_context`'s own tool descriptions and the `/orchestrate` doctrine for the live guard this limitation motivates.
