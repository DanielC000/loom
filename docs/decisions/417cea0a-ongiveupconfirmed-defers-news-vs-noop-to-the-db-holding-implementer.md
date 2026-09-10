# 417cea0a — `onGiveUpConfirmed`: content-match confirmation, `PtyHost` defers "is this news" to the DB-holding implementer

## Narrative

Card 417cea0a (`pty/host.ts`, `PtyHostEvents.onGiveUpConfirmed`): fires when a confirming hook proves, BY CONTENT MATCH, that a give-up-tracked message actually landed — sourced from `purgeConfirmedGiveUpRequeue`'s single-`batchId` CONFIRMED branch, the same signal already logged as "CONFIRMED logicalId=… latencyMs=…", now also exposed to a caller instead of only ever reaching stdout. `logicalId` is the chain's `rootMsgId` (`QueuedMessage.logicalId`'s own doc — stable across every re-mint).

`PtyHost` itself cannot tell whether `logicalId` was ever terminally PARKED (`session_message_gave_up` outcome:"parked") vs. still mid-chain when this confirmation arrived — that needs the DB, which this class deliberately does not hold (mirrors `getCapabilityCatalog`/`getIntegrationPaths`) — so the implementer (`sessions/service.ts`) is the one that decides whether this is news (a previously-parked message, worth a `[loom:redelivery-confirmed]` sender notice) or a no-op (an ordinary mid-chain confirmation).

NEVER fired from the `batchIds.size > 1` branch (see card `bc0774c4`'s own record) — a content match spanning more than one give-up batch is left completely unresolved by design, so a message parked under a colliding signature will NOT produce a confirmed-after-park notice; there is nothing here to attribute the confirmation to.

OPTIONAL, same rationale as `onTurnCompleted` (card `343441bd`, Decision B) — every existing `PtyHostEvents` test double is unaffected until it opts in.

Site 2 (`sessions/service.ts`'s `handleGiveUpConfirmed`, the DB-holding implementer this record already defers to): walks the recipient's own event history for a `session_message_gave_up` row rooted at `logicalId` with `outcome:"parked"` — none found is a silent no-op (an ordinary mid-chain confirmation is not every CONFIRMED signal being news); found means append a NEW row of the SAME kind with `outcome:"confirmed-after-park"` (extends the outcome vocabulary rather than minting a new event kind), then best-effort-notify the ORIGINAL sender (`gaveUp.managerSessionId`, the same session `handleGiveUpExhausted` recorded at park time). The single-batch-only scope above is stated in the PARKED notice's own wording too — hedged as "MAY follow up", never "will" — so a colliding-signature message's silence is never misread as proof of non-delivery.

## Do not

- Do not fire `onGiveUpConfirmed` from the `batchIds.size > 1` branch — a colliding-signature match is deliberately left unresolved; there is no single batch to attribute the confirmation to.
- Do not have `PtyHost` itself decide whether a confirmation is "news" — it has no DB access; that decision belongs to the implementer (`sessions/service.ts`).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onGiveUpConfirmed` field doc on `PtyHostEvents`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.

## (unrelated decision, same card id, `sessions/service.ts`) — the `[loom:redelivery-parked]` notice's claims must fit what the sender can actually do

Card 417cea0a also fixed three "comment/notice is a claim" defects in the `[loom:redelivery-parked]` notice text itself (`handleGiveUpExhausted`), found by a read-only Code Reviewer audit (`4474ffb7`) that refuted this card's own v1 hypothesis first:

1. **The prescribed action was impossible for most senders.** The old text unconditionally said "check `<recipient>`'s transcript/state" — but a manager has no cross-project transcript read (a `cross_project_message` audit event exists; nothing reads it) and, more generally, no read at all into a session it doesn't manage. The one real read: sender is a manager and `recipientId` is its own worker — `worker_list`/`worker_status` answers this (`canCheckRecipient`). Every other sender (a peer project's manager via `peer_message` foremost) gets the honest "no read exists" instead of an instruction that dead-ends.
2. **The "safe by construction" resend claim was false in the case it addressed.** The old text said a same-content resend joins "automatically — no duplicate turn," full stop. False two ways: (a) the auto-join match is on the FRAMED text, which embeds the sender's own sessionId — a sender that has since recycled produces different framed text for byte-identical content, so it does NOT join. (b) the join window is `Live.ambiguousDispatches`, and `purgeConfirmedGiveUpRequeue` deletes that entry the instant a confirming hook proves the original landed — so in exactly the case where the resend advice matters least (the original genuinely did land late), a resend sent after that confirmation is no longer recognized as a duplicate and becomes a second, real turn.
3. **"PARKED after `${GIVE_UP_REMINT_LIMIT}` redelivery attempts" rendered as "PARKED after 1 redelivery attempts"** — read literally, that seeds the "the budget is tiny" inference this card's own (refuted) v1 hypothesis made. Replaced with the real, constant-derived effort (`PARK_SUBMIT_CYCLES`'s own doc).

## Do not (2)

- Do not tell a sender to check a read they cannot perform — gate the instruction on `canCheckRecipient` (or an equivalent real-read check), never state it unconditionally.
- Do not claim a same-content resend is unconditionally safe — it depends on the sender not having recycled and the join window not already having purged.

## Source (2)

Inline comments in `packages/daemon/src/sessions/service.ts` (`handleGiveUpExhausted`'s notice-building block), as of main `c461821e`. Relocated by card `1341fcde` (tranche 20 on `sessions/service.ts`).
