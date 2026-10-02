# c7d7b43a — binding ownership at the delivery chokepoint, and a runtime non-private flag that survives a same-route re-bind

## Context

From the ddf08614 delta review (reviewer 030f7f60), two pre-existing trust-relevant gaps in the companion
outbound/bindings layer, both defense-in-depth (neither is reachable via today's REST surface alone):

**(A) Binding ownership.** `ChatGateway.deliveryBlockReason` resolves the binding backing a route via
`bindingForInbound` — but `companionRouteBlockReason` never checked that the binding it got back actually
belongs to the session asking to deliver.

**FIX ROUND (a second review, after the first pass below shipped): the first pass's framing was wrong, and
its fix left the one actually-reachable vector OPEN.** It described `bindingForInbound` as a "GLOBAL
per-(channel, chatId) lookup across every session's bindings" and exempted the in-app channel from the new
ownership check entirely. In production `ChatGateway` is never shared — `controller.ts` keys one gateway per
session, and `factory.ts` loads only `cfg.sessionId`'s own bindings — so a resolved binding's `sessionId`
always already equals the requester's; the Telegram-channel check is real defense in depth but structurally
unreachable. The ONE shared adapter is in-app: a single `InAppChannel`, built once at boot, is registered on
EVERY per-session gateway, and in-app has no binding row to check (always "live"). The "exemption" left
exactly this open: session A's turn-origin resolving — by a future bug, bypassing every REST guard — to
`{channel: in-app, chatId: sess-B}` would deliver A's reply into B's chat history and push it live to B's
web client. Reproduced with production-shaped wiring (per-session gateways sharing one `InAppChannel`).

**(B) Runtime flag laundering.** `db.upsertCompanionBinding`'s `ON CONFLICT` recomputed `flagged_non_private`
from chatId SHAPE alone (`isLikelyGroupTelegramChatId`) on every write, discarding whatever the row already
held. The flag can also be set at RUNTIME (`flagCompanionBindingNonPrivate`, from
`warnUnconfirmedDirectInbound`) — independent of shape (a numeric-looking dm chatId can still be a group in
practice). Since the shape recompute ran unconditionally, re-submitting the EXACT SAME (chatId, scope) —
nothing about the route changing — silently cleared a runtime-observed flag, laundering it.

## Decision

**(A)** `companionRouteBlockReason` (reconcile.ts) takes a REQUIRED third parameter, `requestingSessionId`
(`string | undefined` — required so every call site makes an explicit choice, never a silent omission; a
caller with no real session id yet passes `undefined`, with a comment saying why). Given a value: for the
IN-APP channel (no binding to consult — always "live"), it compares `route.chatId` DIRECTLY to
`requestingSessionId` and refuses on a mismatch — the actual ownership check for in-app, not an exemption.
For every other channel, the binding-ownership check is unchanged (refuse when `binding` names a different
session). Either branch runs FIRST, before the flagged-non-private and group-scope checks.

`ChatGateway.deliveryBlockReason` passes its own `sessionId` — the real chokepoint. Every per-session-scoped
caller that HAS one now also passes it (`warnStaleStoredHomes`, `validateHomeTarget`, the reply status) —
a no-op for the non-in-app check, but a real additional guard against an in-app home whose chatId doesn't
match. The provision endpoint's pre-spawn check has no session id yet (minted after this validation) — it
passes `undefined` and instead refuses a `home` naming the in-app channel OUTRIGHT, pre-spawn: no caller can
legitimately know the not-yet-minted id in advance, so an in-app home there is either nonsense or an attempt
to pre-target an EXISTING session's route.

`CompanionRouteBindingLike` gains an optional `sessionId` field so `SessionBinding` and a db-row projection
satisfy it structurally; the narrower per-session store surfaces (`store.ts`'s `CompanionConfigStore`, the
provision endpoint's synthetic binding) don't carry it, so the non-in-app check stays a no-op for them.

Every `deliverReply`/`deliverMedia`/`sendToChannel`/`sendVia` call site threads its own `sessionId` through,
including `sendVia`'s per-chunk recheck and `sendToChannel`'s leading `sessionId` parameter. A
`route-foreign-session` refusal logs a disclosure-safe warning (session id + channel, never chatId) via
`warnForeignSessionRouteRefused`, deduped per (session, channel) per process, ALWAYS ON. `sendToChannel`'s
refusal path now also calls this warn helper (the fix-round nitpick) — every producer logs it identically.

The REST remedy for a flagged-non-private binding (`validateHomeTarget`'s error text, and the web Companion
page's flag hint) now names BOTH real clear paths — an actual scope change to `"group"`, or removing and
re-adding the channel — and says plainly the remove-and-re-add path also drops any home/reminder pinned to
that route; there is no new REST action to clear the flag without one of those two.

**(B)** `db.upsertCompanionBinding` now reads the EXISTING row's `chat_id`, `scope`, and `flagged_non_private`
(not just `created_at`) before writing. When the new write is a SAME-ROUTE re-bind — the existing row's
`chat_id` AND `scope` are IDENTICAL to the incoming write — the new `flagged_non_private` is
`existingFlagged || shapeFlagged` (never just `shapeFlagged`), so a runtime-set flag survives a same-route
re-bind undiminished. When EITHER the chatId or the scope actually changes, `flagged_non_private` is
computed fresh from shape alone, exactly as before — a genuine reconfiguration (a different chat, or an
explicit scope flip to "group") IS the "explicit human action" that clears it; nothing else does.

`validateHomeTarget`'s flagged-non-private error text (gateway/server.ts) is corrected: scope "group" is
still the correct remedy for a binding that is genuinely a shared chat, but the text no longer reads as if
any re-bind clears the flag — re-submitting the identical (chatId, scope) will NOT clear it anymore (closing
the laundering this record describes); only an actual chatId or scope change does.

## Do not

- Do not exempt the in-app channel from the ownership check — that was the fix-round defect this record now
  describes. In-app has no binding to check, so the check IS comparing `route.chatId` to
  `requestingSessionId` directly; there is no shape in which "exempt" is right for in-app.
- Do not pass `undefined` for `requestingSessionId` from a caller that already has its own real session id —
  required precisely so this can't happen silently. A caller with no session id yet (the provision pre-spawn
  check) must say so in a comment, and must separately refuse an in-app home outright rather than letting
  the omitted check wave one through.
- Do not move the `route-foreign-session` check after the flagged-non-private or group-scope checks — a
  foreign session's flagged or group-scope binding must still refuse as "foreign" first.
- Do not describe `bindingForInbound`/`deliveryBlockReason`'s lookup as "global" in new prose — every
  `ChatGateway` is built per-session in production; the real cross-session vector is the shared
  `InAppChannel` adapter, not a global binding lookup.
- Do not recompute `flagged_non_private` from shape alone on a SAME-ROUTE (same chatId + same scope)
  re-bind — only a chatId or scope change may clear a runtime-set flag.
- Do not preserve the old flag when the chatId changes — scope staying "dm" with a different (still
  group-shaped) chatId recomputes fresh from shape (correct: a genuinely different chat deserves a fresh
  judgment); special-casing it to preserve the old flag would re-couple two unrelated chats' history.
