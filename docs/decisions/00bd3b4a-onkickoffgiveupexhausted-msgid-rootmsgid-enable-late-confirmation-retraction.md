# 00bd3b4a — `onKickoffGiveUpExhausted`'s `msgId`/`rootMsgId` let a LATE confirming hook find a durable "parked" record to retract

## Narrative

Card 00bd3b4a (`pty/host.ts`, `onKickoffGiveUpExhausted`): `msgId`/`rootMsgId` are the synthetic kickoff origin's own `id`/`logicalId` (`QueuedMessage.logicalId`'s doc), passed through so the implementer can record the same durable `session_message_gave_up` (outcome:"parked") event every other give-up-exhausted path already records (`handleGiveUpExhausted`'s park branch) — keyed the same way `onGiveUpConfirmed`'s `logicalId` already correlates against.

Without this, a late confirming hook that content-matches this exact `rootMsgId` (`requeueGiveUpOrigin` seeds `Live.ambiguousDispatches` for this message regardless of which branch it took, so a late match fires `onGiveUpConfirmed` even after exhaustion) has no durable "parked" record to retract — `handleGiveUpConfirmed`'s lookup finds nothing and silently no-ops, so the notice this hook already sent can never be corrected.

This was the structural gap card 00bd3b4a's incident exposed: a healthy, 35-turn-deep worker whose kickoff confirmed LATE (per pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`) got a categorical "nothing began at all" notice with no way for Loom to ever say otherwise once the confirmation caught up.

## Do not

- Do not omit `msgId`/`rootMsgId` from `onKickoffGiveUpExhausted` — without a durable "parked" record keyed by them, a late confirming hook can never retract an already-sent "nothing began at all" notice, even once the kickoff is confirmed to have landed.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onKickoffGiveUpExhausted` field doc on `PtyHostEvents`, second paragraph), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.
