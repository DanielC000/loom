# `/vault/raw` HEAD must stay an explicit `app.head()` that never opens a read stream

Card `3c783791`, from the `f7525818` review (reviewer `a38c453a`). Anchored from
`packages/daemon/src/gateway/server.ts` (the raw route).

## The bug this prevents from reopening

Fastify 5.8.5 auto-exposes a HEAD sibling for every `app.get()` route unless a HEAD handler for that
exact path is already registered in the router at the time the GET route is added
(`shouldExposeHead && isGetRoute && !isHeadRoute && !hasHEADHandler` in fastify's `lib/route.js`). When
Fastify generates that sibling itself, it appends `headRouteOnSendHandler` (`lib/head-route.js`) to the
route's `onSend` chain. For a stream payload, that handler calls `payload.resume()` to drain and discard
it before suppressing the body — so a route that unconditionally does
`reply.send(fs.createReadStream(...))` has its **entire file read from disk on every HEAD request**, up
to `VAULT_RAW_MAX_BYTES` (50 MB), only to throw the bytes away. Since card `f7525818` made this HEAD
remote-reachable (Tier-1, token required), any token holder could trigger that read on demand.

## Do not remove the explicit `app.head()` registration, or reorder it after `app.get()`

The fix is to register `app.head("/api/projects/:id/vault/raw", ...)` **before** `app.get()` for the
same path, with a handler that never calls `fs.createReadStream` — it builds the identical headers via
the shared `resolveVaultRawHeaders` helper and calls `reply.send()` with no payload.

Registration order is load-bearing: Fastify only skips auto-generating the HEAD sibling (and therefore
only skips attaching `headRouteOnSendHandler`) when `router.findRoute('HEAD', ...)` already resolves at
the moment the GET route is registered. Registering `app.head()` after `app.get()` would be too late —
Fastify would already have auto-generated its own HEAD route by then, and the explicit registration
would throw on a duplicate route.

## Do not replace `reply.send()` with `reply.send(Buffer.alloc(0))` or similar

Fastify's low-level send (`lib/reply.js`, around the `payload === undefined || payload === null` branch)
special-cases this: it only zeroes a previously-set `Content-Length` header when `req.method !== "HEAD"`.
Calling `reply.send()` with a genuinely `undefined` payload on a HEAD request is what keeps our
manually-set `Content-Length` (and the other headers from `resolveVaultRawHeaders`) intact. Any payload
other than `undefined`/`null` (an empty buffer, an empty stream) gets its `Content-Length` recomputed
from the real payload size — zero — which would silently desync HEAD's headers from GET's.

## Verification

`packages/daemon/test/vault-raw-head.mjs` asserts, via a spy on `fs.createReadStream` and `fs.open`,
that no read stream or file descriptor is ever opened for a HEAD request to this route, that HEAD's
response headers are byte-identical to GET's across several content types (including the
`application/pdf` CSP carve-out and the `image/svg+xml` sandboxed/attachment case), and that HEAD and GET
agree on status for a missing file (404) and an oversized file (413).
