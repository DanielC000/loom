# Spike: Releases — distribution / installer / update strategy

**Card:** 353d920e · **Date:** 2026-06-09 · **Type:** research + recommendation (no code)
**Owner direction:** research how openclaw.ai (and comparable tools) ship; recommend a
**lightweight near-term path**. A desktop app (Electron/Tauri) is explicitly a **LATER** phase —
not the v1 pick.

## Verdict (TL;DR)

**Ship Loom as a public npm package (`npm i -g loom` / `npx loom`) for v1.** One command boots
the loopback daemon and serves the prebuilt viewport; the browser opens to it. This is the path
the two closest architectural twins take — **OpenClaw** (the owner's reference: a Node 22/24
daemon + gateway + browser UI) and **n8n** (a Node server + browser UI on `localhost`) both lead
with `npm i -g` and `npx`. It fits Loom's actual shape with the least effort: the daemon already
has a `start` script (`node dist/index.js`) and already bundles `@fastify/static`, and the web
package already builds to a static `dist/` via Vite — so a single process can serve both.

**Why not a standalone binary or desktop app first:** Loom depends on two **native** N-API
modules (`node-pty`, `better-sqlite3`). Node's Single Executable Application (SEA) feature is
still experimental and, per the Node docs, "does not magically make cross-platform native
modules portable" — you must bundle/rebuild per target and there are known arm64 `dlopen`
crashes. A signed desktop app additionally drags in Apple notarization + Windows Authenticode
cost. Both are real later phases; neither earns its keep for a pre-public v1.

**Phased roadmap:** v1 = npm package → Phase 2 = thin script installers (`curl|sh`, `irm|iex`) +
Homebrew/Scoop/winget that *wrap* the npm package (optionally bundling a pinned Node, the
OpenClaw `install-cli.sh` trick) → Phase 3 (later) = Electron/Tauri desktop app with real
auto-update + code-signing. A zero-Node single binary (SEA/pkg) is an off-ramp only if "no Node
prereq" ever becomes a hard requirement.

---

## Part 1 — How comparable tools actually ship

Four reference points, chosen for architectural closeness to Loom (Node daemon + browser UI;
local-first dev tools; the native-module / single-binary tradeoff).

### 1a. OpenClaw — the owner's reference (closest twin)

OpenClaw is a Node **24 (or 22.19+)** daemon + gateway + browser/Hub UI — essentially Loom's
shape. It offers a *menu* of install methods and leads with a one-line script:

| Method | Command | Notes |
|---|---|---|
| Script (recommended) | `curl -fsSL https://openclaw.ai/install.sh \| bash` (mac/Linux/WSL2) · `iwr -useb https://openclaw.ai/install.ps1 \| iex` (Windows) | Detects OS, installs Node if missing (Homebrew / NodeSource / winget / Choco / Scoop), installs Git, deploys OpenClaw, registers gateway service, runs onboarding |
| Local-prefix script | `curl -fsSL https://openclaw.ai/install-cli.sh \| bash` | Keeps OpenClaw **and a pinned Node** under `~/.openclaw` (SHA-256-verified tarball) — **no system Node dependency** |
| npm / pnpm / bun | `npm install -g openclaw@latest` then `openclaw onboard --install-daemon` | pnpm needs `pnpm approve-builds -g` afterward |
| From source | `git clone … && pnpm install && pnpm build && pnpm ui:build && pnpm link --global` | dev/contributor path |
| Docker / Podman / Nix / Ansible | (referenced) | containerized deployments |

**Update mechanism — the most relevant part for Loom.** OpenClaw has a first-class
`openclaw update` command with **release channels** persisted in config:
`openclaw update`, `openclaw update status`, `openclaw update --channel stable|beta|dev`,
`openclaw update --dry-run`, `--json`. `stable`/`beta` are package installs (npm dist-tags);
`dev` forces a git checkout, builds it, and installs the global CLI from that checkout. An
**auto-updater exists but is off by default**, configurable in `~/.openclaw/openclaw.json`
(stable delay/jitter hours, beta check interval). The installer docs note updates otherwise mean
re-running the installer with a version flag; the per-OS service registration (launchd/systemd/
Windows service) is wrapped behind `openclaw gateway install` / `gateway restart` and **no
code-signing/notarization is documented** — because the script/npm path ships source+JS, not a
signed app bundle.

