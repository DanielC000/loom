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
 * Loom's OWN editable skill set (UI-managed). Each session gets these injected as PROJECT-LOCAL
 * skills (<cwd>/.claude/skills) so they're discovered as bare names and SHADOW the user's personal
 * ~/.claude/skills — keeping Loom's skills separate from the user's bespoke personal set (validated
 * spike: project-local shadowing wins). Bundled defaults are seeded here on boot; then user-editable.
 */
export const SKILLS_DIR = path.join(LOOM_HOME, "skills");

/** hook-relay.mjs ships as an asset alongside the built daemon. */
export const RELAY_SCRIPT = path.join(__dirname, "..", "assets", "hook-relay.mjs");
/** vault-lint.mjs (Pillar D PostToolUse hook) ships as an asset too. */
export const VAULT_LINT_SCRIPT = path.join(__dirname, "..", "assets", "vault-lint.mjs");

export const PORT = Number(process.env.LOOM_PORT || 4317);

export function ensureDirs(): void {
  for (const d of [LOOM_HOME, SETTINGS_DIR, LOGS_DIR, WORKTREES_DIR, SKILLS_DIR]) fs.mkdirSync(d, { recursive: true });
}
