import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** All daemon-owned state lives under ~/.loom (overridable via LOOM_HOME). */
export const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
export const DB_PATH = path.join(LOOM_HOME, "loom.db");
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
/** Per-worker git worktrees live outside the repo (share its object store; don't clutter it). */
export const WORKTREES_DIR = path.join(LOOM_HOME, "worktrees");
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
 * skills (<cwd>/.claude/skills) so they're discovered as bare names and SHADOW the user's personal
 * ~/.claude/skills — keeping Loom's skills separate from the user's bespoke personal set (validated
 * spike: project-local shadowing wins). Bundled defaults are seeded here on boot; then user-editable.
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
 * The Obsidian "vault preflight" skill fragment — appended (live-read from the package dir) to the
 * injected pickup/session-end SKILL.md ONLY when a session's project has `obsidian.autoStart` on. Kept
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

export function ensureDirs(): void {
  for (const d of [LOOM_HOME, SETTINGS_DIR, LOGS_DIR, WORKTREES_DIR, RUNS_DIR, SKILLS_DIR, SKILL_BASE_DIR, WORKSPACE_ROOT]) fs.mkdirSync(d, { recursive: true });
}
