<div align="center">

<img src="docs/images/logo.svg" alt="Loom" width="320" />

### A local-first cockpit for real Claude Code sessions

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/DanielC000/loom/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/DanielC000/loom/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/DanielC000/loom/releases"><img alt="Release" src="https://img.shields.io/github/v/release/DanielC000/loom?sort=semver" /></a>
  <img alt="Node >=22" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" />
</p>

</div>

<p align="center">
  <img src="docs/images/hero.png" alt="Loom's Mission Control: a lead agent and three worker sessions on isolated git branches with live context meters, an attention queue with a merge awaiting review, and a real-time activity feed — one phosphor-on-dark cockpit." width="100%" />
</p>

Loom is a local-first AI project workspace that drives the **real interactive `claude`** — the same
terminal session you'd run by hand, not a headless one-shot — and keeps it durable. Sessions are owned
by a daemon on your machine, so closing the window never kills the work. Around those sessions Loom
binds your Obsidian vault and a per-project task board into a single view, and lets one lead agent
decompose a goal, delegate to workers on isolated branches, review their diffs, and merge. It even
self-hosts: Loom is built using Loom.

## Features

- **🖥️ Real Claude Code sessions, not headless.** Loom drives the genuine interactive `claude` over a
  PTY (`node-pty`) — never `claude -p` / headless one-shots. Sessions are resumable and **outlive any
  viewer**, so a closed tab or a reboot doesn't lose the thread.
- **⛓️ Multi-agent orchestration.** A lead session plans, delegates to worker sessions on isolated
  git **worktree branches**, reviews each diff, and merges through a gate. Workers report up; the lead
  holds the whole picture. Loom even orchestrates its own development with this loop.
- **🔒 Local-first by design.** Everything durable lives on your machine: a daemon bound to
  **loopback only** (`127.0.0.1`), an **SQLite** store, your git checkouts, and your vault. No cloud
  service sits between you and your work.
- **✦ Vault-backed knowledge.** Design notes, decisions, and session logs live in an Obsidian vault
  woven alongside the code, and Loom auto-commits vault writes so the knowledge layer stays versioned
  with the work.
- **◧ A task board agents can use.** Tasks are a first-class, project-scoped surface backed by an MCP
  server, so agents read the board, create cards, and move work through columns as part of the same
  loop you watch — rendered as a per-project kanban.
- **❯ The terminal cockpit.** A stateless React/Vite web viewport attaches over WebSockets and
  detaches freely: Mission Control, the task board, live terminals, runs, and git — one
  phosphor-on-dark instrument panel.
- **🌐 Opt-in per-worker browser testing.** A worker profile can be granted its own isolated headless
  Playwright browser, so QA-style sessions can drive a running app and verify UI before reporting back.

## Quick start

You need **Node 22+** and a working `claude` CLI on your machine. From a clone of the repo (pnpm is the
contributor toolchain):

```sh
pnpm install
pnpm build          # builds the shared contract first
pnpm daemon         # the daemon on http://127.0.0.1:4317 (loopback only)
pnpm web            # the viewport on http://127.0.0.1:5317
```

Open `http://127.0.0.1:5317` and you're in the cockpit.

The packaged path — a single `npx loom` that boots the daemon, waits for the gateway, and opens the
browser — is the **intended install** for end users (Node 22+, no pnpm needed). Loom is pre-1.0 and
**not yet published to npm**; until it is, build from source as above. See
[`docs/releasing.md`](docs/releasing.md) for the packaging and release flow.

## How it works

A single local **daemon** owns everything durable — the sessions, the PTY host that drives `claude`,
the Fastify HTTP/WS gateway, an SQLite store, read-only git, and the vault auto-committer. The
**web viewport** is stateless: it attaches to a session over a WebSocket and detaches freely, while the
session keeps running on the daemon whether or not anyone is watching.

Give a **lead** agent a goal and it decomposes the goal into tasks, spawns **workers** — each on its own
worktree branch, each driving a real Claude Code session — then reviews each diff, merges what passes,
and keeps the vault and board versioned alongside the code. Plan, delegate, review, merge.

<p align="center">
  <img src="docs/images/architecture.svg" alt="Loom architecture: a loopback daemon owning SQLite, the PTY host, the HTTP/WS gateway, git, and the vault, with a stateless web viewport attaching over WebSockets and a lead agent orchestrating worker sessions on isolated branches." width="100%" />
</p>

The monorepo (pnpm + Turbo) is three packages:

- **`packages/shared`** — the contract: types (Project / Topic / Session / Task + the session FSM),
  one config-resolution mechanism, and the ws/REST protocol.
- **`packages/daemon`** — owns everything durable: SQLite, the PTY host, the gateway, the
  project-scoped task MCP server, read-only git, and the vault auto-committer.
- **`packages/web`** — the stateless React/Vite viewport.

## Screenshots

<p align="center">
  <img src="docs/images/screenshot-board.png" alt="Loom's per-project task board: a kanban of cards that both you and the agents read and move through columns." width="100%" />
  <br />
  <em>The per-project task board — a kanban you and the agents share, with live worker status and branch on each card.</em>
</p>

<p align="center">
  <img src="docs/images/screenshot-terminal.png" alt="A live Loom session terminal: the real interactive claude running in a daemon-owned PTY, attached over a WebSocket." width="100%" />
  <br />
  <em>A live session terminal — the real interactive <code>claude</code>, attached over a WebSocket.</em>
</p>

## Docs & links

- [`CLAUDE.md`](CLAUDE.md) — architecture, the validated gate-free spawn recipe, and the load-bearing
  invariants (start here to hack on Loom).
- [`docs/releasing.md`](docs/releasing.md) — the packaging, versioning, and release runbook.
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes per version.

## Contributing & community

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) to get set up and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the community standards we hold. To report a security
issue, follow the process in [`SECURITY.md`](SECURITY.md) rather than opening a public issue.

## License

Loom is released under the [MIT License](LICENSE).
