# 6bc02f50 — `remoteAccess`/TLS resolved once, before `Fastify()` is constructed

## Narrative

Access-story Phase C (card `6bc02f50`): `remoteAccessConfig` is resolved via `resolveConfig` ONCE, at the very top of `buildServer`, before `Fastify()` is even constructed — the `https` option can only be set at construction time, so this can't wait until the trust-tier-hook block further down (where Phase A originally resolved it; that resolution is now just a reference to this one). Ships inert: `isTrustTierHookActive` is false by default (enabled:false ⇒ loopback), so `httpsOptions` stays undefined and `Fastify({logger:false})` is byte-identical to pre-Phase-C behavior.

`httpsActive` (a CR follow-up on this card) is the ONE real signal for "did this server actually end up HTTPS" — reported to `deps.onHttpsResolved` so a caller (`index.ts`) never has to independently re-derive it. A re-derivation using a cheaper check like `fs.existsSync` can diverge from what actually happened: a present-but-unreadable key, a cert path that's a directory, or a present-but-invalid PEM file all pass `existsSync` yet fail here. Two failure points are both caught independently, so EITHER degrades to plain HTTP with `httpsActive:false`, never a silent throw out of `buildServer`:
- (a) reading the files (`ENOENT`/`EACCES`/`EISDIR`/a delete-after-check race);
- (b) Node's TLS layer rejecting the read bytes as invalid cert/key material (garbage or empty files) — this only surfaces once `https.createServer` actually parses them, i.e. at `Fastify` construction.

## Do not

- Do not move the `remoteAccessConfig`/`httpsOptions` resolution below the `Fastify()` construction call — the `https` option is construction-time-only.
- Do not collapse the two failure points (file read vs. TLS material rejection) into one try/catch that can't tell which failed — both must independently degrade to plain HTTP with `httpsActive:false`, never throw.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`buildServer`, top of function, lines 292-314 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.
