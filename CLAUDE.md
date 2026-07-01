# Loom

Local-first AI project workspace that weaves real Claude Code sessions, Obsidian docs, and
tasks into one fabric. Clean-slate successor to its predecessor.

**Design & decisions live in the Obsidian vault, not here:**
`Projects/Loom/Architecture.md` (full vision + architecture) and
`Projects/Loom/Vision & Architecture.md` (decisions + spike findings).

## Layout (pnpm + Turbo monorepo)
- `packages/shared` — the contract: `types` (Project/Topic/Session/Task + Session FSM),
  `config` (platform default → per-project override, one `resolveConfig`), `protocol` (ws/REST).
- `packages/daemon` — owns everything durable: SQLite (`db.ts`), the PTY host (`pty/host.ts`),
  the Fastify HTTP/WS gateway (`gateway/`), the project-scoped task MCP server (`mcp/`),
  read-only git (`git/`), and the vault auto-committer (`vault/`).
- `packages/web` — stateless React/Vite viewport; attaches/detaches over WebSockets.

## Run
```sh
pnpm install
pnpm build          # builds shared first (turbo ^build)
pnpm daemon         # dev daemon (tsx watch) on http://127.0.0.1:4317 (loopback only)
pnpm web            # viewport on http://127.0.0.1:5317 (proxies /api + /ws to the daemon)
```

**`LOOM_DEV` (dev-only Platform layer):** the **Platform layer** — the reserved "Loom Platform" project
+ Platform Lead/Auditor agents, the Platform-lead/Platform-audit profiles, and the platform-lead/
platform-audit skills — is gated behind `LOOM_DEV=1` (default OFF) and does **not** ship to regular
`loomctl` users (the npm build omits the two platform skills from `assets/skills/`). It stays in the repo
and loads only in dev: boot the daemon with `LOOM_DEV=1` (e.g. `LOOM_DEV=1 pnpm daemon`) to seed it.
**`pnpm daemon:stable` (the self-hosting entry point) defaults `LOOM_DEV=1` on** — override with
`LOOM_DEV=0 pnpm daemon:stable` to test the non-dev path. The
flag is read in ONE helper (`paths.ts` › `isLoomDev`, same shape as `LOOM_SCHEDULER_ENABLED`); CORE
orchestration (Orchestrator/Dev/Bugfix/QA/Web Designer + their skills) always seeds, flag or not.

