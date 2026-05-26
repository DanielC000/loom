import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");

/**
 * Pre-accept Claude's workspace-trust dialog for a directory so an unattended spawned
 * session doesn't block on "Is this a project you trust?". This is exactly what clicking
 * "Yes, I trust this folder" persists. Trust lives in ~/.claude.json under
 * projects[<abs path, forward slashes>].{hasTrustDialogAccepted, hasCompletedProjectOnboarding}.
 *
 * Idempotent: a no-op once the dir is trusted, so the read-modify-write of the (large,
 * possibly concurrently-used) ~/.claude.json happens at most once per project dir.
 * (Phase-2: a more surgical / locked update to fully avoid a clobber race.)
 */
export function ensureTrusted(dir: string): void {
  const key = path.resolve(dir).replace(/\\/g, "/");
  let cfg: { projects?: Record<string, Record<string, unknown>> } = {};
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")); } catch { /* fresh file */ }
  cfg.projects ??= {};
  const entry = cfg.projects[key] ?? {};
  if (entry.hasTrustDialogAccepted === true && entry.hasCompletedProjectOnboarding === true) return;
  cfg.projects[key] = { ...entry, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  const tmp = `${CLAUDE_JSON}.loom.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CLAUDE_JSON);
}
