# 00bd3b4a — `onKickoffGiveUpExhausted`'s `msgId`/`rootMsgId` let a LATE confirming hook find a durable "parked" record to retract

## Narrative

Card 00bd3b4a (`pty/host.ts`, `onKickoffGiveUpExhausted`): `msgId`/`rootMsgId` are the synthetic kickoff origin's own `id`/`logicalId` (`QueuedMessage.logicalId`'s doc), passed through so the implementer can record the same durable `session_message_gave_up` (outcome:"parked") event every other give-up-exhausted path already records (`handleGiveUpExhausted`'s park branch) — keyed the same way `onGiveUpConfirmed`'s `logicalId` already correlates against.

Without this, a late confirming hook that content-matches this exact `rootMsgId` (`requeueGiveUpOrigin` seeds `Live.ambiguousDispatches` for this message regardless of which branch it took, so a late match fires `onGiveUpConfirmed` even after exhaustion) has no durable "parked" record to retract — `handleGiveUpConfirmed`'s lookup finds nothing and silently no-ops, so the notice this hook already sent can never be corrected.

This was the structural gap card 00bd3b4a's incident exposed: a healthy, 35-turn-deep worker whose kickoff confirmed LATE (per pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`) got a categorical "nothing began at all" notice with no way for Loom to ever say otherwise once the confirmation caught up.

## Do not

- Do not omit `msgId`/`rootMsgId` from `onKickoffGiveUpExhausted` — without a durable "parked" record keyed by them, a late confirming hook can never retract an already-sent "nothing began at all" notice, even once the kickoff is confirmed to have landed.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onKickoffGiveUpExhausted` field doc on `PtyHostEvents`, second paragraph), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.

## Implementer side: CLOSE THE RETRACTION GAP, fix (2) of card 00bd3b4a's two fixes (`sessions/service.ts`, `handleKickoffGiveUpExhausted`)

For the genuine-exhaustion case, `handleKickoffGiveUpExhausted` records the SAME durable `session_message_gave_up` (`outcome:"parked"`) event `handleGiveUpExhausted`'s own park branch records, keyed to `msgId`/`rootMsgId` (the synthetic origin's own ids — see this file's Narrative above). `requeueGiveUpOrigin` (`pty/host.ts`) seeds `Live.ambiguousDispatches` for this exact `rootMsgId` REGARDLESS of which give-up branch fired, so a later content-matched confirming hook still fires `onGiveUpConfirmed` even after exhaustion — but before this fix, `handleGiveUpConfirmed`'s lookup found no "parked" event to retract and silently no-op'd, leaving this notice's claim permanently uncorrected even once the engine's late confirmation proved it wrong. Recording the event here is what lets that ALREADY-CORRECT retraction machinery (card `417cea0a`) reach the kickoff path too. The re-mint branch (card `7772176d`) records its OWN `outcome:"reminted"` event (mirrors `handleGiveUpExhausted`'s identical vocabulary) — a chain that never reaches park correctly leaves `handleGiveUpConfirmed` nothing to retract, same as an ordinary reminted-then-confirmed chain.

The companion fix (1) DISCRIMINATE before accusing, bundled at the same call site under this same card, is recorded separately at `docs/decisions/f91c8634-reference-discriminator-not-exhaustion-alone.md` (it belongs to the discriminator card `f91c8634` specified, not to this card's own retraction-gap finding).

## Do not (2)

- Do not let the kickoff's park branch skip recording a `session_message_gave_up` (`outcome:"parked"`) event — without it, `417cea0a`'s existing late-confirmation retraction machinery has nothing to find for the kickoff path, and an already-wrong notice stays permanently uncorrected.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s JSDoc, "Card 00bd3b4a — TWO fixes" point (2) "CLOSE THE RETRACTION GAP", lines 7432-7444), as of main `afce859a`. Extracted by card `3f99687d` (tranche 21); wording unchanged beyond joining wrapped lines and stripping `*` markers.
