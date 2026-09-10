# c8660ac7 — Root cause of f91c8634's stuck-turn-1 specimens: the kickoff had no re-mint parity with an ordinary durable message

## Narrative

Card c8660ac7 root-caused — as the actual defect behind card `f91c8634`'s stuck-turn-1 specimens — that an ORDINARY durable message which exhausts `GIVE_UP_REQUEUE_LIMIT` gets a further, cross-turn-boundary RE-MINT from `handleGiveUpExhausted` (below `GIVE_UP_REMINT_LIMIT`) before it ever parks. The turn-1 kickoff (`scheduleKickoffGuarantee`'s synthetic origin) had NO equivalent: it went straight from "one requeue" to "park, no further attempt, ever" — an asymmetry between the kickoff's give-up path and every other durable message's give-up path, not a property of give-up-exhaustion itself.

Fixed by card `7772176d`: `handleKickoffGiveUpExhausted` now gives the kickoff the SAME re-mint step, via its own `chainDepth` (mirrors `handleGiveUpExhausted`'s own `chainDepth`/`GIVE_UP_REMINT_LIMIT` pattern exactly — not a parallel, differently-shaped mechanism).

## Do not

- Do not treat a kickoff's give-up-exhaustion path as symmetric with an ordinary durable message's unless it actually gets the same re-mint step before parking — the asymmetry (one requeue then permanent park, vs. re-mint then park) is exactly what caused card `f91c8634`'s specimens.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s JSDoc, "Card 7772176d — THE FIX" paragraph), lines 7352-7360 as of main `afce859a` (tranche 20 HEAD; unchanged since — introducing commit `cfd718687` "fix(pty): the turn-1 kickoff never gets the re-mint that ordinary messages get"). Extracted by card `3f99687d` (tranche 21); wording unchanged beyond joining wrapped lines and stripping `*` markers.

## Related

- `docs/decisions/f91c8634-reference-discriminator-not-exhaustion-alone.md` — the specimens this card root-caused, and the discriminator that card itself specified.
- `docs/decisions/7772176d-onkickoffgiveupexhausted-kickofftext-enables-cross-turn-re-mint.md` — the field wiring this fix depends on, plus the re-mint's own implementer-side mechanics.
