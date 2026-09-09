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

## Narrative (2): `resolveProjectId` (supervisor) caches BOTH a hit and a miss, bounded differently

Card `088afc94` (CR follow-up): `CodescapeSupervisor.resolveProjectId` is the ONE seam every caller (sessions/service.ts's lifecycle hooks, pty/host.ts's per-session MCP mount) should use, so swapping the resolution strategy later is a change in one place. It checks this instance's own in-memory cache first (populated by a successful `registerProject` — the authoritative source for anything this boot has confirmed), falling back to the COLD manifest-by-path read (`codescape/manifest.ts`'s `resolveCodescapeProjectId`) on a cache miss. The manifest fallback is DELIBERATELY kept, not retired: `POST /project` can fail transiently (serve mid-restart, a bad repoRoot, a genuine conflict), while the manifest still resolves an id for any repo codescape has EVER ingested — cache miss or not, restart or not. Never throws; `null` is an honest "cannot resolve right now", which every caller already treats as a clean skip.

A manifest-read HIT is now cached into the in-memory map too (not just a `registerProject` success) — this is the SPAWN HOT PATH (per-session MCP mount resolution), and `CLAUDE.md` pins it to no blocking work, so the cold `readFileSync`+`JSON.parse` inside `resolveCodescapeProjectId` must run at most once per repo, not once per lookup. A MISS is also remembered, but only for a bounded TTL (`PROJECT_ID_NEGATIVE_CACHE_TTL_MS`, 30 seconds) — unlike a resolved HIT, which never changes and is cached forever: a repo that boot registration never covered (created, or `codescape.enabled` toggled on, after boot — a case the code explicitly advertises as needing no restart) would otherwise re-run that synchronous read on the spawn hot path on EVERY call, forever. The tradeoff: a newly-ingested repo can take up to 30s to be picked up here instead of showing up on the very next spawn — acceptable, since ingestion itself already takes far longer than this.

## Do not (2)

- Do not cache a manifest-read MISS forever the way a HIT is cached — a miss must expire after `PROJECT_ID_NEGATIVE_CACHE_TTL_MS`, or a repo enabled after boot never gets picked up without a restart.
- Do not read the manifest synchronously on every `resolveProjectId` call without a cache — this runs on the spawn hot path, which `CLAUDE.md` pins to no blocking work.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`codescapeHttpMcpServer`'s function doc), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. Second narrative/Do-not pair relocated by card `725511f2` (tranche 1 on `codescape/supervisor.ts`), from the JSDoc method comment above `resolveProjectId`: originally lines 1936-1955, as of that tranche's HEAD.
