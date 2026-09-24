<div align="center">

<img src="docs/images/logo.svg" alt="Loom" width="320" />

### Orchestrate a fleet of real Claude Code agents — durable, review-gated, and entirely on your machine

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a> <a href="https://github.com/DanielC000/loom/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/DanielC000/loom/actions/workflows/ci.yml/badge.svg" /></a> <a href="https://github.com/DanielC000/loom/releases"><img alt="Release" src="https://img.shields.io/github/v/release/DanielC000/loom?sort=semver" /></a> <img alt="Node 22+" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" /> </p>

</div>

<p align="center">
  <img src="docs/images/hero.png" alt="Loom's Mission Control: live agent fleets across three projects on isolated git branches with context meters, an attention queue of decisions and inputs awaiting the owner, and a real-time activity feed — one phosphor-on-dark cockpit." width="100%" /> </p>

Loom orchestrates the **real interactive `claude`** — the same terminal session you'd run by hand, driven over a PTY, never a headless `claude -p` one-shot or an API-key agent loop. A daemon on your own machine owns those sessions, so they're **durable**: closing the window — or rebooting — never kills the work. Around them, one lead agent decomposes a goal, delegates to workers on isolated git branches, **reviews each diff, and merges through a build gate** — while your code, transcripts, task board, and the knowledge the fleet accumulates all stay **local, on your hardware**. It even self-hosts: Loom is built using Loom.

Because every agent is a genuine `claude` session rather than an API-key agent loop, a whole fleet of them also runs on the **Claude subscription (Pro/Max)** you already pay for — there's no separate per-token API bill for the orchestration the way there is with tools that drive the Anthropic API directly. That's an honest property, not the headline: the agents still consume your subscription's usage and live within its rate limits (Loom rides the plan you already pay for, it doesn't make Claude free), and how that usage is billed is Anthropic's policy to set and evolve.

## Features

- **🖥️ Durable real sessions, not headless.** Every agent is the genuine interactive `claude` driven
  over a PTY (`node-pty`) — never `claude -p` / headless, never an API-key agent loop — and its session is owned by a daemon, not your shell, so it's resumable and **outlives any viewer**: a closed tab or a reboot doesn't lose the thread.
- **⛓️ Review-gated multi-agent orchestration.** A lead session plans, delegates to worker sessions on
  isolated git **worktree branches**, reviews each diff, and merges through a build gate — a failing gate bounces the card back instead of merging. A lead can land a whole **batch** of ready branches in one gate run rather than paying for a gate per branch, and a change that can't affect the build doesn't pay full price for one: a documentation-only diff skips the gate outright, and an assets- or scripts-only diff runs a reduced set rather than the whole suite. Workers report up; the lead holds the whole picture. Loom even orchestrates its own development with this loop.
- **🚦 Every gate in one place.** Merge, deploy, and worker self-check gates all run daemon-wide through
  a single concurrency budget, and the **Gates** page is the god-eye view of them — which lanes are busy and which are free, what's queued behind them, and a history of settled runs with each one's kind, branch, outcome and duration, filterable per project. It's a read-only instrument — cancelling a run happens on the agent tool surface, not with a button here.
- **🗂️ Multi-repo projects.** A project can register more than one writable repository and route each
  board card to a specific repo, threaded all the way through worktree creation, the merge gate, and the per-card merged badge — so one board can drive a front end and a back end that live in separate checkouts. Separately, a project can list **reference repos**: read-only sibling checkouts a worker may consult but never write to.
- **🏠 Your data, on your hardware.** Everything Loom keeps lives on your machine — an **SQLite** store,
  your git checkouts, your transcripts, and your vault. Loom adds **no cloud service of its own** — there is no Loom account, no Loom server, and nothing phones home. The daemon binds to **loopback** (`127.0.0.1`) by default, and every write route behind it requires a **local access credential** — a bearer secret generated at boot and kept `0600` under `LOOM_HOME` — so another process on the same machine can't drive the API just by reaching the socket. Opening it to another device is deliberate and opt-in (see [Reach Loom from another device](#reach-loom-from-another-device)). Outbound traffic is the same story: every path that leaves your machine is one you turn on yourself — the agents' own calls to Anthropic, the Telegram companion if you bind a bot, an alert webhook if you configure one, a Connection if you bind an API.
- **✦ A versioned knowledge layer — vault + Memory.** Design notes, decisions, and session logs live in
  an Obsidian **vault** woven alongside the code, auto-committed so they stay versioned with the work — optional, so a project can bind a repo with no vault, or be vault-only with no repo. On top of it, **Memory** is a browsable window into the durable memory the fleet itself writes and recalls, so hard-won context carries across sessions instead of being re-derived: notes show their inbound backlinks, and every note recalled into a session carries its version and age so a stale one is visible as stale.
