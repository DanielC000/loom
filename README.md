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

See `CLAUDE.md` for architecture, the validated spawn recipe, and load-bearing invariants.
The `spike/` folder is the throwaway de-risking prototype (kept for reference).
