# 3bd8ef17 — keep Codescape's config shape OUTSIDE resolveConfig() so it never reaches the browser bundle

## Narrative

`PlatformConfig`/`ResolvedConfig` flow through `resolveConfig()`, which `packages/web` calls client-side (Settings/ColumnManager/Companion effective-value hints) — any field on either shape, and any key on `PLATFORM_DEFAULTS`, ships verbatim into the built browser bundle. Codescape is a PRIVATE product end-user agents must never learn exists (project memory `codescape-is-private-no-user-visible-surface`).

So `CodescapeConfig`'s runtime default+merge (`resolveCodescapeConfig`) and the daemon-global codescape integration path resolver (`resolveCodescapeIntegrationPath`) are both kept OUTSIDE `ResolvedConfig`/`resolveConfig()` and `PlatformConfig` respectively — the TYPES stay declared in `packages/shared/src/config.ts` (so daemon code can still type-check against them), but the actual resolution logic lives in separate, DAEMON-ONLY functions `packages/web` never imports.

## Do not

- Do not fold `CodescapeConfig` into `ResolvedConfig`, or the `integrations` key into `PlatformConfig` — either would ship the key (and Codescape's existence) into the client bundle.
- Do not let `packages/web` import `resolveCodescapeConfig` or `resolveCodescapeIntegrationPath` — those are DAEMON-ONLY, even though their TYPES are declared in the shared package.

## Source

JSDoc in `packages/shared/src/config.ts`: `CodescapeConfig`'s own doc (originally lines 157-163) and `PlatformConfig`'s trailing `// NOTE: no integrations key` comment (originally lines 734-736), both as of this tranche's HEAD. Relocated by card `6377d105` (tranche 1 on `shared/config.ts`); no wording changed beyond compressing the surrounding LEAD-ruling/guard text that stays inline.
