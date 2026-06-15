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

## Run
```sh
pnpm install
pnpm build          # builds shared first (turbo ^build)
pnpm daemon         # dev daemon (tsx watch) on http://127.0.0.1:4317 (loopback only)
pnpm web            # viewport on http://127.0.0.1:5317 (proxies /api + /ws to the daemon)
```

**`LOOM_DEV` (dev-only Platform layer):** the **Platform layer** — the reserved "Loom Platform" project
+ Platform Lead/Auditor agents, the Platform-lead/Platform-audit profiles, and the platform-lead/
platform-audit skills — is gated behind `LOOM_DEV=1` (default OFF) and does **not** ship to regular
`loomctl` users (the npm build omits the two platform skills from `assets/skills/`). It stays in the repo
and loads only in dev: boot the daemon with `LOOM_DEV=1` (e.g. `LOOM_DEV=1 pnpm daemon`) to seed it. The
flag is read in ONE helper (`paths.ts` › `isLoomDev`, same shape as `LOOM_SCHEDULER_ENABLED`); CORE
orchestration (Orchestrator/Dev/Bugfix/QA/Web Designer + their skills) always seeds, flag or not.

**Self-hosting (orchestrating Loom WITH Loom):** use `pnpm daemon:stable`, not `pnpm daemon`.
The dev daemon runs under `tsx watch`, so any worker merge that lands a change under
`packages/daemon/src/**` (or `shared/dist`) restarts it mid-orchestration and kills the live
manager/worker PTYs (the watch-restart-kills-PTYs gotcha — it caused an overnight cascade on
2026-06-03). `daemon:stable` runs the **supervisor** (`scripts/daemon-supervisor.mjs`): it builds
once and runs the daemon from `dist/` with **no watcher**, so source merges don't restart the running
daemon. The supervisor relaunches **only** on the explicit restart sentinel (exit `75`); any other
exit (incl. a crash) stops the loop, so a broken daemon stays visibly down instead of crash-looping.
- **Manager self-restart:** under the supervisor, a manager that has merged daemon-`src` can make that
  code go live itself via the `daemon_restart` orchestration tool — it rebuilds first (a failed build
  aborts the restart and leaves the daemon up), then exits `75`; the supervisor relaunches and boot
  re-resumes the manager + its live workers (via `~/.loom/restart-intent.json`) with a "code is live"
  note. Outside the supervisor the tool refuses (nothing would relaunch the daemon).
- **Caveat:** `assets/**` (hook-relay, vault-lint, bundled skills) is read live from the package dir,
  so asset merges take effect on the next spawn without a restart. For full isolation, run the stable
  daemon from a separate checkout (shares `~/.loom` state; override `LOOM_HOME`/`LOOM_PORT` for two
  daemons side by side).

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
- **Opt-in worker browser (`browserTesting`):** a session whose resolved Profile sets `browserTesting`
  spawns with its OWN per-session stdio Playwright MCP (`@playwright/mcp`, absolute node + absolute
  `cli.js`, `--headless --isolated`) and that tool surface allowlisted. Default OFF + fully additive
  (every existing spawn byte-identical when off); pinned on the session row so resume/fork/recycle
  keep the browser. HUMAN-set only (Profiles UI/REST) — never an agent MCP tool (same capability-gating
  posture as gateCommand/shell). The MCP launches Chromium lazily on first use; needs a one-time
  `npx playwright install chromium`. The bundled "QA Tester" profile is the browser-capable rig.
- **Worktree dep-provisioning (`git/worktrees.ts`):** `createWorktree` best-effort-installs deps at
  creation so a worker boots build-ready. It picks the package manager by lockfile marker IN the worktree
  root — deterministic precedence pnpm (`pnpm-lock.yaml`) → npm (`package-lock.json`) → yarn (`yarn.lock`),
  no marker → no-op — and runs the matching install ASYNC + bounded by `PROVISION_TIMEOUT_MS`, best-effort
  (all failures swallowed; the worker installs on its own), HARDCODED commands (never agent input). Each
  worktree gets its OWN node_modules; node_modules is NEVER shared/symlinked/junctioned across worktrees
  (native modules + concurrent install-state would break — load-bearing). **A fresh worktree does NOT carry
  gitignored files — notably `.env`/secrets are absent.** A worker that needs env vars must be told so in
  its kickoff; provisioning deliberately does not copy or widen the secret surface.

## Conventions
- Node 22 + TypeScript, ESM (`NodeNext`) in daemon/shared; `bundler` resolution in web.
- One config-resolution mechanism (`resolveConfig`) — never read defaults ad hoc.
- Vault + git writes are enabled via a HUMAN-only REST surface (vault: `vault/writer.ts`; git:
  `git/writer.ts` — checkout/commit/push/create-branch). These are trust-boundary surfaces like
  gateCommand: NO agent MCP tool exposes them; an agent can never write/commit/push from a session.
  Every git write is bounded + non-interactive (`GIT_TERMINAL_PROMPT=0` + timeout) so a hung push
  can't wedge the daemon. The read-only log/branches view is unchanged.
