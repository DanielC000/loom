import type { Agent, Project, SessionListItem } from "@loom/shared";
import type { Db } from "../db.js";
import { isLoomDev } from "../paths.js";
import { resolveLivePlatformHome } from "../platform/seed.js";
import { resolveLiveSetupHome, SETUP_AGENT_NAME, SETUP_HOME_LEAD_AGENT_ID_KEY } from "./reserved-home-markers.js";

/**
 * Card 1731ab5b (epic f437d4e9 C2) — resolve the ONE live platform-tier home for THIS install, by STRICT
 * MUTUAL EXCLUSION on `isLoomDev()`: never a cross-fallback between the two homes. A dev install
 * (LOOM_DEV=1) always resolves the dev "Loom Platform" home (`resolveLivePlatformHome`), or `undefined` if
 * it somehow isn't seeded yet; a non-dev install always resolves the end-user "Platform" home
 * (`resolveLiveSetupHome`), or `undefined`. Falling back from one to the other when the "right" home for
 * this install type is merely ABSENT would be worse than throwing: nothing archives the dev home when
 * LOOM_DEV flips 1 → 0 (e.g. the owner's own `LOOM_DEV=0 pnpm daemon:stable` path), so a stale dev
 * "Loom Platform" row left behind by an earlier LOOM_DEV=1 boot must never silently absorb a non-dev
 * install's escalations/nudges — and a dev install's setup home holds a role:"setup" Setup Assistant, not
 * a Lead, so misrouting an escalation there on a dev install with no (yet-)seeded dev home would be a
 * worse failure than the existing loud throw.
 *
 * This is the ONE place `platformEscalate`, the stuck-manager Lead-notify helper
 * (`notifyLeadOfStuckManager`), and every `PlatformMcpRouter`/orchestration-router tool
 * description/error string that used to hardcode "Loom Platform" resolve their target through — never a
 * bare `.find(p => p.reserved)` (more than one reserved project can coexist, and that shape was a past
 * regression).
 *
 * Lives in its OWN neutral module, never inside `platform/seed.ts` or `setup/seed.ts` themselves, since
 * this function needs both of them.
 *
 * @decision a47dd144 — the two seeders deliberately never import one another.
 */
export function resolveLiveLeadHome(db: Db): Project | undefined {
  return isLoomDev() ? resolveLivePlatformHome(db) : resolveLiveSetupHome(db);
}

/**
 * Card be9cb999 (f437d4e9 C5, round 2 item 1a/4/5) — THE single definition of "the end-user Platform
 * Lead agent" on a non-dev install. `startPlatformLead`, `resume()`, `recyclePlatformLead`,
 * `first-run.ts`'s auto-launch, and `migrateSetupHomeToLead` all resolve through this one function
 * instead of re-deriving their own marker/name lookup — never widen it beyond what's documented here.
 *
 * Always `undefined` on a dev install (`isLoomDev()`) — the dev Lead lives in the separate "Loom
 * Platform" home (`resolveLiveLeadHome` above) and has no relationship to this marker at all.
 *
 * Resolution order, on a non-dev install:
 *   1. The stable id marker (`SETUP_HOME_LEAD_AGENT_ID_KEY`), when it resolves to a real agent IN the
 *      live setup home — survives a rename, and resolves correctly REGARDLESS of the agent's CURRENT
 *      profile role (a customized, not-yet-upgraded agent is still "the home's operator agent").
 *   2. Marker absent/dangling (deleted agent, or an install from before the marker existed) — the
 *      lockout-repair fallback: the single agent in the home bound to a platform-role profile, if there
 *      is EXACTLY one. Zero or several is unresolvable by this step alone — never guess which one is
 *      "the" Lead. Re-stamps the marker onto whichever single agent this finds, so the same repair is a
 *      one-time correction, not a per-call re-derivation.
 *   3. STILL nothing (no platform-role agent exists yet at all — the true pristine-or-customized,
 *      never-migrated shape) — a plain name lookup (`SETUP_AGENT_NAME`) within the home, REGARDLESS of
 *      its role, backfilling the marker the moment one is found.
 *
 * @decision be9cb999 — step 2 runs BEFORE step 3 (round 3, finding N1): a stray same-named-but-not-
 * platform-bound agent must never shadow a genuinely rebound-but-differently-named one. Never widen
 * step 2 beyond "exactly one platform-role agent in the home".
 */
