import type { Db } from "../db.js";
import { profileEqualsOwnBaseSnapshot } from "../profiles/customization.js";
import { stripRetiredPlatformConfigKeys, RETIRED_PLATFORM_CONFIG_KEYS } from "@loom/shared";
import {
  SETUP_HOME_OPERATOR_AGENT_ID_KEY,
  resolveSetupHome,
  resolveSeededHomeAgent,
  seededMarkerMigratedKey,
} from "../projects/reserved-home-markers.js";

/**
 * Boot migration for the retired Operator role (the "Elevated Operator", `loom-operator` MCP router).
 * Everything an older install can still hold is handled here and nowhere else — this file is the ONLY
 * place that may still name the retired role, its seeded agent/profile and its config key.
 *
 * @decision 7f6c1cbb — never delete a customized agent/profile; demote (profile role → plain) instead.
 *
 * What it does, in order (all idempotent — a second run changes nothing):
 *  1. platform_config: strip the stored `operatorEnabled` key (it would 400 every later PATCH, since the
 *     validators are strict). `db.getPlatformConfig()` ALSO strips on every read; this persists the strip.
 *  2. sessions: every stored `role='operator'` row becomes plain (NULL) — history only, the surface is gone.
 *  3. the seeded "Elevated Operator" AGENT (found by its id marker only, never by name): deleted when it is
 *     PRISTINE (startup prompt byte-identical to a shipped value, bound to the pristine seeded profile or no
 *     profile) AND has no session history; otherwise kept (nothing of the user's is destroyed) and its
 *     marker is simply dropped. The marker + its one-shot name-migration sentinel are always removed.
 *  4. every profile still carrying role `operator`: deleted when it is the PRISTINE seeded rig and no
 *     surviving agent is bound to it; otherwise its role is set to plain (NULL) and it is kept as the
 *     user's own profile (name/description/skills/model untouched).
 */

/** The shipped name of the bundled profile and agent the retired seeders created. */
const OPERATOR_PROFILE_NAME = "Elevated Operator";

/** Every startup prompt the retired seeder ever shipped, byte-exact. */
const OPERATOR_SHIPPED_PROMPTS: readonly string[] = [
  `You are the **Elevated Operator** — a bounded operator a human spawns deliberately to act on THEIR CURRENT PROJECT's working tree: switch/create local branches, commit changes, write notes into that project's vault, and push its current branch to its own remote. You are confined to the one project you're started in; you can never reach another project, run host/deploy commands, send data to a webhook, edit Loom's bundled skills, create schedules, or spawn/elevate other sessions.

Act only on the explicit task the human gives you this session. Confirm before an irreversible or ambiguous step. When you're done, say plainly what you changed (branch/commit/push/vault write) so the human can verify.`,
  `You are the **Elevated Operator** — a bounded, own-workspace-confined operator a human spawns deliberately to act on THEIR CURRENT PROJECT's working tree: switch/create local branches, commit changes, write notes into that project's vault, and push its current branch to its own remote. You are confined to the one project you're started in; you can never reach another project, run host/deploy commands, send data to a webhook, edit Loom's bundled skills, create schedules, or spawn/elevate other sessions.

Act only on the explicit task the human gives you this session. Confirm before an irreversible or ambiguous step. When you're done, say plainly what you changed (branch/commit/push/vault write) so the human can verify.`,
];

export interface RetireOperatorResult {
  /** True when anything at all was changed (drives the one boot log line). */
  changed: boolean;
  configKeyStripped: boolean;
  sessionsDemoted: number;
  agentDeleted: boolean;
  /** The seeded agent existed but was customized / had history, so it was kept. */
  agentKept: boolean;
  profilesDeleted: number;
  profilesDemoted: number;
}

/**
 * Pristine check for the seeded profile: still named as seeded AND still equal to its OWN seed snapshot
 * (`base_snapshot`, the customization engine's own record), so fields a later default migration rewrote
 * (model, harness) do not read as user edits. A missing snapshot reads as customized (kept).
 */
function isPristineOperatorProfile(p: ReturnType<Db["listProfiles"]>[number], db: Db): boolean {
  return p.name === OPERATOR_PROFILE_NAME && profileEqualsOwnBaseSnapshot(db, p.id);
}

export function retireOperatorRole(db: Db): RetireOperatorResult {
  const result: RetireOperatorResult = {
    changed: false, configKeyStripped: false, sessionsDemoted: 0,
    agentDeleted: false, agentKept: false, profilesDeleted: 0, profilesDemoted: 0,
  };

  // 1. stored config key. `getPlatformConfig()` already strips on read, so inspect the raw blob via the
  //    corrupt-guard: never overwrite a blob that does not parse to an object.
  if (!db.isPlatformConfigCorrupt()) {
    const raw = db.getPlatformConfigRaw();
    if (raw && RETIRED_PLATFORM_CONFIG_KEYS.some((k) => k in raw)) {
      db.setPlatformConfig(stripRetiredPlatformConfigKeys(raw));
      result.configKeyStripped = true;
    }
  }

  // 2. historical sessions.
  result.sessionsDemoted = db.retireOperatorSessionRoles();

  // 3. the seeded agent — by id marker only. A name match would adopt a human's same-named agent.
  const home = resolveSetupHome(db);
  const marked = home ? resolveSeededHomeAgent(db, home, SETUP_HOME_OPERATOR_AGENT_ID_KEY) : undefined;
  const hadMarker = db.getMeta(SETUP_HOME_OPERATOR_AGENT_ID_KEY) !== undefined
    || db.getMeta(seededMarkerMigratedKey(SETUP_HOME_OPERATOR_AGENT_ID_KEY)) !== undefined;
  const profiles = db.listProfiles();
  if (marked) {
    const boundProfile = marked.profileId ? profiles.find((p) => p.id === marked.profileId) : undefined;
    const promptPristine = OPERATOR_SHIPPED_PROMPTS.includes(marked.startupPrompt);
    const profilePristine = marked.profileId == null || (boundProfile ? isPristineOperatorProfile(boundProfile, db) : true /* dangling */);
    const hasHistory = db.listSessions(marked.id).length > 0;
    if (promptPristine && profilePristine && !hasHistory && !marked.endpoint) {
      db.deleteAgent(marked.id);
      result.agentDeleted = true;
    } else {
      result.agentKept = true;
    }
  }
  if (hadMarker) {
    db.deleteMeta(SETUP_HOME_OPERATOR_AGENT_ID_KEY);
    db.deleteMeta(seededMarkerMigratedKey(SETUP_HOME_OPERATOR_AGENT_ID_KEY));
  }

  // 4. profiles still carrying the retired role. Re-read agents AFTER step 3 so a just-deleted agent no
  //    longer pins its profile.
  const retiredIds = new Set(db.listProfileIdsWithRetiredOperatorRole());
  if (retiredIds.size > 0) {
    const boundProfileIds = new Set(db.listAllAgents().map((a) => a.profileId).filter((id): id is string => id != null));
    for (const p of db.listProfiles()) {
      if (!retiredIds.has(p.id)) continue;
      if (isPristineOperatorProfile(p, db) &&!boundProfileIds.has(p.id)) {
        db.deleteProfile(p.id);
        result.profilesDeleted += 1;
      } else {
        db.updateProfile(p.id, { role: null });
        result.profilesDemoted += 1;
      }
    }
  }

  result.changed = result.configKeyStripped || result.sessionsDemoted > 0 || result.agentDeleted || result.agentKept
    || hadMarker || result.profilesDeleted > 0 || result.profilesDemoted > 0;
  return result;
}
