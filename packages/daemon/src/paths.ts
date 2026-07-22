import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "./pty/resolve-bin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Expand a leading `~` in a USER-SUPPLIED host path (repoPath/vaultPath/referenceRepos entries,
 * obsidian.path, python.interpreterPath) to the current user's home directory — `~` is a SHELL
 * expansion, so it never reaches Node; a path typed into a form field or passed to an MCP tool arrives
 * literally, and `fs`/`isGitRepo` don't expand it either. Apply this at the input boundary, before any
 * existence/isGitRepo check, so the STORED path is already the expanded absolute one.
 *   - `"~"` alone → `os.homedir()`.
 *   - `"~/…"` or `"~\\…"` → `os.homedir()` joined with the rest.
 *   - `"~otheruser/…"` (another user's home) → left UNCHANGED — Node has no portable way to resolve an
 *     arbitrary user's home directory, unlike a shell.
 *   - anything else (no leading `~`) → left UNCHANGED.
 * Cross-platform: `os.homedir()` resolves on Windows too (harmless there — a Git-Bash user may still
 * type `~`), and `path.join` normalizes the separator for the current platform either way.
 */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** All daemon-owned state lives under ~/.loom (overridable via LOOM_HOME). */
export const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
export const DB_PATH = path.join(LOOM_HOME, "loom.db");
/**
 * The local 32-byte master key for the recoverable-secret envelope helper (`keys/envelope.ts`).
 * A recoverable OUTWARD credential — e.g. the companion bot token the daemon must DECRYPT to call
 * Telegram — is stored AES-256-GCM-encrypted at rest (in loom.db, which is backed up + syncable);
 * the ciphertext is useless without THIS separate local key file, which is NEVER backed up. Lazily
 * generated 0600 on first use (win32 mode is best-effort — confidentiality rests on the file living
 * under the user profile). NOT created in ensureDirs (lazy), so a daemon with no recoverable secret
 * never writes it. Resolve via LOOM_HOME here — never hard-code — and pass an override key path in tests.
 */
export const SECRET_KEY_PATH = path.join(LOOM_HOME, "secret.key");
export const SETTINGS_DIR = path.join(LOOM_HOME, "tmp", "settings");
export const LOGS_DIR = path.join(LOOM_HOME, "logs");
/**
 * A repo-EXTERNAL, per-session scratch directory under LOOM_HOME (sibling of the per-session settings
 * convention `tmp/settings/<id>.json`). It is the default output base for a browser session's
 * Playwright captures (`--output-dir`), so a `browser_take_screenshot` taken with NO explicit path can
 * NEVER land inside the project working tree — without it, the Playwright MCP defaults output to
 * `<cwd>/.playwright-mcp` and cwd IS the project repo root, a stray-PNG-commit footgun in a self-hosting
 * repo (a missed cleanup stages a verification screenshot). An explicit (absolute) caller path is
 * unaffected: playwright-core resolves an output filename with `path.resolve(outputDir, fileName)`, so an
 * absolute filename bypasses this base entirely. NOT created here (the Playwright MCP mkdir-recursive's it
 * lazily on first write) — a pure path derivation, safe on the synchronous spawn hot path.
 */
export function sessionScratchDir(sessionId: string): string {
  return path.join(LOOM_HOME, "tmp", "scratch", sessionId);
}
/**
 * Per-worker git worktrees live outside the PROJECT repo (share its object store; don't clutter it) —
 * AND outside LOOM_HOME itself. `LOOM_HOME` (`~/.loom`) is a plain state dir for most users, but in the
 * self-hosting setup it IS a git repo of its own (cross-agent state: skill sources, resume docs,
 * `restart-intent.json`, …). Nesting `worktrees/` inside it (the pre-2026-07-07 layout) meant a worker
 * whose Bash cwd sits under its worktree could `cd ..` up into that repo and a stray `git` command there
 * would mutate the daemon home's live working tree — this actually happened (a worker's `cd .. && git
 * stash` swept up another agent's uncommitted WIP). So the base is a SIBLING of LOOM_HOME —
 * `<LOOM_HOME>-worktrees` — derived from it (still isolated per-LOOM_HOME, so side-by-side daemons with
 * different LOOM_HOME stay isolated) but with no `.git` ancestor of its own between it and the
 * filesystem root (LOOM_HOME's parent — the user's home dir — is not a git repo). `path.dirname`/
 * `path.basename` (not string concatenation) so a trailing separator on LOOM_HOME can't produce a
 * malformed sibling path. Existing worktrees created under the OLD `LOOM_HOME/worktrees` layout keep
 * working (tracked by absolute path in the DB) until they're individually removed — going-forward
 * relocation only, no migration.
 */
export const WORKTREES_DIR = path.join(path.dirname(LOOM_HOME), `${path.basename(LOOM_HOME)}-worktrees`);
/**
 * Agent Runs (R2): each ephemeral `run` session gets a disposable, read-only snapshot of the project's
 * HEAD as its cwd under `runs/<sessionId>/`. NOT a git worktree (no .git, no branch, no admin record —
 * sidesteps the worktree-GC bug class); hard-deleted on teardown, and the whole tree is swept on boot
 * (runs never resume, so any dir lingering at boot is orphaned by definition).
 */
export const RUNS_DIR = path.join(LOOM_HOME, "runs");
/**
 * The SANCTIONED base for projects the ungated Setup/Platform operator BOOTSTRAPS for a user who has no
 * existing repo/folder (the `loom-setup` `project_init` tool). The operator can create a fresh project
 * directory ONLY strictly under here — the dir name is derived from the project name (or an explicit
 * `dirName`), confined to this base, with traversal/escape rejected. This is the operator's ENTIRE
 * host-write envelope: it is the lower-privilege cousin of the dev Platform layer and holds no other
 * host-writer surface, so a fresh-user "empty install → working setup" flow can `git init` a workspace
 * without ever widening the trust boundary to arbitrary host paths. Lives under LOOM_HOME so it is
 * always present + daemon-owned; an individual project dir here is NOT operational (no loom.db/worktrees
 * inside it), so the vault versioner treats a vault-only project here as an ordinary docs vault.
 */
export const WORKSPACE_ROOT = path.join(LOOM_HOME, "workspaces");
/**
 * Automatic DB backups. The auto-backup service writes + rotates rolling snapshots under `auto/`;
 * manual snapshots (e.g. `pre-*` dirs) live directly under `backups/` and are NEVER touched by
 * rotation. The dir is created lazily by the backup module (only when a snapshot is actually taken).
 */
export const BACKUPS_DIR = path.join(LOOM_HOME, "backups");
export const AUTO_BACKUP_DIR = path.join(BACKUPS_DIR, "auto");
/**
 * Loom's OWN editable skill set (UI-managed). Each session gets these injected as PROJECT-LOCAL
 * skills (<cwd>/.claude/skills) so they're discovered as bare names — keeping Loom's skills separate
 * from the user's bespoke personal set without ever touching ~/.claude/skills. NOTE: this does NOT
 * shadow a same-named personal skill — Claude Code's documented precedence is personal-overrides-
 * project (see inject.ts's injectSkills doc comment for the full correction and citation), so a
 * bundled Loom skill name must not collide with a common personal one. Bundled defaults are seeded
 * here on boot; then user-editable.
 */
export const SKILLS_DIR = path.join(LOOM_HOME, "skills");

/**
 * Per-bundled-skill `base` snapshots — the shipped SKILL.md content as of the user's LAST sync (the
 * third version, alongside `mine` = the store under SKILLS_DIR and `shipped` = the bundled asset). One
 * flat `<name>.md` file each. DELIBERATELY OUTSIDE SKILLS_DIR so session injection (skills/inject.ts
 * mirrors the skill DIR into <cwd>/.claude/skills) NEVER copies a base file, and listSkills/seed never
 * mistake it for a skill. Used only to derive precise customization state (customized / updateAvailable)
 * and to drive the non-destructive 3-way adopt-update merge.
 */
export const SKILL_BASE_DIR = path.join(LOOM_HOME, "skill-base");

/**
 * The Loom Companion's SELF-AUTHORED skill store (epic Phase 2) — ISOLATED per companion session and kept
 * strictly SEPARATE from the global SKILLS_DIR. Each bound companion gets its OWN base dir
 * `<LOOM_HOME>/companion-skills/<companionSessionId>/<name>/SKILL.md`. These skills are authored/refined by
 * the companion over MCP and loaded ON-DEMAND (skill_list + skill_read); they are NEVER seeded into
 * SKILLS_DIR and NEVER injected into any session's `<cwd>/.claude/skills` — a companion co-located with a
 * manager on the same repoPath cwd would otherwise LEAK its private skills into the manager's skill dir.
 * Created lazily on first author (never in ensureDirs), so default-OFF stays byte-identical.
 */
export const COMPANION_SKILLS_DIR = path.join(LOOM_HOME, "companion-skills");
export function companionSkillsDir(sessionId: string): string {
  return path.join(COMPANION_SKILLS_DIR, sessionId);
}

/**
 * The Loom Companion's SELF-AUTHORED memory store — the sibling of COMPANION_SKILLS_DIR, same isolation
 * discipline: each bound companion gets its OWN base dir `<LOOM_HOME>/companion-memory/<companionSessionId>/
 * <name>/MEMORY.md`. Memory entries are authored/refined by the companion (name+description+pinned
 * frontmatter) and loaded ON-DEMAND, NEVER seeded/injected into any session's skill dir. Created lazily on
 * first author (never in ensureDirs), so default-OFF stays byte-identical.
 */
export const COMPANION_MEMORY_DIR = path.join(LOOM_HOME, "companion-memory");
export function companionMemoryDir(sessionId: string): string {
  return path.join(COMPANION_MEMORY_DIR, sessionId);
}

/**
 * Single-process mode (Releases v1): where the PREBUILT web viewport (Vite output) lives, so the daemon
 * can serve the UI from its own loopback origin — no separate `pnpm web`. One resolver, with an env
 * override so it works in the monorepo NOW and from a bundled npm package LATER (Part 2). Priority:
 *   1. LOOM_WEB_DIST (explicit override — the bundled package points this at its shipped assets);
 *   2. a copy bundled NEXT TO the built daemon (`<daemon>/dist/web`) — Part 2's default drop location;
 *   3. the monorepo build output (`packages/web/dist`, resolved relative to this built file).
 * Returns the first candidate that actually holds an `index.html`, else the monorepo path (so the
 * gateway logs a sensible "missing dist" location and skips static — it never crashes a dist-less boot).
 */
export function resolveWebDistDir(): string {
  const override = process.env.LOOM_WEB_DIST;
  if (override) return path.resolve(override);
  const bundled = path.join(__dirname, "web"); // dist/paths.js → dist/web (Part 2 bundles here)
  const monorepo = path.join(__dirname, "..", "..", "web", "dist"); // dist/paths.js → packages/web/dist
  return fs.existsSync(path.join(bundled, "index.html")) ? bundled : monorepo;
}

/** hook-relay.mjs ships as an asset alongside the built daemon. */
export const RELAY_SCRIPT = path.join(__dirname, "..", "assets", "hook-relay.mjs");
/** vault-lint.mjs (Pillar D PostToolUse hook) ships as an asset too. */
export const VAULT_LINT_SCRIPT = path.join(__dirname, "..", "assets", "vault-lint.mjs");
/**
 * ensure-obsidian.mjs (Obsidian auto-start vault preflight) ships as an asset too. Injected into a
 * session's env as LOOM_OBSIDIAN_PREFLIGHT only when obsidian.autoStart is on, so a vault skill can run
 * `node "$LOOM_OBSIDIAN_PREFLIGHT"` before its `obsidian` CLI calls (self-heals or falls back to FS).
 */
export const ENSURE_OBSIDIAN_SCRIPT = path.join(__dirname, "..", "assets", "scripts", "ensure-obsidian.mjs");
/**
 * transcribe.py (Companion Voice epic, VOICE-P2 — local faster-whisper STT) ships as an asset too, invoked
 * via the shared Python venv's interpreter (see companion/stt.ts). Read live from the package dir like the
 * other assets, so an asset edit applies on the next transcribe call with no rebuild of the daemon itself.
 */
export const TRANSCRIBE_SCRIPT = path.join(__dirname, "..", "assets", "python", "transcribe.py");
/**
 * synthesize.py (Companion Voice epic, VOICE-P3 — local Kokoro-onnx TTS) ships as an asset too, invoked via
 * the shared Python venv's interpreter (see companion/tts.ts). Read live from the package dir like the
 * other assets, so an asset edit applies on the next synthesize call with no rebuild of the daemon itself.
 */
export const SYNTHESIZE_SCRIPT = path.join(__dirname, "..", "assets", "python", "synthesize.py");

/**
 * The Obsidian "vault preflight" skill fragment — appended (live-read from the package dir) to the
 * injected loom-pickup/loom-session-end SKILL.md ONLY when a session's project has `obsidian.autoStart` on. Kept
 * OUT of the store SKILL.md so the base skills stay short + Obsidian-free (byte-identical when off); see
 * skills/inject.ts. Read live like the other assets, so an asset edit applies on the next spawn.
 */
export const OBSIDIAN_PREFLIGHT_FRAGMENT = path.join(__dirname, "..", "assets", "skill-fragments", "obsidian-preflight.md");

export const PORT = Number(process.env.LOOM_PORT || 4317);

/**
 * The Loom SOURCE repo root — the checkout whose code the DEV Platform Auditor reads for code-awareness
 * (its least-privilege, read-only repo tools confine EVERY read to this tree — see mcp/repo-read.ts).
 * Resolved from the built daemon's own location: `dist/paths.js` lives at `<repo>/packages/daemon/dist`,
 * so three levels up is the monorepo root (the same monorepo layout `resolveWebDistDir` already relies
 * on). A human-only `LOOM_REPO_ROOT` override takes precedence — the hermetic-test seam (point it at a
 * temp fixture tree) and an ops escape hatch. Read at CALL time (like `isLoomDev` / `resolveWebDistDir`)
 * so a test can set the override after import. The Auditor is LOOM_DEV-gated and runs from the self-host
 * monorepo, so the three-up resolution is the real path in every shipping scenario.
 */
export function loomRepoRoot(): string {
  const override = process.env.LOOM_REPO_ROOT;
  if (override) return path.resolve(override);
  return path.resolve(__dirname, "..", "..", ".."); // dist/paths.js → packages/daemon/dist → repo root
}

/**
 * Dev-only feature gate (`LOOM_DEV=1`, default OFF). The "Platform layer" — the reserved "Loom Platform"
 * project + its Platform Lead / Platform Auditor agents, the Platform-lead / Platform-audit profiles, and
 * the platform-lead / platform-audit skills — is gated behind this flag so it does NOT ship to regular
 * `loomctl` users, while staying in the repo (loadable in dev mode). This is the SINGLE env read for the
 * gate; the seeders call it. Read at CALL time (like index.ts's `LOOM_SCHEDULER_ENABLED` boot read) so a
 * single process can toggle the flag — the hermetic test exercises both default-off and dev-on in one run.
 */
export function isLoomDev(): boolean {
  return process.env.LOOM_DEV === "1";
}

/**
 * Test/ops escape hatch (`LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1`, default OFF). A throwaway/isolated daemon
 * booted against a fresh LOOM_HOME (e.g. a verification worker spinning one up to eyeball the web UI)
 * otherwise auto-spawns a REAL `claude` process (the Setup/Platform operator) via the first-run
 * auto-launch — before an operator has a chance to pre-stamp the marker. This flag pre-suppresses ONLY
 * that auto-SPAWN; the daemon still boots normally and the `app_meta` one-time marker (see
 * setup/first-run.ts › SETUP_FIRST_RUN_KEY) is still read/written exactly as today, so the "fires at most
 * once, ever" guarantee is unaffected — a later boot with the flag unset will not re-launch once the
 * marker is set. Read at CALL time (like `isLoomDev`) so a single test process can exercise both states.
 */
export function isFirstRunLaunchSuppressed(): boolean {
  return process.env.LOOM_SUPPRESS_FIRST_RUN_LAUNCH === "1";
}

/**
 * Test/ops escape hatch (`LOOM_SUPPRESS_USAGE_POLLER=1`, default OFF), same family as
 * {@link isFirstRunLaunchSuppressed}. The account-wide plan-usage poller (orchestration/usage-status.ts)
 * reads the HOST's real Claude OAuth credentials and serves the owner's real 5h/7d utilization over
 * GET /api/usage/limits — a throwaway/isolated daemon (e2e, demo, a verification worker eyeballing the
 * UI) has no business reading or exposing that. Read at CALL time so a single test process can exercise
 * both states.
 */
export function isUsagePollerSuppressed(): boolean {
  return process.env.LOOM_SUPPRESS_USAGE_POLLER === "1";
}

/**
 * Card C1 (Codescape fleet-daemon wiring epic `369dde3c`, LOOM_DEV-gated): the ONE shared working
 * directory BOTH `codescape ingest` and `codescape serve` must be spawned from — both commands resolve
 * their `.codescape` state dir relative to `process.cwd()`, so ingest and serve sharing this exact cwd is
 * the CWD CONTRACT (see codescape/supervisor.ts) — a mismatch means serve silently never sees what
 * ingest wrote. Deliberately NOT created here (unlike WORKTREES_DIR etc. in `ensureDirs`) — creating it
 * unconditionally would make a disabled boot no longer "byte-identical" (the C1 negative-case DoD); the
 * supervisor creates it lazily, only once it actually starts.
 */
export const CODESCAPE_HOME_DIR = path.join(LOOM_HOME, "codescape");

/**
 * Card 503a30a0: whether the Codescape fleet-daemon supervisor should start at boot. `isLoomDev()` is a
 * HARD prerequisite — Codescape supervision lives in the same LOOM_DEV-gated layer as the Platform Lead
 * builtins and NEVER runs for a regular `loomctl` user, flag or not. Within dev, the gate is now HOST-CLI
 * PRESENCE, not a hand-set env toggle: `hostToolBinExists(codescapeBinCandidate(dbPath))` — the SAME
 * DB-path → `LOOM_CODESCAPE_BIN` → bare-PATH-name precedence the spawn resolvers already use (see
 * `codescapeBinCandidate`/`resolveCodescapeBin` below). Codescape is a PRIVATE internal tool: a vanilla
 * end-user's host never has a `codescape` binary anywhere on PATH, so this resolves false for every
 * ordinary install with ZERO configuration and no discoverable toggle — it activates automatically, with
 * no hand-set env var, on the ONE class of host that actually has the CLI installed (the owner's own dev
 * machine). Retires the old `LOOM_CODESCAPE_ENABLED=1` hardcoded env-only gate entirely (the exact class
 * of knob the `f487df9d` sweep retired elsewhere) — there is no env-based "master switch" left to hand-set.
 * `dbPath` is the optional DB-persisted `integrations.codescape.path` override (card 8dc5ebb9), threaded
 * in by a caller that has one (e.g. `pty/host.ts`'s per-spawn `getIntegrationPaths` seam); omitted by a
 * caller with no DB context (paths.ts itself has none), which still resolves correctly via the
 * env/bare-PATH layers alone. Read at CALL time (like `isLoomDev`) so a single test process can exercise
 * both the CLI-present and CLI-absent state within one run.
 */
export function isCodescapeSupervisorEnabled(dbPath?: string): boolean {
  return isLoomDev() && hostToolBinExists(codescapeBinCandidate(dbPath));
}

/**
 * Card C2 (updated 503a30a0): whether a SPECIFIC project should get the per-session Codescape MCP wired
 * in. Combines the daemon-wide supervisor gate ({@link isCodescapeSupervisorEnabled}, now host-CLI-
 * presence-based) with the per-project opt-in (`ResolvedConfig.codescape.enabled`, LEAD RULING:
 * per-project, NOT per-profile) — a project can only opt in to what the daemon has already detected as
 * available. Flipping the project flag alone on a non-dev build (or on a host with no codescape CLI)
 * wires nothing. Shared with C3 (the worktree lifecycle hooks), which gates its own ingest/register/drop
 * calls the same way. `dbPath` forwards straight to {@link isCodescapeSupervisorEnabled}.
 */
export function isCodescapeEnabled(config: { codescape: { enabled: boolean } }, dbPath?: string): boolean {
  return isCodescapeSupervisorEnabled(dbPath) && config.codescape.enabled;
}

/**
 * Shape-aware host-tool launch resolver — the ONE helper every optional host-tool resolver (Codescape,
 * and any future one) shares, so a new tool gets this for free instead of re-deriving it (a node ESM
 * script bin launched directly fails on Windows — there's no reliable shebang/association to exec a bare
 * `.mjs` file cross-platform). Given ANY bin (a `.js`/`.mjs`/`.cjs` script path, an absolute
 * compiled-binary path, or a bare PATH-resolvable name), returns the correct `{command, args}` spawn pair:
 *   - a `.js`/`.mjs`/`.cjs` path runs via node explicitly (`process.execPath`, the script as its one arg);
 *   - anything else resolves through {@link resolveExecutable} (PATH + Windows PATHEXT, e.g. a `.cmd`
 *     npm shim or a compiled binary) and launches directly with NO shell — sidesteps the shell-quoting
 *     concerns `git/worktrees.ts:166` documents for its own `shell:true` installs (an argv element here
 *     never needs quoting).
 * The caller appends its OWN subcommand args (e.g. `["mcp"]`, `["mcp", "--graph", graphPath]`) after this
 * resolves the base command+args.
 */
const HOST_TOOL_SCRIPT_RE = /\.[mc]?js$/;
export function resolveHostToolBin(bin: string): { command: string; args: string[] } {
  if (HOST_TOOL_SCRIPT_RE.test(bin)) return { command: process.execPath, args: [bin] };
  return { command: resolveExecutable(bin), args: [] };
}

/**
 * Card 8dc5ebb9: does `bin` (either of {@link resolveHostToolBin}'s two shapes) resolve to a file that
 * actually EXISTS on disk? For a `.js`/`.mjs`/`.cjs` script, that's `bin` itself (the thing node would
 * run); for anything else, {@link resolveExecutable}'s result (PATH+PATHEXT search, or the input
 * unchanged when nothing resolves — `fs.existsSync` on the unresolved bare name then correctly reads
 * false in the overwhelming common case). Used ONLY by the human-only `/api/integrations` detect
 * endpoint (a live "is this configured tool actually there" check) — NEVER on the synchronous spawn hot
 * path, which stays each resolver's own fast existsSync/isAbsolute check (codescapeMcpServer), unchanged.
 */
export function hostToolBinExists(bin: string): boolean {
  const target = HOST_TOOL_SCRIPT_RE.test(bin) ? bin : resolveExecutable(bin);
  return fs.existsSync(target);
}

/**
 * The `codescape` bin CANDIDATE string (before shape resolution): DB-first (card 8dc5ebb9's
 * `integrations.codescape.path`, threaded in by the caller), then `LOOM_CODESCAPE_BIN`, then the bare
 * PATH-resolvable default name. Exported (not just inlined into {@link resolveCodescapeBin}) so the
 * `/api/integrations` detect endpoint can run the SAME precedence through {@link hostToolBinExists}
 * without duplicating it.
 */
export function codescapeBinCandidate(dbPath?: string): string {
  return dbPath?.trim() || process.env.LOOM_CODESCAPE_BIN?.trim() || "codescape";
}

/**
 * Card C1: resolve the `codescape` CLI as a `{command, args}` spawn pair (never a shell string — see
 * codescape/supervisor.ts for why). `LOOM_CODESCAPE_BIN`/the DB path are human-only overrides — but do
 * not require an absolute path: the supervisor spawns via plain `child_process.spawn` (not node-pty), so
 * a bare PATH-resolvable name is fine too (CONTRACT Q5: "PATH or absolute both acceptable"). Card
 * 8dc5ebb9: `dbPath` (the DB-persisted `integrations.codescape.path`, when the caller has one) wins over
 * `LOOM_CODESCAPE_BIN`, mirroring every other host-tool resolver's DB-first precedence — see
 * {@link codescapeBinCandidate}. Shape resolution itself is the shared {@link resolveHostToolBin}.
 */
export function resolveCodescapeBin(dbPath?: string): { command: string; args: string[] } {
  return resolveHostToolBin(codescapeBinCandidate(dbPath));
}

/**
 * Card C2 rewrite (`369dde3c`): the per-project graph file BOTH `codescape ingest <repo> --out
 * <path>` (sessions/service.ts C3 hooks) and the per-session stdio `codescape mcp --graph <path>`
 * (pty/host.ts `codescapeMcpServer`) agree on — replaces the old shared-`serve` HTTP-scope model
 * (see codescape/supervisor.ts's CWD CONTRACT for the now-agent-path-decoupled shared-serve index,
 * which this graph file is independent of). One graph per PROJECT (not per-worktree/session) —
 * every session on a project reads the same always-current main graph.
 */
export function codescapeGraphPath(projectId: string): string {
  return path.join(CODESCAPE_HOME_DIR, projectId, "graph.json");
}

export function ensureDirs(): void {
  for (const d of [LOOM_HOME, SETTINGS_DIR, LOGS_DIR, WORKTREES_DIR, RUNS_DIR, SKILLS_DIR, SKILL_BASE_DIR, WORKSPACE_ROOT]) fs.mkdirSync(d, { recursive: true });
  ensureLoomHomeGitignore();
}

/**
 * Defense-in-depth (p3): a fresh LOOM_HOME has NO git history of its own by default, but a user who
 * `git init`s their home dir (or a tool that does it on their behalf) could otherwise commit
 * SECRET_KEY_PATH (the AES-256 envelope master key, see above) or any stray private-key/cert material
 * dropped alongside it. The acute vector (the auto-vault-versioner walking into LOOM_HOME) is already
 * closed elsewhere (`versioner.ts` › `isOperationalVaultDir`) — this is a belt-and-suspenders default
 * ignore so a fresh install never has to discover that gap by hand. Idempotent: appends only the
 * entries missing from an existing `.gitignore`, never touches or reorders a user's own lines.
 */
const DEFAULT_GITIGNORE_ENTRIES = ["secret.key", "*.key", "*.pem"];

function ensureLoomHomeGitignore(): void {
  const gitignorePath = path.join(LOOM_HOME, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    existing = "";
  }
  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = DEFAULT_GITIGNORE_ENTRIES.filter((e) => !existingLines.has(e));
  if (missing.length === 0) return;
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  fs.appendFileSync(gitignorePath, `${needsLeadingNewline ? "\n" : ""}${missing.join("\n")}\n`);
}
