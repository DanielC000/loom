import { randomUUID } from "node:crypto";
import {
  agentsBoundToProfile,
  profileGrantReachOf,
  profileWideningsOf,
  resolveProfile,
  type AgentListItem,
  type ProfileWideningFields,
  type ProfileWideningKey,
  type ProfileGrantReach,
} from "@loom/shared";

/**
 * Blast-radius audit for a HUMAN grant, or a role/restrictedTools widening (card `be447b3f`), onto a
 * GLOBAL Profile: which agents, in which projects, are already bound to it. The Profiles editor confirms
 * a grant before the save (role/restrictedTools have no editor confirm yet — see that card); this is the
 * backstop for every profile update/delete write path, including the ones that can never be prompted:
 * REST, the two agent-facing `profile_update` MCP tools, and all THREE `profile_delete` write paths —
 * platform, an agent manager's own tool, and the human REST route — which all route through the ONE
 * shared {@link recordProfileDeleteGrantReach} (built on {@link PROFILE_DELETE_BACKSTOP_FIELDS}) so a
 * fourth can never drift from the other three. An agent REBIND (`agent_update`/`profile_assign` widening
 * what a single already-bound agent's profile reaches) is accepted OUT of scope here and tracked on its
 * own card (`8b236b22`) — see `be447b3f`'s own decision record for why.
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

/**
 * Which write path produced this — carried on the event so an auditor can tell a deliberate editor save
 * apart from a grant pulled in by adopting/resetting to shipped bundled fields, or a role/restrictedTools
 * widening landed via the Setup Assistant's or the Platform Lead's own `profile_update` MCP tool (card
 * `be447b3f`) — the two surfaces where this durable event is the ONLY signal a human gets, since neither
 * can be interactively confirmed the way the editor's save button can. `"manager"` (round 3) is an agent
 * manager's OWN `profile_delete` tool — the third of three delete paths that now all route through
 * {@link recordProfileDeleteGrantReach}, alongside `"platform"`'s and REST's.
 */
export type GrantReachSource = "rest" | "adopt" | "reset" | "setup" | "platform" | "manager";

/**
 * Compute the reach of a profile save and, when it widened trust (a human-only grant, a role change, or
 * restrictedTools relaxing — {@link profileWideningsOf}), file the audit event. Returns the reach payload
 * for the caller's own response, or `null` when the save widened nothing — a rename, a description edit,
 * a grant/role being REVERTED, or a re-save of values already there all return null and file nothing,
 * which is what makes an absent row mean "nothing was widened".
 *
 * Filed even when `agentCount` is 0: the row records the WIDENING, and the reach is a field on it. An
 * absent row therefore never has to be disambiguated between "nothing widened" and "something widened but
 * happened to reach nobody".
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
    before: ProfileWideningFields;
    after: ProfileWideningFields;
    source: GrantReachSource;
  },
): ProfileGrantReach | null {
  const addedKeys = profileWideningsOf(args.before, args.after);
  if (addedKeys.length === 0) return null;

  // `agent.profileId` is the WHOLE binding surface — see `agentsBoundToProfile`'s own doc for the
  // source-level verification, and for why a pending-binding row is NOT a binding.
  const bound = agentsBoundToProfile(db.listAllAgents(), args.profileId);
  const roleChange = addedKeys.includes("role")
    ? { from: args.before.role ?? null, to: args.after.role ?? null }
    : undefined;
  const reach = profileGrantReachOf(addedKeys, bound, roleChange);

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

/**
 * The {@link ProfileWideningFields} a dangling `agent.profileId` resolves to once its Profile is gone —
 * DERIVED from `resolveProfile`'s own backstop (`packages/shared/src/config.ts`) rather than restated by
 * hand (card `be447b3f` round 3: a hand-copied constant is exactly the second-source-of-truth this
 * project's `CLAUDE.md` warns can drift silently — this round's Minor found no test would have caught
 * `PROFILE_DELETE_BACKSTOP_FIELDS` going stale against a future backstop change). Deleting a profile is
 * itself a widening write path for `role`/`restrictedTools` (never for a grant key — every grant backstops
 * to empty/off, which `profileWideningsOf` only ever reports as a NARROWING) — e.g. deleting a
 * `restrictedTools:true` profile un-restricts every still-bound agent's next session.
 *
 * Only two shape differences exist between `ResolvedProfile` and `ProfileWideningFields`, both translated
 * here once: `allow` → `allowDelta`, and a backstop `harness:null` → `undefined` (`Profile.harness` is
 * `"claude" | "codex" | undefined` — never `null`; `isDefaultHarness` treats the two identically).
 */
