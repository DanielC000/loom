# ddf08614 — one shared `companionRouteBlockReason` predicate, not a binding-row-exists approximation

## Context

Card 1b0df437's Code Review found the card's motivating case still invisible end-to-end, plus a nitpick and
test gaps — tracked as card ddf08614. Implementing items 1-5 of that review (commit 511e9659) itself got a
delta review (reviewer be7cad57) that found a deeper, shared root cause behind two Majors:

`hasLiveCompanionBinding` (reconcile.ts) only asks "does a binding ROW exist for (session, channel,
chatId)". `ChatGateway.deliveryBlockReason` — the ACTUAL outbound gate — refuses more than that: a
`dm`-scope binding flagged non-private (card 7578dea2), or a negative/non-numeric Telegram id with no
matching `group`-scope binding (card 94754bbe), both have a live binding ROW and both still get refused on
delivery. Three call sites approximated "would delivery be refused" with the row-exists check alone and
silently diverged from the real gate:

- `warnStaleStoredHomes` (store.ts) — the boot-time stale-home backstop — skipped the warning for exactly
  this shape of stored home.
- The reply status's `homeRouteRefused` field (gateway/server.ts) read `false` for it.
- `validateHomeTarget` (gateway/server.ts) — the home write guard — accepted setting it as a home.

Repro: bind a `dm`-scope Telegram binding on a negative chatId (e.g. `-100555`, auto-flagged non-private by
the write chokepoint itself), set it as the session's home. Every proactive turn then silently refuses to
deliver, forever, while the boot warning never fires and the UI never reads the route as refused.

## Decision

Extract `ChatGateway.deliveryBlockReason`'s per-route decision into one pure function,
`companionRouteBlockReason(route, binding)` (reconcile.ts) — same semantics, same order (flagged-non-
private → group-scope exemption → shape refusal → row-exists fallback). `binding` is the one binding row
(if any) that currently backs `route`; the caller resolves it however its own scope demands:

- `ChatGateway.deliveryBlockReason` keeps its existing GLOBAL per-(channel,chatId) lookup
  (`bindingForInbound`) — a route is unique across every session's bindings, so that scope is deliberate,
  not a bug, and is unchanged by this extraction.
- `warnStaleStoredHomes`, `validateHomeTarget`, and the reply status's `homeRouteRefused` all resolve it by
  scanning the ONE session's own `getCompanionBindingsForSession` rows for a channel+chatId match — never a
  global scan (the TRUST NEGATIVE tests already proved per-session scoping is load-bearing: a different
  session's live binding on the same route must never let this session treat it as live).
- The provision endpoint's `home` field gets the same treatment PRE-SPAWN: the only two bindings that call
  can ever write (the always-written in-app route, and the Telegram dm route when a token + chat are given)
  are both already known before the session is minted, so the SAME predicate runs against a synthetically
  resolved planned binding, with no wasted spawn+rollback.

`hasLiveCompanionBinding` stays as a row-exists-only check, deliberately — it is still correct and
sufficient for its one remaining caller, `reconcileCompanionBindingRoutes` (clear a home/reminder whose
route lost its binding row entirely on a binding MUTATION). Widening it to the richer predicate there was
out of scope for this round and would be a separate behavior change (e.g. silently clearing a home the
moment it gets flagged non-private, mid-flight) — not requested by the review.

## Do not

- Do not approximate "would delivery to this route be refused" with a binding-row-exists check
  (`hasLiveCompanionBinding`) anywhere outside `reconcileCompanionBindingRoutes` — that is exactly the gap
  this card closed; every other such question routes through `companionRouteBlockReason`.
- Do not widen `hasLiveCompanionBinding` itself to the richer semantics — it would change
  `reconcileCompanionBindingRoutes`'s behavior (home-clear-on-mutation) in a way this card never reviewed.
- Do not let a caller scoped to one session's own bindings (`warnStaleStoredHomes`, `validateHomeTarget`,
  the reply status, the provision endpoint) resolve `binding` via a global scan — that reopens the TRUST
  NEGATIVE hole (a different session's live binding on the same route being treated as this session's own).
