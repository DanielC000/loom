# 1b0df437 — a companion route refused for `route-unbound` must stay observable, never silent, end to end

## Context

Card 1b0df437 made a `route-unbound` delivery refusal (no live binding backs the target at all — most
often a stale/bad companion HOME) observable instead of completely silent: a disclosure-safe
`console.warn` + a durable `companion_unbound_route_refused` event in `ChatGateway.warnUnboundRouteRefused`
(chat-gateway.ts), fired once per (session, route) per daemon process.

Context: commit 3129552e (this card) landed under the subject "fix(companion): log a refused unbound-route
delivery and stop it resetting the zero-reply alarm" — but it did NOT stop the streak reset; it kept
d3f9b4d2's reset and added the durable event instead (see the UI decision below for why that reset stays
correct). The subject was never corrected before the solo landing, so it misstates its own commit on
mainline; this record is the durable correction.

Its own Code Review (reviewer be7cad57) found the fix still had three gaps, closed in round 2:

1. **UI**: nothing read the new durable event — no web consumer, excluded from activity kinds — while the
   zero-reply alarm (a different, already-surfaced cause) DOES have a chat-panel banner.
2. **Boot backstop shape-only**: `store.ts`'s `warnStaleStoredHomes` only checked whether a stored home
   was SHAPED like a bad Telegram target (non-numeric, or group-shaped without a group binding) — a
   perfectly numeric-shaped home with NO live binding backing it at all got no boot warning.
3. **Disclosure inconsistency**: the runtime warn (chat-gateway.ts) deliberately omits the chatId
   (identifying); the two boot-time `console.error` calls in store.ts printed it via `JSON.stringify`.

## Decision

- **UI**: fold a LIVE-derived `homeRouteRefused` boolean into `CompanionReplyStatus`
  (`buildCompanionReplyStatus`) rather than stopping `onReplyDelivered`'s streak reset for
  `route-unbound` (the other option the Code Review offered). The zero-reply banner's copy ("has stopped
  replying... check its Terminal tab") is written for an UNDIAGNOSED silence and would misdirect an owner
  whose companion is actually fine but mis-homed — exactly the misdirection `deliverReply`'s own comment
  on the streak-reset says this design exists to avoid. A live check (`home != null &&
  companionRouteBlockReason(home, binding) !== undefined` — card ddf08614; originally the narrower
  `hasLiveCompanionBinding`) also self-heals the instant the home is fixed/rebound, and flags the problem
  BEFORE a heartbeat turn is ever wasted on it (earlier than waiting for the durable event, which only
  fires after a real delivery attempt).
- **Boot backstop**: `warnStaleStoredHomes` now runs the same `companionRouteBlockReason` decision
  `deliveryBlockReason` runs (card ddf08614; originally only `hasLiveCompanionBinding`'s narrower row-
  exists check) — a route it reports as deliverable is never warned about, regardless of shape. This also
  subsumes the old shape-only group-scope exemption: a group-"@handle" home backed by a live group binding,
  and a numeric home backed by a live dm binding, are both simply "deliverable" now, with no separate
  scope-aware carve-out needed.
- **Disclosure**: both store.ts boot `console.error` calls were trimmed to omit the chatId, matching the
  runtime warn's posture — `daemon-output.log` is a host-wide shared log, not a private one.

## Do not

- Do not let the zero-reply banner (CompanionChat.tsx) also fire for `route-unbound` — its copy
  misdirects toward "the agent is stuck" instead of "fix the home"; the two causes must stay on separate
  surfaces.
- Do not reintroduce a shape-only check in `warnStaleStoredHomes` — use the same predicate as
  `deliveryBlockReason` (`companionRouteBlockReason`, reconcile.ts, card ddf08614); a second, narrower
  check (shape-only, or row-exists-only) will drift from it again.
- Do not print a companion route's chatId in a boot-time or runtime daemon log — it's identifying content
  on a host-wide shared log. The durable event's own `detail` MAY carry it (a project-scoped durable
  record, not a public log).
