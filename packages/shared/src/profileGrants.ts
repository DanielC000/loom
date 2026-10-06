/**
 * The HUMAN-ONLY profile grant keys, and the two pure functions that answer "what did this save newly
 * grant, and whom does it already reach".
 *
 * WHY THIS LIVES IN `shared` AND NOT IN THE DAEMON (card `3c4e0df6`): the Profiles editor has to decide
 * BEFORE it sends a save whether that save widens a trust boundary, and the daemon has to record the same
 * fact AFTER it lands. Two copies of the key list would drift the moment an eighth key is added — and the
 * web's copy would drift silently, because nothing on the daemon side type-checks it. `AGENT_FORBIDDEN_PROFILE_KEYS`
 * therefore lives here, with `profiles/validate.ts` importing it rather than declaring its own.
 */
import type { AgentListItem, Profile, ProfileId } from "./types.js";

/**
 * Profile fields that NO agent-facing MCP tool may ever write — only a human, via the Profiles UI or the
 * loopback REST surface. Each confers (or selects) a real capability: access to external secrets, a host
 * subprocess, a browser, write access into a reviewed vault corpus, a wider spawn allowlist, or which
 * vendor binary gets spawned at all.
 *
 * Consumed in two directions, and the two must never disagree:
 *  - `profiles/validate.ts` — rejects an agent payload that names one of these (`agentProfileKeyError`),
 *    and refuses an agent role-change on a profile already carrying one (`roleChangeCapabilityCarryoverError`).
 *  - `addedProfileGrants` below — the blast-radius half: which of these a given save newly GRANTS.
 *
 * @decision 8c27ae8e — `browserTesting`/`documentConversion`/`allowDelta` must never be settable by an
 * elevated profile-writing agent; `allowDelta` is the same trust class as `gateCommand`.
 * @decision be8be211 — same prohibition, for `vaultWrite`.
 */
export const AGENT_FORBIDDEN_PROFILE_KEYS = [
  "connections",
  "capabilities",
  "vaultWrite",
  "harness",
  "browserTesting",
  "documentConversion",
  "allowDelta",
] as const;

export type AgentForbiddenProfileKey = (typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number];

/** The slice of a Profile the grant-reach computation reads — nothing else is consulted. */
export type ProfileGrantFields = Pick<Profile, AgentForbiddenProfileKey>;

/** One agent a profile grant already reaches, with the project it lives in (for a "Project / Agent" label). */
export interface BoundAgentRef {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
}

/**
 * Per-key "what did this save newly grant" predicate.
 *
 * ⚠️ DELIBERATELY NOT `profiles/validate.ts`'s `AGENT_FORBIDDEN_PROFILE_KEY_CARRIED`, and the two must not
 * be collapsed — they answer different questions. `_CARRIED` asks "does this profile hold this capability
 * AT ALL" (a non-empty check), which is the right question for refusing an agent role-change. This asks
 * "did THIS edit hand out something that wasn't granted before", which is value-level: adding a SECOND
 * connection to a profile that already had one is a new secret reaching every bound agent, and a non-empty
 * check cannot see it.
 *
 * An EXHAUSTIVE Record keyed off `AGENT_FORBIDDEN_PROFILE_KEYS` (same posture as its two siblings in
 * `validate.ts`) — an eighth key added to that array without an entry here fails to COMPILE, rather than
 * silently never being treated as a grant.
 */
const GRANT_ADDED: Record<
  AgentForbiddenProfileKey,
  (before: ProfileGrantFields, after: ProfileGrantFields) => boolean
> = {
  connections: (b, a) => hasNewEntry(b.connections, a.connections),
  capabilities: (b, a) =>
    hasNewEntry(
      (b.capabilities ?? []).map(capabilityGrantKey),
      (a.capabilities ?? []).map(capabilityGrantKey),
    ),
  allowDelta: (b, a) => hasNewEntry(b.allowDelta, a.allowDelta),
  vaultWrite: (b, a) => !b.vaultWrite && !!a.vaultWrite,
  browserTesting: (b, a) => !b.browserTesting && !!a.browserTesting,
  documentConversion: (b, a) => !b.documentConversion && !!a.documentConversion,
  // Absent means "claude" (the default harness, no grant), so only a move ONTO a non-default binary is a
  // grant. Moving BACK to claude, or an unrelated save on a rig already pinned to codex, is not.
  harness: (b, a) => isDefaultHarness(b.harness) && !isDefaultHarness(a.harness),
};

