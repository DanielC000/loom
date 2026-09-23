<div align="center">

<img src="docs/images/logo.svg" alt="Loom" width="320" />

### Orchestrate a fleet of real Claude Code agents — durable, review-gated, and entirely on your machine

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a> <a href="https://github.com/DanielC000/loom/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/DanielC000/loom/actions/workflows/ci.yml/badge.svg" /></a> <a href="https://github.com/DanielC000/loom/releases"><img alt="Release" src="https://img.shields.io/github/v/release/DanielC000/loom?sort=semver" /></a> <img alt="Node 22+" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" /> </p>

</div>

<p align="center">
  <img src="docs/images/hero.png" alt="Loom's Mission Control: live agent fleets across three projects on isolated git branches with context meters, an attention queue of decisions and secrets awaiting the owner, and a real-time activity feed — one phosphor-on-dark cockpit." width="100%" /> </p>

Loom orchestrates the **real interactive `claude`** — the same terminal session you'd run by hand, driven over a PTY, never a headless `claude -p` one-shot or an API-key agent loop. A daemon on your own machine owns those sessions, so they're **durable**: closing the window — or rebooting — never kills the work. Around them, one lead agent decomposes a goal, delegates to workers on isolated git branches, **reviews each diff, and merges through a build gate** — while your code, transcripts, task board, and the knowledge the fleet accumulates all stay **local, on your hardware**. It even self-hosts: Loom is built using Loom.

Because every agent is a genuine `claude` session rather than an API-key agent loop, a whole fleet of them also runs on the **Claude subscription (Pro/Max)** you already pay for — there's no separate per-token API bill for the orchestration the way there is with tools that drive the Anthropic API directly. That's an honest property, not the headline: the agents still consume your subscription's usage and live within its rate limits (Loom rides the plan you already pay for, it doesn't make Claude free), and how that usage is billed is Anthropic's policy to set and evolve.

## Features

- **🖥️ Durable real sessions, not headless.** Every agent is the genuine interactive `claude` driven
  over a PTY (`node-pty`) — never `claude -p` / headless, never an API-key agent loop — and its session is owned by a daemon, not your shell, so it's resumable and **outlives any viewer**: a closed tab or a reboot doesn't lose the thread.
- **⛓️ Review-gated multi-agent orchestration.** A lead session plans, delegates to worker sessions on
  isolated git **worktree branches**, reviews each diff, and merges through a build gate — a failing gate bounces the card back instead of merging. A lead can land a whole **batch** of ready branches in one gate run rather than paying for a gate per branch, and a change that can't affect the build doesn't pay full price for one: a documentation-only diff skips the gate outright, and an assets- or scripts-only diff runs a reduced set rather than the whole suite. Workers report up; the lead holds the whole picture. Loom even orchestrates its own development with this loop.
- **🚦 Every gate in one place.** Merge, deploy, and worker self-check gates all run daemon-wide through
  a single concurrency budget, and the **Gates** page is the god-eye view of them — which lanes are busy and which are free, what's queued behind them, and a history of settled runs with each one's kind, branch, outcome and duration, filterable per project and with a kill switch on a run that's gone wrong.
- **🗂️ Multi-repo projects.** A project can register more than one writable repository and route each
  board card to a specific repo, threaded all the way through worktree creation, the merge gate, and the per-card merged badge — so one board can drive a front end and a back end that live in separate checkouts. Separately, a project can list **reference repos**: read-only sibling checkouts a worker may consult but never write to.
- **🏠 Your data, on your hardware.** Everything Loom keeps lives on your machine — an **SQLite** store,
  your git checkouts, your transcripts, and your vault. Loom adds **no cloud service of its own**, so your code and history never leave your machine through Loom. The daemon binds to **loopback** (`127.0.0.1`) by default, and every write route behind it requires a **local access credential** — a bearer secret generated at boot and kept `0600` under `LOOM_HOME` — so another process on the same machine can't drive the API just by reaching the socket. Opening it to another device is deliberate and opt-in (see [Reach Loom from another device](#reach-loom-from-another-device)).
