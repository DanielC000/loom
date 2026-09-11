# 8fbb634c — an oauth2 connection can never be statically injected; reject the P4↔P1 binding at bind time, not silently

## Narrative

Guards the P4 capability-grant ↔ P1 connection binding at bind time — the human-facing REST surface (POST/PUT /api/profiles, gateway/server.ts), called AFTER `validateProfile` on its already-normalized `capabilities` array. A `requiresConnection` capability injects its bound connection's secret as a STATIC env var at spawn (`capabilities/registry.ts` › `resolveCapabilityServer`) — but an `oauth2` connection's secret never resolves that way: `getSecretForUse` (`connections/store.ts`) returns undefined for an `oauth2` row BY DESIGN, since oauth2 must flow through refresh-on-use via the P2 `authenticated_request` tool, never a static token that would go stale with no refresh path (`resolveConnectionSecret` in `index.ts` / the grant loop in `pty/host.ts` › `buildMcpServers` then correctly omit the env injection — that fail-closed runtime behavior is UNCHANGED by this guard).

Without this check, binding an oauth2 connection to such a grant would save successfully and then silently spawn every session under that profile credential-less. Rejects at bind time instead — safe here because this is a human-only config action, never an agent-writable path.

## Do not

- Do not let a `requiresConnection` capability grant bind to an oauth2 connection without rejecting it here — the connection's secret can never resolve as a static env var, so an unchecked bind would silently spawn every session under that profile credential-less.

## Source

Inline comment in `packages/daemon/src/profiles/validate.ts` (the JSDoc above `capabilityGrantBindingError`), as of commit 8fbb634cbc3b6700464240ba1eddde3d85908143. Relocated by card 53087a6a (tranche 2 on `profiles/validate.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers. The function's own "Returns an error string..." mechanics sentence stays inline in source (Class C contract doc) and is not duplicated here.

Source: commit 8fbb634cbc3b6700464240ba1eddde3d85908143, no board card.
