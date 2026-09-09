# 89257222 — `resolvedGateCommand`'s `timeoutMs` reads the SAME config path the gate itself enforces, never re-derived

## Narrative

`resolvedGateCommand` is a READ-ONLY projection of the caller's project RESOLVED gateCommand (the build/DoD gate run in a worker's worktree before merge), folded into `my_context` so a manager/worker can SEE the gate without a new tool. Resolved through the ONE config mechanism (`resolveConfig`) — never the default ad hoc — so a per-project override or human PATCH is reflected with no daemon restart.

`timeoutMs` is resolved through the SAME `resolveConfig(...).orchestration.gateCommandTimeoutMs` path the gate itself enforces (`sessions/service.ts` confirmWorkerMerge + the worker `run_gate` call-site) — never re-derived or hardcoded — so it tracks a per-project override, not the platform default (card 89257222: an unreadable timeout was propagating as manager-to-manager folklore instead of being read from the artifact). Reported unconditionally, even when no gateCommand is configured, since the timeout still governs whatever gate a project later sets.

## Do not

- Do not re-derive or hardcode `timeoutMs` here — always read it through the same `resolveConfig(...).orchestration.gateCommandTimeoutMs` path the gate itself enforces, or a per-project override silently stops tracking.

## Source

JSDoc comment in `packages/daemon/src/mcp/orchestration.ts`, above `resolvedGateCommand`. Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`) — the TRUST BOUNDARY guard clause stayed inline per `CLAUDE.md`'s class-A rule, compressed in place. No wording changed in the narrative moved here; wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
