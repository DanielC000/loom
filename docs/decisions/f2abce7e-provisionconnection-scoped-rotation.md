# f2abce7e — `provisionConnection` scoped rotation preserves the oauth2-clobber guard

## Narrative

Card f2abce7e (project-scoped connections) unlocked scoped rotation on top of the create-only refusal from card 193de09e — see `docs/decisions/193de09e-provisionconnection-refuses-on-name-collision.md`.

SCOPED ROTATION: when the caller passes `projectId` AND the existing same-name row is scoped to that EXACT project, "the connection I own" is now well-defined — `provisionConnection` (`packages/daemon/src/connections/store.ts`) rotates its secret in place via `updateConnectionSecret` (the reserved db-layer seam) instead of refusing. Every OTHER collision still refuses exactly as before: a GLOBAL existing row, a row scoped to a DIFFERENT project, or a caller with no `projectId` at all — so a project can never rotate a connection it doesn't itself own, and the original create-only posture is unchanged for every caller that omits `projectId`.

It still guards failure mode (a) from the original design: rotation is refused (same collision error) when the existing same-scope row isn't `api-key` — an `oauth2` row's secret_blob is a JSON token bundle, and overwriting it with a plain api-key envelope while `authScheme` stayed `"oauth2"` would break the next `getOAuthTokenBundle` (`JSON.parse` on now-api-key ciphertext).

## Do not

- Do not let scoped rotation apply to an existing same-scope row that isn't `api-key` — an `oauth2` row's secret_blob is a JSON token bundle, not a raw secret; overwriting it breaks the next `getOAuthTokenBundle` call.

## Source

Inline comment in `packages/daemon/src/connections/store.ts`, above `provisionConnection`: lines 181-191, introduced by commit `f7849999dfe3ead680306151b24c9189139d0a05` (`feat(connections): project-scoped connections (project_id nullable=global) + resolution + Settings scope selector`). Relocated by card `854a8a6b` (tranche 1).
