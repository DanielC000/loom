# 088afc94 / 42f50ca1 — `codescapeHttpMcpServer` is a clean skip on failure, and its baked-in port must stay stable

## Narrative

Card 088afc94 (P4 wiring): `codescapeHttpMcpServer` builds the streamable-HTTP MCP-config entry for a codescape-enabled session, pointed at the SHARED `codescape serve` process (`/mcp/<codescapeId>` for a manager, or `/mcp/<codescapeId>/<worktreeId>` for a worker tied to a task — codescape confirmed this route is the STABLE long-term interface: it serves the project's main graph today and will serve worktree-adjusted overlay content through this SAME URL once that ships, so this is not a placeholder to "simplify" back to the bare route later).

Returns `null` — a CLEAN SKIP, never a stale/absent fallback (Platform Lead ruling on this card: silent staleness was the ORIGINAL defect, and a stdio-snapshot fallback would silently reproduce exactly that) — when `port` is null (serve isn't up: disabled, never started, mid-restart, or gave up) or when `resolveProjectId` can't resolve an id for `repoPath` (never registered). `resolveProjectId` should be the SAME supervisor instance's `resolveProjectId` (its own boot-registration cache first, falling back to the cold manifest read — see `codescape/supervisor.ts`) — kept as an injected function (not a raw `homeDir`) so this stays a pure, hermetically-testable seam and so every caller shares the ONE id-resolution strategy in one place.

PRIOR-ATTEMPT NOTE: an EARLIER HTTP-mount attempt was abandoned because it scoped by Loom's own `project.id`, which never matched codescape's OWN path-derived id — the MCP never registered, silently. Resolving via `resolveProjectId` (never a reimplemented hash) is what fixes that class of bug for good.

Card 42f50ca1: the returned URL bakes `port` in literally. `buildMcpServers`' caller writes this into a session's `--mcp-config` at `createPty` time (fresh spawn/resume/fork/recycle) — the running `claude` process holds that URL for the rest of its life and never re-reads `getPort()`. So the supervisor's port MUST stay stable for as long as a session that mounted it stays alive; see the reuse-on-restart doc at `codescape/supervisor.ts`'s `spawnServe()` for why that stability is deliberate, not incidental.

## Do not

- Do not add a stdio-snapshot (or any other) fallback when `port`/`resolveProjectId` fails — the CLEAN skip (`null`) is deliberate; a fallback would silently reproduce the original staleness defect this card fixed.
- Do not scope codescape MCP resolution by Loom's own `project.id` — use `resolveProjectId` (codescape's own path-derived id) or the mount silently never registers, as it did before this card.
- Do not let the codescape supervisor's port change while any session that mounted it via `--mcp-config` is still alive — the running `claude` process bakes the URL in at spawn time and never re-reads `getPort()`.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`codescapeHttpMcpServer`'s function doc), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
