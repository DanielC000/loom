# 2281009d — `broken-spawn`: a non-null `engineSessionId` alone is not proof a turn ran

## Narrative

`broken-spawn` — `busy` fell to false WITHOUT the worker ever running a turn (the fresh-spawn kickoff race — host.ts's scheduleKickoffGuarantee / the short pre-first-turn healIfStuck window). Two independent proofs feed this, checked in order: `engineSessionId` is captured ONLY on the engine's own SessionStart hook, so `null` is definitive proof not even the kickoff ever started. But `engineSessionId` being SET is NOT proof a turn ran (card 2281009d) — SessionStart can fire while the kickoff sits unsent in the composer forever (card f91c8634's parked-Enter signature), so this ALSO checks the same "did a turn actually start" fact `handleKickoffGiveUpExhausted` uses (`hasFirstTurnStarted` OR a non-empty transcript) before falling through past this branch — keeping both nudge paths agreeing on one fact instead of one keying off session-id presence and the other off turn/transcript state. Either way: a DISTINCT failure, not a "did not report" stall.

## Do not

- Do not treat a non-null `engineSessionId` as proof a turn ran (card 2281009d) — SessionStart can fire while the kickoff sits unsent in the composer forever (card `f91c8634`'s parked-Enter signature).
- Do not let this classifier and `handleKickoffGiveUpExhausted` key off two different facts (one off session-id presence, the other off turn/transcript state) — both must check the SAME `hasFirstTurnStarted` OR non-empty-transcript fact.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`): lines 12750-12759, as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph, the leading list-bullet marker and `*` comment markers stripped. Card `f91c8634` is referenced here as related context (the parked-Enter signature) rather than covered by this record — out of this record's scope.
