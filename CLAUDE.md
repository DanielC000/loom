# Loom

Local-first AI project workspace that weaves real Claude Code sessions, Obsidian docs, and
tasks into one fabric. Clean-slate successor to Jinn.

**Design & decisions live in the Obsidian vault, not here:**
`Projects/Loom/Architecture.md` (full vision + architecture) and
`Projects/Loom/Vision & Architecture.md` (decisions + spike findings).

## Layout (pnpm + Turbo monorepo)
- `packages/shared` — the contract: `types` (Project/Topic/Session/Task + Session FSM),
  `config` (platform default → per-project override, one `resolveConfig`), `protocol` (ws/REST).
- `packages/daemon` — owns everything durable: SQLite (`db.ts`), the PTY host (`pty/host.ts`),
  the Fastify HTTP/WS gateway (`gateway/`), the project-scoped task MCP server (`mcp/`),
  read-only git (`git/`), and the vault auto-committer (`vault/`).
- `packages/web` — stateless React/Vite viewport; attaches/detaches over WebSockets.
- `spike/` — throwaway de-risking spike (all assumptions validated 2026-05-26). Reference only.

## Run
```sh
pnpm install
pnpm build          # builds shared first (turbo ^build)
pnpm daemon         # daemon on http://127.0.0.1:4317 (loopback only)
pnpm web            # viewport on http://127.0.0.1:5317 (proxies /api + /ws to the daemon)
```

## Load-bearing invariants (validated in the spike — do not regress)
- **Drive the REAL interactive `claude` via node-pty.** Never `claude -p`/headless.
- **Spawn recipe** (`pty/host.ts`): absolute claude path (Windows node-pty doesn't search %PATH%);
  env scrub of `CLAUDECODE`/`CLAUDE_CODE_*`; `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` +
  `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1`; `--permission-mode acceptEdits` + allowlist (NOT
  `--dangerously-skip-permissions`, which shows a blocking gate); `--strict-mcp-config` WITH an
  explicit `--mcp-config` (suppresses the `.mcp.json` enable prompt). This combo boots unattended.
- **Engine session id** captured via the SessionStart hook → `assets/hook-relay.mjs` →
  `/internal/hook`; persisted on receipt. New session injects the topic startup prompt; resume injects nothing.
- **MCP scoping:** session id is in the URL path (`/mcp/:sessionId`); the project is derived
  SERVER-SIDE. The agent never passes a projectId.
- **Sessions outlive viewers:** closing a ws never kills the pty. Fixed pty geometry (120×40),
  no resize. Stop: graceful (Ctrl-C ×2, clean) default, hard (`pty.kill`) escalation — both
  resumable and orphan-free (node-pty Job Object).

## Conventions
- Node 22 + TypeScript, ESM (`NodeNext`) in daemon/shared; `bundler` resolution in web.
- One config-resolution mechanism (`resolveConfig`) — never read defaults ad hoc.
- Read-only in phase 1: vault browser and git view do not write/commit/push from the UI.