- **📌 Decision records the code points at.** A load-bearing decision is pulled out of the comment it
  grew in and written to `docs/decisions/` (or `docs/adr/` for the architectural ones), leaving a one-line `@decision <id>` anchor behind. Reading that line in the source surfaces the record's prohibitions automatically, so the reasoning reaches the next person editing the code rather than sitting in a file nobody opens. Loom's own tree carries hundreds of them; a project Loom creates from scratch for you gets the store scaffolded (binding a repo you already have leaves its tree alone — the first record you write creates the folder).
- **◧ A task board agents can use.** Tasks are a first-class, project-scoped surface backed by an MCP
  server, so agents read the board, create cards, and move work through columns as part of the same loop you watch — rendered as a per-project kanban.
- **💳 Runs on your subscription, not metered API costs.** Because every agent is a genuine interactive
  `claude` session rather than an API-key agent loop, a whole fleet of them runs on the **Claude subscription (Pro/Max)** you already pay for — there's no per-token API bill for the orchestration the way there is with tools that call the Anthropic API directly. (Honest caveat: the agents still consume your subscription's usage and obey its rate limits.)
- **❯ The terminal cockpit.** A stateless React/Vite web viewport attaches over WebSockets and
  detaches freely, driven by a live status feed rather than polling. A collapsible instrument-rail sidebar groups every destination — Mission Control, live terminals, the Requests inbox, Runs, Gates and the session Archive to *operate*; a project's Overview, board, Memory and Repository (vault files + git) to work *in* it; Projects, Actors (profiles + skills), Companion and Automation (cron + event triggers) to *configure* it — all one phosphor-on-dark panel.
- **💬 A chat-native personal companion.** Spin up a long-lived **companion** agent you talk to over
  **Telegram** or an in-app web chat — the same durable, real-`claude` runtime, now reachable from your phone. Give it a name and it holds the thread across restarts: it keeps a **durable memory** of what matters to you (recalled automatically at the start of each chat), sets **one-shot and recurring reminders** that ping you back on your own channel, authors its own private skills, and can proactively check in. You manage it from one **Companion** page — chat plus config, channels, memory, reminders, and its persona — behind a fail-closed security model: an encrypted bot token, sender allowlists, DM pairing codes, and human-only configuration.
- **🧪 An opt-in second CLI harness (experimental).** A profile can spawn the **Codex** CLI instead of
  `claude`, pinned onto the session so every resume, fork, and recycle keeps the same harness. It's early and honestly narrower than the `claude` path. Codex has no skill-invocation tool, so instead of Loom's full skill set a session gets a condensed worker doctrine written into its `AGENTS.md` — and only a **worker** session gets even that: the harness field itself isn't role-gated, so a profile on another role can select Codex and will simply boot without any Loom doctrine. There's no context or usage telemetry either — Codex does surface the data, but not yet in a shape Loom is willing to guess at, so rather than silently misreport a number Loom reports the capability as absent and a lead steers those sessions by turn count instead of a context meter. Per-profile capabilities that need a stdio MCP (browser testing, document conversion) and per-tool restrictions are refused outright on a Codex profile rather than silently dropped. Off by default; `claude` remains the harness everything else is built around.
- **🌐 Opt-in per-worker browser testing.** A worker profile can be granted its own isolated headless
  Playwright browser, so QA-style sessions can drive a running app and verify UI before reporting back.
- **🚀 Guided setup + a standing Platform operator.** A built-in **Platform** operator greets you on
  first run and stays one click away (the **Platform** page). It helps you create and configure your projects, agents, and profiles, pick your skills and workflow, and can set them up on your behalf — confirming the big moves first, on a deliberately narrow, safe tool surface. The one lifecycle move it has is archiving a *project*: soft, reversible, and refused on a reserved one. It can't archive or delete an agent or a profile.
- **🔐 An opt-in Elevated Operator.** Off by default, and off unless you turn it on in Settings: an
  *operator* session confined to the one project you start it in, with seven tools and no more: switch or create a local branch, commit, push, write into that project's vault, read its own project, and end itself. None of them takes a project id — the target is always resolved from the session, so an operator bound to one project structurally cannot reach another. Nothing on that surface configures the project, runs its gate or deploy command, creates a schedule, edits Loom's bundled skills, or spawns a session. **Read the boundary precisely, though:** it is a *tool-surface* boundary, not a sandbox. Like any other session it still has its own shell in its own working directory, so "the push tool never forces" is a statement about `git_push`, not a guarantee the session can't run `git push --force` itself. Leave it off unless you want an agent committing and pushing for you.
