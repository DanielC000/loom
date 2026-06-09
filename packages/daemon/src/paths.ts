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

export const PORT = Number(process.env.LOOM_PORT || 4317);

export function ensureDirs(): void {
  for (const d of [LOOM_HOME, SETTINGS_DIR, LOGS_DIR, WORKTREES_DIR, RUNS_DIR, SKILLS_DIR]) fs.mkdirSync(d, { recursive: true });
}
