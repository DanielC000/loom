# 3c205fb5 — a gateway token status change closes the sockets it already opened, not just future requests

## Narrative

`gateway/trust-tier.ts`'s Tier-1 wall checked a presented gateway token only at WS **upgrade**
(`/ws/term`, `/ws/fleet`, `/ws/companion`). The REST admin routes that revoke, pause, rotate, or
delete a token (`gateway/server.ts`'s `/api/gateway-tokens*`) only ever wrote the DB row — they closed
nothing. So a leaked token that the owner revoked kept streaming an agent pty, kept streaming the fleet
feed, and kept accepting owner-attested companion chat on any socket that was already open, until that
socket happened to drop on its own. The doc comments on `Db.rotateGatewayToken`/`updateGatewayToken`
(and `docs/decisions/80e2093f-bindhost-deliberately-accepts-all-interfaces.md`) said the old token "stops
verifying immediately" — true for REST (every request re-verifies), false for an already-open socket
(verified once, at upgrade, never again).

Fix: `gateway/token-sockets.ts`'s `GatewayTokenSocketRegistry` tracks open sockets keyed by the gateway
token id that authenticated them. The trust-tier `onRequest` hook resolves that id (via the new
`deps.identifyGatewayToken`, kept separate from the boolean `verifyGatewayToken` so every existing test
stub keeps building) and stashes it on the request (a `WeakMap<FastifyRequest, string>`); each of the
three WS route handlers reads it and registers the real socket. The four REST writers call
`gatewayTokenSockets.closeAll(tokenId, 1008, reason)` right after their DB write — PAUSED and REVOKED do
(ACTIVE and a name-only edit do not: nothing stale to cut off), ROTATE and DELETE always do (the old
secret is dead either way). A socket closes itself out of the registry on normal close regardless of
cause.

ROTATE decision (card asked explicitly): yes, rotation kills sockets opened under the old secret — the
old secret is dead the instant rotation happens (`Db.rotateGatewayToken`'s own doc), so a socket that
used it has no more authority than a REST request that would now also be rejected.

Loopback/human sessions are never token-authenticated (`identifyGatewayToken` is only consulted for a
request that resolved a token at all), so they never register here and are unaffected.

## Do not

- Do not widen `verifyGatewayToken`'s return shape to carry the token id — every existing test stub
  (`remote-bind.mjs`, `trust-tier.mjs`, `webhook-ingress.mjs`, …) implements it as a plain boolean
  predicate; use the separate `identifyGatewayToken` dep instead.
- Do not register a socket anywhere other than the three WS route handlers — that's the only place the
  real `WebSocket` instance exists; the trust-tier hook only ever has the request.
- Do not skip closing sockets on PAUSE — a paused token is blocked at `authenticateGatewayToken` exactly
  like a revoked one; an already-open socket must go the same way.
- Do not add a dual-accept grace window to the socket-close side to "fix" the breakage rotate/revoke
  cause a live client — that breakage is the deliberate immediate-cutover posture from card `80e2093f`;
  this card only makes it ALSO true of already-open sockets, not less strict.

## Source

New registry: `packages/daemon/src/gateway/token-sockets.ts`. Wiring: `packages/daemon/src/gateway/server.ts`
(`GatewayDeps.identifyGatewayToken`/`gatewayTokenSockets`, the trust-tier hook, the three WS route
handlers, the four `/api/gateway-tokens*` REST writers); `packages/daemon/src/index.ts` (the real
`identifyGatewayToken` wiring). Test: `packages/daemon/test/gateway-token-socket-close.mjs`.

## Fix round: `close()` alone leaves a ~30s non-cooperative-peer window (reviewed tip 13764a04)

Code Review reproduced a Critical: `closeAll` (`token-sockets.ts:46`) called only `socket.close(code,
reason)`. In ws 8.21 that moves the socket to `CLOSING` and waits up to `closeTimeout` (default 30s) for
the peer's own close frame — it does not stop reading. ws's `Receiver` keeps emitting `'message'` while
`CLOSING` (`websocket.js`'s `receiverOnMessage` has no `readyState` check), and none of the three WS
route handlers (`/ws/term`, `/ws/fleet`, `/ws/companion` in `gateway/server.ts`) check `readyState`
before acting on an inbound frame. So a leaked-token client that simply **ignores** the close frame could
keep sending `{type:"chat"}`/`{type:"audio"}`/`{type:"stdin"}`/etc. as owner-attested input for up to 30s
after its token was revoked, paused, rotated or deleted. Reproduced with a raw-TCP client (manual
handshake, ignores incoming frames): 3 post-revoke `/ws/companion` chat frames were processed at
`readyState === 2` (CLOSING) before the fix.

Fix: `closeAll` now calls `socket.terminate()` immediately after `socket.close(code, reason)` — in the
SHARED unit, not per handler, since the defect is generic to any WS route registered in this registry.
`terminate()` destroys the underlying socket synchronously, so there is no window left for the Receiver
to emit further `'message'` events; a non-cooperative peer's connection is gone in the same tick instead
of up to 30s later.

Chose `close()` + `terminate()` over `terminate()`-only (which sends no close frame at all) because a
well-behaved peer should still get the code + reason. Verified, not assumed: a standalone raw-TCP probe
(manual WS handshake, capturing every raw byte with no `ws`-client auto-close-ack that could otherwise
race the TCP teardown) showed the `close(1008, reason)` frame bytes reliably land on the wire before the
connection ends, across 5 runs, when `close()` is immediately followed by `terminate()` — so a
cooperative client still sees the real code/reason, it just can no longer linger past it.

Web reconnect loop (`packages/web/src/components/Terminal.tsx`, `CompanionChat.tsx`,
`FleetSocketProvider.tsx`): none of the three `onclose` handlers read the `CloseEvent`'s `code` at all —
each schedules a reconnect with the same capped exponential backoff (1s, doubling, capped at 10s)
regardless of why the socket closed. A 1008 (token revoked) therefore does not hammer the server (never
tighter than the normal 10s-capped retry), but it also never surfaces "token revoked" to the user — the
pane just shows the generic "[connection lost — reconnecting]"/"reconnecting" state forever. Left as-is
for this round: the task's own trigger ("if it retries tightly, stop reconnecting") doesn't fire. Filed
as a non-blocking UX gap, not fixed here.

Tests: `packages/daemon/test/gateway-token-socket-close.mjs` (cases 11–12, non-cooperative-peer probes
on `/ws/companion` and `/ws/fleet`, both proven RED on 13764a04 before the fix).
