<div align="center">

<img src="docs/images/logo.svg" alt="Loom" width="320" />

### A local-first cockpit for real Claude Code sessions

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/DanielC000/loom/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/DanielC000/loom/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/DanielC000/loom/releases"><img alt="Release" src="https://img.shields.io/github/v/release/DanielC000/loom?sort=semver" /></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" />
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
- **🚀 Guided setup + a standing Platform operator.** A built-in **Platform** operator greets you on
  first run and stays one click away (the **Platform** page). It helps you create, configure, and archive
  your projects, agents, and profiles, pick your skills and workflow, and can set them up on your behalf —
  confirming the big moves first, on a deliberately narrow, safe tool surface.
- **🔎 Suggest-only Workspace Auditor.** A read-only reviewer scans your own recent sessions for vague or
  ambiguous instructions in *your* agent prompts and skills, and for prompts you type repeatedly that are
  worth saving as one-click presets — then files improvement suggestions as cards on your board. It never
  changes anything itself. Run it on demand ("Review my workspace" on the Platform page) or on a schedule.

## Quick start

You need **Node 22+** and a working `claude` CLI on your machine. Install Loom globally from npm
(published as [`loomctl`](https://www.npmjs.com/package/loomctl)) — that gives you the `loom` command:

```sh
npm i -g loomctl
loom            # boots the daemon (loopback only) and opens the cockpit in your browser
```

`loom` with no arguments starts the daemon in the foreground and opens your browser; press Ctrl-C to
stop. To manage a background daemon, use the subcommands:

```sh
loom start --detach   # run the daemon in the background (writes a PID file under ~/.loom)
loom status           # is it running? — prints version, URL and PID (exit non-zero if stopped)
loom stop             # stop it gracefully and clean up
loom restart          # stop, then start (honors --detach/--port/--no-open)
loom open             # open the browser to a running daemon
loom update           # update to the latest release (npm i -g loomctl@…), then restart
```

`loom update` upgrades the global install and restarts the daemon; `loom update --channel beta` switches
to (and remembers) the beta track. When a newer release is available the cockpit also shows an
"update available" banner you can act on from the UI.

To have Loom **autostart in the background on login**, register it with your OS service manager:

```sh
loom service install     # register autostart (systemd --user / launchd / Task Scheduler)
loom service status      # is it registered? + is the daemon running?
loom service uninstall   # remove the autostart registration
```

`install` runs `loom start --no-open` under the OS service manager, which owns keep-alive/restart —
a systemd `--user` unit on Linux, a launchd LaunchAgent on macOS, and a per-user Task Scheduler logon
task on Windows (no admin required). It is idempotent (re-installing replaces cleanly) and honors
`--port`. So far only the Windows path has been verified end-to-end on real hardware; the macOS and
Linux artifacts are generated to spec and structurally tested but still need a live check on a Mac/Linux host.

Common flags: `-p, --port <n>` (default `4317`, or `LOOM_PORT`), `--no-open`, `-d, --detach`,
`-v, --version`, `-h, --help`. Prefer not to install? Run it once with **no install** via
`npx loomctl` (same flags and subcommands, e.g. `npx loomctl status`).

### One-line install

For a hands-off setup, the repo ships two installer scripts ([`install.sh`](install.sh) for
macOS/Linux/WSL, [`install.ps1`](install.ps1) for Windows). They check for Node 22+ (and print a guide
if it's missing — they do **not** download Node for you), run `npm i -g loomctl`, optionally register
autostart, and launch Loom — all idempotent (safe to re-run; `npm i -g` upgrades in place):

```sh
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/DanielC000/loom/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/DanielC000/loom/main/install.ps1 | iex
```

Because `curl … | sh` and `irm … | iex` have no interactive prompt, drive optional steps with flags
(local-file runs) or env vars (piped runs):

| Behaviour                  | sh flag / env                         | PowerShell flag / env                       |
| -------------------------- | ------------------------------------- | ------------------------------------------- |
| Register autostart         | `--service` / `LOOM_INSTALL_SERVICE=1`| `-Service` / `$env:LOOM_INSTALL_SERVICE='1'`|
| Don't launch the daemon    | `--no-start` / `LOOM_INSTALL_START=0` | `-NoStart` / `$env:LOOM_INSTALL_START='0'`  |
| Install a specific source  | `--source <spec>` / `LOOM_INSTALL_SOURCE` | `-Source <spec>` / `$env:LOOM_INSTALL_SOURCE` |
| Port                       | `--port <n>` / `LOOM_PORT`            | `-Port <n>` / `$env:LOOM_PORT`              |

> **⚠ Piping a script straight to a shell runs unreviewed code.** The one-liners above fetch the
> installers from this repo over **HTTPS** (raw GitHub) and execute them. If you'd rather inspect first,
> clone the repo and run them by local path (`sh install.sh` / `pwsh -ExecutionPolicy Bypass -File
> install.ps1`), or download the script, verify its **SHA-256 checksum**, then run it. (A vanity/Pages
> URL may front these raw links later; the raw-GitHub URLs above resolve today.)

### From source (contributors)

pnpm is the contributor toolchain. From a clone of the repo:

```sh
pnpm install
pnpm build          # builds the shared contract first
pnpm daemon         # the daemon on http://127.0.0.1:4317 (loopback only)
pnpm web            # the viewport on http://127.0.0.1:5317
```

Open `http://127.0.0.1:5317` and you're in the cockpit. See
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
