# 80e2093f — P5b hardening follow-up: two items, `bindHost` posture (item 2) and gateway-token rotation (item 1)

Card `80e2093f` is a P5b hardening follow-up with (at least) two distinct DoD items, each its own decision below.

## Decision: `bindHost` deliberately accepts `0.0.0.0`/`::` (item 2); this is a posture call, not an auth bypass

### Narrative

Access-story Phase A (card 766f8b50), tightened in Phase C (card 6bc02f50, CR 77ade04c): the remote-bind block. `.strict()` rejects unknown keys; the token itself is never part of this shape (Phase B stores it in a keyed table, not config). `bindHost` shape validation (77ade04c): must be a valid IPv4/IPv6 literal (`net.isIP`) OR an RFC 1123-shaped hostname (dot-separated 1-63-char alnum/hyphen labels, no leading/trailing hyphen per label) — this is what a tailnet name (`foo.tailnet-name.ts.net`) and a plain LAN hostname both look like. Rejects garbage (spaces, a URL, a CIDR) BEFORE it ever reaches `gateway/trust-tier.ts`'s Host comparison or a `.listen()` call.

This deliberately ACCEPTS `0.0.0.0`/`::` (binds ALL interfaces, LAN in scope) — an owner-decided posture call (item 2), NOT an auth bypass (every non-loopback peer still hits the same token+TLS wall). See `RemoteAccessConfig.bindHost`'s doc (`@loom/shared`) for the full posture note, and `gateway/trust-tier.ts`'s `isAllInterfacesBindHost` for where this mode is made VISIBLE (a boot log line + a Settings UI hint) rather than silent.

### Do not

- Do not treat `0.0.0.0`/`::` as an auth-bypass bug to "fix" by rejecting it — every non-loopback peer still hits the same token+TLS wall; accepting it is a deliberate owner-decided posture call (item 2).
- Do not silently widen the bind surface without also keeping `isAllInterfacesBindHost`'s visibility (the boot log line + Settings UI hint) working — the posture is meant to stay VISIBLE, never silent.

### Source

Inline comment in `packages/daemon/src/mcp/platform.ts` (the block preceding `remoteAccessOverride`, lines 694-711 as of that tranche's HEAD, prior to compression). Relocated by card `b721401b` (tranche 1 on `mcp/platform.ts`).

## Decision: gateway-token rotation is an immediate cutover, no dual-accept grace TTL (item 1)

### Narrative

Rotating a gateway token (`Db.rotateGatewayToken`) is an IMMEDIATE cutover — the old token's salt+hash is overwritten in place, so it stops verifying the instant rotation happens, breaking any remote client still presenting it until it picks up the new one. This is INTENTIONAL, not a bug — the store deliberately does not do a dual-accept grace TTL, keeping the auth surface simple (exactly one valid secret per token row at a time).

If a live remote client needs to switch tokens without a connectivity gap, the store's existing multi-token support is the manual grace procedure instead: mint a SECOND gateway token, distribute it to every remote client, confirm they've all switched over, THEN revoke/delete the OLD token (rather than rotating it) — every other token stays valid throughout. See `Db.rotateGatewayToken`'s own doc comment.

### Do not

- Do not add a dual-accept grace TTL to token rotation to "fix" the breakage — the immediate cutover is deliberate, for a simpler auth surface (exactly one valid secret per token row).
- Do not rotate a token a live remote client still needs — mint a second token and let every client switch over first, then revoke the old one; that path keeps every other token valid throughout.

### Source

JSDoc in `packages/shared/src/config.ts` above `RemoteAccessConfig`, originally lines 796-804, as of this tranche's HEAD. Relocated by card `6377d105` (tranche 1 on `shared/config.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
