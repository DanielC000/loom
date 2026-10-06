import { randomUUID } from "node:crypto";
import {
  addedProfileGrants,
  agentsBoundToProfile,
  profileGrantReachOf,
  type AgentListItem,
  type ProfileGrantFields,
  type ProfileGrantReach,
} from "@loom/shared";

/**
 * Blast-radius audit for a HUMAN grant onto a GLOBAL Profile: which agents, in which projects, are
 * already bound to it. The Profiles editor confirms this before the save; this is the backstop for a
 * REST-only caller, which cannot be prompted.
 *
 * @decision 3c4e0df6 — a grant reaches each bound agent's NEXT session, never its live ones, so never
 * write copy implying a retroactive grant; and `agent.profileId` is the whole binding surface — never
 * count a pending-binding row, which is an unanswered request and reports reach that does not exist.
 */

/** The narrow db surface this module needs — the two read methods plus the append, nothing else. */
export interface GrantReachDbStore {
  listAllAgents(): AgentListItem[];
  appendEvent(evt: {
    id: string;
    ts: string;
    managerSessionId: string;
    kind: "profile_grant_reach";
    detail: Record<string, unknown>;
  }): unknown;
}

/** Which human write path granted this — carried on the event so an auditor can tell a deliberate
 *  editor save apart from a grant pulled in by adopting or resetting to shipped bundled fields. */
export type GrantReachSource = "rest" | "adopt" | "reset";

/**
 * Compute the reach of a profile save and, when it added at least one human-only grant, file the audit
 * event. Returns the reach payload for the caller's own response, or `null` when the save granted
 * nothing new — a rename, a description edit, a grant being REMOVED, or a re-save of grants already
 * present all return null and file nothing, which is what makes an absent row mean "no grant added".
 *
 * Filed even when `agentCount` is 0: the row records the GRANT, and the reach is a field on it. An absent
 * row therefore never has to be disambiguated between "nothing was granted" and "something was granted
 * but happened to reach nobody".
 *
 * Best-effort on the audit write ONLY — a failed append must never turn a legitimate, already-persisted
 * profile save into a 500. The reach is still returned to the caller in that case, so the response half
 * of the signal survives an audit-write fault.
 */
export function recordProfileGrantReach(
  db: GrantReachDbStore,
  args: {
    profileId: string;
    profileName: string;
    before: ProfileGrantFields;
    after: ProfileGrantFields;
    source: GrantReachSource;
  },
): ProfileGrantReach | null {
  const addedKeys = addedProfileGrants(args.before, args.after);
  if (addedKeys.length === 0) return null;

  // `agent.profileId` is the WHOLE binding surface — see `agentsBoundToProfile`'s own doc for the
  // source-level verification, and for why a pending-binding row is NOT a binding.
  const bound = agentsBoundToProfile(db.listAllAgents(), args.profileId);
  const reach = profileGrantReachOf(addedKeys, bound);

  try {
    db.appendEvent({
      id: randomUUID(),
      ts: new Date().toISOString(),
      // A Profile is GLOBAL: no owning session, and no single projectId to stamp. Mirrors
      // `vault_index_lock_stale`'s own daemon-internal sentinel.
      managerSessionId: "",
      kind: "profile_grant_reach",
      detail: {
        profileId: args.profileId,
        profileName: args.profileName,
        source: args.source,
        ...reach,
      },
    });
  } catch { /* best-effort — a failed audit write must never fail an already-persisted save */ }

  return reach;
}

/** Narrow an arbitrary profile-shaped row to just the fields the grant computation reads. */
export function grantFieldsOf(p: ProfileGrantFields): ProfileGrantFields {
  return {
    connections: p.connections,
    capabilities: p.capabilities,
    vaultWrite: p.vaultWrite,
    harness: p.harness,
    browserTesting: p.browserTesting,
    documentConversion: p.documentConversion,
    allowDelta: p.allowDelta,
  };
}
