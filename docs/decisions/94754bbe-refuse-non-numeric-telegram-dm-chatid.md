# 94754bbe — refuse a non-numeric Telegram chatId on a dm-scope binding, at the write chokepoint

## Context

Code review of card `61e33b99` (reviewer `30b3a81c`) found a gap `isLikelyGroupTelegramChatId` doesn't
close: a dm binding whose Telegram chatId is `"@somechannel"` is never flagged — `Number("@somechannel")`
is `NaN`, so the negative-integer group heuristic never fires — and `telegram.ts`'s `send` passes the
chatId string straight to `bot.api.sendMessage`, which the Bot API happily accepts for a public channel
the bot can post to. A human REST dm-bind (or a provisioned companion) pointed at `"@somechannel"` would
leak heartbeats/reminders/attention-pushes to that channel with no suppression at all.

## Decision

Unlike a negative-integer chatId (a real, structurally-identifiable Telegram group/supergroup id, which
`isLikelyGroupTelegramChatId` continues to only FLAG — the owner may still want to re-bind it as scope
`"group"`), a non-numeric chatId can never be a legitimate dm-scope Telegram route: Telegram's own private
chat ids are always positive integers. So this is a REFUSAL, not a flag — enforced once, at the single
write chokepoint `db.upsertCompanionBinding` (`db.ts`), via a new predicate `isNonNumericTelegramChatId`
(`companion/types.ts`, beside `isLikelyGroupTelegramChatId`): a `dm`-scope write whose `isLikelyGroupTelegramChatId`-adjacent
check finds a non-numeric Telegram chatId throws `InvalidTelegramChatIdError` before anything is written.

Because `upsertCompanionBinding` is already the one chokepoint every `companion_bindings` write goes
through (see `docs/decisions/61e33b99-boot-time-preflag-group-dm-bindings.md` for the enumerated call
sites), this one check covers all of them structurally:

- `packages/daemon/src/gateway/server.ts` — the admin REST `POST /api/companion/bindings` bind/re-bind
  handler now distinguishes `InvalidTelegramChatIdError` from the pre-existing UNIQUE-route conflict and
  returns 400 with the thrown message, instead of folding it into the 409 conflict branch.
- `packages/daemon/src/gateway/server.ts` — the provision endpoint ALSO pre-validates `allowedChatId`
  up front (a new GUARD, alongside its existing pre-spawn guards) so a bad chatId is rejected with 400
  before a session is spawned and then rolled back — the chokepoint throw is still the structural
  backstop if this pre-check is ever bypassed.
- `packages/daemon/src/companion/factory.ts`'s env/token bootstrap seed and `packages/daemon/src/db.ts`'s
  pairing-code `dm-bind` redemption both call the same chokepoint, and BOTH now log a SPECIFIC, actionable
  `console.error` naming the session, the channel, and the remedy before swallowing the error into their
  pre-existing containment — never a totally silent failure, even though both still contain it rather than
  letting it propagate (see "Never silent" below for why each one still has to contain it).
  - `redeemPairingCode`'s dm-bind branch still reduces the REMOTE reply to the same silent `rejected` (no
    pairing oracle — the chat-side behavior must stay indistinguishable from a wrong code), but the catch
    now logs server-side before returning. Pairing redemption's chatId is sourced from Telegram's own
    inbound `message.chat.id` (`telegram.ts`'s `normalizeTelegramMessage`), always a real number stringified
    — so this refusal is structurally unreachable on that path in production; the log exists as defense in
    depth for a future adapter bug, not a case expected to fire today.
  - `createCompanionGateway`'s bootstrap-seed call now catches `InvalidTelegramChatIdError` itself (instead
    of letting it propagate out of the whole function) and logs before continuing — the gateway still
    builds, just without a Telegram BINDING (its chat_reply/inbound route), rather than failing to build at
    all. This is scoped to the BINDING only — a companion's HOME target (heartbeats/reminders/
    attention-pushes) is a separate `app_meta` value with its own writers and is validated/suppressed
    independently (see "Fix round 2" below); don't read "no Telegram binding" as "no Telegram delivery of
    any kind." This is the one REAL, reachable case: an owner's `LOOM_COMPANION_CHAT_ID` (or a config-set
    `allowedChatId`) set to something like `"@me"` hits this path on every boot/reconcile until fixed.

## Fix round 2 — the write-chokepoint refusal alone left the HOME route (and every unbound Telegram target) leaking