/** A capability grant's identity for "is this new": the slug, plus the connection it is bound to — a
 *  re-bind onto a DIFFERENT connection hands the rig a credential it did not have before. */
function capabilityGrantKey(g: { slug: string; connectionId?: string }): string {
  return `${g.slug}\u0000${g.connectionId ?? ""}`;
}

/** True when `after` contains at least one entry absent from `before` (order-insensitive, dupe-tolerant). */
function hasNewEntry(before: readonly string[] | undefined, after: readonly string[] | undefined): boolean {
  if (!after || after.length === 0) return false;
  const had = new Set(before ?? []);
  return after.some((entry) => !had.has(entry));
}

/** Absent/null is the shipped default (`claude`), which confers nothing. */
function isDefaultHarness(harness: Profile["harness"] | null | undefined): boolean {
  return harness == null || harness === "claude";
}

/**
 * Which human-only grants this edit ADDS, in `AGENT_FORBIDDEN_PROFILE_KEYS` order. Empty = the edit
 * widens no trust boundary (a rename, a description change, a grant being REMOVED, or a re-save of grants
 * that were already there).
 *
 * Pure and side-effect-free by design: the Profiles editor calls it on local state before sending a save,
 * and the daemon calls it on the stored-vs-merged pair after one lands. Both get the same answer.
 */
export function addedProfileGrants(
  before: ProfileGrantFields,
  after: ProfileGrantFields,
): AgentForbiddenProfileKey[] {
  return AGENT_FORBIDDEN_PROFILE_KEYS.filter((key) => GRANT_ADDED[key](before, after));
}

/**
 * The agents a profile grant already reaches: every agent bound to `profileId`, across every project.
 *
 * ⚠️ `agent.profileId` is the WHOLE binding surface — verified at source (card `3c4e0df6`): `profile_id`
 * exists on exactly one table (`agents`), and `resolveProfile(agent, db.getProfile(agent.profileId))` is
 * the only resolution shape in the daemon. A pending-binding row also carries a profileId, but that is an
 * UNANSWERED REQUEST for a grant, not a binding, and must never be counted here.
 *
 * Agents in ARCHIVED projects are counted deliberately and without a label: the grant goes live again the
 * moment the project is unarchived, so excluding them would under-report the real reach.
 */
export function agentsBoundToProfile(agents: readonly AgentListItem[], profileId: ProfileId): BoundAgentRef[] {
  return agents
    .filter((a) => a.profileId === profileId)
    .map((a) => ({ id: a.id, name: a.name, projectId: a.projectId, projectName: a.projectName }));
}

/**
 * The reach of a grant, as both the UI preview and the durable audit record carry it.
 *
 * `agents` is CAPPED at {@link GRANT_REACH_AGENTS_CAP} with `truncated: true`; `agentCount` is always the
 * true total. A profile bound to hundreds of agents must not bloat an append-only event row, and a reader
 * deriving "how many" must never get the capped length by mistake — hence a separate count field rather
 * than `agents.length`.
 */
export interface ProfileGrantReach {
  addedKeys: AgentForbiddenProfileKey[];
  agentCount: number;
  agents: BoundAgentRef[];
  truncated?: true;
}

/** How many bound agents a reach payload lists before truncating. `agentCount` stays exact regardless. */
export const GRANT_REACH_AGENTS_CAP = 50;

/** Build the capped reach payload from a full bound-agent list. */
export function profileGrantReachOf(
  addedKeys: AgentForbiddenProfileKey[],
  bound: BoundAgentRef[],
): ProfileGrantReach {
  const truncated = bound.length > GRANT_REACH_AGENTS_CAP;
  return {
    addedKeys,
    agentCount: bound.length,
    agents: truncated ? bound.slice(0, GRANT_REACH_AGENTS_CAP) : bound,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/** Human-facing label for a granted key — used by the pre-save confirm and the audit detail alike. */
export const AGENT_FORBIDDEN_PROFILE_KEY_LABELS: Record<AgentForbiddenProfileKey, string> = {
  connections: "authenticated-egress connections",
  capabilities: "capability grants",
  vaultWrite: "vault write",
  harness: "harness (which CLI binary spawns)",
  browserTesting: "browser testing",
  documentConversion: "document conversion",
  allowDelta: "permission allowlist delta",
};
