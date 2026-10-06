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

/**
 * `role` and `restrictedTools` widen what a profile's ALREADY-bound agents can do — same blast-radius
 * shape as an `AGENT_FORBIDDEN_PROFILE_KEYS` grant — but neither CONFERS a capability: a role selects
 * which orchestration surface a spawn gets, and restrictedTools only restricts/relaxes an already-
 * available native tool set.
 *
 * @decision be447b3f — a SEPARATE, superset key for the reach/audit computation only; must never be read
 * as "these two are now human-only too". Neither belongs in `AGENT_FORBIDDEN_PROFILE_KEYS`; both stay
 * agent-writable by design, per decision 8c27ae8e.
 */
export type ProfileWideningKey = AgentForbiddenProfileKey | "role" | "restrictedTools";

/** The slice of a Profile the WIDENING computation reads: every grant field, plus `role`/`restrictedTools`. */
export type ProfileWideningFields = ProfileGrantFields & Pick<Profile, "role" | "restrictedTools">;

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
 * Per-key "did this edit widen reach" predicate for `role`/`restrictedTools` — the two keys `addedProfileGrants`
 * deliberately does not cover (card `be447b3f`). Kept as its own exhaustive Record, same posture as
 * `GRANT_ADDED`, so a key added here later cannot silently go unchecked.
 *
 * `role`: ANY change is reportable, not only an "escalating" one — this computation does not judge which
 * direction is safe (that would need its own, separately-reviewed ordering over the role enum); it reports
 * the same way a grant addition does, and leaves the judgment to the reader.
 *
 * `restrictedTools`: INVERTED relative to a boolean grant like `vaultWrite` — this field RESTRICTS rather
 * than grants, so the widening direction is true→false (removing the restriction reaches every bound
 * agent with a less-restricted tool surface); false→true is a narrowing, never reported.
 *
 * @decision 8c27ae8e — restrictedTools stays agent-writable by design (it only restricts, never grants).
 */
const WIDENING_ADDED: Record<"role" | "restrictedTools", (before: ProfileWideningFields, after: ProfileWideningFields) => boolean> = {
  role: (b, a) => (b.role ?? null) !== (a.role ?? null),
  restrictedTools: (b, a) => !!b.restrictedTools && !a.restrictedTools,
};

/**
 * The superset of {@link addedProfileGrants} that also reports `role`/`restrictedTools` widening — the
 * ONE computation the reach/audit machinery (planner + `recordProfileGrantReach`) calls. `addedProfileGrants`
 * itself is UNCHANGED and still the right call for anything that only cares about `AGENT_FORBIDDEN_PROFILE_KEYS`
 * grants (e.g. `roleChangeCapabilityCarryoverError`'s carry-over check) — this is a strict superset, in a
 * fixed order: every grant key first (in `AGENT_FORBIDDEN_PROFILE_KEYS` order), then "role", then
 * "restrictedTools".
 */
export function profileWideningsOf(
  before: ProfileWideningFields,
  after: ProfileWideningFields,
): ProfileWideningKey[] {
  const keys: ProfileWideningKey[] = [...addedProfileGrants(before, after)];
  if (WIDENING_ADDED.role(before, after)) keys.push("role");
  if (WIDENING_ADDED.restrictedTools(before, after)) keys.push("restrictedTools");
  return keys;
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
 * The reach of a grant (or a role/restrictedTools widening — card `be447b3f`), as both the UI preview and
 * the durable audit record carry it.
 *
 * `agents` is CAPPED at {@link GRANT_REACH_AGENTS_CAP} with `truncated: true`; `agentCount` is always the
 * true total. A profile bound to hundreds of agents must not bloat an append-only event row, and a reader
 * deriving "how many" must never get the capped length by mistake — hence a separate count field rather
 * than `agents.length`.
 *
 * `roleChange` is present ONLY when `"role"` is one of `addedKeys` — a bare key name can't carry a
 * from/to VALUE the way a boolean grant key doesn't need to.
 */
export interface ProfileGrantReach {
  addedKeys: ProfileWideningKey[];
  agentCount: number;
  agents: BoundAgentRef[];
  truncated?: true;
  roleChange?: { from: string | null; to: string | null };
}

/** How many bound agents a reach payload lists before truncating. `agentCount` stays exact regardless. */
export const GRANT_REACH_AGENTS_CAP = 50;

/** Build the capped reach payload from a full bound-agent list. */
export function profileGrantReachOf(
  addedKeys: ProfileWideningKey[],
  bound: BoundAgentRef[],
  roleChange?: { from: string | null; to: string | null },
): ProfileGrantReach {
  const truncated = bound.length > GRANT_REACH_AGENTS_CAP;
  return {
    addedKeys,
    agentCount: bound.length,
    agents: truncated ? bound.slice(0, GRANT_REACH_AGENTS_CAP) : bound,
    ...(truncated ? { truncated: true as const } : {}),
    ...(roleChange ? { roleChange } : {}),
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

/**
 * The superset of {@link AGENT_FORBIDDEN_PROFILE_KEY_LABELS} for the widening computation (card
 * `be447b3f`) — adds the two non-grant keys {@link profileWideningsOf} can also name. Kept as its own
 * export, never merged into the grant-only map above: that map's keys are, by construction, exactly
 * `AGENT_FORBIDDEN_PROFILE_KEYS` (several call sites rely on that exact correspondence).
 */
export const PROFILE_WIDENING_KEY_LABELS: Record<ProfileWideningKey, string> = {
  ...AGENT_FORBIDDEN_PROFILE_KEY_LABELS,
  role: "a role change",
  restrictedTools: "unrestricted tool access",
};
