# 2521bf51 — `humanSubmitHeldUntil` closes a race between a human's own Enter and the queue drain

## Narrative

Card `2521bf51`: a human's own Enter-submit never arms `busy` — unlike a programmatic turn (`submit()`'s own synchronous M1 optimistic `busy=true` set), nothing tells Loom a human-typed turn is genuinely in flight until claude's OWN `UserPromptSubmit` hook actually fires, asynchronously, after it has processed the Enter. Draining a queued message on local byte-counting alone (the composer's tracked length hitting 0) would submit the queued turn into a composer claude may still be transitioning out of — the exact race this card fixes: `Live.humanSubmitHeldUntil` is an epoch-ms deadline, set by `writeStdin` instead of draining promptly, until which `drainPending` suppresses a queued turn after a genuine human Enter-submit (`nextRawDraftState`'s `draft.submitted !== null`) is detected.

## Do not

- Do not drain a queued message on local composer byte-counting alone right after a human Enter — the human's turn may not have genuinely started yet (`UserPromptSubmit` hasn't fired), and draining early races it into a composer claude may still be transitioning out of.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `humanSubmitHeldUntil` field doc, `Live` state), as of commit `779f3ce7eccfb6cb3880d285b2016bc0554cc82c`. Extracted by card `6ba35149` (tranche 7 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. The field's own consumer-facing mechanics (the bounded backstop deadline, the `busy`/M1 distinction, and the in-flight-turn exception clause — see `humanSubmitHeldArmedDuringTurn`, card `3ff89cbc`) remain inline at the same location as Class-A guards; this record captures only the race narrative. Card `2521bf51` recurs at several other sites in this file (drain gates, delivery checks, byte-order handling) not covered by this record — each is either a short Class-A reference or a candidate for a future tranche.

## `writeStdin`'s arm condition — ARM ON `draft.submitted !== null` ALONE, never `wasDirty && composerLen===0`

Card `2521bf51`: a human Enter never arms `busy`, so the drain races the turn it just started. A box-free transition in `writeStdin` is EITHER a genuine SUBMIT (`draft.submitted !== null` — an Enter with a non-empty draft) or a CLEAR (Ctrl-C/kill-line/Esc/backspace-to-empty — `draft.submitted === null`).

Card `2521bf51` (code review Major 2): `writeStdin` arms `humanSubmitHeldUntil` on `draft.submitted !== null` alone. `draft.submitted` already requires a non-empty draft (`nextRawDraftState`'s own `text.length > 0` gate), so it can never false-arm — the arming condition and the discriminator are now the same fact.

Gating on `wasDirty` too (the pre-fix condition) was itself the bug: a single chunk like `"abc\r"` accumulates its own draft AND frees the box within the SAME `writeStdin` call, so `wasDirty` (computed from `composerLen` BEFORE this call) reads false even though this is a genuine submit — the whole block used to be skipped, arming nothing, leaving that chunk shape fully unprotected.

A submit starts a real engine turn that Loom has NOT yet been told about — nothing arms `live.busy` on this path (that only happens once claude's own `UserPromptSubmit` hook actually fires, asynchronously, after it has genuinely processed the Enter). Draining here directly (or via the ~10s reconcile tick — see `humanSubmitHeldUntil`'s own doc, above, for why the reconcile tick alone isn't safe either) would write Loom's queued turn into a composer claude may still be transitioning out of — the exact race this card fixes. So `writeStdin` arms the bounded hold instead of draining: it self-clears the instant a confirming hook arrives (`deliverHook`'s `UserPromptSubmit`/`Stop` cases), letting the ordinary Stop-path drain (the M2 window) deliver once the human's own turn genuinely completes — delayed, never lost, even in the backstop-bound case where a hook is lost outright.

### Do not (2)

- Do not gate the arm on `wasDirty && composerLen===0` — a single chunk that both dirties and frees the composer within the same `writeStdin` call reads `wasDirty` false even though it is a genuine submit, leaving it fully unprotected.
- Do not drain a queued message directly from this arm condition instead of setting `humanSubmitHeldUntil` — the human's turn has not yet been confirmed by `UserPromptSubmit`, so draining here races the queued turn into a composer claude may still be transitioning out of.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (`writeStdin`'s arm-condition block, immediately after `live.pendingRawOwnerSubmitAt` is set), as of this tranche's starting HEAD (`main` commit `51425319`). Extracted by card `05058dc8` (tranche 52 on `pty/host.ts`); condensed, not verbatim.
