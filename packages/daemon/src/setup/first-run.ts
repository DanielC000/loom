import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { SETUP_PROJECT_NAME, SETUP_AGENT_NAME } from "./seed.js";

/**
 * Setup Assistant E1-6 — FIRST-RUN auto-launch of the Setup Assistant.
 *
 * The one-time app_meta marker key stamped at the first auto-launch. Daemon-GLOBAL (app_meta is not
 * project-scoped), so it survives a daemon_restart — the load-bearing "fires exactly once, forever" anchor.
 */
export const SETUP_FIRST_RUN_KEY = "setup.firstRunLaunched";

export type FirstRunResult =
  | { launched: true; sessionId: string }
  | { launched: false; reason: "marker-set" | "has-projects" | "agent-missing" };

/**
 * On a brand-new/empty install, greet the user by auto-launching the Setup Assistant session ONCE, then
 * stamp the one-time marker. Fires iff BOTH:
 *   1. the marker is unset (never auto-launched on this LOOM_HOME before), AND
 *   2. there are NO ORDINARY projects — db.listProjects() EXCLUDES the reserved homes (Getting Started +
 *      Loom Platform are reserved=1), so a fresh install with only those seeded homes reads as empty.
 *
 * The marker is stamped AT LAUNCH (not when the user finishes onboarding) and BEFORE the spawn, so the
 * exactly-once guarantee holds unconditionally: it never re-triggers after a daemon_restart, and never
 * again if the user later deletes all their projects (the marker outlives the empty-project state). A
 * spawn that throws still consumes the single attempt — a fresh user gets at most one auto-launch, and
 * the always-available Setup page is the recovery path rather than a re-spawn loop on every boot.
 *
 * Resolves the reserved "Getting Started" home + its Setup Assistant agent (seeded by seedSetupHome, E1-4)
 * by name; returns {launched:false, reason:"agent-missing"} (no marker stamped) if either is absent, so a
 * misconfigured install can still auto-launch on a later boot once the seed lands.
 */
export function maybeAutoLaunchSetup(db: Db, sessions: SessionService): FirstRunResult {
  if (db.getMeta(SETUP_FIRST_RUN_KEY)) return { launched: false, reason: "marker-set" };
  if (db.listProjects().length > 0) return { launched: false, reason: "has-projects" };
  const home = db.getReservedProjectByName(SETUP_PROJECT_NAME);
  const agent = home ? db.listAgents(home.id).find((a) => a.name === SETUP_AGENT_NAME) : undefined;
  if (!agent) return { launched: false, reason: "agent-missing" };
  // Stamp FIRST — the exactly-once guarantee must hold even if the spawn below throws.
  db.setMeta(SETUP_FIRST_RUN_KEY, new Date().toISOString());
  const session = sessions.startSetup(agent.id);
  return { launched: true, sessionId: session.id };
}
