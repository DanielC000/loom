# cda454c8 — key-authed Agent Runs routes are exempt from the loopback-secret write guard

The loopback write guard (card 9ccedbee) requires `Authorization: Bearer <loopback secret>` on every non-GET `/api/*` from loopback. `POST /api/runs` and `POST /api/runs/:id/cancel` authenticate via `authRunKey`, which reads the run API key from the SAME header. One Bearer value can't be both, so since the guard landed those two routes were uncallable (401 from the guard) from loopback, and they are not Tier-1, so there is no remote path either.

## Decision

Exempt exactly `POST /api/runs` and `POST /api/runs/:id/cancel`, listed in `LOOPBACK_GUARD_KEY_AUTHED_EXEMPT` (`gateway/server.ts`), matched on the registered route pattern (`req.routeOptions.url`), not the URL text. The header contract is unchanged (moving the key to another header would break the public README/site API without shrinking the trust surface).

Why a run API key suffices for exactly these routes: the guard stops a co-resident agent using HUMAN-authority writes. The run routes are not that — they carry their own credential a human minted (hashed at rest, plaintext shown once), and each handler's first statement is `authRunKey`, which fails closed (missing/malformed/unknown/bad secret → 401, paused/revoked → 403) before any run is started or any DB write. It does NOT run before body parsing: Fastify's JSON parser runs first (an unauthenticated `{bad json` gets 400, not 401), so an unauthenticated loopback caller can now make the daemon parse up to the default bodyLimit, where the guard used to 401 in onRequest. Accepted residual; do not move `authRunKey` into a preParsing hook for this. A key reaches only its own project's allowlisted endpoint agents, is cap-limited, and cancel/GET are own-run-scoped. The exemption is keyed on route patterns, so a run key opens no other write, and the loopback secret presented on the run routes is rejected as an invalid key.

Residual risk: a co-resident process that obtains a valid run key can feed arbitrary input to an endpoint agent, which runs under ITS OWN profile (possibly more privileged than the thief's), bounded by the key's allowlist and caps. That is the key's intended capability.

Inbound webhooks (`/hooks/:endpointPath`) never conflicted: not under `/api/`, HMAC-gated, never read Authorization.

Pinned by `test/agent-runs-loopback-guard.mjs` (exact contents of the constant, per-route no-credential 401s, run key rejected on other writes).

## Do not

- Do not widen `LOOPBACK_GUARD_KEY_AUTHED_EXEMPT` beyond these two exact patterns, and never exempt by prefix, credential shape, or `startsWith`.
- Do not add a route to the set unless it is matched by exact registered pattern AND its handler calls `authRunKey` (or an equivalent fail-closed credential check) as its first statement.
- Do not move the run API key to a different header to "fix" this; it is a breaking change to the public API.
