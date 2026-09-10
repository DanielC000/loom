# 52ab5d45 — the Scheduler's maxConcurrentManagers cap is daemon-global; a per-project override is accepted but inert

## Narrative

The cron Scheduler is ONE daemon-wide service — it is never scoped to a project. So the `maxConcurrentManagers` value that actually reaches the Scheduler's own concurrency check comes ONLY from the daemon-global `PlatformConfigOverride.maxConcurrentManagers` (mirroring `maxConcurrentGates`'s daemon-global resolution).

A per-project override of `orchestration.maxConcurrentManagers` is STILL accepted by the per-project config schema, for backward compatibility — but it is not read by the merge that feeds the Scheduler, so setting it on a project's own config has zero effect on Scheduler behavior.

## Do not

- Do not assume setting `orchestration.maxConcurrentManagers` on a per-project config override changes the Scheduler's actual cap — it doesn't; only the daemon-global `PlatformConfigOverride` value does.
- Do not remove the per-project schema field outright on the strength of it being inert — it's kept deliberately, for backward compat with configs that still set it.

## Source

JSDoc in `packages/shared/src/config.ts` above `OrchestrationConfig.maxConcurrentManagers`, originally lines 356-362, as of this tranche's HEAD. Relocated by card `6377d105` (tranche 1 on `shared/config.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
