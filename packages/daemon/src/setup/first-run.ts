import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { resolveLiveSetupHome, SETUP_AGENT_NAME } from "./seed.js";
import { resolveHomeLeadAgent } from "../projects/live-lead-home.js";
import { isFirstRunLaunchSuppressed } from "../paths.js";

/**
 * Setup Assistant E1-6 — FIRST-RUN auto-launch of the Setup Assistant.
 *
 * The one-time app_meta marker key stamped at the first auto-launch. Daemon-GLOBAL (app_meta is not
 * project-scoped), so it survives a daemon_restart — the load-bearing "fires exactly once, forever" anchor.
 */
export const SETUP_FIRST_RUN_KEY = "setup.firstRunLaunched";

export type FirstRunResult =
  | { launched: true; sessionId: string }
  | { launched: false; reason: "marker-set" | "has-projects" | "agent-missing" | "suppressed" };

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
 * Resolves the reserved "Platform" setup home + its Setup Assistant agent (seeded by seedSetupHome, E1-4)
 * via resolveLiveSetupHome (card 5dff8d08 — marker-first, surviving a human rename of the home, archive-
 * excluded), not a raw name lookup; returns {launched:false, reason:"agent-missing"} (no marker stamped)
 * if either is absent, so a misconfigured install can still auto-launch on a later boot once the seed lands.
 *
 * `LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1` (see paths.ts › isFirstRunLaunchSuppressed) pre-suppresses ONLY the
 * spawn below — the marker is still stamped exactly as today (so this attempt still counts as the one
 * lifetime auto-launch, byte-identical to a spawn that throws), the daemon otherwise boots normally, and
 * with the flag unset this function is byte-identical to before the flag existed.
 */
export function maybeAutoLaunchSetup(db: Db, sessions: SessionService): FirstRunResult {
  if (db.getMeta(SETUP_FIRST_RUN_KEY)) return { launched: false, reason: "marker-set" };
  if (db.listProjects().length > 0) return { launched: false, reason: "has-projects" };
  const home = resolveLiveSetupHome(db);
  // Card be9cb999 round 2, item 5: resolve via the shared resolveHomeLeadAgent helper (marker-first,
  // name-fallback, lockout-repair) rather than a bare name lookup, falling back to the name lookup only
  // when it resolves nothing (e.g. a dev install, where resolveHomeLeadAgent is always undefined).
  const agent = home ? (resolveHomeLeadAgent(db) ?? db.listAgents(home.id).find((a) => a.name === SETUP_AGENT_NAME)) : undefined;
  if (!agent) return { launched: false, reason: "agent-missing" };
  // Stamp FIRST — the exactly-once guarantee must hold even if the spawn below throws.
  db.setMeta(SETUP_FIRST_RUN_KEY, new Date().toISOString());
  if (isFirstRunLaunchSuppressed()) return { launched: false, reason: "suppressed" };
  // f437d4e9 C5: the home operator agent may now be bound to the ungated "Platform-lead" profile
  // (role "platform") instead of "Setup Assistant" (role "setup") — resolve which start path matches
  // its ACTUAL current profile role rather than hardcoding startSetup. A dev install's Getting-Started
  // agent stays role "setup" (never migrated, §1c), so this still picks startSetup there unchanged.
  const profile = agent.profileId ? db.getProfile(agent.profileId) : undefined;
  const session = profile?.role === "platform" ? sessions.startPlatformLead(agent.id) : sessions.startSetup(agent.id);
  return { launched: true, sessionId: session.id };
}
