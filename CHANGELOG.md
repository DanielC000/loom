# Changelog

All notable changes to Loom (the umbrella `loom` package) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Loom adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor = breaking/notable,
patch = fixes — see [`docs/releasing.md`](docs/releasing.md)).

## [Unreleased]

## [0.4.0] — 2026-06-17

Onboarding gains in-chat skill editing, the install instructions become accurate, and a round of
input/terminal reliability fixes lands.

### Added
- **In-chat skill editing for the Setup Assistant.** The assistant can now read and edit your skills
  directly in the conversation — new `skill_list` / `skill_write` tools on the curated `loom-setup`
  surface — instead of sending you to the Skills UI. Writes are bounded strictly to *your* skill store
  (it can never modify Loom's bundled skills) and are **confirm-first**: it shows you the skill name and
  full content and gets your go-ahead before writing.
- **Hosted landing page.** A GitHub Pages workflow publishes the `site/` landing page.

### Fixed
- **Accurate one-line install.** The README and `install.sh` / `install.ps1` pointed at a placeholder
  `loom.example` domain that didn't resolve. They now use the real raw-GitHub script URLs, so
  `curl … | sh` and `irm … | iex` work exactly as written.
- **Composer draft survives maximize/minimize.** Typing a message into a session's composer and then
  maximizing or minimizing that terminal no longer discards your unsent draft — it's preserved per
  session across the layout change.
- **No garbled turns when typing in the raw terminal.** A message delivered to a session (e.g. an
  automated status report) is no longer appended onto text you've half-typed directly in the terminal
  pane. Delivery now waits until you submit or clear your line — including multi-line pastes — and never
  alters your text.

## [0.3.0] — 2026-06-16

End-user onboarding and the full Phase-2 distribution layer: a friendly Setup Assistant that gets a
new user from an empty install to a working setup, and a real management CLI + cross-OS autostart +
`loom update` + one-line installers + package-manager manifests.

### Added
- **Setup Assistant — guided onboarding.** A standing, user-facing assistant (auto-launched on a fresh
  install, always reachable from the new **Set up Loom** page) that creates and configures your first
  projects, agents and profiles and picks default skills — acting on your behalf, confirming big or
  irreversible actions first. It runs on a new `setup` session role over a curated, fail-closed
  `loom-setup` MCP surface (project/agent/profile create+configure, manager/plain session spawn only) —
  no elevated or outward capability (no git/vault writers, no `gateCommand`, no cross-project messaging).
  Ships ungated to every user as the lower-privilege cousin of the dev-only Platform Lead. Seeds a
  reserved "Getting Started" home; the daemon auto-launches the assistant once on a brand-new install.
- **Management CLI.** `loom` gains subcommands: `start` (with `--detach`), `stop`, `status`, `restart`,
  `open`, alongside the bare `loom` (start + open browser). `stop`/`restart` use a graceful loopback
  shutdown hook so a backgrounded daemon snapshots live transcripts before exiting (cross-platform —
  Windows has no SIGTERM). State (PID file) lives under `LOOM_HOME`.
- **Cross-OS autostart.** `loom service install | uninstall | status` registers Loom to start on
  login/boot — a systemd `--user` unit (Linux), a launchd LaunchAgent (macOS), or a Task Scheduler
  logon task (Windows).
- **`loom update` + release channels.** `loom update [--channel stable|beta]` upgrades in place
  (`npm i -g loomctl@<dist-tag>`) and restarts; the channel is persisted under `LOOM_HOME`. Plus an
  unobtrusive in-app **"update available"** banner with an "Update & restart" button (a human-only,
  loopback, packaged-install-only control — never an agent surface).
- **One-line install scripts.** `install.sh` (`curl … | sh`, macOS/Linux/WSL) and `install.ps1`
  (`irm … | iex`, Windows): detect Node 22+, install `loomctl`, optionally register autostart, and
  launch. Plus Homebrew / Scoop / winget manifests + a submission runbook (`docs/packaging-submission.md`).
- **Prominent global-install docs.** The README now leads with `npm i -g loomctl` → `loom`.

### Fixed
- **Reserved-project home resolution.** Introducing the second reserved home (the Setup "Getting
  Started" project) is now name-scoped everywhere, so `/api/platform/home`, manager escalations, and
  auditor findings always resolve the correct home instead of "whichever reserved project sorts first."

### Security
- **Least-privilege profiles.** The setup surface can no longer mint `platform`/`auditor` profiles, and
  a default session spawn no longer lets a profile silently confer an elevated role — those roles come
  only from their explicit human spawn paths.

## [0.2.0] — 2026-06-16

The first publicly published Loom: the installable npm package goes live, joined by voice input,
preset prompts, composer queue management, per-profile model selection, board search, and a round of
reliability + stability hardening since `0.1.0`.

### Added
- **`loomctl` npm package + `loom` CLI.** `bin/loom.mjs` boots the single-process daemon, waits for the
  gateway, prints the local URL, and opens the browser — so `npx loomctl` / `npm i -g loomctl` runs the
  whole app (the installed command stays `loom`). Flags: `--port`, `--no-open`, `--version`, `--help`.
  Built by `pnpm pack:npm` (`scripts/build-npm-package.mjs`) into a self-contained tarball: the daemon
  dist (copied, not bundled), the prebuilt web at `dist/web`, the daemon `assets/`, and the private
  `@loom/shared` bundled via `bundledDependencies`; native deps stay real `dependencies` so a plain
  install fetches their prebuilt binaries. Build + local-install + publish runbook in
  [`docs/releasing.md`](docs/releasing.md).
- **Voice input in the cockpit.** A mic button in the composer — under every terminal (Overview grid,
  Terminals, Workspace) — uses the browser Web Speech API to dictate into the prompt box; the
  transcript is appended for review, never auto-sent. Includes a speech-recognition **language
  selector**. The mic appears only in browsers that support speech recognition.
- **Preset Prompts.** A global, editable store of reusable prompts, surfaced as a popover under each
  terminal's action buttons — one click sends a saved prompt to the session.
- **Board search + filter bar** on the task board.
- **Composer queued-message management.** Messages you queue while a session is busy are shown under
  every terminal and are now editable, reorderable, and deletable; messages queued programmatically
  (e.g. an agent's report to its manager) appear read-only so they can't be altered out from under it.
- **Per-profile model.** A Profile can pin a model that is applied at spawn (`--model`); leaving it
  blank uses the engine default, unchanged.

### Changed
- **Worker merges are now a single squashed commit** per task (one clean commit per branch).
- **Worktree dep-provisioning** covers npm and yarn projects, not just pnpm (picks the package manager
  by the worktree's lockfile marker).
- The optional dev-only **Platform layer is gated behind `LOOM_DEV`** and excluded from the published
  package — core orchestration (lead + workers) always ships.
- **Live-terminal grids order managers first** (the orchestrator sits leftmost, its workers to the
  right), then newest-first within each group.

### Fixed
- **Reliability:** a crash-recovery watchdog bounded-auto-resumes a session whose process died while
  the daemon stays healthy; workers no longer intermittently hang at startup on the plugin-MCP enable
  prompt; boot reconciliation no longer leaks orphaned worktree directories; `worker_report(done)` now
  refuses on uncommitted changes so completed work can't be silently dropped.
- **UI:** terminal scroll behavior; unreadable preset/button text on the default light background; a
  composer/terminal layout regression when toggling Voice; the task board now auto-refreshes on
  changes made by another process (no manual reload).
- **Stability:** a transient `~/.claude/projects` file-watcher error (e.g. a short-lived temp run
  directory vanishing mid-stat on Windows) no longer crashes the daemon.

## [0.1.0] — 2026-06-09

The first versioned Loom — sets the version backbone the install/update story builds on.

### Added
- **Versioning backbone.** The root `loom` package is the single source of truth for the
  user-facing version (now `0.1.0`); internal `@loom/*` packages stay private `0.0.0`.
- **`GET /api/version`** — a read-only daemon endpoint returning `{ version }`, read from the
  package version at runtime (never a hardcoded copy). The version also appears in the daemon's
  boot log line.
- **Version in the web UI** — a quiet `vX.Y.Z` chip in the header, fetched from `/api/version`.
- **Release process** — this `CHANGELOG.md` and [`docs/releasing.md`](docs/releasing.md) (version
  scheme, `npm version` → git tag → GitHub Release → `npm publish` + stable/beta channels).
- **Single-process viewport** — the daemon serves the prebuilt web UI from its own loopback origin,
  the prerequisite for an `npx loomctl` package.
