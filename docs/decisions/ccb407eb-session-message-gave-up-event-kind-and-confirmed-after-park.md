# ccb407eb — `session_message_gave_up`'s three outcomes, and the confirmed-after-park correction

## Narrative

Card ccb407eb (the give-up terminal-branch fix): fires when a message's own IN-SESSION retry budget (`GIVE_UP_REQUEUE_LIMIT`, `pty/host.ts`) was exhausted after repeated GIVE-UP RECOVERY — the pty layer never confirmed the engine actually received it. Deliberately INDEPENDENT of `session_message_delivered`: that marker is stamped optimistically the instant a held message is HANDED to the recipient (`drainPending`, BEFORE give-up detection resolves — see `resolveQueuedMessage`'s doc), so a message that later gives up can already carry a (premature) delivered marker under the SAME `msgId`. `session_message_gave_up` is the correction a reader must consult alongside it, not a replacement for it — don't infer "never dropped" from `session_message_delivered`'s presence alone.

`detail` carries `{ msgId, rootMsgId, chainDepth, outcome: "reminted" | "parked" | "confirmed-after-park", remintedAs? }`. `rootMsgId` is the FIRST msgId in this logical message's chain (self-referential on the first give-up), so every re-mint traces back to one auditable origin instead of a chain of unrelated ids.

- `"reminted"` means a FRESH `session_message_queued` record (`msgId = detail.remintedAs`) was dispatched in its place, budget reset, `chainDepth+1` — never the same retry loop widened. CR follow-up (card ccb407eb, BLOCKING finding [1]): a turn-boundary dispatch, not an immediate re-hammer, is ENFORCED — not just intended — by the re-mint stamping its own `giveUpHeldUntil` (`sessions/service.ts` `handleGiveUpExhausted`), which forces `enqueueStdin`'s HELD branch even though `live.busy` is already false at that instant (the give-up detector clears it BEFORE this fires). Omitting that stamp was a real, shipped bug — see git history for card ccb407eb's Code Review — not a hypothetical.
- `"parked"` means `chainDepth` reached `GIVE_UP_REMINT_LIMIT`: Loom stops writing to this recipient's pty for this message and surfaces it to the sender (a `[loom:redelivery-parked]` notice, durable itself) — never a silent discard, per this project's "fail toward a duplicate, never a loss" principle (card 88f11385).
- `"confirmed-after-park"` (card 417cea0a) is a LATER, separate event (same `rootMsgId`) filed if a confirming hook later content-matches a message whose chain DID reach `"parked"` — `sessions/service.ts`'s `handleGiveUpConfirmed` files it and best-effort notifies the original sender (`[loom:redelivery-confirmed]`). Not filed for every confirmed give-up — only when the chain's own history actually reached `"parked"` first (an ordinary mid-chain reminted-then-confirmed resolution is ubiquitous and not news) — and never filed at all when the confirming content match spans more than one give-up batch (card bc0774c4's batch-provenance guard leaves those entirely unresolved) — so a `"parked"` event with no later `"confirmed-after-park"` is NOT evidence the message never landed.

## Do not

- Do not infer "never dropped" from `session_message_delivered`'s presence alone — that marker is stamped optimistically before give-up detection resolves; consult `session_message_gave_up` alongside it.
- Do not widen `GIVE_UP_REMINT_LIMIT`'s retry loop on a re-mint — each re-mint resets the budget and increments `chainDepth`, it never re-runs the same loop.
- Do not read a `"parked"` event with no later `"confirmed-after-park"` as proof the message never landed — a confirming match spanning more than one give-up batch is left entirely unresolved by design.

## Source

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `session_message_gave_up` case doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
