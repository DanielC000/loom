# Changelog

All notable changes to Loom (the umbrella `loom` package) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Loom adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor = breaking/notable,
patch = fixes — see [`docs/releasing.md`](docs/releasing.md)).

## [Unreleased]

### Added
- **`loom` npm package + CLI.** `bin/loom.mjs` boots the single-process daemon, waits for the gateway,
  prints the local URL, and opens the browser — so `npx loom` / `npm i -g loom` runs the whole app.
  Flags: `--port`, `--no-open`, `--version`, `--help`.
- **`pnpm pack:npm`** (`scripts/build-npm-package.mjs`) assembles a self-contained, publishable
  `loom-X.Y.Z.tgz`: the daemon dist (copied, not bundled), the prebuilt web at `dist/web`, the daemon
  `assets/`, and the private `@loom/shared` bundled via `bundledDependencies`. Native deps stay real
  `dependencies` so a plain `npm install` fetches their prebuilt binaries. Build + local-install +
  owner-publish runbook in [`docs/releasing.md`](docs/releasing.md). Not yet published (owner-gated).

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