- **✦ A versioned knowledge layer — vault + Memory.** Design notes, decisions, and session logs live in
  an Obsidian **vault** woven alongside the code, auto-committed so they stay versioned with the work — optional, so a project can bind a repo with no vault, or be vault-only with no repo. On top of it, **Memory** is a browsable window into the durable memory the fleet itself writes and recalls, so hard-won context carries across sessions instead of being re-derived: notes show their inbound backlinks, and every note recalled into a session carries its version and age so a stale one is visible as stale.
- **📌 Decision records the code points at.** A load-bearing decision is pulled out of the comment it
  grew in and written to `docs/decisions/` (or `docs/adr/` for the architectural ones), leaving a one-line `@decision <id>` anchor behind. Reading that line in the source surfaces the record's prohibitions automatically, so the reasoning reaches the next person editing the code rather than sitting in a file nobody opens. Loom's own tree carries hundreds of them; a new project gets the store scaffolded for it.
- **◧ A task board agents can use.** Tasks are a first-class, project-scoped surface backed by an MCP
  server, so agents read the board, create cards, and move work through columns as part of the same loop you watch — rendered as a per-project kanban.
- **💳 Runs on your subscription, not metered API costs.** Because every agent is a genuine interactive
  `claude` session rather than an API-key agent loop, a whole fleet of them runs on the **Claude subscription (Pro/Max)** you already pay for — there's no per-token API bill for the orchestration the way there is with tools that call the Anthropic API directly. (Honest caveat: the agents still consume your subscription's usage and obey its rate limits.)
- **❯ The terminal cockpit.** A stateless React/Vite web viewport attaches over WebSockets and
  detaches freely, driven by a live status feed rather than polling. A collapsible instrument-rail sidebar groups every destination — Mission Control, live terminals, the Requests inbox, Runs, Gates and the session Archive to *operate*; a project's Overview, board, Memory and Repository (vault files + git) to work *in* it; Projects, Actors (profiles + skills), Companion and Automation (cron + event triggers) to *configure* it — all one phosphor-on-dark panel.
- **💬 A chat-native personal companion.** Spin up a long-lived **companion** agent you talk to over
  **Telegram** or an in-app web chat — the same durable, real-`claude` runtime, now reachable from your phone. Give it a name and it holds the thread across restarts: it keeps a **durable memory** of what matters to you (recalled automatically at the start of each chat), sets **one-shot and recurring reminders** that ping you back on your own channel, authors its own private skills, and can proactively check in. You manage it from one **Companion** page — chat plus config, channels, memory, reminders, and its persona — behind a fail-closed security model: an encrypted bot token, sender allowlists, DM pairing codes, and human-only configuration.
- **🧪 An opt-in second CLI harness (experimental).** A profile can spawn the **Codex** CLI instead of
  `claude`, pinned onto the session so every resume, fork, and recycle keeps the same harness. It's early and honestly narrower than the `claude` path: worker sessions only, a condensed doctrine instead of the full skill set, and no context or usage telemetry — Codex does surface the data, but not yet in a shape Loom is willing to guess at, so rather than silently misreport a number Loom reports the capability as absent and a lead steers those sessions by turn count instead of a context meter. Off by default; `claude` remains the harness everything else is built around.
- **🌐 Opt-in per-worker browser testing.** A worker profile can be granted its own isolated headless
  Playwright browser, so QA-style sessions can drive a running app and verify UI before reporting back.
- **🚀 Guided setup + a standing Platform operator.** A built-in **Platform** operator greets you on
  first run and stays one click away (the **Platform** page). It helps you create, configure, and archive your projects, agents, and profiles, pick your skills and workflow, and can set them up on your behalf — confirming the big moves first, on a deliberately narrow, safe tool surface.
