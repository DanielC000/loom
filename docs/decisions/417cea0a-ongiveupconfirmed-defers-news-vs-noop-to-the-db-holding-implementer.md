# 417cea0a — `onGiveUpConfirmed`: content-match confirmation, `PtyHost` defers "is this news" to the DB-holding implementer

## Narrative

Card 417cea0a (`pty/host.ts`, `PtyHostEvents.onGiveUpConfirmed`): fires when a confirming hook proves, BY CONTENT MATCH, that a give-up-tracked message actually landed — sourced from `purgeConfirmedGiveUpRequeue`'s single-`batchId` CONFIRMED branch, the same signal already logged as "CONFIRMED logicalId=… latencyMs=…", now also exposed to a caller instead of only ever reaching stdout. `logicalId` is the chain's `rootMsgId` (`QueuedMessage.logicalId`'s own doc — stable across every re-mint).

`PtyHost` itself cannot tell whether `logicalId` was ever terminally PARKED (`session_message_gave_up` outcome:"parked") vs. still mid-chain when this confirmation arrived — that needs the DB, which this class deliberately does not hold (mirrors `getCapabilityCatalog`/`getIntegrationPaths`) — so the implementer (`sessions/service.ts`) is the one that decides whether this is news (a previously-parked message, worth a `[loom:redelivery-confirmed]` sender notice) or a no-op (an ordinary mid-chain confirmation).

NEVER fired from the `batchIds.size > 1` branch (see card `bc0774c4`'s own record) — a content match spanning more than one give-up batch is left completely unresolved by design, so a message parked under a colliding signature will NOT produce a confirmed-after-park notice; there is nothing here to attribute the confirmation to.

OPTIONAL, same rationale as `onTurnCompleted` (card `343441bd`, Decision B) — every existing `PtyHostEvents` test double is unaffected until it opts in.

## Do not

- Do not fire `onGiveUpConfirmed` from the `batchIds.size > 1` branch — a colliding-signature match is deliberately left unresolved; there is no single batch to attribute the confirmation to.
- Do not have `PtyHost` itself decide whether a confirmation is "news" — it has no DB access; that decision belongs to the implementer (`sessions/service.ts`).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onGiveUpConfirmed` field doc on `PtyHostEvents`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.
