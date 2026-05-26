import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Resolve Claude's main JSON config file. Honors CLAUDE_CONFIG_DIR (Claude relocates the
 * config — incl. the trust flags below — to <CLAUDE_CONFIG_DIR>/.claude.json when it is set),
 * falling back to ~/.claude.json. Read fresh each call so the env can be set per-process
 * (e.g. an isolated config dir for hermetic tests) without re-importing this module.
 */
function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/**
 * Atomically write `value` as pretty JSON to `filePath`: a uniquely-named temp file in the
 * same directory (so two concurrent writers can't collide on it) followed by a rename onto
 * the target. The rename is atomic on a single filesystem, so a crash mid-write can never
 * leave the real (possibly large, concurrently-read) config truncated/corrupt.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.loom.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Pre-accept Claude's workspace-trust dialog for a directory so an unattended spawned
 * session doesn't block on "Is this a project you trust?". This is exactly what clicking
 * "Yes, I trust this folder" persists. Trust lives in .claude.json under
 * projects[<abs path, forward slashes>].{hasTrustDialogAccepted, hasCompletedProjectOnboarding}.
 *
 * Idempotent: a no-op once the dir is trusted, so the read-modify-write of the (large,
 * possibly concurrently-used) .claude.json happens at most once per project dir.
 * (Phase-2: a more surgical / locked update to fully avoid a clobber race.)
 */
export function ensureTrusted(dir: string): void {
  const claudeJson = claudeJsonPath();
  const key = path.resolve(dir).replace(/\\/g, "/");
  let cfg: { projects?: Record<string, Record<string, unknown>> } = {};
  try { cfg = JSON.parse(fs.readFileSync(claudeJson, "utf8")); } catch { /* fresh file */ }
  cfg.projects ??= {};
  const entry = cfg.projects[key] ?? {};
  if (entry.hasTrustDialogAccepted === true && entry.hasCompletedProjectOnboarding === true) return;
  cfg.projects[key] = { ...entry, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  writeJsonAtomic(claudeJson, cfg);
}