- **🔐 An opt-in Elevated Operator.** Off by default, and off unless you turn it on in Settings: an
  *operator* session confined to the one project you start it in, allowed to switch or create local branches and commit, write into that project's vault, and push its own branch (never a force-push). It can't run host or deploy commands, reach another project, create schedules, edit Loom's bundled skills, or spawn anything. Leave it off unless you want an agent committing and pushing for you.
- **🔎 Suggest-only Workspace Auditor.** A read-only reviewer scans your own recent sessions for vague or
  ambiguous instructions in *your* agent prompts and skills, and for prompts you type repeatedly that are worth saving as one-click presets — then files improvement suggestions as cards on your board. It never changes anything itself. Run it on demand ("Review my workspace" on the Platform page) or on a schedule.
- **🧩 Editable skills, injected per session.** Loom ships a curated set of skills and mirrors them into every session as **project-local** skills, leaving your personal `~/.claude/skills` untouched — Claude Code gives a personal skill precedence over a project-local one of the same name, so Loom's names are chosen not to collide. A profile can pin **which** skills its sessions get (its own role doctrine always ships), and a built-in editor lets you read, edit, create, reset, and three-way-merge Loom's shipped updates into your own — per file, not just `SKILL.md`. Changes take effect on the next session spawn.
- **🛰️ Agents as authenticated API endpoints (Agent Runs).** Flag a project agent as an endpoint, mint a scoped API key with concurrency, token, and spend caps, then trigger structured async runs over `POST /api/runs`. The Runs page shows every run's input, result, usage, and retained transcript, with a per-key kill-switch that cancels in-flight runs.
- **🔑 Connections — bound credentials the agent never sees.** Store a credential once (say a GitHub token), encrypted at rest; a session's profile allowlists which connections it may use, and the agent reaches the API through Loom without the secret ever entering its context. Write-only and human-managed — there is no agent path to read, create, or bind one. Separately, a session that genuinely needs a secret *in hand* asks for one through the attention queue: you type it, Loom encrypts it and hands it to that project's sessions as a named environment variable, and you can revoke it later without tearing the session down.
- **⏱️ A built-in cron scheduler.** Run a manager — or the Workspace Auditor — on a cron cadence; each fire boots a real interactive session against the agent you pick, behind concurrency and usage-limit gates. Off by default; enable it in Settings.
- **📄 Opt-in document conversion.** Grant a worker profile a markitdown MCP and its sessions can convert PDFs, Office files, images, and HTML to Markdown — useful for research and document-heavy work. Off by default, human-enabled per profile.

## Quick start

