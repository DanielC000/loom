# Changelog

All notable changes to Loom (the umbrella `loom` package) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Loom adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor = breaking/notable,
patch = fixes — see [`docs/releasing.md`](docs/releasing.md)).

## [Unreleased]

## [0.2.0] — 2026-06-15

The first publicly published Loom: the installable npm package goes live, joined by voice input,
preset prompts, board search, and a round of reliability hardening since `0.1.0`.

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

### Changed
- **Worker merges are now a single squashed commit** per task (one clean commit per branch).
- **Worktree dep-provisioning** covers npm and yarn projects, not just pnpm (picks the package manager
  by the worktree's lockfile marker).
- The optional dev-only **Platform layer is gated behind `LOOM_DEV`** and excluded from the published
  package — core orchestration (lead + workers) always ships.

### Fixed
- **Reliability:** a crash-recovery watchdog bounded-auto-resumes a session whose process died while
  the daemon stays healthy; workers no longer intermittently hang at startup on the plugin-MCP enable
  prompt; boot reconciliation no longer leaks orphaned worktree directories; `worker_report(done)` now
  refuses on uncommitted changes so completed work can't be silently dropped.
- **UI:** terminal scroll behavior; unreadable preset/button text on the default light background; a
  composer/terminal layout regression when toggling Voice.

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
  the prerequisite for an `npx loom` package.