export function resolveHomeLeadAgent(db: Db): Agent | undefined {
  if (isLoomDev()) return undefined;
  const home = resolveLiveSetupHome(db);
  if (!home) return undefined;

  const markerId = db.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY);
  if (markerId) {
    const marked = db.getAgent(markerId);
    if (marked && marked.projectId === home.id) return marked;
    // Dangling marker (the agent was deleted, or — defensively — points outside this home): fall
    // through to the repair steps below rather than returning something wrong.
  }

  const platformAgents = db.listAgents(home.id).filter((a) => {
    const profile = a.profileId ? db.getProfile(a.profileId) : undefined;
    return profile?.role === "platform";
  });
  if (platformAgents.length === 1) {
    const sole = platformAgents[0]!;
    db.setMeta(SETUP_HOME_LEAD_AGENT_ID_KEY, sole.id);
    return sole;
  }
  if (platformAgents.length > 1) return undefined; // ambiguous — never guess

  const byName = db.listAgents(home.id).find((a) => a.name === SETUP_AGENT_NAME);
  if (byName) {
    if (db.getMeta(SETUP_HOME_LEAD_AGENT_ID_KEY) !== byName.id) db.setMeta(SETUP_HOME_LEAD_AGENT_ID_KEY, byName.id);
    return byName;
  }
  return undefined;
}

/**
 * Card be9cb999 round 3 (findings J1/M1) — THE "no second live Lead" check, shared by both the start
 * path (`startPlatformLead`) and `resume()` (incl. boot-resume) on a non-dev install, so a rebind-free
 * resume of an exited Lead alongside a still-live one can never produce two concurrent Leads either.
 * Keyed on VERIFIED pty liveness (`isAlive`), never the raw DB `processState` (decision 39b58667's own
 * rule for the setup-singleton sibling) — a phantom-live row must never falsely block a start/resume,
 * and a genuinely live one must never be missed. `excludeSessionId` lets a caller check "is there a
 * DIFFERENT live Lead" without needing a separate early-exit for its own row. `!db.hasSuccessor(s.id)`
 * excludes a `recyclePlatformLead` predecessor that has ALREADY been atomically retired in the DB even
 * though its real pty may still be alive for a few more seconds (the deferred hard-stop) — that brief
 * two-row window is the sanctioned exception this check must never collide with. Always `undefined` on
 * a dev install (decision 8ddcf787: multiple concurrent dev Leads are allowed, unconditionally).
 */
export function liveOtherPlatformLead(
  db: Db, isAlive: (sessionId: string) => boolean, excludeSessionId?: string,
): SessionListItem | undefined {
  if (isLoomDev()) return undefined;
  return db.listAllSessions().find((s) =>
    s.role === "platform" && s.id !== excludeSessionId && !db.hasSuccessor(s.id) && isAlive(s.id));
}

/**
 * Card be9cb999 round 2 item 1(a) — THE check for "may `agentId` run role:platform on this install".
 * Always `true` on a dev install (unrestricted — decision 8ddcf787: multiple concurrent dev Leads are
 * allowed). On a non-dev install, BOTH conditions must hold: `agentId` IS `resolveHomeLeadAgent`'s own
 * resolved id (never a name or `.find(p=>p.reserved)` lookup), AND that agent's CURRENT bound profile
 * role is `"platform"` — the marker alone is never enough, since it is also stamped onto a customized,
 * not-yet-upgraded agent (see docs/decisions/be9cb999-*.md) that must NOT be startable as platform until
 * the user actually opts in by rebinding its profile.
 */
export function isSanctionedPlatformLeadAgent(db: Db, agentId: string): boolean {
  if (isLoomDev()) return true;
  const lead = resolveHomeLeadAgent(db);
  if (!lead || lead.id !== agentId) return false;
  const profile = lead.profileId ? db.getProfile(lead.profileId) : undefined;
  return profile?.role === "platform";
}