You need **Node 22+** and a working `claude` CLI on your machine. **On Windows, Loom needs build 18309+ (Windows 10 version 1903, May 2019, or later, or Windows 11)** — that's node-pty's own floor for using ConPTY; below it node-pty falls back to winpty, a path Loom has never tested or claimed support for. `install.ps1` (see [One-line install](#one-line-install) below) checks this and refuses to install below it — installing directly via `npm i -g loomctl`, as below, runs **no such check**, so confirm your build meets the floor first if you're using that route. Install Loom globally from npm (published as [`loomctl`](https://www.npmjs.com/package/loomctl)) — that gives you the `loom` command:

```sh
npm i -g loomctl
loom            # boots the daemon (loopback only) and opens the cockpit in your browser
```

`loom` with no arguments starts the daemon in the foreground and opens your browser; press Ctrl-C to stop. To manage a background daemon, use the subcommands:

```sh
loom start --detach   # run the daemon in the background (writes a PID file under ~/.loom)
loom status           # is it running? — prints version, URL and PID (exit non-zero if stopped)
loom stop             # stop it gracefully and clean up
loom restart          # stop, then start (honors --detach/--port/--no-open)
loom open             # open the browser to a running daemon
loom update           # update to the latest release (npm i -g loomctl@…), then restart
```

`loom update` upgrades the global install and restarts the daemon; `loom update --channel beta` switches to (and remembers) the beta track. When a newer release is available the cockpit also shows an "update available" banner you can act on from the UI.

To have Loom **autostart in the background on login**, register it with your OS service manager:

```sh
loom service install     # register autostart (systemd --user / launchd / Task Scheduler)
loom service status      # is it registered? + is the daemon running?
loom service uninstall   # remove the autostart registration
```

`install` runs `loom start --no-open` under the OS service manager, which owns keep-alive/restart — a systemd `--user` unit on Linux, a launchd LaunchAgent on macOS, and a per-user Task Scheduler logon task on Windows (no admin required). It is idempotent (re-installing replaces cleanly) and honors `--port`. So far only the Windows path has been verified end-to-end on real hardware; the macOS and Linux artifacts are generated to spec and structurally tested but still need a live check on a Mac/Linux host.

Common flags: `-p, --port <n>` (default `4317`, or `LOOM_PORT`), `--no-open`, `-d, --detach`, `-v, --version`, `-h, --help`. Prefer not to install? Run it once with **no install** via `npx loomctl` (same flags and subcommands, e.g. `npx loomctl status`).

### One-line install

For a hands-off setup, the repo ships two installer scripts ([`install.sh`](install.sh) for macOS/Linux/WSL, [`install.ps1`](install.ps1) for Windows). They check for Node 22+ (and print a guide if it's missing — they do **not** download Node for you), run `npm i -g loomctl`, optionally register autostart, and launch Loom — all idempotent (safe to re-run; `npm i -g` upgrades in place):

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
| Skip autostart (no prompt) | `--no-service` / `LOOM_INSTALL_SERVICE=0` | `-NoService` / `$env:LOOM_INSTALL_SERVICE='0'` |
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

## Reach Loom from another device

The daemon binds to **loopback** (`127.0.0.1`) by default, and that stays the recommended shape. There are two supported ways to reach it from elsewhere: put a **tunnel** in front of the loopback daemon, or turn on Loom's own **authenticated remote bind**. The tunnel is the one to reach for first — it's less to get right, and the daemon never leaves loopback.

### Option A — a tunnel (recommended)

Put a tunnel in front that carries the authentication and encryption, and let it terminate on the host's loopback. Two well-supported options:

- **SSH local port-forward** (SSH-key auth). From the remote device, forward a local port to the
  daemon's loopback on the host:

  ```sh
  ssh -L 4317:127.0.0.1:4317 you@your-host
  # then open http://127.0.0.1:4317 on the device you're sitting at
  ```

  The SSH key authenticates you and encrypts the link; Loom still only ever sees loopback traffic.

- **Tailscale `serve`** (tailnet ACLs + WireGuard). On the host running Loom, expose the loopback daemon
  to your private tailnet:

  ```sh
  tailscale serve --bg 4317
  # reach it at https://your-host.<your-tailnet>.ts.net from any device on the tailnet
  ```

  WireGuard encrypts the connection and your tailnet ACLs decide who may reach it; the daemon is never exposed to the public internet.

In both cases the tunnel owns auth + transport security and the daemon still only ever sees loopback traffic. (Use the daemon port — `4317` by default, or whatever you set with `--port` / `LOOM_PORT`.)

### Option B — a direct authenticated bind

If you'd rather not run a tunnel, Loom can bind a non-loopback interface itself. It is **off by default** and stays off until you configure it deliberately:

- **A gateway token authenticates every remote caller.** Mint one over the loopback API
  (`POST /api/gateway-tokens`); the plaintext is returned exactly once and only the hash is stored. Tokens can be rotated, paused, or revoked — but only over that same loopback API, never over the remote bind itself, so a remote caller can never mint or revoke its own access. There's no UI for this yet; today it's a loopback REST call.
- **TLS is mandatory** for any non-loopback bind that isn't a Tailscale `.ts.net` address (a tailnet link
  is already encrypted). Point `remoteAccess.tls` at a cert and key; without readable material the daemon **refuses to open the remote listener and stays on loopback** rather than serving plaintext.
- **Routes are allowlisted, fail-closed.** Only an explicitly listed set — reads, plus the surfaces you
  need to actually answer and steer (the Requests inbox, session input/stop/resume/end, read-only terminals) — is reachable remotely. Everything else, including all configuration and every human-only writer, is loopback-only by construction: a new route is unreachable from the remote bind until someone deliberately allowlists it.
- **Remote requests are rate-limited** per caller IP and per token, with a lockout on repeated auth
  failures. The loopback path is exempt.

Setting `bindHost` to `0.0.0.0` (or `::`) is supported and puts every device on your local network in scope — still behind the same token and TLS wall, but a deliberately broad surface, so the daemon logs a plain warning at startup and Settings says so too.

Step-by-step instructions for both options live on the landing site's **Remote access** page ([`site/remote-access.html`](site/remote-access.html)).

## How it works

A single local **daemon** owns everything durable — the sessions, the PTY host that drives `claude`, the Fastify HTTP/WS gateway, an SQLite store, git, and the vault auto-committer. Git is **read-only to an ordinary project agent**: the log and branch views it can see have no write counterpart on its tool surface, and checkout/commit/push live behind a human-only route (or one of the deliberate, opt-in grants above — the Elevated Operator, the companion's git lever). The **web viewport** is stateless: it attaches to a session over a WebSocket and detaches freely, while the session keeps running on the daemon whether or not anyone is watching.

Give a **lead** agent a goal and it decomposes the goal into tasks, spawns **workers** — each on its own worktree branch, each driving a real Claude Code session — then reviews each diff, merges what passes, and keeps the vault and board versioned alongside the code. Plan, delegate, review, merge.

A run, end to end:

1. **You hand a lead a goal** — say *"add rate-limit middleware and cover it with tests."*
2. **It decomposes the goal** into cards on the project board and **delegates** each to a worker spawned on its own git worktree branch.
3. **Workers build in parallel** — each drives a real `claude` session, commits to its branch, and reports back up when it's done or blocked.
4. **The lead reviews each diff** and merges what passes through a build gate; a failing gate bounces the card back to the worker instead of merging.
5. **The board and vault stay versioned** with the code, so the whole run stays legible after the fact.

You watch it live in **Mission Control** — the fleet, context meters, an activity feed, and an attention queue that surfaces a merge the moment it needs your review.

<p align="center">
  <img src="docs/images/architecture.svg" alt="Loom architecture: a loopback daemon owning SQLite, the PTY host, the HTTP/WS gateway, git, and the vault, with a stateless web viewport attaching over WebSockets and a lead agent orchestrating worker sessions on isolated branches." width="100%" /> </p>

The monorepo (pnpm + Turbo) is three packages:

- **`packages/shared`** — the contract: types (Project / Topic / Session / Task + the session FSM),
  one config-resolution mechanism, and the ws/REST protocol.
- **`packages/daemon`** — owns everything durable: SQLite, the PTY host, the gateway, the
  project-scoped task MCP server, git, and the vault auto-committer.
- **`packages/web`** — the stateless React/Vite viewport.

## Your companion

Beyond the orchestration fleet, Loom can run a **companion** — a single long-lived agent you chat with directly, over **Telegram** or an in-app web chat, on the same daemon-owned real-`claude` runtime. It's a personal assistant rather than a project worker: it stays running across restarts, holds the thread of an ongoing conversation, and reaches you on the channel you started from.

The companion grows with you. It curates a **durable memory** of what matters — your preferences, ongoing context, things it said it would follow up on — and recalls it silently at the start of each conversation. It sets its own **reminders**, both one-shot ("remind me in 20 minutes") and recurring (on a cron schedule), which fire back to your chat as a nudge. It writes its own private **skills** for tasks worth repeating, and — when you enable a cadence — proactively checks in only when there's something genuinely worth surfacing.

What it may actually *do* is yours to grant, one lever at a time. Out of the box it talks; grant it more and it can commit and push on your behalf, against either the project's vault or its code repo — the target resolved by the daemon, never a path the agent supplies, and a push always asks you first. If you'd rather not hand out levers one by one, there's an opt-in **lead mode** that gives one companion full capability across every project; the UI states that blast radius plainly before you turn it on.

You set it up and run it from a single **Companion** page: chat on one side; configuration, channels, memory, reminders, capability grants, and its editable persona on the other. Every inbound message is treated as untrusted input, the bot token is encrypted at rest, senders are allowlisted, enrollment uses one-time DM pairing codes, and all configuration is human-only — never something the chat-reachable agent can change about itself. It can't be driven through a raw terminal either: text pushed at a companion session over the API or a terminal socket is refused outright, so nothing can put words in your mouth for it to act on.

## Screenshots

<p align="center">
  <img src="docs/images/screenshot-terminals.png" alt="Loom's terminal cockpit: a lead session and its worker fleet tiled side by side — live interactive claude transcripts, per-session context meters, branch names, and voice controls in one phosphor-on-dark panel." width="100%" /> <br /> <em>The terminal cockpit — a lead orchestrating its worker fleet, every pane a real interactive <code>claude</code> session with its own context meter and branch.</em> </p>

<p align="center">
  <img src="docs/images/screenshot-board.png" alt="Loom's per-project task board: a kanban of cards that both you and the agents read and move through columns." width="100%" /> <br /> <em>The per-project task board — a kanban you and the agents share, with live worker status and branch on each card.</em> </p>

<p align="center">
  <img src="docs/images/screenshot-terminal.png" alt="A live Loom session terminal: the real interactive claude running in a daemon-owned PTY, attached over a WebSocket." width="100%" /> <br /> <em>A live session terminal — the real interactive <code>claude</code>, attached over a WebSocket.</em> </p>

<p align="center">
  <img src="docs/images/screenshot-companion.png" alt="Loom's Companion page: a chat with a long-lived personal agent, on the same daemon-owned real-claude runtime, reachable over Telegram or in-app web chat." width="100%" /> <br /> <em>The Companion — chat with a long-lived personal agent over Telegram or in-app web chat, on the same durable runtime.</em> </p>

<p align="center">
  <img src="docs/images/screenshot-skills.png" alt="Loom's Skills store (under Actors): a SKILL.md open in the editor with save, publish-to-repo, and reset-to-shipped controls, beside the list of bundled skills." width="100%" /> <br /> <em>The editable skill store — read, edit, and three-way-merge Loom's shipped skills; changes apply on the next session spawn.</em> </p>

<p align="center">
  <img src="docs/images/screenshot-platform.png" alt="Loom's Platform page: the standing Platform operator and the suggest-only Workspace Auditor, with the auditor's run-on-a-schedule control." width="100%" /> <br /> <em>The Platform operator and suggest-only Workspace Auditor — set up your workspace and review your own sessions, on a deliberately narrow tool surface.</em> </p>

<p align="center">
  <img src="docs/images/screenshot-projects.png" alt="Loom's Projects page: the list of projects with live-session dots, a selected project's repo and vault, its agents, and an agent's editable startup prompt." width="100%" /> <br /> <em>The Projects page — create and manage projects and their agents, each agent carrying an editable startup prompt injected as its first turn.</em> </p>

## Docs & links

- [`CLAUDE.md`](CLAUDE.md) — architecture, the validated gate-free spawn recipe, and the load-bearing
  invariants (start here to hack on Loom).
- [`docs/decisions/`](docs/decisions) and [`docs/adr/`](docs/adr) — the decision records the
  `@decision` anchors in the source point at; [`docs/investigations/`](docs/investigations) holds the incident write-ups.
- [`docs/releasing.md`](docs/releasing.md) — the packaging, versioning, and release runbook.
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes per version.

## Contributing & community

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) to get set up and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the community standards we hold. To report a security issue, follow the process in [`SECURITY.md`](SECURITY.md) rather than opening a public issue.

## License

Loom is released under the [MIT License](LICENSE).
