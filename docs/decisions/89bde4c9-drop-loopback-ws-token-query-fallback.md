# 89bde4c9 — drop the deprecated loopback ws `?token=` fallback

## Narrative

The loopback human-only-write guard (card `9ccedbee`/`214caa53`, `gateway/server.ts`) authenticates
`/ws/term`/`/ws/companion` upgrades via the `Sec-WebSocket-Protocol: loom.v1, loom.bearer.<secret>`
double-subprotocol contract. Since card `e4459829` (squash `fce9f3578`, tagged `v0.31.0`) the web client
sends only that subprotocol — `gatewayCredential.ts`'s `socketAuth` never puts the secret in the URL for
the loopback branch. The guard itself kept accepting a `?token=` query-param fallback for one extra
release, so a browser tab still holding the previous bundle (pre-`e4459829`) kept working across that one
deploy, with a follow-up card tracking the removal.

That release has shipped (`v0.31.0` contains `fce9f3578`), so the fallback window has closed. This card
removes it: a well-formed `[loom.v1, loom.bearer.<token>]` subprotocol offer is still accepted; anything
else (no subprotocol offer, a malformed/rejected offer, or a bare `?token=` query value with no
subprotocol at all) is refused with the same 401 the guard already gives a credential-less upgrade.

This is the LOOPBACK guard only. The REMOTE Tier-1 gateway-token `?token=` fallback — a structurally
different mechanism — is untouched. It lives in `gateway/server.ts`'s trust-tier wall hook, a SEPARATE
`app.addHook("onRequest", …)` registration inside `if (remoteTrust.tierWall)` (~:701), where a
`resolveWsSubprotocolToken` `"no-token"` outcome falls back to the query param; `trust-tier.ts` itself
only supplies that pure helper, not the fallback logic or `verifyGatewayToken` (a `deps`-supplied
callback). No card tracks its removal yet, unrelated to this one.

## Do not

- Do not re-add a `?token=` (or any URL-carried) fallback to the loopback write-guard's WS auth branch —
  the whole point of the subprotocol contract is that the secret never rides a URL (devtools history,
  proxy/tunnel access logs).
- Do not touch the REMOTE Tier-1 `?token=` fallback (the trust-tier wall, `resolveWsSubprotocolToken`'s
  `"no-token"` outcome falling back to the query param) as part of this decision — it is a separate
  mechanism, untracked by any card today, and not what this decision removes.
- Do not assume the log-redaction machinery (`REDACTED_QUERY_KEYS`, `redactTokenFromLoggedUrl`) can be
  removed alongside this — it still guards the REMOTE tier's own `?token=` fallback and the unrelated
  `gwtoken=` page-load capture param.

## Source

`packages/daemon/src/gateway/server.ts`, the loopback human-only-write guard's WS branch
(`isTermSocket || isCompanionSocket`), as of commit `91bb7627` (the pre-fix HEAD this card started from).
