# 0045a8cb — one `isWellFormedLoopbackToken` predicate for both the store and the socket paths

From CR `74471968` (card `a1ec70a6`), verify item 6. `storeVerifiedLoopbackToken` proves a candidate
secret over an HTTP `Authorization: Bearer <token>` header, which accepts characters a WebSocket
subprotocol list element cannot (RFC 7230 §3.2.6 `token` chars only). Card `e4459829` round 2 separately
made `socketAuth` (`gatewayCredential.ts`) treat a non-token-safe loopback secret as ABSENT rather than
let `new WebSocket(url, protocols)` throw synchronously on it.

Before this card, those two facts were checked by two independently hand-written rules in two files: the
HTTP verify path had no shape check at all, and `socketAuth`'s own `SUBPROTOCOL_TOKEN_RE` existed only to
serve the WS path. A candidate could therefore VERIFY (the HTTP probe doesn't care about its shape) and
get STORED, and only later be silently dropped by `socketAuth`'s own separate check — at which point
`isCredentialSocketFailure` (keyed on `token === null`) would read the resulting refused handshake as
"this browser holds no token at all" and misreport the lock reason. The real secret
(`getOrCreateLoopbackSecret`, daemon-side) is always hex, so this was never a live bug — but the two
checks disagreeing was exactly the kind of asymmetry the project has been bitten by before (see
`a1ec70a6`), so it's fixed as a consistency matter rather than waiting for it to become a real one.

## What ships

One predicate, `isWellFormedLoopbackToken`, defined once in `loopbackCredential.ts` (the module that
already owns every other loopback-secret invariant). Two call sites, no third hand-written copy:

- `storeVerifiedLoopbackToken` refuses a malformed candidate immediately, before the round-trip to the
  daemon — there is nothing to gain by proving a candidate that could never actually work for a socket
  upgrade.
- `socketAuth`'s loopback branch (`gatewayCredential.ts`) calls the same predicate instead of running its
  own `asSubprotocolSafe`/`SUBPROTOCOL_TOKEN_RE` check against the loopback secret. The gateway-token
  branch of `socketAuth` keeps `asSubprotocolSafe` for the GATEWAY token — a different credential, with
  its own verify path in the same file — so that check is untouched.

## Do not

- **Do not reintroduce a second hand-written shape check for the loopback secret.** The whole point of
  this card is that `storeVerifiedLoopbackToken` and `socketAuth` must never be able to disagree about
  what counts as a well-formed loopback token — if a future change needs a different rule, change
  `isWellFormedLoopbackToken` itself, not a call site.
- **Do not widen this predicate to cover the gateway token too.** The gateway token is a distinct
  credential with its own module, its own storage key, and its own verify path (`verifyGatewayTokenAgainstDaemon`
  over `GET /api/version`); collapsing the two shape checks into one shared function would make a future
  change to one credential's shape rule silently affect the other.
- **Do not skip the pre-round-trip refusal in `storeVerifiedLoopbackToken` and rely on the HTTP probe to
  catch a malformed candidate.** The probe proves the secret works over an `Authorization` header, which
  is a strictly looser character set than a WS subprotocol element — it will happily say `"valid"` for a
  candidate that can never actually authenticate a terminal/companion socket.
