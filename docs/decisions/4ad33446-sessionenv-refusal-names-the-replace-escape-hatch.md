# 4ad33446 — the dot-bearing `sessionEnv` refusal names the `replace:true` REST escape hatch

## Narrative

Card `32b23f0f` made the project Settings `sessionEnv` editor refuse to remove or rename a stored key whose name contains a `.` — `unsetConfigPath` splits on `.`, so it can never target such a key, and silently orphaning the old secret (still delivered to every spawn) is worse than a loud refusal. That refusal was correct, but as originally worded it read as an absolute dead end: no UI path to ever delete such a key.

A second-pass Code Reviewer (session `3ee9210b`, then `74a109ab`) found the dead end isn't absolute: `PATCH /api/projects/:id/config` with `{config, replace: true}` bypasses `unset` entirely — it replaces the whole stored config wholesale (card `546034fa`'s deep-merge-by-default grammar, `gateway/server.ts`'s `/api/projects/:id/config` route). Re-submitting the full existing config with the offending `sessionEnv` key omitted removes it cleanly, no unset involved.

This panel can't compose that call itself — `ConfigEditor` only ever builds a partial override from its own form state, and never reads the project's other stored config fields, so it has no way to assemble a safe whole-object replacement. The fix here is therefore a copy change, not a mechanism change: the refusal names the escape route so a developer with REST/MCP access isn't left believing there is none. It does not help a non-dev user, who has no REST access either way — that gap is unchanged and out of scope for this card.

This does not retire the wire-format option (an escape/key-array form that lets `unset` itself address a dotted key) — that remains the only fix that makes `unset` correct for every consumer (human REST, platform `project_configure`, setup), and it overlaps card `b5faa194`'s territory. It is simply no longer needed just to un-stick a user.

## Do not

- Do not loosen the refusal itself to "solve" this — silently orphaning a live secret while reporting success is strictly worse than a documented dead end; `32b23f0f`'s fail-closed choice stands.
- Do not assume this closes the gap for a non-dev/non-REST user — the escape hatch is real but requires REST/MCP access this card does not add.
- Do not treat this as replacing or racing the config-grammar fix (`b5faa194`'s territory) — that's a separate, larger change that would make `unset` itself address a dotted key for every consumer.

## Source

Inline comment in `packages/web/src/pages/Settings.tsx` (`ConfigEditor`'s `sessionEnvErrors`, the dot-bearing-name refusal loop).
