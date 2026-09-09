# 80e2093f — `bindHost` deliberately accepts `0.0.0.0`/`::` (LAN in scope); this is a posture call, not an auth bypass

## Narrative

Access-story Phase A (card 766f8b50), tightened in Phase C (card 6bc02f50, CR 77ade04c): the remote-bind block. `.strict()` rejects unknown keys; the token itself is never part of this shape (Phase B stores it in a keyed table, not config). `bindHost` shape validation (77ade04c): must be a valid IPv4/IPv6 literal (`net.isIP`) OR an RFC 1123-shaped hostname (dot-separated 1-63-char alnum/hyphen labels, no leading/trailing hyphen per label) — this is what a tailnet name (`foo.tailnet-name.ts.net`) and a plain LAN hostname both look like. Rejects garbage (spaces, a URL, a CIDR) BEFORE it ever reaches `gateway/trust-tier.ts`'s Host comparison or a `.listen()` call.

This deliberately ACCEPTS `0.0.0.0`/`::` (binds ALL interfaces, LAN in scope) — an owner-decided posture call (P5b hardening follow-up, card 80e2093f, item 2), NOT an auth bypass (every non-loopback peer still hits the same token+TLS wall). See `RemoteAccessConfig.bindHost`'s doc (`@loom/shared`) for the full posture note, and `gateway/trust-tier.ts`'s `isAllInterfacesBindHost` for where this mode is made VISIBLE (a boot log line + a Settings UI hint) rather than silent.

## Do not

- Do not treat `0.0.0.0`/`::` as an auth-bypass bug to "fix" by rejecting it — every non-loopback peer still hits the same token+TLS wall; accepting it is a deliberate owner-decided posture call (card `80e2093f`, item 2).
- Do not silently widen the bind surface without also keeping `isAllInterfacesBindHost`'s visibility (the boot log line + Settings UI hint) working — the posture is meant to stay VISIBLE, never silent.

## Source

Inline comment in `packages/daemon/src/mcp/platform.ts` (the block preceding `remoteAccessOverride`, lines 694-711 as of this tranche's HEAD, prior to compression). Relocated by card `b721401b` (tranche 1 on `mcp/platform.ts`).
