# 7772176d — `onKickoffGiveUpExhausted`'s `kickoffText` gives a kickoff the same cross-turn-boundary re-mint an ordinary message gets

## Narrative

Card 7772176d (`pty/host.ts`, `onKickoffGiveUpExhausted`): `kickoffText` (the pristine `live.startupPrompt` the synthetic kickoff origin was built from) is passed through so the implementer can give the kickoff the same cross-turn-boundary re-mint an ordinary durable message gets from `handleGiveUpExhausted` before ever parking — see that method's doc for why park-only, with no retry at all, under-serves a kickoff exactly as it would any other message.

Nothing upstream of `scheduleKickoffGuarantee`'s own closure ever persisted this text anywhere else this handler could read it back from, so it must ride the event.

## Do not

- Do not drop `kickoffText` from `onKickoffGiveUpExhausted` — nothing else persists it, and without it the implementer cannot re-mint the kickoff before parking it the same way an ordinary durable message would be.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onKickoffGiveUpExhausted` field doc on `PtyHostEvents`, third paragraph), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.

## Implementer side: the re-mint mechanics (`sessions/service.ts`, `handleKickoffGiveUpExhausted`)

Below `GIVE_UP_REMINT_LIMIT`, `handleKickoffGiveUpExhausted` re-mints via a fresh, held `enqueueStdin` call (mirrors `handleGiveUpExhausted`'s own `chainDepth`/`GIVE_UP_REMINT_LIMIT` pattern exactly — not a parallel, differently-shaped mechanism); at/above the limit, it falls through to the park+notify path (see `docs/decisions/a8f8a8f2-*.md`).

DOUBLE-DELIVERY protection: the re-mint is dispatched with `logicalId: rootMsgId` — the IDENTICAL key `requeueGiveUpOrigin` (`pty/host.ts`) already seeds into `Live.ambiguousDispatches` for the ORIGINAL kickoff write, UNCONDITIONALLY, even on the exhaustion branch (before the budget check). So if the original write is ever confirmed by a later hook, `purgeConfirmedGiveUpRequeue`'s existing content-match purge (card `4a0af485`) finds and deletes this still-queued re-mint by that shared `logicalId` — the IDENTICAL protection every ordinary `handleGiveUpExhausted` re-mint already relies on, not a new or stronger guarantee invented here. `giveUpHeldUntil` also forces `enqueueStdin`'s HELD branch, so the re-mint can never immediately re-hammer a session just shown wedged (mirrors `handleGiveUpExhausted`'s own `giveUpHeldUntil` reasoning, card `ccb407eb` finding [1] — see `docs/decisions/ccb407eb-session-message-gave-up-event-kind-and-confirmed-after-park.md`). See `kickoff-giveup-remint-purge.mjs` for the actual race proven end-to-end against the real PtyHost purge, not just a SessionService-level stub.

Routed, for the re-mint, through `this.pty.enqueueStdin` directly rather than `enqueueDurableMessage`: the kickoff's synthetic origin was never durable in the first place (no `session_message_queued` row — see `scheduleKickoffGuarantee`'s own doc), and `enqueueDurableMessage`'s `onGiveUpExhausted` is hardwired to the generic `handleGiveUpExhausted` (whose terminal park targets a generic `sender`, not this method's manager-notify shape) — reusing it here would either invent a fake "sender" for a kickoff (which has none) or silently drop the manager-visible notice on the re-mint's own eventual exhaustion. Recursing back into THIS method (with `chainDepth + 1`) keeps the manager-notify terminal behavior intact regardless of how many re-mints preceded it.

## Do not (2)

- Do not dispatch the kickoff re-mint through `enqueueDurableMessage` — its `onGiveUpExhausted` is hardwired to the generic `handleGiveUpExhausted`, which has no manager-notify shape and no real `sender` for a kickoff.
- Do not mint a fresh `logicalId` for the re-mint — reuse `rootMsgId` so the existing content-match purge (card `4a0af485`) can find and delete it if the original write is later confirmed.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s JSDoc: "Card 7772176d — THE FIX" paragraph lines 7359-7360, "DOUBLE-DELIVERY" paragraph lines 7370-7379, and "Routed, for the re-mint" paragraph lines 7381-7388), as of main `afce859a`. Extracted by card `3f99687d` (tranche 21); wording unchanged beyond joining wrapped lines and stripping `*` markers.
