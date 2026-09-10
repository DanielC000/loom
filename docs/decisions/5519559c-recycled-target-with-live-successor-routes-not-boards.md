# 5519559c — a not-live message target with a live recycle successor routes there, never boards

## Narrative

`deliverSessionMessage` (`sessions/service.ts`) is the shared cross-project message-delivery mechanic
behind `messageSessionAsPlatform` and `messageSessionAsCompanion`. When the target session is not live,
its recycle lineage is checked for a live successor: if one exists, the message routes to the successor
via the SAME durable stdin-enqueue channel used for a live target, instead of falling back to the
durable-board fallback. The target id was superseded by a recycle, not actually gone — so the message
reaches whoever is doing the work now rather than sitting unread on a board for an identity nobody is
watching anymore. The response's `routedTo` field names the successor so the caller can see the redirect
happened.

This is deliberately distinct from card `2ca18433`'s case: there, a recipient is LIVE at send time and
only recycles AFTER the message has already been queued (durable-record dedup on the restart-intent
path); here, the target is already NOT live at the moment of the send call itself, so the successor
lookup happens synchronously in this same call rather than via a later redrive.

## Do not

- Do not board a message for a not-live target whose recycle lineage has a live successor — route it to
  the successor via the same durable channel instead, so it is never silently missed by a recipient
  nobody is watching anymore.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`deliverSessionMessage`'s own JSDoc), as of
`main` `598130999a62058bb22362decdf17de62f412dae`. Extracted by card `d42c8f40` (tranche 27 on
`sessions/service.ts`).