- **🔎 Suggest-only Workspace Auditor.** A read-only reviewer scans your own recent sessions for vague or
  ambiguous instructions in *your* agent prompts and skills, and for prompts you type repeatedly that are worth saving as one-click presets — then files improvement suggestions as cards on your board. It never changes anything itself. Run it on demand ("Review my workspace" on the Platform page) or on a schedule.
- **🧩 Editable skills, injected per session.** Loom ships a curated set of skills and mirrors them into every session as **project-local** skills, leaving your personal `~/.claude/skills` untouched — Claude Code gives a personal skill precedence over a project-local one of the same name, so Loom's names are chosen not to collide. A profile can pin **which** skills its sessions get (its own role doctrine always ships), and a built-in editor lets you read, edit, create, and reset them. When a shipped update lands on a skill you've edited, its `SKILL.md` goes through a real three-way merge with per-hunk conflict resolution; the skill's other files (references, scripts) get a simpler per-file choice — take yours or take the shipped one — and any of them you never touched is fast-forwarded for you. Changes take effect on the next session spawn.
- **🛰️ Agents as authenticated API endpoints (Agent Runs).** Flag a project agent as an endpoint, mint a scoped API key with concurrency, token, and spend caps, then trigger structured async runs over `POST /api/runs`. The Runs page shows every run's input, result, usage, and retained transcript, with a per-key kill-switch that cancels in-flight runs.
- **🔑 Connections — bound credentials the agent never sees.** Store a credential once (say a GitHub token), encrypted at rest; a session's profile allowlists which connections it may use, and the agent reaches the API through Loom without the secret ever entering its context. Write-only and human-managed — there is no agent path to read, create, or bind one. Separately, a session that genuinely needs a secret *in hand* asks for one through the attention queue: you type it, Loom encrypts it and hands it to that project's sessions as a named environment variable. You can revoke it later, but be clear on what that buys you: revocation is **de-provisioning, not containment**. It stops future delivery — a session already running keeps the value in its process environment until it next resumes, and nothing can reach in and take it back. Treat a leaked secret as leaked and rotate it at the source.
- **⏱️ A built-in cron scheduler.** Run a manager — or the Workspace Auditor — on a cron cadence; each fire boots a real interactive session against the agent you pick, behind concurrency and usage-limit gates. Off by default; enable it in Settings, and restart the daemon — the ticker is armed once at boot, so the toggle takes effect on the next start, not immediately.
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

Open `http://127.0.0.1:5317` and you're in the cockpit. One catch on that dev origin: the **local access
credential** every write route needs is stored per browser origin, and the Vite dev server is a different
origin from the daemon's own — so a token you captured on `:4317` is invisible on `:5317`. Visit
`http://127.0.0.1:5317/?token=<credential>` once (the daemon prints this instruction, and the path to the
key file, on startup) or every write comes back `401` and the terminal panes stay blank. See
[`docs/releasing.md`](docs/releasing.md) for the packaging and release flow.

## Reach Loom from another device

The daemon binds to **loopback** (`127.0.0.1`) by default, and that stays the recommended shape. The path that works end to end today is an **SSH local port-forward**: the daemon never leaves loopback, and there's nothing new to configure inside Loom.

### An SSH tunnel (recommended)

From the remote device, forward a local port to the daemon's loopback on the host:

```sh
ssh -L 4317:127.0.0.1:4317 you@your-host
# then open http://127.0.0.1:4317 on the device you're sitting at
```

The SSH key authenticates you and encrypts the link; Loom still only ever sees loopback traffic, arriving on the interface it already trusts. (Use the daemon port — `4317` by default, or whatever you set with `--port` / `LOOM_PORT`.)

**Then do the one-time token step, or the cockpit looks broken.** The **local access credential** is required on every write and on the terminal socket, even over a tunnel, and a browser on the far end has never been handed it. Before you do this, the page loads and reads fine, but every action fails with *"unauthorized — see `loom open` for how to obtain the local access credential"* and every terminal pane sits blank — and `loom open`, the advice in that message, is a command on the *host*, which is not the machine you're sitting at. Fix it once per device by opening the URL with the token appended:

```
http://127.0.0.1:4317/?token=<credential>
```

The browser stores it and strips it from the address bar. The credential is the contents of `~/.loom/gateway-loopback.key` under `LOOM_HOME` on the host; it's stored per browser origin, and anything holding it can drive the full loopback API — so treat it like a password.

