# af995d1d — `carryPendingToSuccessor`'s durable re-mint LINKS the old msgId to the new one, so the give-up chain walk can hop it across a recycle

## Narrative

Card af995d1d: the durable-record re-mint loop in `carryPendingToSuccessor` (`sessions/service.ts`) appends a `session_message_gave_up` event (`outcome:"reminted"`) linking the OLD record's msgId to the NEW one it just minted onto the successor — the SAME vocabulary `handleGiveUpExhausted`'s in-session remint already writes, so `resolveDirectiveOutcome`'s chain walk (`mcp/orchestration.ts`, shared by `peer_message_status`/`directive_status`) can hop forward from a msgId a sender is still holding to whatever actually happens to the carried copy on the successor.

BEFORE this fix, a re-mint here started a brand-new, DISCONNECTED msgId with no link back to the one the original caller (`messagePeerManager`/`messageWorker`) returned — so a sender polling the OLD msgId saw `state:"pending"` FOREVER, even once the successor genuinely delivered (and the recipient consumed) the carried copy. The measured incident: a peer letter the recipient confirmed arrived in full and acted on, whose sender-side `peer_message_status` read never converged past `pending` across two reads ~16 minutes apart.

The `flushed` loop (non-durable entries, same method) ALSO resolves the old in-memory entry as `"superseded"` (no `turnSeqAtDelivery`) for the boot-scan/done-guard's sake — that resolution is harmless to this fix: `resolveDirectiveOutcome`'s walk checks `session_message_gave_up` BEFORE it ever falls through to a `session_message_delivered` check, so the new "reminted" link is always found first and the chain hops onward instead of dead-ending on the superseded stamp.

## Do not

- Do not re-mint a carried durable record onto a recycle successor without linking the old msgId to the new one — an unlinked re-mint leaves a sender polling the OLD msgId stuck at "pending" forever, even after genuine delivery.
- Do not worry that the same-method `"superseded"` stamp on the old in-memory entry defeats this link — `resolveDirectiveOutcome` checks `session_message_gave_up` first, before it ever falls through to a `session_message_delivered` check.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`carryPendingToSuccessor`'s method doc), as of main `753e55a754afc0638516f9079ee6c24219d80db8`. Extracted by card `fa831c1c` (tranche 25).
