# Changelog

All notable changes to Loom (the umbrella `loom` package) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Loom adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor = breaking/notable,
patch = fixes — see [`docs/releasing.md`](docs/releasing.md)).

## [Unreleased]

## [0.8.0] — 2026-06-25

**Customize the bundled skills & profiles** with precise, update-safe tracking, opt-in **document-to-Markdown
conversion**, and a batch of **manager→worker message-delivery** hardening.

### Added
- **Customize bundled skills and profiles — and adopt Loom's updates without losing your edits.** Edit a
  bundled skill or profile and Loom now tracks precisely what you changed against the shipped version: clear
  badges show whether an item is untouched, customized, or has an update available; a **"what changed"** diff
  shows your edits; and when Loom later ships a new version of a bundled item, an **update banner** offers a
  two-step adopt with a **field-level conflict resolver** — take the upstream change while keeping your own
  edits, line by line. Backed by a base-snapshot store and a 3-way merge engine (with `adopt` / `reset` /
  update-diff REST). New customizations work entirely off the server's notion of which items are bundled.
- **Opt-in document conversion (`documentConversion`).** A profile can enable a per-session **markitdown**
  MCP that converts PDFs, Office files, images, and HTML to Markdown — so a research/document rig can read
  documents cheaply in tokens. Default off and fully additive; **human-set only** (Profiles UI/REST), never
  an agent tool. Loom owns a shared Python venv for it and **pre-warms** it on profile-save and at boot, so
  the first document-conversion session usually finds the converter already ready.
- **Cross-project task-boarding for the Platform Lead.** The Platform operator can file a task directly onto
  another project's board (and link an escalation to the task it relates to).

### Changed
- **`project_configure` does a patch/merge instead of a clobber.** Changing a single config key no longer
  wipes your other per-project overrides.
- **Manager steering of workers is more authoritative.** A burst of manager→worker messages is now delivered
  as **one coalesced batch** (a single authoritative turn, not one injection per message), and a new
  **`worker_redirect`** lets a manager interrupt a worker's current turn, flush any now-superseded queued
  direction, and deliver one "do this now" instruction immediately.

### Fixed
- **A worker can no longer finish on a stale plan.** The daemon refuses a worker's completion report while it
  still has unconsumed manager direction queued, so a just-superseded plan can't be reported done.
- **`/session-end` stages only the files your session touched** in the shared vault (never a blanket
  `git add -A`), and drops an invalid merge flag — so wrapping up a session can't sweep in unrelated changes.
- **Orchestration tools resolve correctly in `/orchestrate`.** The lead doctrine now namespaces the
  `mcp__loom-orchestration__*` tools and preloads the lifecycle set, so a manager's first calls don't miss.
- **The skill "what changed" diff is line-ending tolerant** — it strips `\r` before comparing, so a CRLF
  edit no longer shows a whole file as changed.

## [0.7.0] — 2026-06-24

Board lanes you can **color, limit, and edit in place**, opt-in **Obsidian auto-start**, and a large batch
of **multi-agent orchestration reliability** hardening.

### Added
- **Board column customization.** Give each lane an **accent color** and a soft **WIP limit** (with an
  unobtrusive over-limit indicator), apply a **column preset** at project creation (Agent Dev / Research /
  Ops / Simple) with a reset-to-preset action, and edit the board **in place** — rename, add, or remove
  columns directly on the board header with a live preview and role-coupling warnings. New columns are
  inserted before the terminal lane.
- **Opt-in Obsidian auto-start.** A new per-project setting (`obsidian.autoStart`, default **off**) that
  self-heals the vault tooling: when a skill needs the `obsidian` CLI and Obsidian isn't running, Loom
  launches it and waits until it's ready, then proceeds — falling back to direct filesystem access when
  it's disabled, headless, or not installed (never a hard error). Cross-platform, with an optional
  human-only launch-path override.
- **Repository-path editing.** Change a project's bound git repository from Settings (validated as a real
  repo; refused while a worktree session is live so an in-flight worker can't be rebound out from under).
- **Spawn a worker by agent name.** `worker_spawn` now accepts an agent's **name or slug** (not only its
  id), and a mistyped value returns a "did you mean …?" suggestion instead of a bare failure.
- **Editable agent prompts on the Platform page** and a `agent_update` patch surface.

### Changed
- **Manager sessions know where things live.** An orchestrator session now starts with its project's
  absolute repo and vault paths, so it reads its notes by path instead of a slow filesystem search.
- **Upward reports carry a delivery status.** A worker's report (and a platform escalation) now reports
  whether it was delivered live, queued, durably boarded, or dropped — and a **report wakes a parked
  manager**, so completed work is never left sitting unnoticed.
- **Bounded cross-project listings.** The platform/audit agent and session listings are capped to fit the
  context budget, so a large workspace can't overflow an operator.

### Fixed
- **`worker_spawn` validates its inputs up front** — a malformed or stale task id is rejected before any
  worktree or session is created, instead of binding a worker to a bogus task.
- **`worker_merge` won't silently pass an empty merge.** When a worker reported changes but its branch has
  nothing to merge (work was committed to the wrong place), the gate now hard-flags it for recovery
  instead of quietly marking the task done. The worker doctrine also now says, explicitly, never commit to
  `main`.
- **Usage-limit handling on spawn is self-healing.** A `worker_spawn` blocked by a usage limit now returns
  a retry-after deadline and the manager is auto-woken when the limit clears — no manual "retry" pokes.
- **Cleaner restart resumes.** After a daemon restart a session resumes as one coherent turn (the bare
  "Continue" no-op the engine emits is absorbed) and is told its file-read tracking was reset, so it
  re-reads before editing.