**Setup Assistant → "Platform" operator (ships to ALL users — the ungated, lower-priv cousin of the dev Platform layer):** a
standing, user-facing operator agent — seeded and shown as **"Platform"** since 0.5.0 (legacy display name "Setup Assistant"
retained for the rename migration), no longer just a one-time onboarding helper — on the `setup` SessionRole, served by a curated **fail-closed**
`loom-setup` MCP router (`/mcp-setup/:sessionId`, role-gated, 19 tools — incl. the one safe lifecycle cap
`project_archive`: soft, reversible, and REFUSES a reserved/system home). It acts on the user's behalf —
`project_create` (bind an EXISTING repo, OR a **vault-only** project via `vaultPath` with `repoPath` omitted)
+ `project_init` (0.9.0 — the operator's ONLY host-write: create a BRAND-NEW project dir under the SANCTIONED
`WORKSPACE_ROOT` base inside `LOOM_HOME` — name-derived + confined, traversal/escape rejected — and `git init`
it, or `kind:"vault"` for a notes folder; so a no-repo user can be onboarded end-to-end) / `configure`/`update` via the **AGENT validator** (rejects `gateCommand`/`alertWebhook`),
`agent_create` + `agent_update` (0.9.0 — edit an existing agent; least-priv: REJECTS assigning an
elevated platform/auditor rig), `profile_create`/`update`/`assign`, the single-record `agent_get`/
`profile_get`/`project_get` + `list_all_*` reads, and `session_spawn`
`manager|plain` only — with **no** writers/escalation/auditor/archive surface and no self-elevation. It
follows the CORE-seed pattern (NOT `LOOM_DEV`-gated): a reserved "Platform" home (renamed from "Getting
Started" in 0.9.0 via a boot migration; surfaced in the project picker) + the "Platform" operator
agent + the `setup-assistant` skill, spawned human-REST / first-run-boot only (`startSetup` singleton;
first-run auto-launch via an `app_meta` one-time marker, exactly-once). The `setup` `profile_create` rejects
`platform`/`auditor` roles (least-privilege). Design: `Projects/Loom/Setup Assistant Design.md` in the vault.

## Distribution (the shipped `loomctl`, released as 0.3.0)
End users install globally — `npm i -g loomctl` (command stays `loom`) — and the `loom` bin is a management
CLI: `loom start/stop/status/restart/open` (`--detach`, PID file under `LOOM_HOME`) + graceful loopback
`POST /internal/shutdown`; cross-OS autostart via `loom service install/uninstall/status` (systemd `--user`
/ launchd / Task Scheduler); and `loom update [--channel stable|beta]` (channel persisted) backed by a
packaged-only loopback `POST /internal/update` + a UI "update available" banner. **The end-user daemon runs
NO supervisor** — `daemon-supervisor.mjs` is dev/self-host-only and not in the npm `files` set; the OS
service manager owns keep-alive (it runs `loom start --no-open` foreground). `/internal/shutdown` and
`/internal/update` are **loopback-only, human-only, NOT agent MCP tools** (same trust posture as the
human-only REST vault/git writers below — the one agent-facing exception there is the `LOOM_DEV`
Platform Lead surface, which `/internal/*` has no equivalent of). loomctl@0.3.0 is published via npm **trusted publishing** (OIDC, no `NPM_TOKEN`,
auto-provenance — see `docs/releasing.md`).

**Self-hosting (orchestrating Loom WITH Loom):** use `pnpm daemon:stable`, not `pnpm daemon`.
The dev daemon runs under `tsx watch`, so any worker merge that lands a change under
`packages/daemon/src/**` (or `shared/dist`) restarts it mid-orchestration and kills the live
manager/worker PTYs (the watch-restart-kills-PTYs gotcha — it caused an overnight cascade on
2026-06-03). `daemon:stable` runs the **supervisor** (`scripts/daemon-supervisor.mjs`): it builds
once and runs the daemon from `dist/` with **no watcher**, so source merges don't restart the running
daemon. The supervisor relaunches **only** on the explicit restart sentinel (exit `75`); any other
exit (incl. a crash) stops the loop, so a broken daemon stays visibly down instead of crash-looping.
- **Manager self-restart:** under the supervisor, a manager that has merged daemon-`src` can make that
  code go live itself via the `daemon_restart` orchestration tool — it rebuilds first (a failed build
  aborts the restart and leaves the daemon up), then exits `75`; the supervisor relaunches and boot
  re-resumes the manager + its live workers (via `~/.loom/restart-intent.json`) with a "code is live"
  note. Outside the supervisor the tool refuses (nothing would relaunch the daemon).
- **Manager orchestration around a restart:** after **any** daemon restart — *especially one you did
  not initiate* (e.g. the owner deploying) — don't trust the auto-resume to have put your workers back
  to work: run `worker_list` and read each live worker's transcript. A worker resumed but left **idle
  mid-task** (a generic "Continue" just draws "No response requested") needs a **specific**
  `worker_message` re-nudge naming where it left off — a generic nudge won't revive it. And a
  low-urgency `daemon_restart` that should wait for the fleet to go quiet is a **park, not a poll**:
  don't re-run `worker_list` in a wake loop watching for quiet — note the held restart in your resume
  doc, `idle_report('waiting', minutes=…)`, and resume on the next genuine event (a worker report, a
  wake), then re-check quietness **once** and fire `daemon_restart`.
- **Deploy-build gate integrity** (`restart.ts` › `deployBuildSteps`/`buildDaemon`): the deploy rebuild
  is two ordered, fail-closed steps so a stale cache or a missing install can't verify a broken main
  green. (1) `pnpm install --frozen-lockfile` FIRST — a merged dep-add (package.json + lockfile) gets
  linked before the build, instead of failing to resolve the new import (`daemon_restart` never used to
  install). (2) `turbo build … --force` SECOND — `--force` is the **real** cache-defeating invocation
  ONLY when passed directly to turbo (`node <turbo> build … --force`); `pnpm <pkg> build --force`
  forwards `--force` to the build *script* (vite), NOT turbo, so the cache is **not** defeated and a
  stale FULL TURBO replay ships green (the aad5fff3 footgun). A failed install short-circuits the build.
  (turbo.json also keys all build caches on `pnpm-lock.yaml`, so a dep change busts the cache repo-wide.)
- **Caveat:** `assets/**` (hook-relay, vault-lint, bundled skills) is read live from the package dir,
  so asset merges take effect on the next spawn without a restart. For full isolation, run the stable
  daemon from a separate checkout (shares `~/.loom` state; override `LOOM_HOME`/`LOOM_PORT` for two
  daemons side by side).
- **Caveat (supervisor code is NOT `daemon_restart`-deployable):** `daemon_restart` only rebuilds +
  relaunches the daemon *process*; the **supervisor** (`scripts/daemon-supervisor.mjs`) and anything it
  loads are NOT re-read across exit `75` (the same running supervisor execs the new `dist/`). A merge that
  edits the supervisor needs a **human Ctrl-C + re-run of `pnpm daemon:stable`** to go live — a manager
  must flag that human action in its done-report (mirrors the unsupervised `restarting:false` refusal).

## Load-bearing invariants (validated in the spike — do not regress)
- **Drive the REAL interactive `claude` via node-pty.** Never `claude -p`/headless.
- **Spawn recipe** (`pty/host.ts`): absolute claude path (Windows node-pty doesn't search %PATH%);
  env scrub of `CLAUDECODE`/`CLAUDE_CODE_*`; `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` +
  `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1`; `--permission-mode acceptEdits` + allowlist (NOT
  `--dangerously-skip-permissions`, which shows a blocking gate); `--strict-mcp-config` WITH an
  explicit `--mcp-config` (suppresses the `.mcp.json` enable prompt). This combo boots unattended.
  - **Role-scoped human-prompt disallow** (`buildSpawnArgs`/`disallowedToolsForRole`): a Loom-DRIVEN role —
    **worker, setup, auditor, workspace-auditor** — spawns with `--disallowedTools AskUserQuestion
    ExitPlanMode EnterPlanMode`, so the interactive human-prompt tools are REMOVED from the model's tool
    list and can never block the turn on input that the human will never give (a worker's stdin is owned by
    its manager). The flag sits BEFORE `--strict-mcp-config` so its variadic value list is terminated by
    that flag, keeping `--mcp-config` the last flag before `--`. **Manager/orchestrator + the human-driven
    platform lead are DELIBERATELY excluded** (a manager legitimately surfaces decisions to the human), as
    are `run`/plain sessions — for every out-of-scope role the flag is omitted and the argv is byte-identical.
    Computed at the single `createPty` spawn chokepoint, so every path (fresh/resume/fork/recycle/boot)
    inherits it. `/worker` doctrine is the soft complement; this is the structural backstop (board card 8dd1dd1c).
- **Engine session id** captured via the SessionStart hook → `assets/hook-relay.mjs` →
  `/internal/hook`; persisted on receipt. New session injects the topic startup prompt; resume injects nothing.
- **MCP scoping:** session id is in the URL path (`/mcp/:sessionId`); the project is derived
  SERVER-SIDE. The agent never passes a projectId.
- **Sessions outlive viewers:** closing a ws never kills the pty. Fixed pty geometry (120×40),
  no resize. Stop: graceful (Ctrl-C ×2, clean) default, hard (`pty.kill`) escalation — both
  resumable and orphan-free (node-pty Job Object).
- **Manager→worker direction is coalesced + supersession-guarded** (`orchestration/`): worker-bound
  messages **drain as ONE turn** — the whole pending FIFO lands together, not one-injection-per-turn — so
  a burst of `worker_message`s is delivered as a single authoritative batch. The daemon also **refuses a
  worker's `done` report while it still has unconsumed manager direction queued** (the hard guard), so a
  worker can't finish a now-stale plan; the `/worker` doctrine is the soft complement (re-check for newer
  `[loom:from-manager]` direction before reporting). For a "land it NOW" steer, the manager has
  **`worker_redirect`** — it interrupts the worker's current turn, **flushes** any superseded queued
  direction, and delivers ONE authoritative instruction immediately — the escalation above the additive
  `worker_message`.
- **Opt-in worker browser (`browserTesting`):** a session whose resolved Profile sets `browserTesting`
  spawns with its OWN per-session stdio Playwright MCP (`@playwright/mcp`, absolute node + absolute
  `cli.js`, `--headless --isolated`) and that tool surface allowlisted. Default OFF + fully additive
  (every existing spawn byte-identical when off); pinned on the session row so resume/fork/recycle
  keep the browser. HUMAN-set only (Profiles UI/REST) — never an agent MCP tool (same capability-gating
  posture as gateCommand/shell). The MCP launches Chromium lazily on first use; needs a one-time
  `npx playwright install chromium`. The bundled browser-capable rigs are "QA Tester" (test/verify) and
  "Web Designer" (UI/frontend build) — both spawn the per-session Playwright MCP.
- **Opt-in document conversion (`documentConversion`):** a session whose resolved Profile sets
  `documentConversion` spawns with its OWN per-session stdio markitdown MCP (Microsoft `markitdown-mcp`,
  resolved to an ABSOLUTE path) and its single tool `mcp__markitdown__convert_to_markdown` allowlisted —
  so a research/document rig can convert files (PDF/Office/images/HTML/…) to Markdown to save tokens.
  **ffmpeg caveat:** AUDIO conversion needs `ffmpeg` on PATH; document formats (PDF/Office/images/HTML)
  don't. Without ffmpeg, `markitdown[all]`'s `pydub` prints a harmless "Couldn't find ffmpeg or avconv"
  to stderr on every invocation — documents convert fine. Loom does NOT install or suppress it.
  Structurally identical to `browserTesting`: default OFF + fully additive (every existing spawn
  byte-identical when off); pinned on the session row so resume/fork/recycle keep it. HUMAN-set only
  (Profiles UI/REST) — never an agent MCP tool (it launches a host process; same capability-gating posture
  as browserTesting/gateCommand). The binary is resolved (`pty/host.ts` › `markitdownMcpServer`) via the
  shared Python venv (below): first the human-only `LOOM_MARKITDOWN_BIN` override (an already-installed
  binary — and the TEST seam, so CI never builds a venv), else a single `fs.existsSync(loomVenvBin(…))` —
  if the venv is warm, inject it; if cold, return null (THIS spawn skips the MCP, like Playwright's
  missing-cli) and kick BACKGROUND provisioning. A later spawn picks it up once the venv lands — and the
  kick is RETRYABLE + DIAGNOSTIC (a failed attempt no longer dead-ends; the classified reason + captured
  error tail is surfaced via the status model + REST below). **One-time USER setup is just a base Python
  ≥3.10** discoverable on PATH (or pointed at via `python.interpreterPath`) — Loom owns the venv and the install.
- **Shared Loom-managed Python venv (`python/venv.ts`) + `python.interpreterPath`:** Loom owns ONE shared
  venv under `<LOOM_HOME>/python/venv` — NOT a venv-per-tool. **Event-loop discipline (load-bearing):** the
  spawn HOT PATH (`createPty` → `buildMcpServers`) does NO blocking work — only `fs.existsSync(loomVenvBin(
  binary))` (instant). Creating the venv + `pip install markitdown[all]` takes minutes, so provisioning is
  fully ASYNC (`child_process.spawn`, never `spawnSync`) and BEST-EFFORT, off the event loop — mirroring
  `git/worktrees.ts` `createWorktree`. A synchronous `spawnSync` venv-create/pip on the spawn path would
  FREEZE the whole daemon (every spawn/resume, the web UI, all HTTP/MCP) for the entire install; that bug is
  what this split avoids. `ensurePythonPackageAsync({ package, binary, probeImport?, timeoutMs?,
  interpreterOverride? })` is the reusable surface EVERY Python-backed capability calls OFF the hot path
  (e.g. from a background job): it creates the venv if missing (from a discovered base Python via async
  `discoverBasePythonAsync` — `python.interpreterPath` FIRST, then `python3` → `python` → win32 `py -3`),
  pip-installs, and returns a CLASSIFIED `{ binary, outcome, errorTail }` — the ABSOLUTE console-script path +
  `ready` on success, else `binary:null` with the SPECIFIC failure (`no-base-python` / `venv-create-failed` /
  `pip-failed` / `timeout` / `disabled`) and the captured ~4KB stdout+stderr tail. venv/pip run with PIPED
  stdio (NOT `stdio:'ignore'`), so the REAL cause (proxy / SSL / resolver / timeout) is logged + surfaced, not
  lumped into one opaque "venv/pip failed". Idempotent (a ready venv hits a fast path via an import probe),
  BOUNDED (every spawn has a timeout; the markitdown `pip install` gets a ~15-min / `900_000`ms bound —
  `markitdown[all]` is heavy: onnxruntime + many converters — killed-on-exceed ⇒ classified `timeout`, while
  venv-create/probe keep their fast bounds), NEVER throws. The markitdown consumer kicks it RETRYABLY — deduped
  ONLY while a job is genuinely IN-FLIGHT (concurrent spawns never launch parallel installs), but a fresh kick
  is allowed after a TERMINAL outcome, so a profile-save pre-warm, a later spawn, or the human-only retry below
  all actually retry (NOT the old PERMANENT one-shot that dead-ended every retry until a daemon restart). It
  tracks a status `{ state: idle|installing|ready|failed, reason, errorTail, binary, lastAttemptAt }` read via
  the human-only loopback `GET /api/python/provisioning`; `POST /api/python/provisioning/retry` re-kicks it off
  the event loop (both NOT agent MCP tools — provisioning launches a host process, same trust posture as the
  git/vault/gateCommand writers). On success the resolved path is memoized (the cold case re-checks
  `fs.existsSync` each spawn until warm). `LOOM_PYTHON_NO_PROVISION=1` disables real venv/pip provisioning
  (CI hermetic tests + an ops escape hatch). Loom installs PACKAGES, never the interpreter.
  `python.interpreterPath` is a top-level human-only config (resolved by `resolveConfig`, carried to the
  daemon resolver via the session-env transport `pythonSessionEnv` → `LOOM_PYTHON_INTERPRETER`); it points
  at a host EXECUTABLE, so — exactly like `obsidian.path`/`gateCommand` — the agent-facing config validator
  REJECTS it (human REST path only). The venv is PRE-WARMED off the hot path to close the cold-skip window
  (`python/prewarm.ts`): at daemon boot if any profile sets `documentConversion`, and when a profile is
  SAVED with it on — both reuse the SAME deduped async background kick (`prewarmMarkitdown`), so the first
  documentConversion session usually finds the MCP already warm. The carried `python.interpreterPath` (a
  per-project config with no platform-override layer) resolves to the first project that sets one, else PATH
  discovery.
- **Worktree dep-provisioning (`git/worktrees.ts`):** `createWorktree` best-effort-installs deps at
  creation so a worker boots build-ready. It picks the package manager by lockfile marker IN the worktree
  root — deterministic precedence pnpm (`pnpm-lock.yaml`) → npm (`package-lock.json`) → yarn (`yarn.lock`),
  no marker → no-op — and runs the matching install ASYNC + bounded by `PROVISION_TIMEOUT_MS`, best-effort
  (all failures swallowed; the worker installs on its own), HARDCODED commands (never agent input). Each
  worktree gets its OWN node_modules; node_modules is NEVER shared/symlinked/junctioned across worktrees
  (native modules + concurrent install-state would break — load-bearing). **A fresh worktree does NOT carry
  gitignored files — notably `.env`/secrets are absent.** A worker that needs env vars must be told so in
  its kickoff; provisioning deliberately does not copy or widen the secret surface.

## Conventions
- Node 22 + TypeScript, ESM (`NodeNext`) in daemon/shared; `bundler` resolution in web.
- One config-resolution mechanism (`resolveConfig`) — never read defaults ad hoc.
- **Conventional Commits, going-forward only** (do NOT rewrite published history). Every Loom-authored
  commit subject is `type(scope): summary` — lowercase type, imperative, no trailing period, ≤~72 chars.
  Allowed types: `feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert`. **The scope is
  REQUIRED** and must come from the "Commit scopes" list below. Managers title board cards in this form
  (NO `[Type, Priority]` bracket — priority is the card's field); the per-task squash merge uses the card
  title verbatim as the commit subject, so a conventional title is a conventional commit. A title that
  slips is coerced by a merge-code safety-net (`toConventionalSubject` in `git/worktrees.ts`: legacy
  bracket → mapped type, bare prose → `chore:`) — but the net only guarantees a valid *type*; it can't know
  the scope, so scope is enforced by titling, not the helper. Title it right at the source.

### Commit scopes
Loom's commit scope vocabulary, derived from the real tree. Pick the one subsystem a change lands in;
prefer the finest-grained scope that fits.
- **Packages:** `daemon`, `web`, `shared`, `cli` (the `bin/loom.mjs` management CLI).
- **Daemon subsystems** (`packages/daemon/src/*`): `gateway`, `git`, `mcp`, `orchestration`, `platform`,
  `profiles`, `pty`, `runs`, `sessions`, `setup`, `skills`, `tasks` (the task board / cards domain),
  `update`, `vault`.
- **Cross-cutting / process:** `deps` (dependency bumps), `ci`, `release`, `docs`, `assets` (bundled
  skills / hook-relay / vault-lint under `assets/**`).

This list is **Loom-specific**. Every project keeps its OWN "Commit scopes" list in its OWN `CLAUDE.md`;
a project with no documented list gets one derived from its structure at intake, and only a project with
no meaningful code subdivisions may go scopeless.
- Vault + git writes are enabled via a HUMAN-only REST surface (vault: `vault/writer.ts`; git:
  `git/writer.ts` — checkout/commit/push/create-branch). These are trust-boundary surfaces like
  gateCommand: NO **core / project-session** MCP tool exposes them; an agent in an ordinary project
  session can never write/commit/push. The one deliberate exception is the `LOOM_DEV`-gated **Platform
  Lead** surface (`mcp/platform.ts`), which is itself human-driven and ABOVE all projects: it registers
  `git_checkout`/`git_create_branch`/`git_commit`/`git_push` + `vault_write` as agent tools (each reusing
  the same bounded writer code by explicit `projectId`). Every git write is bounded + non-interactive
  (`GIT_TERMINAL_PROMPT=0` + timeout) so a hung push can't wedge the daemon. The read-only log/branches
  view is unchanged.

### Vault structure
Loom's design docs live in the Obsidian vault at `Projects/Loom/` in a **shallow (one-level), stable**
taxonomy — not a flat wall of notes. **Fixed-path / canonical docs stay pinned at the vault root** —
including the ones this `CLAUDE.md` references by exact path (`Architecture.md`, `Vision & Architecture.md`,
`Setup Assistant Design.md`), which is *why* they're pinned: moving them would break those refs. The
root-pinned set: `Architecture.md`, `Vision & Architecture.md`, `Setup Assistant Design.md`,
`Companion Design.md`, `Loom.md`, `Platform Manager.md`, `Orchestrator Log.md`, `Platform Lead Resume.md`.
**Every other note lives in a taxonomy folder:** `Design/`, `Operations/`, `Roadmap/`, `Release/`,
`Spikes/`. An **`_Index.md`** map-of-content at the vault root lists every note by group — **read it to
locate a note instead of Globbing, and update its line when you add or move a note.** Wikilinks resolve by
note name, so moving a note between folders never breaks a `[[link]]`.

Like "Commit scopes", this folder vocabulary is **Loom-specific** — every project keeps its own "Vault
structure" section in its own `CLAUDE.md`; the shipped skills teach the generic shallow-taxonomy +
`_Index.md` principle and read the folder names from here.