export const PROFILE_DELETE_BACKSTOP_FIELDS: ProfileWideningFields = (() => {
  const backstop = resolveProfile({ startupPrompt: null }, null);
  return {
    connections: backstop.connections,
    capabilities: backstop.capabilities,
    vaultWrite: backstop.vaultWrite,
    harness: backstop.harness ?? undefined,
    browserTesting: backstop.browserTesting,
    documentConversion: backstop.documentConversion,
    allowDelta: backstop.allow,
    role: backstop.role,
    restrictedTools: backstop.restrictedTools,
  };
})();

/** The narrow db surface {@link rebindWideningFields} needs. */
export interface RebindWideningFieldsDbStore {
  getProfile(id: string): ProfileWideningFields | undefined;
}

/**
 * @decision 8b236b22 — ONE place that resolves an agent rebind's before/after widening-field pair
 * (Code Review nit, round 2) — the OLD bound profile vs. the NEW one, each substituting
 * {@link PROFILE_DELETE_BACKSTOP_FIELDS} when null/dangling. Call this, never re-derive it inline.
 */
export function rebindWideningFields(
  db: RebindWideningFieldsDbStore,
  oldProfileId: string | null,
  newProfileOrNull: ProfileWideningFields | null,
): { before: ProfileWideningFields; after: ProfileWideningFields } {
  const before = oldProfileId != null ? db.getProfile(oldProfileId) ?? null : null;
  return {
    before: before ? grantFieldsOf(before) : PROFILE_DELETE_BACKSTOP_FIELDS,
    after: newProfileOrNull ? grantFieldsOf(newProfileOrNull) : PROFILE_DELETE_BACKSTOP_FIELDS,
  };
}

/**
 * The Setup Assistant's OWN view of a `grantReach` payload (card `be447b3f`, MINOR): filters `agents[]`
 * down to agents in a LIVE project only. The setup operator's other reads (`list_all_projects`/
 * `list_all_agents`) already exclude archived projects — surfacing an archived-project agent name/project
 * name here, which `3c4e0df6`'s unfiltered reach does for the Platform Lead by design, would leak
 * visibility this least-privilege surface has no other route to. `agentCount` is left as the TRUE total
 * (including any archived-project agents) — only the listed names are narrowed, never the count — and the
 * durable event this reach was already filed from (`recordProfileGrantReach`, above) is untouched; this
 * runs ONLY on the response a setup caller sees.
 */
export function setupVisibleGrantReach(
  reach: ProfileGrantReach,
  liveProjectIds: ReadonlySet<string>,
): ProfileGrantReach {
  return { ...reach, agents: reach.agents.filter((a) => liveProjectIds.has(a.projectId)) };
}

/** Narrow an arbitrary profile-shaped row to just the fields the widening computation reads. */
export function grantFieldsOf(p: ProfileWideningFields): ProfileWideningFields {
  return {
    connections: p.connections,
    capabilities: p.capabilities,
    vaultWrite: p.vaultWrite,
    harness: p.harness,
    browserTesting: p.browserTesting,
    documentConversion: p.documentConversion,
    allowDelta: p.allowDelta,
    role: p.role,
    restrictedTools: p.restrictedTools,
  };
}

