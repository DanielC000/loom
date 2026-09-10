# 766f8b50 — RemoteAccessConfig ships fully inert in Phase A, daemon-global, with the gateway token deliberately kept out of it

## Narrative

Access-story Phase A: `RemoteAccessConfig` is NOT per-project — like `backup`/`platform`, the daemon shares exactly ONE of these. It ships fully INERT: `enabled:false` + `bindHost: "127.0.0.1"` by default, so today's loopback-only bind stays byte-identical to before this config shape existed. `enabled` is the master switch a later phase reads before ever attempting a non-loopback `.listen()`; `bindHost` is the interface a later bind target will use, still ignored today while a boot-time token guard refuses any non-loopback bind (see `gateway/trust-tier.ts`'s `canOpenRemoteListener`). `tls`/`rateLimit` are Phase C concerns (TLS material + a remote-request limiter, card `6bc02f50`) — plumbed into the shape now, but not actually consumed until Phase C ships.

The gateway TOKEN itself deliberately does NOT live in this config shape at all — Phase B stores it in a separate, keyed table instead, never in config. Keeping the secret out of the general config blob means it never rides through the same read/write/API surface as ordinary tuning knobs.

## Do not

- Do not add the gateway token itself to `RemoteAccessConfig` (or any config shape) — Phase B's keyed table is a deliberate choice to keep the secret off the general config surface.
- Do not assume `tls`/`rateLimit` are live before Phase C ships (card `6bc02f50`) — they're typed and plumbed now, but inert until then.
- Do not scope this config per-project — it mirrors `backup`/`platform` as a genuinely daemon-global shape.

## Source

JSDoc in `packages/shared/src/config.ts` above `RemoteAccessConfig`, originally lines 786-794, as of this tranche's HEAD (before the two hardening-follow-up paragraphs that stayed with card `80e2093f`). Relocated by card `6377d105` (tranche 1 on `shared/config.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
