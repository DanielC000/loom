# 546034fa — `unsetConfigPath` prunes a now-empty parent object

## Narrative

`unsetConfigPath` (`packages/daemon/src/mcp/platform.ts`) is the deletion half of the deep-merge config-PATCH grammar shared by `project_configure` and the REST `PATCH /api/projects/:id/config` (card 546034fa). A caller names a leaf dot-path (e.g. `"memory.budgetTokens"`) to clear one field of a group without touching its siblings.

The original implementation deleted only the named leaf. Settings.tsx's `buildOverride()` clears an entire group (e.g. the three `memory.*` fields, or `permission.allow`) by sending one `unset` entry per leaf — so after all three memory leaves were individually removed, the STORED override was left with a dangling `memory: {}` husk instead of a genuinely absent `memory` key. `resolveConfig` treats an empty group and an absent one identically (each field is read with its own `??` fallback), so this was invisible to every resolved-config consumer — but a RAW reader of the stored override (`project.config?.memory ?? null`, exactly what `packages/web/e2e/settings.spec.ts`'s "clearing them removes the override" assertion does) sees a truthy `{}` instead of `null`, and the spec fails.

Every caller that BUILDS a config object locally already prunes an emptied group itself (e.g. Settings.tsx's own `if (Object.keys(mem).length) o.memory = mem; else delete o.memory;`) — the gap was purely in the SERVER-side `unset` mechanism not mirroring that same convention when a group's leaves are cleared one dot-path at a time instead of via a single top-level `unset: ["memory"]`.

## Fix

`unsetConfigPath` now walks the full ancestor chain when descending to the leaf, and after deleting the leaf, prunes each ancestor that has become empty — deepest first, stopping at the first ancestor that still has a sibling key. This makes clearing every leaf of a group (in any order, across any number of separate `unset` entries in one PATCH) converge on the SAME genuinely-absent result as clearing the whole group in a single top-level `unset` entry, or as the old whole-object-replace PATCH path used to produce.

## Do not

- Do not revert to a bare leaf-only delete in `unsetConfigPath` — that reopens the dangling `group: {}` husk a raw presence/truthiness check (an e2e spec, a REST consumer reading `project.config` directly) reads as "configured", even though every resolved-config reader is unaffected either way.
- Do not "fix" this instead by teaching every UI/agent caller to pre-compute whether a group will end up empty and send a single top-level `unset` entry — that pushes the same bookkeeping error back onto every future caller of a shared primitive; the chokepoint (`unsetConfigPath` itself) is the right place to make deletion behave like deletion.

## Source

Found via `packages/web/e2e/settings.spec.ts:644`'s "editing the project Memory fields ... clearing them removes the override" acceptance spec going deterministically red (2/2 reproductions) against branch `loom/e69a4b98b4f0` while the same spec stayed 3/3 green on unmodified main.
