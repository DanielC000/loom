# 2521bf51 — `humanSubmitHeldUntil` closes a race between a human's own Enter and the queue drain

## Narrative

Card `2521bf51`: a human's own Enter-submit never arms `busy` — unlike a programmatic turn (`submit()`'s own synchronous M1 optimistic `busy=true` set), nothing tells Loom a human-typed turn is genuinely in flight until claude's OWN `UserPromptSubmit` hook actually fires, asynchronously, after it has processed the Enter. Draining a queued message on local byte-counting alone (the composer's tracked length hitting 0) would submit the queued turn into a composer claude may still be transitioning out of — the exact race this card fixes: `Live.humanSubmitHeldUntil` is an epoch-ms deadline, set by `writeStdin` instead of draining promptly, until which `drainPending` suppresses a queued turn after a genuine human Enter-submit (`nextRawDraftState`'s `draft.submitted !== null`) is detected.

## Do not

- Do not drain a queued message on local composer byte-counting alone right after a human Enter — the human's turn may not have genuinely started yet (`UserPromptSubmit` hasn't fired), and draining early races it into a composer claude may still be transitioning out of.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `humanSubmitHeldUntil` field doc, `Live` state), as of commit `779f3ce7eccfb6cb3880d285b2016bc0554cc82c`. Extracted by card `6ba35149` (tranche 7 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. The field's own consumer-facing mechanics (the bounded backstop deadline, the `busy`/M1 distinction, and the in-flight-turn exception clause — see `humanSubmitHeldArmedDuringTurn`, card `3ff89cbc`) remain inline at the same location as Class-A guards; this record captures only the race narrative. Card `2521bf51` recurs at several other sites in this file (drain gates, delivery checks, byte-order handling) not covered by this record — each is either a short Class-A reference or a candidate for a future tranche.
