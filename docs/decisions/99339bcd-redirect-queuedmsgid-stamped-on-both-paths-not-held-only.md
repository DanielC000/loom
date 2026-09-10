# 99339bcd — `deliverRedirect` stamps `queuedMsgId` on BOTH the held and immediate paths, not held-only

## Narrative

`queuedMsgId` is `r.msgId` — minted by `enqueueDurableMessage` and returned unconditionally — and card
`99339bcd` stamps it on the emitted `redirect_worker` event on BOTH the HELD and IMMEDIATE delivery
paths; it was previously held-only.

- **HELD**: links the event to its own sibling `session_message_queued` record (card `02621025`).
  Without this linkage a later staleness check has only `ts` to tell "this redirect's own record" apart
  from "a genuinely different, later redirect" — and this event's `ts` is computed by a separate
  `new Date()` call strictly after `enqueueDurableMessage`'s own, so it is not just possible but typical
  for this event to land at or after its own record's `ts`. Without the explicit id, that self-comparison
  would retire the redirect's own just-queued record as "superseded by itself" — the exact silent-drop
  failure card `02621025` exists to prevent, just relocated to the redirect arm.
- **IMMEDIATE**: no `session_message_queued` record ever exists for this `msgId` (`enqueueDurableMessage`
  only appends one `if (!r.delivered)`), so there is nothing for the id to collide with here — stamping
  it is safe (`staleQueuedMessageReason`'s self-match exclusion, `service.ts` ~3298-3310, only ever
  matches against a real `session_message_queued` event's own `msgId`). What it buys: an
  immediately-delivered redirect's hand-off can still silently give up async (card `04de8bbf`) exactly
  like a held one can, and `session_message_gave_up` is keyed on this `msgId` regardless of whether a
  queued record ever existed — so this is the ONLY way that outcome becomes auditable at all.

`turnSeqAtDelivery` mirrors `messageWorker`'s own immediate-path stamp — `target.turnSeq` was read by the
caller (`redirectWorker`/`redirectSessionAsCompanion`) before this call and nothing between then and here
touches `turn_seq` (`flushPending`/`submit` don't), so it's still current at hand-off. Without this, an
immediate redirect that never gives up would stamp a real `msgId` that `resolveDirectiveOutcome`
(`mcp/orchestration.ts`) can never resolve to "delivered" — the root `msgId`'s delivered-check requires
`turnSeqAtDelivery` on THIS event, and no other event ever stamps one for an immediate redirect
(`resolveQueuedMessage`'s `session_message_delivered` marker only fires via `onDeliver`, never invoked on
the immediate-submit path) — it would misread as "pending" forever instead of "delivered". A populated id
that never resolves is worse than the null id it replaces, so this stamp is not optional.

## Do not

- Do not stamp `queuedMsgId` only on the HELD path — the immediate path needs it too, for
  `session_message_gave_up` auditability (card `04de8bbf`) even though no `session_message_queued`
  record exists there to collide with.
- Do not skip `turnSeqAtDelivery` on the immediate-delivery path — without it, `resolveDirectiveOutcome`
  can never resolve that redirect's outcome to "delivered" and misreads it as "pending" forever.

## Related

- `docs/decisions/02621025-stale-queued-message-retire-is-exception-scoped.md` — the self-match
  exclusion this stamp feeds.
- `docs/investigations/04de8bbf-giveup-confirmation-lag/findings.md` — the give-up discriminator work
  this stamp makes auditable.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `deliverRedirect`'s event-append
call: lines 6825-6850, as of main `fbb3555c`. Relocated by card `1acde858` (tranche 17); wrapped source
lines joined into a flowing paragraph and the `//` comment markers stripped, wording otherwise
unchanged.
