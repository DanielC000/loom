# b5faa194 — refuse a config PATCH whose `unset` collides with its own write

## Narrative

`gateway/server.ts`'s `PATCH /api/projects/:id/config` and `mcp/platform.ts`'s `project_configure` both apply a config PATCH as `merge` THEN `unset`, unconditionally (card 546034fa introduced this grammar so `unset` can express deletion the merge itself cannot). A payload that writes a value at a dot-path AND unsets that same dot-path in one call used to silently lose the write: the merge landed it, the unset then pruned it, HTTP 200, no error.

A code-reviewer session (`3ee9210b`, reviewing `32b23f0f`'s branch) measured this directly by running the real `mergeConfigOverride`/`unsetConfigPath` helpers in the handler's own two-line order — writing `sessionEnv.API_KEY` while also unsetting `sessionEnv.API_KEY` produced `sessionEnv === null`, both the written value and the parent key gone. The reachable trigger is the web Settings sessionEnv editor's natural "remove then re-add the same name" credential-rotation flow (card 32b23f0f's own defect); no observed agent-side `project_configure` collision exists, only the structural exposure of the identical order on that surface.

DoD-0 (this card) checked every caller of `mergeConfigOverride`/`unsetConfigPath` (`gateway/server.ts`, `mcp/platform.ts`'s `project_configure`, `sessions/service.ts`'s `updateProjectStructural`, `mcp/setup.ts`'s two config-write tools) for any live dependence on the old "unset wins" precedence. Only the two named handlers ever combine a write and an `unset` in the SAME call (the manager/setup config-write paths carry no `unset` parameter at all). The one caller that already sends both — Settings.tsx's sessionEnv editor — was fixed (card 32b23f0f) to avoid the collision client-side (collect every written name first, never emit an `unset` for a name the same payload also writes) rather than to rely on either resolution order. So no live caller depends on the old precedence, clearing the way to change it.

## Fix

Both handlers now compute `findConfigPatchUnsetCollisions(v.value, unset)` (`mcp/platform.ts`) — the shared primitive both share — against the RAW, pre-merge write (never the merged result), and REFUSE the whole PATCH (HTTP 400 / `{error}` tool result) naming every colliding path, before the merge or any unset runs. This is a fail-closed choice over the alternative (silently making the write supersede a colliding unset): a refusal surfaces the caller's own contradictory intent immediately, instead of making the result depend on an ordering rule the caller can't see — the same shape of problem that produced this bug in the first place.

## Do not

- Do not "fix" this by moving `unset` before the merge — that silently inverts the documented `project_configure` grammar ("REMOVE a key AFTER the merge") for every caller, including ones that never collide.
- Do not make a write silently supersede a colliding unset (or vice versa) — a refusal that names the collision is preferred specifically because it doesn't hide an ordering rule inside the server; see the Fix section above.
- Do not treat this fix as proof an agent has ever actually triggered a colliding `project_configure` call — the reviewer's measurement is real, but the agent-side reachability is structural, not observed.

## Source

Card `b5faa194`, spun out of `32b23f0f` as pre-existing/out-of-scope for that branch's client-side fix. Reviewer finding: session `3ee9210b`, reviewing `32b23f0f`'s branch, 2026-09-18.
