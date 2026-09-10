# 193de09e — `provisionConnection` refuses on name collision instead of rotating (v1)

## Narrative

`provisionConnection` (`packages/daemon/src/connections/store.ts`) is credential auto-provisioning v1's core write, called ONLY from the human-only answer boundary (`POST /api/questions/:id/answer`'s credential branch in `gateway/server.ts`), never from an agent path.

It REFUSES (throws) if a connection by this EXACT name already exists, of ANY auth scheme — v1 deliberately does NOT rotate-in-place (CR finding on this card): `getConnectionByName`'s lookup is GLOBAL and scheme-agnostic, so silently rotating whatever it finds had two live failure modes:

- (a) provisioning an api-key secret over an EXISTING `oauth2` connection of the same name would overwrite its token-bundle blob with an api-key envelope while `authScheme` stayed `"oauth2"`, so a later `getOAuthTokenBundle` (`JSON.parse` on now-api-key ciphertext) throws — a silent, hard-to-diagnose break;
- (b) connections had no scope yet, so ANY manager could overwrite an UNRELATED project's api-key connection's secret just by naming it, consent the human never gave.

Refusing collision entirely closes both. `updateConnectionSecret` stayed on the db layer for a FUTURE scoped-rotation path once card f2abce7e (project-scoped connections) made "the connection I own" well-defined — see `docs/decisions/f2abce7e-provisionconnection-scoped-rotation.md` for that follow-on. Until then, a human can always rotate an existing connection via the Connections settings UI/REST.

## Concurrency (part of the same decision)

A race between two answers naming the same new connection (both pass the collision check, both create) is left unhandled in v1 — a single-human loopback daemon makes concurrent answers to the SAME question effectively impossible, and this create-only refusal narrows the window further to two DIFFERENT questions racing to create the identical name at the identical instant. Not worth a transaction for that.

## Do not

- Do not make `provisionConnection` rotate-in-place on a name collision without re-deriving both failure modes above — `getConnectionByName`'s lookup is still global and scheme-agnostic.

## Source

Inline comment in `packages/daemon/src/connections/store.ts`, above `provisionConnection`: lines 156-180, introduced by commit `ddcf71cc4716e83650c62440665a21307eecb9f2` (`feat(connections): auto-provision an answered credential into a Connection at the answer boundary + role-gate + pending-binding + honest ack`). Relocated by card `854a8a6b` (tranche 1).
