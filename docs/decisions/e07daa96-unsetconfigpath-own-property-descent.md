# e07daa96 — `unsetConfigPath` descends with own-property semantics

## Narrative

`unsetConfigPath` (`packages/daemon/src/mcp/platform.ts`) walks a dot-path's intermediate segments with a plain bracket read (`cur[parts[i]]`) before this fix. A segment named `__proto__` resolves through that read via the JavaScript accessor on `Object.prototype` — not as an own property of the config object being walked — so the walker could descend straight onto the REAL, shared `Object.prototype`. The function's final step is a `delete` on whatever object the walk landed on, so a dot-path like `sessionEnv.__proto__.toString` deleted `Object.prototype.toString` itself: a permanent, process-wide mutation, not a per-project config change.

A code-reviewer session (`4275d929`, reviewing `b5faa194`'s commit `3425b1a3`) measured this directly on the real built `dist`: `unsetConfigPath({sessionEnv:{A:"1"}}, "sessionEnv.__proto__.toString")` deleted `Object.prototype.toString`, after which `String({})` throws `TypeError: Cannot convert object to primitive value` for the remaining life of the daemon process, for every project it serves. The defect is pre-existing (not introduced by `3425b1a3`) and is not closed by that commit's own `findConfigPatchUnsetCollisions` guard — that guard runs against the incoming `config` PATCH, and an unset-only payload (no colliding write) never reaches it at all.

Reachability: the human loopback REST `PATCH /api/projects/:id/config`, and the `LOOM_DEV`-gated platform `project_configure` (agent-callable — a hallucinated unset path is sufficient, no malice required). NOT reachable from an ordinary project-session agent — the manager `project_update` and `mcp/setup.ts`'s two config writers call `mergeConfigOverride` only and take no `unset` parameter at all. Not observed in the wild; the severity is the blast radius and agent-reachability, not evidence of occurrence.

## Fix

The intermediate-segment walk now checks `Object.hasOwn(cur, key)` before reading `cur[key]`, matching the function's own real contract: its terminal `delete` only ever removes an OWN property, so a prototype-chain READ during descent was already incoherent with that. A segment that isn't an own property of the current node is treated as "path doesn't exist" — the same harmless no-op the function already returns for a path through a non-object value. `findConfigPatchUnsetCollisions` (card `b5faa194`) carries the identical guard at its own descent site, for the identical reason — a prototype-chain name must never resolve to a defined value there either, or a legitimate removal of a stored key sharing that name (e.g. a `sessionEnv` var literally named `constructor`) gets refused as a collision the patch never wrote.

## Do not

- Do not revert to a plain bracket read at either descent site (`unsetConfigPath` or `findConfigPatchUnsetCollisions`) — that reopens the prototype-chain hop this card measured.
- Do not treat `findConfigPatchUnsetCollisions`'s collision check as covering this defect — it only ever sees the incoming `config` write; an unset-only payload with no colliding write bypasses it entirely and reaches `unsetConfigPath` directly.
- Do not assume this has been observed in production — the severity argument is blast radius (process-wide, until restart) and agent-reachability (the platform `project_configure` tool), not an incident record.

## Source

Card `e07daa96`, filed by a code-reviewer session (`4275d929`) reviewing `b5faa194`'s commit `3425b1a3`, 2026-09-18.