Code review of this card's first round found the refusal above never reached the *real* goal: a dm-scope
Telegram **bind** to `"@somechannel"` is refused, but the companion **HOME** route — the proactive target
heartbeats, reminders, and attention-pushes all resolve via `db.getCompanionHome(sessionId)` — is an
`app_meta` value, never a `companion_bindings` row. `ChatGateway.mayDeliverTo` (the one chokepoint every
outbound producer resolves through — `deliverReply`, `tryDeliverVoice`, `sendVia`, `deliverMedia`,
`sendToChannel`) used to read only `bindingForInbound(channel, chatId)?.flaggedNonPrivate !== true` — for an
UNBOUND route, `bindingForInbound` returns `undefined`, so the expression reads `undefined !== true` ⇒
`true` ⇒ "may deliver," with NO look at the chatId's own shape at all. An owner's `LOOM_COMPANION_CHAT_ID`
(or a `PUT /api/companion/home` write) set to `"@chan"` armed a Telegram adapter on `botToken` alone and then
delivered every heartbeat/reminder/attention-push to that public channel — reproduced directly:
`deliverReply` returned `delivered:true` and the fake adapter recorded a real send to `"@chan"`.

**Decision:** move the invariant to the OUTBOUND chokepoint itself, so it covers every target regardless of
whether a binding backs it. `ChatGateway.mayDeliverTo` now:
1. Refuses when the matched binding (if any) is already `flaggedNonPrivate` — unchanged.
2. **Allows unconditionally when the matched binding's `scope` is `"group"`** — an explicit group binding
   legitimately owns a `@handle` or a negative (group/supergroup) id; this must never be second-guessed.
3. Otherwise (no binding at all, OR a `dm`-scope binding) refuses when `isNonNumericTelegramChatId` or
   `isLikelyGroupTelegramChatId` says the target isn't shaped like a private chat.

For an EXISTING `companion_bindings` row this is pure defense in depth — a `dm`-scope row can no longer hold
a non-numeric chatId at all (the write chokepoint refuses it) and a negative one is always flagged fresh on
write (`docs/decisions/61e33b99-boot-time-preflag-group-dm-bindings.md`) — but it is LOAD-BEARING for any
route that was never a binding: home, and (since a reminder/attention-push fire reuses the SAME
`deliverReply` as a heartbeat) every proactive producer that targets it.

**Write-time validation, additionally** (never the real guarantee — the outbound check above is): `home`'s
four writers (the env/config bootstrap seed in `companion/store.ts`, `PUT /api/companion/home`,
`applyHomeIfPresent` inside the `POST`/`PUT /api/companion/config` handlers, and the provision endpoint's
`home` write) and `buildCompanionUpsert`'s `allowedChatId` (the `POST`/`PUT /api/companion/config` twin of
the provision endpoint's pre-existing GUARD 6) now reject a non-numeric Telegram target with an immediate
400, so a human gets setup-time feedback instead of a silently-armed, silently-leaking route. These are
convenience guards, not the security boundary — a value written before this fix, or written by a future
caller that forgets the check, is still caught by the outbound chokepoint above.

## Never silent

A refusal that only shows up as a generic, unspecific error (or as "the companion just didn't arm, with no
further explanation") is nearly as bad as a silent failure — the admin has no way to tell a chatId problem
apart from any other misconfiguration. Both swallowed paths above now log distinctly enough to grep for:
the session id (short form), the channel, that it's a SETUP/bootstrap problem (for the bootstrap path), and
the fix. Before this, the bootstrap-seed path's only visible trace was the companion controller's generic
`"[companion] hot-lifecycle reconcile failed: <message>"` — accurate, but it doesn't say WHICH binding,
WHY, or HOW to fix it, and a reader skimming logs has no reason to treat it differently from any other
transient reconcile hiccup.

## Do not

- Do not widen `isNonNumericTelegramChatId` past `"dm"` scope — a group/channel binding may legitimately
  use Telegram's `@username` form (the Bot API's own addressing for a channel/supergroup handle).
- Do not let this refusal use a different "is this a valid Telegram id" rule than `isLikelyGroupTelegramChatId`'s
  own numeric check — both parse with `Number(chatId)` / `Number.isFinite`.
- Do not drop the provision endpoint's pre-spawn validation and rely on the chokepoint's throw-and-rollback
  alone — the whole point of a pre-spawn guard (matching GUARD 2/4/5 already in that handler) is to avoid
  spawning a session only to tear it down for an input error that was checkable up front.
- Do not let a caller of `upsertCompanionBinding` swallow `InvalidTelegramChatIdError` without first logging
  something specific enough to grep for (the session, the channel, and that it's this refusal) — a silent
  catch here reads to the owner as their companion simply not working, with zero signal pointing at the
  actual misconfigured chat id.
- Do not re-gate `ChatGateway.mayDeliverTo`'s new chatId-shape check on a binding lookup succeeding — the
  whole point is to also catch a route (home, or any future unbound target) that has no `companion_bindings`
  row at all.
- Do not let the write-time 400s (home's writers, `buildCompanionUpsert`'s `allowedChatId`) stand in for the
  outbound chokepoint check — they are convenience-only; `mayDeliverTo` is the actual guarantee.
