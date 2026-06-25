import { resolveConfig, type ProjectConfigOverride } from "@loom/shared";
import { prewarmMarkitdown, getMarkitdownProvisionStatus } from "../pty/host.js";
import type { MarkitdownProvisionStatus } from "../pty/host.js";

// Re-export the host primitives so this module is the single "pre-warm / provisioning status" surface callers
// import (the REST profile-save handlers call prewarmMarkitdown with a resolved interpreter; the human-only
// `/api/python/provisioning` GET/POST read + re-kick via getMarkitdownProvisionStatus + prewarmMarkitdown;
// boot uses the helper below).
export { prewarmMarkitdown, getMarkitdownProvisionStatus };
export type { MarkitdownProvisionStatus };

/**
 * Pre-warming the shared Python venv (markitdown today) BEFORE the first documentConversion session needs
 * it — so that first session doesn't hit the provision-on-first-spawn cold-skip window (spawn WITHOUT the
 * MCP, only a later spawn picks it up once the venv warms). Everything here delegates to the EXISTING async,
 * best-effort, deduped background kick in `pty/host.ts` ({@link prewarmMarkitdown}); this module only decides
 * WHEN to kick (boot / profile-save) and WHICH base-Python interpreter to carry. It never blocks and never
 * throws into the caller's path.
 */

/**
 * Resolve the `python.interpreterPath` to carry when pre-warming OUTSIDE a single-session context (daemon
 * boot, or a profile save). `python.interpreterPath` is a PER-PROJECT, human-only config over a hardcoded
 * default of *undefined* — there is NO platform-level override layer for it (PLATFORM_DEFAULTS.python is
 * `{}`). With no single project in hand we therefore pick the FIRST project that configures one; if none do,
 * we return undefined and the venv resolver's PATH discovery (`python3` → `python` → win32 `py -3`) takes
 * over. The venv is SHARED (one per machine), so any working base Python builds the same venv — the first
 * configured interpreter is a sound, deterministic (project-name-ordered, per `listAllProjects`) choice.
 */
export function resolvePrewarmInterpreterPath(projects: { config?: ProjectConfigOverride }[]): string | undefined {
  for (const p of projects) {
    const ip = resolveConfig(p.config).python.interpreterPath;
    if (ip) return ip;
  }
  return undefined;
}

/** The narrow daemon-db surface the boot pre-warm needs (kept structural so it's trivially fakeable in a test). */
export interface PrewarmDeps {
  listProfiles(): { documentConversion?: boolean }[];
  listAllProjects(): { config?: ProjectConfigOverride }[];
}

/**
 * At daemon boot, pre-warm the markitdown venv IFF any profile opts into documentConversion — so the first
 * documentConversion session usually finds the MCP already warm. Best-effort + fully off the event loop
 * (delegates to the async background kick); a no-op when no profile wants document conversion. Returns
 * whether a pre-warm was kicked (for the boot log / tests).
 */
export function prewarmMarkitdownForProfilesAtBoot(db: PrewarmDeps): boolean {
  const wanted = db.listProfiles().some((p) => p.documentConversion);
  if (!wanted) return false;
  prewarmMarkitdown(resolvePrewarmInterpreterPath(db.listAllProjects()));
  return true;
}