- **Vault-tooling correctness across the board** — unified board column coloring with AA-contrast-safe
  labels, Settings now preserves per-column accent/WIP on save, rate-limit holds clear cleanly across
  parked sessions, and several boot-migration and merge-recovery edge cases were hardened.

## [0.6.0] — 2026-06-23

A real board **column manager**, and a more robust + tunable worker-lifecycle watchdog.

### Added
- **Board column manager.** Settings → Board Columns replaces the old one-line-per-column textbox with a
  real editor: drag to reorder, rename inline, assign each lane a lifecycle role, see a live per-column
  card count, and add or remove columns. Removing or renaming a column **that still has cards is now
  safe** — its cards are atomically re-homed in one transaction (a removed lane's cards move to your
  default-landing column), so a card can never be orphaned onto a column that no longer exists. Columns
  are now identified by a stable lifecycle *role* internally, so renaming a lane no longer breaks
  delegation; existing boards are migrated automatically with no change to where your cards sit.
- **Adjustable worker-stuck threshold.** A new **"Worker stuck (min)"** field (Settings → Orchestration
  Caps) sets how long a worker may sit busy in a single turn before its manager is alerted. Set it to
  `0` to disable the stuck-worker watchdog for a project.

### Changed
- **Default worker-stuck threshold raised 20 → 30 minutes** — fewer false "stuck" alerts on a
  legitimately long single turn (a big build/test run). Override it per project in Settings.

### Fixed
- **Workers no longer wedge after committing.** A worker's shell could hang on a pager — e.g. a
  post-commit `git diff`/`git log` paging into `less` and blocking forever — which froze its turn and
  tripped a false "stuck" alert while its completion report sat undelivered. The worker environment now
  disables the git/terminal pager (`GIT_PAGER`/`PAGER`/`GIT_TERMINAL_PROMPT`) so a command can't block
  the turn.
- **Reviewer/operator sessions resume cleanly after a daemon restart.** When the daemon restarts, the
  Workspace Auditor, the dev Auditor, and the Platform operator are now nudged to continue (the way worker
  sessions already are) instead of sitting idle after their resume.
- **Captured transcripts keep tool-result bodies.** Saved session transcripts retain the bodies of tool
  results, so a later review or audit sees the full record rather than truncated tool output.
- **The Workspace Auditor's tooling is bounded and forgiving.** Its session listing is capped so a large
  workspace can't flood the auditor's context, and its transcript reads accept a session-id *prefix*, not
  only the full id.
- **Confirming a worker merge is idempotent.** A repeated merge-confirm (e.g. after a reconnect) is now a
  safe no-op instead of double-applying or erroring.
- **Queued messages survive a restart or the sender ending.** A message queued to a busy session is
  persisted, so it still arrives after a daemon restart or after the session that queued it exits —
  instead of being silently dropped.
- **A fast-exiting worker always reports back.** A worker that finishes or dies very quickly now always
  emits its terminal report to its lead, so the lead is never left waiting on a report that never comes.
- **Corrected the shipped Platform & Workspace Auditor prompts.** The seed prompts that ship to new
  installs dropped stale, Loom-internal wording (a leftover "auditor stand-down" note and dev-only
  framing) in favor of clean, user-facing text.

## [0.5.0] — 2026-06-23

The onboarding assistant grows into a standing **Platform** operator, and a new suggest-only **Workspace
Auditor** reviews your own workspace and proposes improvements.

### Added
- **Workspace Auditor — a suggest-only review of your own workspace.** A new read-only reviewer scans
  your recent sessions for vague or ambiguous instructions in *your* own agent prompts and skills, and
  for prompts you type repeatedly that are worth saving as one-click presets. It files improvement
  suggestions as cards on your home board and proposes presets — it never changes anything itself, and it
  does not touch Loom's own internals. Run it on demand with **"Review my workspace"** on the Platform
  page, or put it on a cron schedule.
- **Archive a project from the Platform operator.** The operator can now soft-archive a project you're
  done with (reversible; it refuses your reserved home).
- **Voice dictation on board cards.** The card description field in the board drawer gains the same
  speech-to-text mic as the composer — dictate a card's description instead of typing it (the mic appears
  only in browsers that support speech recognition).

### Changed
- **The Setup Assistant is now your "Platform" operator.** What greeted you as the "Setup Assistant" is
  rebranded **"Platform"** — a standing, user-facing operator you return to whenever you want to create,
  configure, or archive your projects, agents, and profiles, not just a one-time onboarding helper.
  Existing installs are migrated automatically, and the Platform surface is now a single consolidated
  page (one tab per edition).

## [0.4.2] — 2026-06-17

### Fixed
- **Pasting into a terminal duplicated the text.** Ctrl/Cmd+V directly in a session's terminal pane
  pasted the clipboard contents twice. The terminal both pasted manually *and* let the browser's
  native paste run; it now lets the native paste happen exactly once (still swallowing the raw control
  byte and still honoring bracketed-paste mode for the agent's TUI).

## [0.4.1] — 2026-06-17

### Fixed
- **`loom` did nothing under fnm / nvm / volta (any symlinked global install).** Every command
  (`loom`, `loom start`, `loom status`, …) exited silently with no output when Loom was installed under
  a Node version manager that symlinks the global package directory. The CLI's entry-point check
  compared the launcher's path against the module's own URL; those diverge when the global dir is a
  symlink (Node resolves the real path while the launcher passes the symlinked one — plus Windows
  path-casing differences), so the CLI body never ran. The check now realpath-normalizes both sides.
  Update with `npm i -g loomctl@latest`.

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