/**
 * The SHARED "delete = reach against the backstop" computation (card `be447b3f` round 3) — the one place
 * every `profile_delete` write path (the platform MCP tool, an agent manager's own MCP tool, and the human
 * REST route) computes reach, so a future fourth path can never drift by re-deriving its own before/after
 * pair. Never deletes anything itself — call `db.deleteProfile` separately, in whichever order that path's
 * own existing logic already uses; this only needs the row as it stood BEFORE deletion.
 */
export function recordProfileDeleteGrantReach(
  db: GrantReachDbStore,
  args: { profileId: string; existing: { name: string } & ProfileWideningFields; source: GrantReachSource },
): ProfileGrantReach | null {
  return recordProfileGrantReach(db, {
    profileId: args.profileId,
    profileName: args.existing.name,
    before: grantFieldsOf(args.existing),
    after: PROFILE_DELETE_BACKSTOP_FIELDS,
    source: args.source,
  });
}

/**
 * @decision 8b236b22 — the REBIND twin of {@link recordProfileGrantReach}: one agent moving onto a
 * DIFFERENT pre-existing profile, kept structurally separate per `be447b3f`. See the decision record
 * for the backstop-substitution and `DURABLE_AUDIT_EVENT_KINDS` reasoning.
 *
 * `before`/`after` are the agent's OLD/NEW bound profile's widening fields (substitute
 * {@link PROFILE_DELETE_BACKSTOP_FIELDS} for either side when that side's `profileId` is/was `null`).
 * Returns the reach payload for the caller's response (`rebindReach`), or `null` when nothing widened.
 * Best-effort on the audit write ONLY, same posture as {@link recordProfileGrantReach}.
 */
export function recordAgentProfileRebindReach(
  db: AgentRebindReachDbStore,
  args: {
    agentId: string;
    agentName: string;
    projectId: string;
    before: ProfileWideningFields;
    after: ProfileWideningFields;
    source: AgentRebindSource;
  },
): AgentRebindReach | null {
  const addedKeys = profileWideningsOf(args.before, args.after);
  if (addedKeys.length === 0) return null;
  const roleChange = addedKeys.includes("role")
    ? { from: args.before.role ?? null, to: args.after.role ?? null }
    : undefined;
  const reach: AgentRebindReach = { addedKeys, ...(roleChange ? { roleChange } : {}) };

  try {
    db.appendEvent({
      id: randomUUID(),
      ts: new Date().toISOString(),
      managerSessionId: "",
      kind: "agent_profile_rebind",
      detail: {
        agentId: args.agentId,
        agentName: args.agentName,
        projectId: args.projectId,
        source: args.source,
        ...reach,
      },
    });
  } catch { /* best-effort — a failed audit write must never fail an already-persisted rebind */ }

  return reach;
}

/** Which write path produced an agent rebind — the REBIND twin of {@link GrantReachSource}, minus the
 *  two profile-field-edit-only values ("adopt"/"reset") that have no rebind equivalent. */
export type AgentRebindSource = "setup" | "platform" | "manager" | "rest";

/** The narrow db surface {@link recordAgentProfileRebindReach} needs — just the append, kind-narrowed to
 *  `agent_profile_rebind` (distinct from {@link GrantReachDbStore}'s `profile_grant_reach`, and with no
 *  `listAllAgents` — a rebind reaches exactly the one agent being rebound, never a scanned list). */
export interface AgentRebindReachDbStore {
  appendEvent(evt: {
    id: string;
    ts: string;
    managerSessionId: string;
    kind: "agent_profile_rebind";
    detail: Record<string, unknown>;
  }): unknown;
}

/** The `agent_profile_rebind` event's own payload shape — deliberately NOT {@link ProfileGrantReach}:
 *  a rebind always reaches exactly the ONE agent being rebound, so there is no bound-agent LIST/cap/
 *  count to carry, only the widening itself. */
export interface AgentRebindReach {
  addedKeys: ProfileWideningKey[];
  roleChange?: { from: string | null; to: string | null };
}
