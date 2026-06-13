# Loom

A **local-first AI project workspace** that weaves real Claude Code sessions, Obsidian docs,
and task-tracking into one fabric. Sessions live serverside in a daemon-owned pty; the web UI
is a viewport that attaches/detaches. Docs and a per-project kanban are first-class.

> Clean-slate successor to Jinn. Full design in the Obsidian vault (`Projects/Loom/`).

## Quick start
```sh
pnpm install
pnpm build
pnpm daemon   # http://127.0.0.1:4317
pnpm web      # http://127.0.0.1:5317
```

## Layout
- `packages/shared` — the shared contract: types, config resolution, and the ws/REST protocol.
- `packages/daemon` — owns everything durable: SQLite, the PTY host, the HTTP/WS gateway, the task MCP server, git, and the vault auto-committer.
- `packages/web` — stateless React/Vite viewport that attaches/detaches over WebSockets.

See `CLAUDE.md` for architecture, the validated spawn recipe, and load-bearing invariants.