> **⚠ Tailscale `serve` does not work today.** `tailscale serve --bg 4317` looks like the same shape as the SSH tunnel and was recommended here previously, but the daemon's CSRF guard refuses a request whose `Origin` isn't loopback, before any other check — and a browser on `https://your-host.<tailnet>.ts.net` sends exactly that origin on every write and every WebSocket upgrade, so both come back `403`. The DNS-rebind guard applies the same rule to the `Host` header on reads, so depending on how Serve proxies it the cockpit may not load at all. This is a gap in Loom, not in Tailscale; it's tracked, and until it's fixed use the SSH forward above. (A `.ts.net` address as the `bindHost` of a *direct* bind, below, is a different thing and is unaffected.)

### A direct authenticated bind (an API surface, not a cockpit)

Loom can also bind a non-loopback interface itself. It is **off by default**, and it is best understood as an **authenticated API surface rather than a second way to open the cockpit** — the SPA's own routes are not on the remote allowlist, so a remote browser is refused the page itself. What is in place:

- **A gateway token authenticates every remote caller.** Mint one over the loopback API
  (`POST /api/gateway-tokens`); the plaintext is returned exactly once and only the hash is stored. Tokens can be rotated, paused, or revoked — but only over that same loopback API, never over the remote bind itself, so a remote caller can never mint or revoke its own access. There's no UI for this yet; today it's a loopback REST call, and like every other write it needs the local access credential:

  ```sh
  curl -X POST http://127.0.0.1:4317/api/gateway-tokens \
    -H "Authorization: Bearer $(cat ~/.loom/gateway-loopback.key)" \
    -H 'content-type: application/json' -d '{"name":"my-laptop"}'
  ```

- **TLS is mandatory** for any non-loopback bind that isn't a Tailscale `.ts.net` address (a tailnet link
  is already encrypted). Point `remoteAccess.tls` at a cert and key; without readable material the daemon **refuses to open the remote listener and stays on loopback** rather than serving plaintext.
- **Routes are allowlisted, fail-closed.** Only an explicitly listed set — reads, plus the surfaces you
  need to actually answer and steer (the Requests inbox, session input/stop/resume/end, and the live session sockets) — is reachable remotely. Everything else, including all configuration, every human-only writer, and the SPA's own static routes, is loopback-only by construction: a new route is unreachable from the remote bind until someone deliberately allowlists it.
- **Remote requests are rate-limited** per caller IP and per token, with a lockout on repeated auth
  failures. The loopback path is exempt.

Two sharp edges to know before you turn it on. **`bindHost: "0.0.0.0"` (or `::`) does not currently work**: the DNS-rebind guard requires a request's `Host` to match the configured `bindHost` exactly, and a real client's `Host` is the address it dialled, never the literal `0.0.0.0` — so every remote request is refused with `403`. Bind the specific address you mean instead. And **a bind other than loopback takes your local tooling with it**: the daemon opens one listener, so binding a specific address stops it answering on `127.0.0.1` at all, and enabling TLS makes the whole listener HTTPS — either way `loom status`, `loom stop`, `loom open` and the `http://127.0.0.1:4317` admin curls above, which all speak plain HTTP to loopback, stop working.

Step-by-step instructions live on the landing site's **Remote access** page ([`site/remote-access.html`](site/remote-access.html)).

## How it works

A single local **daemon** owns everything durable — the sessions, the PTY host that drives `claude`, the Fastify HTTP/WS gateway, an SQLite store, git, and the vault auto-committer. An ordinary project agent gets **no git write on its tool surface**: checkout, commit and push live behind a human-only REST route, or behind one of the deliberate, opt-in grants above (the Elevated Operator, the companion's git lever). Read that as the tool-surface boundary it is rather than a sandbox — a worker still has an ordinary shell inside its own worktree, which is how it commits its work in the first place; what the boundary buys you is that no *agent tool* can push, and no automated path can reach a repo the session wasn't given. The **web viewport** is stateless: it attaches to a session over a WebSocket and detaches freely, while the session keeps running on the daemon whether or not anyone is watching.

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
  <img src="docs/images/screenshot-board.png" alt="Loom's per-project task board: a kanban of cards that both you and the agents read and move through columns, each card tagged with its priority and the repository it is routed to." width="100%" /> <br /> <em>The per-project task board — a kanban you and the agents share. On a multi-repo project each card carries the repo it's routed to, so one board can drive several checkouts.</em> </p>

<p align="center">
  <img src="docs/images/screenshot-gates.png" alt="Loom's Gates page: the daemon-wide gate lanes across every project, showing semaphore occupancy on top and a history table of settled merge, worker and deploy runs with outcome, branch, worker, duration and how long ago each ended." width="100%" /> <br /> <em>The Gates page — every merge, worker self-check, and deploy run across all projects, sharing one concurrency budget, with the failing test named on a rejection.</em> </p>

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
