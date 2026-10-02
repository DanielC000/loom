# d5e3fa82 — bound websocket payload size and per-socket fleet subscriptions

## Context

Full review lane 3 (`269ea64f`) found two unbounded surfaces behind the `/ws/*` gateway routes:

1. `@fastify/websocket` was registered with no `maxPayload`, so every `/ws/*` route (`/ws/term`,
   `/ws/fleet`, `/ws/companion`) shared ws's library default of 104,857,600 bytes (~100 MiB) — there is no
   per-route override; `@fastify/websocket` passes its `options` object straight into a single
   `new WebSocket.Server(...)` that every route's upgraded socket comes from.
2. `FleetHub.subscribeEvents` (`gateway/fleet-hub.ts`) recorded a `managerId → sinceSeq` entry on a
   per-socket `Map` with no upper bound, so a client could grow that map without limit.

Both matter because `/ws/fleet` accepts a connection with **no credential at all on loopback** — any
co-resident process (not just the web UI) can open it, so an "unbounded until closed" surface there is a
real memory / event-loop DoS, not just a theoretical one.

## Decision

**`WS_MAX_PAYLOAD_BYTES` (`gateway/server.ts`) = 8 MiB**, passed as `maxPayload` into the single
`app.register(websocket, { options: { ... } })` call, so it applies uniformly to every `/ws/*` route.

Sizing rationale: the largest frame a REAL client legitimately sends over one of these sockets is a raw
terminal paste on `/ws/term` — `Terminal.tsx`'s `term.onData` fires once per xterm paste event and sends
the whole pasted text as one `{type:"stdin",data}` frame (the Composer, by contrast, posts over REST and
is already capped by Fastify's own default 1 MiB `bodyLimit` on `POST /api/sessions/:id/input`, since that
route sets no override). 8 MiB gives generous headroom over that 1 MiB REST-side precedent — a pathological
paste's JSON-string-escaping can inflate its wire size several-fold over its raw character count — while
still cutting the library default's exposure by more than 10x.

Exceeding the cap needs no bespoke handling: ws's own `Receiver` rejects an over-budget frame with a clean
`1009` ("Message Too Big") close (verified against `ws@8.21.0`'s `lib/receiver.js`), and
`@fastify/websocket` already attaches a `socket.on("error", ...)` listener to every connection (`index.js`),
so that close can never surface as an uncaught exception / daemon crash.

**`MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET` (`gateway/fleet-hub.ts`) = 128**, enforced in
`FleetHub.subscribeEvents`: a request to subscribe to a manager ID already present just updates its
`sinceSeq` (never grows the map, always allowed); a request for a NEW manager ID once the map is already at
the cap is silently dropped. No real fleet client subscribes to anywhere near 128 managers on one socket
(the client-side `sub:events` producer doesn't even exist yet — see project memory
`ws-delta-push-c4-measured-status-events-unmigrated`), so this only ever bites a socket that is being
abused to grow the map without bound.

Dropping (not closing the socket) on overflow is deliberate: closing would also tear down every OTHER
already-subscribed manager's live event feed on that same connection, which is a worse outcome for a
legitimate client than silently capping further growth.

## Do not

- Do not raise `WS_MAX_PAYLOAD_BYTES` back toward ws's ~100 MiB default — `/ws/fleet` takes no credential
  on loopback, so that reopens the per-connection memory/event-loop DoS for any co-resident process.
- Do not lower `WS_MAX_PAYLOAD_BYTES` below what a real terminal paste needs — it is sized off the actual
  client code path (`Terminal.tsx`'s `term.onData`), not an arbitrary round number.
- Do not add a per-route `maxPayload` override as the "real" fix for a route that needs a different bound
  — `@fastify/websocket`'s single `new WebSocket.Server(...)` makes this a daemon-wide knob; a future
  route needing a smaller bound needs its own in-handler check, not a different library option.
- Do not remove the `MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET` cap, and do not change an overflow into closing
  the socket — that would punish every other manager subscription already live on that connection.
- Do not assume the subscription cap protects against anything other than per-socket map growth — it says
  nothing about how many managers legitimately exist; it exists purely so an adversarial loopback process
  can't make the map grow without bound.
