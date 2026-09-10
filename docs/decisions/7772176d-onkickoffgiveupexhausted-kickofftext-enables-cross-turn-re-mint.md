# 7772176d — `onKickoffGiveUpExhausted`'s `kickoffText` gives a kickoff the same cross-turn-boundary re-mint an ordinary message gets

## Narrative

Card 7772176d (`pty/host.ts`, `onKickoffGiveUpExhausted`): `kickoffText` (the pristine `live.startupPrompt` the synthetic kickoff origin was built from) is passed through so the implementer can give the kickoff the same cross-turn-boundary re-mint an ordinary durable message gets from `handleGiveUpExhausted` before ever parking — see that method's doc for why park-only, with no retry at all, under-serves a kickoff exactly as it would any other message.

Nothing upstream of `scheduleKickoffGuarantee`'s own closure ever persisted this text anywhere else this handler could read it back from, so it must ride the event.

## Do not

- Do not drop `kickoffText` from `onKickoffGiveUpExhausted` — nothing else persists it, and without it the implementer cannot re-mint the kickoff before parking it the same way an ordinary durable message would be.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onKickoffGiveUpExhausted` field doc on `PtyHostEvents`, third paragraph), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.
