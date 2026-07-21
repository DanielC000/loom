# Contributing to Loom

Thanks for your interest in Loom — orchestrate a fleet of real Claude Code agents on your Claude subscription (Pro/Max), not per-token API bills, all local-first on your own machine. This guide covers getting set up, the repo layout, the test/build gates a change must pass, and the branch/PR conventions.

> `CLAUDE.md` at the repo root is the authoritative, checked-in summary of architecture, the validated
> `claude` spawn recipe, and the load-bearing invariants — **read it before changing daemon behavior.**

## Prerequisites

- **Node 22+** (the workspace targets Node 22, ESM throughout).
- **pnpm 10.6.4** — the repo's `packageManager`. Use Corepack (`corepack enable`) or install pnpm
  directly. pnpm is a **contributor tool**; end users of the published package need only Node.

## Setup

```sh
pnpm install
pnpm build          # builds shared first (turbo ^build), then daemon + web
pnpm daemon         # dev daemon (tsx watch) on http://127.0.0.1:4317 (loopback only)
pnpm web            # viewport on http://127.0.0.1:5317 (proxies /api + /ws to the daemon)
```

The daemon binds loopback (`127.0.0.1`) only. The web app is a stateless viewport that attaches to the daemon over WebSockets — closing the browser never kills a running session.

## Monorepo layout

Loom is a pnpm + Turbo monorepo with three packages:

- **`packages/shared`** — the contract: `types` (Project/Topic/Session/Task + the Session FSM),
  `config` (one `resolveConfig`: platform default → per-project override), and `protocol` (ws/REST).
- **`packages/daemon`** — owns everything durable: SQLite (`db.ts`), the PTY host (`pty/host.ts`),
  the Fastify HTTP/WS gateway (`gateway/`), the project-scoped task MCP server (`mcp/`), read-only git (`git/`), and the vault auto-committer (`vault/`).
- **`packages/web`** — the stateless React/Vite viewport.

`shared` is the dependency root — `pnpm build` builds it first via Turbo's `^build` ordering.

## The gates a change must pass

CI (`.github/workflows/ci.yml`) runs these two on every PR and `main` push; run them locally first.

### 1. Build

```sh
pnpm build
```

Must be green. This is the primary definition-of-done gate.

### 2. Daemon test suite (hermetic)

The daemon ships a hermetic, `claude`-free test suite under `packages/daemon/test/*.mjs`, run via a single runner:

```sh
pnpm --filter @loom/daemon build        # tests import dist/, so build first
pnpm --filter @loom/daemon test:daemon  # scripts/test-daemon.mjs
```

The runner (`packages/daemon/scripts/test-daemon.mjs`) DISCOVERS tests by glob over `test/*.mjs` (mirrors the web suite) — a new hermetic test file needs no edit here. Each test runs **isolated by construction**: its own fresh temp `LOOM_HOME`, a non-4317 `LOOM_PORT`, and `LOOM_TEST=1` — so running the tests can never touch your real `~/.loom/loom.db` or a daemon on `:4317`. Tests spawn no real `claude` and boot no external daemon.

A few tests are **not** in the hermetic runner because they need a human-started isolated daemon and/or a real `claude` login (e.g. `integration-e2e`, `orchestration-e2e`, `manager-live`) — they're excluded via the small `NOT_HERMETIC` denylist in `scripts/test-daemon.mjs`. Run those manually per the header comment in each file.

Booting your own throwaway daemon against a fresh `LOOM_HOME` (e.g. to eyeball the web UI, or to seed a clean demo for a screenshot)? Set `LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1` — otherwise the daemon's first-run auto-launch spawns a real `claude` process (the Setup/Platform operator) before you get a chance to stamp the marker yourself. The daemon still boots normally and the marker is still written; only that one auto-spawn is skipped. Also set `LOOM_SUPPRESS_USAGE_POLLER=1` — otherwise the plan-usage poller reads and serves *your real account's* Claude usage (5h/7d utilization) over `GET /api/usage/limits`, even on a throwaway daemon with an empty seeded DB.

## Conventions

- **TypeScript + ESM.** Node 22, `NodeNext` module resolution in daemon/shared; `bundler` resolution
  in web. Match the style of the surrounding code.
- **One config-resolution mechanism.** Always go through `resolveConfig` — never read defaults ad hoc.
- **Trust boundaries are real.** Vault writes, git writes (checkout/commit/push/create-branch), and
  `gateCommand` are exposed only through a **human-only REST surface** — never as an agent MCP tool. Don't widen that surface. See `CLAUDE.md` › *Conventions* and *Load-bearing invariants*.
- **Don't regress the load-bearing invariants** documented in `CLAUDE.md` (the `claude` spawn recipe,
  session/MCP scoping, sessions-outlive-viewers, worktree dep-provisioning, etc.).

## Branches & pull requests

- Branch off `main`; keep one logical change per PR.
- Make sure `pnpm build` and the hermetic daemon suite are green locally before opening the PR.
- Write a clear PR description: what changed, why, and how you verified it. The PR template prompts
  for these.
- Keep commit messages clear and scoped. Plain commits land under the repo's configured identity —
  don't add personal-email or `Co-Authored-By` overrides.

## Releasing

Cutting a release (version bump, changelog, tag, npm publish) is owner-gated and documented in [`docs/releasing.md`](docs/releasing.md). Contributors don't publish.

## Reporting bugs & security issues

- **Bugs / features:** open a GitHub issue using the templates under `.github/ISSUE_TEMPLATE/`.
- **Security vulnerabilities:** do **not** open a public issue — see [`SECURITY.md`](SECURITY.md).