Sources: [Install · OpenClaw](https://docs.openclaw.ai/install) ·
[Installer internals · OpenClaw](https://docs.openclaw.ai/install/installer) ·
[Updating · OpenClaw](https://docs.openclaw.ai/install/updating) ·
[Release channels · OpenClaw](https://docs.openclaw.ai/install/development-channels)

### 1b. n8n — the architectural twin (Node server + browser UI on localhost)

n8n is a self-hosted Node app whose UI is a browser app at `http://localhost:5678` — the same
"daemon + browser viewport" shape as Loom.

- **Install:** `npm install -g n8n` (global), or **`npx n8n`** with no install at all (downloads
  on demand, then open the browser). Requires Node 20.19–24. Docker is also offered.
- **Update:** `npm update -g n8n`, or pin with `n8n@<version>`.
- **UX:** install/`npx` → run `n8n` → open `localhost:5678`. Minimal ceremony, no installer GUI.

Sources: [npm · n8n Docs](https://docs.n8n.io/hosting/installation/npm/) ·
[n8n-docs npm.md](https://github.com/n8n-io/n8n-docs/blob/main/docs/hosting/installation/npm.md)

### 1c. Ollama — the local-daemon / native-installer / auto-update model

Ollama is a local background daemon with a CLI, shipped as **standalone per-OS binaries** (no
Node prereq — it's Go) and native installers:

- **Linux:** `curl -fsSL https://ollama.com/install.sh | sh` — downloads the binary, **creates a
  systemd service, and starts the server**. A raw binary download is also offered.
- **macOS:** official `.app` installer or Homebrew.
- **Windows:** `OllamaSetup.exe` — **registers Ollama as a Windows service** (starts on boot,
  runs in background), adds it to PATH; a standalone `ollama-windows-amd64.zip` is also published.
- **Update:** on macOS/Windows the app **auto-downloads updates**; the user clicks the
  menubar/taskbar item → "**Restart to update**". On Linux you re-run the install script.

Takeaway for Loom: this is the polished end-state (background service + auto-update + "restart to
update"), but Ollama can ship a single self-contained binary precisely because it has **no native
Node addons** to drag along — the part Loom can't cheaply copy in v1.

Sources: [Download Ollama](https://www.ollama.com/download) ·
[Windows · Ollama](https://docs.ollama.com/windows) ·
[Ollama install script (HN)](https://news.ycombinator.com/item?id=39308276)

### 1d. Supabase CLI — the brew/Scoop multi-channel pattern (and the "not npm -g" tradeoff)

A dev-tool CLI that **deliberately does not support `npm install -g`** (it ships a Go binary, so
global npm is "not supported"; npm is offered only as a local dev-dependency). Instead:

- **macOS/Linux:** `brew install supabase/tap/supabase` (always-current tap), `brew install supabase`,
  or the `supabase-beta` formula for the beta channel.
- **Windows:** Scoop — `scoop bucket add supabase … && scoop install supabase` (or `supabase-beta`).
- **Linux packages:** `.deb` / `.rpm` / `.apk` / `.pkg.tar.zst` from GitHub Releases.
- **Update:** same channel — `brew upgrade`, `scoop update`, etc. Stable vs beta are separate
  formulae/buckets. winget has been requested but isn't official.

Takeaway: this is the model for **Phase 2** package managers, and a cautionary note — a tool
chooses brew/Scoop over `npm -g` when it ships a *binary*. Loom is genuinely Node, so `npm -g` is
the natural primary, with brew/Scoop as convenience wrappers later.

Sources: [Supabase CLI · Getting started](https://supabase.com/docs/guides/local-development/cli/getting-started) ·
[supabase/cli (GitHub)](https://github.com/supabase/cli)

### 1e. Feasibility note — Node single-executable (SEA) vs Loom's native modules

For Part 2's option (b): per the Node docs, SEA is **experimental** ("subject to change"), built
by injecting a blob into a copy of the `node` binary via `postject` (Node 25.5+ adds a one-step
`--build-sea`). Critically for Loom: applications using native modules (N-API / node-gyp) **"must
ensure the addon binaries are bundled or rebuilt for the target platform; SEA does not magically
make cross-platform native modules portable,"** with known arm64 `dlopen` crashes when built in
some containers. Loom has **two** such modules — `node-pty` and `better-sqlite3` — so a single
binary is a high-effort, fragile path today.

Sources: [Single executable applications · Node.js docs](https://nodejs.org/api/single-executable-applications.html) ·
[Node 25.5 `--build-sea`](https://progosling.com/en/dev-digest/2026-01/nodejs-25-5-build-sea-single-executable)

---

## Part 2 — Options for Loom (mapped to the real architecture)

Loom today: a pnpm+Turbo monorepo — `@loom/daemon` (Node ≥22, SQLite via `better-sqlite3`,
node-pty host, Fastify HTTP/WS on loopback `:4317`, **already depends on `@fastify/static`** and
has a `start` = `node dist/index.js`) + `@loom/web` (Vite/React, **builds to a static `dist/`**,
served at `:5317` proxying to the daemon) + `@loom/shared`. Native build deps:
`better-sqlite3`, `node-pty`, `esbuild`. Windows-primary (ConPTY), also macOS/Linux.

### Option A — public npm package: `npm i -g loom` / `npx loom`  ← **recommended v1**

Publish a single public `loom` package with a `bin` that boots the daemon and serves the
**prebuilt** viewport from the same process (the daemon already has `@fastify/static`), then opens
the browser. `@loom/shared`, `@loom/daemon`, and the built `@loom/web` assets ship inside it.

- **Effort: LOW.** Mostly packaging, not new architecture: add a public umbrella package + `bin`
  entry, prebuild `web` into it, have the daemon serve those assets, auto-open the browser. No
  change to the loopback/PTY/MCP invariants.
- **Cross-OS: excellent.** Same story as n8n. `node-pty` and `better-sqlite3` publish prebuilt
  binaries for win/mac/linux; `npm i` fetches the matching one (rebuilds only if none exists).
  Windows-primary already works (the spawn recipe is validated).
- **Update story:** CLI = `npm i -g loom@latest` (or a `loom update` wrapper around it); UI = a
  daemon registry check + "Update & restart" button (see Part 3).
- **Prereqs:** **Node 22+** on the user's machine (a C toolchain only in the rare no-prebuilt
  case). **pnpm is NOT required for end users** — it stays a contributor/build tool.
- **Fit:** best — it preserves the loopback daemon + browser viewport model exactly, and reuses
  the existing `daemon:stable` supervisor for restart-on-update.

### Option B — standalone per-OS binary (Node SEA / `pkg`) + thin installer

Bundle Node + Loom into one executable per OS/arch; a small installer drops it on PATH.

- **Effort: HIGH.** SEA is experimental and `node-pty`/`better-sqlite3` are native addons that
  SEA won't make portable (Part 1e) — per-arch build matrix, fragile, and the binary needs signing
  to clear Gatekeeper/SmartScreen.
- **Cross-OS:** a build+sign matrix (win-x64/arm64, mac-x64/arm64, linux-x64/arm64).
- **Update story:** you must write your own updater (download new binary, atomic swap) — no npm to
  lean on.
- **Prereqs:** **none** (Node is bundled) — the one real upside.
- **Fit:** removes the Node prereq but fights Loom's two native modules. Defer; revisit only if
  "no Node on the user's box" becomes a hard requirement.

### Option C — script installers (`curl|sh`, `irm|iex`) + Homebrew / Scoop / winget

The OpenClaw/Ollama onboarding layer, built **on top of** Option A's npm package: a hosted
`install.sh` / `install.ps1` that ensures Node (or bundles a pinned Node à la OpenClaw's
`install-cli.sh`), runs the global install, optionally registers a background service, and opens
the browser. Homebrew formula / Scoop manifest / winget package wrap the same payload.

- **Effort: MEDIUM** — and it *requires* Option A first (the scripts install the npm package).
  Cost is the scripts + package-manager manifests + hosting `install.{sh,ps1}` on a domain.
- **Cross-OS: great** — `curl|sh` (mac/Linux/WSL), `irm|iex` (Windows), brew/Scoop/winget.
- **Update story:** `loom update`, `brew upgrade`, `scoop update`, or re-run the script.
- **Prereqs:** can **bundle a pinned Node** (OpenClaw's `install-cli.sh` pattern) to remove even
  the Node prereq, without going all the way to a single binary.
- **Fit:** the natural Phase-2 polish — nicer onboarding + package-manager presence, no
  architectural change.

### Option D — desktop app (Electron / Tauri)  ← **LATER phase, per owner**

Wrap the same daemon + serve the viewport inside a native window; gain a signed installer and
real auto-update (`electron-updater` / Tauri updater).

- **Effort: HIGH**, and it adds the full **code-signing/notarization** burden (Part 3).
- **Cross-OS:** native installers per OS (`.dmg`/`.pkg`, `.msi`/`.exe`, `AppImage`/`.deb`).
- **Update story:** best-in-class — background download + "restart to update" (the Ollama UX).
- **Prereqs:** none for the user (Node bundled in the app).
- **Fit:** the eventual consumer-grade end-state. Explicitly deferred.

### At a glance

| Option | Effort | Node prereq? | Cross-OS | Update | Signing burden | v1? |
|---|---|---|---|---|---|---|
| **A** npm `i -g` / `npx` | **Low** | Yes (22+) | Excellent | `npm i -g …@latest` / UI button | **~None** | ✅ **pick** |
| **C** script + brew/Scoop/winget | Med | Optional (can bundle Node) | Great | `loom update` / brew / scoop | ~None | Phase 2 |
| **B** SEA/pkg single binary | High | No | Build matrix | DIY updater | mac+win signing | If/when |
| **D** Electron/Tauri | High | No | Native installers | Auto-update | **mac+win, full** | Later |

---

## Part 3 — Recommendation, roadmap, update flows, signing

### The pick: v1 = Option A (public npm package)

**Why.** It is the lowest-effort path that fits Loom's *actual* shape, and it's exactly what the
two closest twins do (OpenClaw and n8n both lead with `npm i -g` / `npx`). Loom is already a Node
app whose daemon can serve the static viewport (`@fastify/static` is already a dependency; the web
package already produces a static `dist/`). It sidesteps the native-module portability wall that
sinks the single-binary option, and it carries **~zero code-signing burden** for v1 (see below).
It also reuses machinery Loom already has — the `daemon:stable` **supervisor** with its
**exit-75 restart sentinel** is exactly the primitive an "update & restart" flow needs.

### Phased roadmap

1. **v1 — npm package.** Publish public `loom`; `npm i -g loom` and `npx loom` both boot the
   daemon, serve the prebuilt viewport, and open the browser. Document Node 22+ as the one prereq.
2. **Phase 2 — onboarding polish.** Hosted `install.sh` / `install.ps1` (one-line install that
   ensures/bundles Node), plus a Homebrew tap, Scoop bucket, and winget manifest — all wrapping the
   v1 package. Add `loom update` and release **channels** (stable/beta) following OpenClaw's
   `--channel` model.
3. **Phase 3 (later) — desktop app.** Electron or Tauri shell over the same daemon, with real
   auto-update and signed/notarized installers. Take on signing here, not before.

   *(Off-ramp: a SEA/`pkg` single binary only if a strict "no Node prereq, no app shell"
   requirement appears — accepting the native-module build matrix.)*

### How "update from CLI" works in the recommended path

- Primary: `npm install -g loom@latest` (or `loom@<version>` to pin). Optionally ship a thin
  `loom update` subcommand that shells the same npm command (and later honors a channel:
  `loom update --channel beta`, mirroring OpenClaw).
- A daemon started under the **supervisor** (`pnpm daemon:stable` / `scripts/daemon-supervisor.mjs`)
  can adopt the new code by exiting with the **restart sentinel (exit 75)** the supervisor already
  watches for; outside the supervisor the user just restarts `loom`. (Self-hosting note from
  `CLAUDE.md`: a dep-adding upgrade needs the install to land before the restart.)

### How "update from UI" works in the recommended path

- The daemon periodically checks the npm registry's `dist-tags.latest` for `loom`; when the
  installed version is behind, the viewport shows an unobtrusive "Update available" banner (this is
  OpenClaw's model — an updater that's **off/quiet by default**, configurable).
- An "**Update & restart**" button calls a **HUMAN-only REST endpoint** that runs the install and
  emits **exit 75** so the supervisor relaunches on the new version — the Ollama "Restart to
  update" UX, realized via Loom's existing supervisor.
- **Trust boundary (non-negotiable, per `CLAUDE.md`):** self-update is a privileged,
  outward-acting operation, so it lives behind the **human-only REST surface** alongside
  `vault/writer.ts` and `git/writer.ts` — **never** exposed as an agent MCP tool. An agent must
  never be able to upgrade or restart the daemon from a session.

### Code-signing / notarization implications per OS (called out even though v1 defers them)

The headline: **the npm/script path (Options A & C) carries essentially no app-signing burden** —
that's a core reason to start there. The burden only arrives with Options B/D.

- **v1 npm / Phase-2 scripts (A, C):** you ship source + JS that runs under the user's own Node,
  exactly like OpenClaw and n8n. `npm`, `curl|sh`, and `irm|iex` are **not** gated by macOS
  Gatekeeper or Windows SmartScreen the way a downloaded `.app`/`.exe` is. The only native
  artifacts are the prebuilt `.node` binaries for `node-pty`/`better-sqlite3`, which their
  maintainers publish — Loom signs nothing. (Caveat: a `curl|sh` installer should be served over
  HTTPS from a trusted domain and ideally checksum its downloads, as OpenClaw's `install-cli.sh`
  does with SHA-256.)
- **macOS (B / D — single binary or app):** needs an **Apple Developer ID** (~$99/yr), `codesign`
  signing, **notarization** via `notarytool`, and stapling — otherwise Gatekeeper blocks it
  ("damaged / unidentified developer").
- **Windows (B / D):** needs an **Authenticode** code-signing certificate (OV ~$200–400/yr; an
  **EV** cert buys instant SmartScreen reputation). Unsigned `.exe`/`.msi` downloads trip
  SmartScreen "unrecognized app" warnings.
- **Linux (B / D):** no mandatory OS signing; optionally publish **GPG-signed** `.deb`/`.rpm`
  repos (the Supabase/Ollama pattern) for apt/dnf trust.

**Net:** signing cost is precisely what the v1 npm path lets Loom **avoid**, and precisely what
Phase 3 (desktop app) must budget for — Apple Developer ID + a Windows OV/EV cert.

---

## Part 4 — Scope

Research/recommendation only. **No code changed**, so `pnpm build` stays green by construction;
the sole committed artifact is this doc. The owner picks the v1 approach from Part 3.

## Sources

- OpenClaw — [Install](https://docs.openclaw.ai/install) ·
  [Installer internals](https://docs.openclaw.ai/install/installer) ·
  [Updating](https://docs.openclaw.ai/install/updating) ·
  [Release channels](https://docs.openclaw.ai/install/development-channels)
- n8n — [npm install docs](https://docs.n8n.io/hosting/installation/npm/) ·
  [npm.md (GitHub)](https://github.com/n8n-io/n8n-docs/blob/main/docs/hosting/installation/npm.md)
- Ollama — [Download](https://www.ollama.com/download) ·
  [Windows docs](https://docs.ollama.com/windows) ·
  [install script (HN)](https://news.ycombinator.com/item?id=39308276)
- Supabase CLI — [Getting started](https://supabase.com/docs/guides/local-development/cli/getting-started) ·
  [supabase/cli (GitHub)](https://github.com/supabase/cli)
- Node.js — [Single executable applications](https://nodejs.org/api/single-executable-applications.html) ·
  [Node 25.5 `--build-sea`](https://progosling.com/en/dev-digest/2026-01/nodejs-25-5-build-sea-single-executable)
