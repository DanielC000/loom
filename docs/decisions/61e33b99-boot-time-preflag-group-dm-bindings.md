# 61e33b99 — a dm-scope Telegram binding with a negative chatId can never go unflagged, at bind time or at boot

## Context

Commit 4836cf6c (card 7578dea2) suppresses companion outbound pushes (heartbeats, reminders, attention
pushes) to a `dm`-scope binding once `companion_bindings.flagged_non_private` is set, via
`db.flagCompanionBindingNonPrivate`. But that flag was only ever set reactively, inside
`warnUnconfirmedDirectInbound` (`chat-gateway.ts`) — triggered by an actual INBOUND message the channel
does not confirm as private. A misbound GROUP whose members never message the bot never sends such an
inbound, so it was never flagged, and outbound kept flowing to it indefinitely.

### Round 1 (boot-time only) — left a fail-open window

The first fix persisted the flag at BOOT: `factory.ts`'s boot-time check (`warnLikelyGroupDmBindings`,
previously log-only) was changed to actually call `db.flagCompanionBindingNonPrivate` for a `dm`-scope
Telegram binding whose chatId parses as a negative integer. This closed the "never flagged at all" gap but
left a NEW one, caught at review: `db.upsertCompanionBinding`'s `ON CONFLICT` path unconditionally RESET
`flagged_non_private` to 0 on every bind/re-bind (the DoD's own stated remedy for a FLAGGED route). That
same unconditional reset also fired for a re-bind that did NOT fix the misconfiguration — e.g. a dm-scope
re-bind to the SAME (or another) negative Telegram chatId — clearing the flag immediately and leaving
outbound open until the NEXT gateway rebuild (boot/restart), a live fail-open window.

## Decision

ONE shared predicate, `isLikelyGroupTelegramChatId(channel, chatId)` (`companion/types.ts`, beside the
existing `isConfirmedDirectChat`), applied at BOTH call sites so they can never diverge:

- **The bind chokepoint**: `db.upsertCompanionBinding` (`db.ts`) now computes `flagged_non_private` FRESH
  from this predicate on EVERY write — both the INSERT and the `ON CONFLICT` update — instead of
  unconditionally writing 0. A `dm`-scope bind or re-bind whose Telegram chatId is negative persists
  `flagged_non_private = 1` in the SAME write, synchronously, before the caller ever sees the result.
- **Boot**: `factory.ts`'s `preFlagLikelyGroupDmBindings` (renamed from `warnLikelyGroupDmBindings`) uses
  the SAME predicate, as a BACKSTOP for a row written by an OLDER daemon build that predates this fix and
  has never been re-bound since. It also mutates the in-memory `CompanionBinding` before `toSessionBinding`
  maps it, so a fresh gateway's routing map sees it flagged from construction.

`upsertCompanionBinding` is THE single write chokepoint for every `companion_bindings` row in the daemon —
every caller that mutates a binding routes through it, so fixing it here fixes all of them in one place:

- `packages/daemon/src/db.ts:3738` — pairing-code `dm-bind` redemption (`redeemPairingCode`).
- `packages/daemon/src/companion/factory.ts:121` — the env/token bootstrap seed (a session with no
  bindings yet).
- `packages/daemon/src/gateway/server.ts:1399` — the admin REST `POST /api/companion/bindings` bind/re-bind
  handler.
- `packages/daemon/src/gateway/server.ts:1876` and `:1878` — the provision endpoint's in-app + external-
  channel binding seeds.

The one LIVE in-memory sync point, `ChatGateway.bind` (`chat-gateway.ts`), is not a write path itself — it
just stores whatever `SessionBinding` it's handed. Both of its callers (`gateway/server.ts:1407`'s REST
live-sync, and `chat-gateway.ts`'s own `handleInbound` after a pairing redemption) pass through the
ALREADY-correctly-computed `flaggedNonPrivate` from `upsertCompanionBinding`'s return value, so no change
was needed there — it inherits correctness automatically.

A negative Telegram chat id cannot be a private chat (Telegram's id scheme), so this can never suppress a
genuine DM — it is fail-closed with no false-positive risk on the one adapter it covers.

## Scope: Telegram only

The predicate is scoped to Telegram because Telegram's id scheme structurally distinguishes a group
(negative id) from a private chat (positive id). No other adapter in this codebase has an equivalent
structural signal. Do not widen this to another adapter without first confirming it has the same
guarantee — guessing would reintroduce exactly the kind of unproven heuristic this check is designed to
avoid everywhere else. `isLikelyGroupTelegramChatId` duplicates the `"telegram"` channel literal rather
than importing `TELEGRAM_CHANNEL` from `telegram.ts`, because that module pulls in the grammY bot client —
a dependency `companion/types.ts` (imported by the low-level `db.ts`) must never transitively carry.

## Remedy

A genuine fix — re-bind with scope `"group"`, or a real positive chatId — still clears the flag in the
SAME write, computed by the SAME predicate; this is unchanged and needed no new code. What's gone is the
window where a re-bind that does NOT fix the misconfiguration (same scope, same or another negative
chatId) could clear the flag regardless.

## Do not

- Do not let this gate INBOUND authorization. It is still only a heuristic for that purpose — the real
  security check is `isConfirmedDirectChat` at inbound authorization time (`auth.ts`), which requires the
  inbound's own `chatIsDirect` regardless of what this check finds. A positive-looking chatId proves
  nothing either way, and Telegram could change its id scheme.
- Do not widen this check to a non-Telegram adapter without first confirming that adapter's id scheme
  structurally distinguishes a group from a private chat, the same way Telegram's does.
- Do not let `db.upsertCompanionBinding`'s write-time computation and `factory.ts`'s boot-time backstop use
  a different predicate — both must call the one shared `isLikelyGroupTelegramChatId` in `companion/types.ts`.
- Do not add a new `companion_bindings` write path that bypasses `db.upsertCompanionBinding` — it is the
  one chokepoint this fix (and any future one shaped like it) depends on covering every write.
