# b4f124d8 — dm-scope authorization requires a CONFIRMED-private inbound, not just a route match

## Context

Card db49891d closed the WRITE side of this hole: `pairing.ts`'s `dm-bind` redemption gate refuses to
mint a new `dm`-scope binding unless the inbound's `chatIsDirect` is explicitly `true`. That left the
READ side open — `auth.ts`'s `isSenderAuthorized` authorized ANY inbound on a `dm`-scope binding's route
match alone, with no check on `chatIsDirect` at all.

That's exploitable for any `dm`-scope binding that predates the write-side fix, or that was hand-bound by
a human via the REST admin surface (`POST /api/companion/bindings`), the provision endpoint, or the env
bootstrap path (`factory.ts`) — none of those paths are gated by `chatIsDirect`, and a human can bind a
Telegram group/supergroup chatId as `dm` scope by mistake (nothing in the UI/REST layer distinguishes a
group id from a private id). Once such a binding exists, EVERY member of that group could drive the
companion session as if they were its single owner — full tool access, including a companion's
board/git/memory levers.

## Decision

`CompanionAuth.isSenderAuthorized` (`auth.ts`) now takes the inbound's own `chatIsDirect` as a third
argument, and a `dm`-scope binding authorizes ONLY when `isConfirmedDirectChat(chatIsDirect)` is true —
the SAME predicate `pairing.ts`'s `dm-bind` gate already used (previously duplicated as an inline
`a.chatIsDirect !== true` check there; now both call the one shared function in `types.ts`).

`isConfirmedDirectChat` requires an explicit `true`. Both `false` (the channel confirms a
group/supergroup/channel) and `undefined` (the channel didn't report chat type — a malformed Telegram
update, or a channel that structurally can't report it) fail CLOSED.

## Why `undefined` fails closed too, not just `false`

The two real channels in this codebase today are Telegram and in-app. In-app's `normalizeInAppMessage`
always sets `chatIsDirect: true` (the loopback cockpit is structurally single-owner) and can never
produce `undefined`. Telegram's normalizer produces `undefined` only for a malformed/missing
`chat.type` (never expected from the real Bot API, but not impossible to construct). So in this
codebase, "fail closed for `undefined`" and "fail closed for Telegram when it can't confirm chat type"
are the same rule — and keeping it fail-closed for both matches the ALREADY-SHIPPED write-side rule
(pairing.ts / card db49891d), so the read side and the write side can never silently diverge on what
counts as "confirmed direct."

## Do not

- Do not authorize a `dm`-scope binding on route match alone — `isConfirmedDirectChat(chatIsDirect)` must
  be consulted for every inbound, not just at bind time.
- Do not let `auth.ts`'s dm-scope check and `pairing.ts`'s dm-bind mint check diverge on what counts as
  "confirmed direct" — both must call the one shared `isConfirmedDirectChat` predicate in `types.ts`.
- Do not treat a positive-looking heuristic (e.g. a Telegram chatId's sign) as a substitute for
  `chatIsDirect` — `factory.ts`'s boot-time negative-chatId check (`preFlagLikelyGroupDmBindings`, card
  61e33b99) now pre-flags such a binding for OUTBOUND suppression, but it remains heuristic-only for
  authorization and must never gate it; see `docs/decisions/61e33b99-boot-time-preflag-group-dm-bindings.md`.
