# 66b1b40d — the default `harness` config key: layers, fleet scope, and the codex-compat skip

Relocated from CLAUDE.md (docs relocation, card `e0ba98c1`). Card `66b1b40d`, multi-harness epic `df1f94b0`; compat skip card `961da6c6`; recycle re-resolution card `8d4b4433`; fleet widening card `4c4eb9af`.

## What it is

`harness: {default, scope}` is a human-only config key at TWO layers: platform (`PATCH /api/platform/config`, `PlatformConfigOverride.harness`) and project (`ProjectConfigOverride.harness`, human REST PATCH). It fills an UNSET Profile `harness` for a fresh `worker` spawn.

- Precedence: Profile `harness` > project > platform > built-in `claude`/`workers` (`resolveHarnessConfig`/`harnessDefaultForRole`, `packages/shared/src/config.ts`).
- A resolved `claude` writes a NULL session column, so every existing spawn stays byte-identical.
- It is read inside `SessionService.resolveAgentSpawn`, NOT off its `config` argument, because every `resolveConfig(` caller there passes no platform layer.

## Trust class: HUMAN-only

Same class as `profile.harness`/`gateCommand`. The platform validator has no agent variant, the agent project-config shape drops the key (`.strict()` rejects it), and even the Platform Lead's elevated `project_configure` rejects it (`HUMAN_ONLY_PROJECT_CONFIG_KEYS`, `mcp/platform.ts`).

## `scope:"fleet"` is fail-closed

Both validators reject it with an error naming card `4c4eb9af` (codex has no doctrine/parity for non-worker roles yet) until the ONE shared allowlist `HARNESS_FLEET_ROLES` (`packages/shared/src/config.ts`, today `["worker"]`) reaches beyond `worker`. `harnessDefaultForRole` reads the same const, so a stored `fleet` reaches no more than that list; the default reaches `worker` only today. Widening is one role per card (never a free-form roles key; setup/auditors last).

## A default-derived `codex` applies ONLY to a codex-compatible agent (card `961da6c6`)

`validateProfile`'s codex rejections fire only for an explicit `harness:"codex"` profile, and codex silently ignores `restrictedTools`. So `SessionService.defaultHarnessForSpawn` keeps on claude an agent needing `restrictedTools` (fail-open) or `browserTesting`/`documentConversion`/`capabilities` (purpose-defeating). `codexIncompatibilities` (`profiles/codex-compat.ts`) is the one source of the reason strings. Codescape is deliberately NOT a skip reason: it is fail-closed, with only a loud spawn-time `onCodexUnsupportedCapability` degrade. A fresh `worker_spawn`/`startNew` files a durable `harness_default_skipped` event (`worker_spawn`'s result also carries `harnessDefaultSkipped`); an explicit codex profile is unchanged. `forkSession` REFUSES a codex-pinned source (codex has no fork primitive).

## Which paths consult the default (card `8d4b4433`)

A FRESH spawn consults it, and so does a manager / platform-lead recycle: it is re-resolved through `resolveAgentSpawn`. A re-resolved `codex` is applied only if the OLD ROW's carried restrictedTools/browserTesting/documentConversion/capabilities are codex-compatible per `codexIncompatibilities`; otherwise `old.harness` is kept and a `harness_default_skipped` event with `trigger:"recycle"` is filed. That skip is PERMANENT for a lineage whose row carries those fields, since recycle carries them forever and each recycle files another skip. Worker recycle, resume, fork and boot-reconcile read the pinned row value, so flipping the default never migrates a live session or a worker.

## codex never reads `opts.permission`

An authored PROJECT `permission.deny` (profiles have no deny field of their own; there is no platform permission layer) is a codex-incompatibility too (same skip-to-claude shape). Several other claude-side read-denies are only loudly disclosed at spawn (never enforced, and never put into the codex session's own turn input). A RESOLVED codex harness is forced back to claude, at the `resolveAgentSpawn` chokepoint keyed on the resolved session role (not the profile's own role field), for any role that gets claude's blanket transcript-root deny; an explicit `harness:"codex"` profile for such a role is rejected earlier too, at `validateProfile` save time. Exactly which denies, why, and the open residual risk: `docs/decisions/7955458e-*.md`.

## Tests

`packages/daemon/test/default-harness-config.mjs`, `packages/daemon/test/recycle-harness-reresolve.mjs`.
