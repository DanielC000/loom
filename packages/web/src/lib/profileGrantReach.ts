// Decides whether a pending Profile save needs a pre-save grant confirm, and what that confirm says.
// JSX-free so test/profile-grant-reach.mjs imports the real planner; Profiles.tsx imports the SAME
// function (mirrors lib/endpointAllowlist.ts + test/endpoint-allowlist.mjs).
//
// The key list and both computations come from @loom/shared — the SAME ones the daemon uses to record the
// audit event — so the pre-save preview and the durable record cannot disagree about what was granted or
// whom it reached.
//
// @decision 3c4e0df6 — fail CLOSED: "not loaded" (null) and "nobody bound" (an empty array) are DIFFERENT
// states that must never collapse — treating an unloaded list as empty skips the prompt and saves a
// trust-boundary widening silently. Never pass `query.data ?? []`; gate on `query.isSuccess`.
import {
  addedProfileGrants,
  agentsBoundToProfile,
  AGENT_FORBIDDEN_PROFILE_KEY_LABELS,
  type AgentForbiddenProfileKey,
  type AgentListItem,
  type BoundAgentRef,
  type CapabilityGrant,
  type ProfileGrantFields,
} from "@loom/shared";

/**
 * The Profiles editor's own field record, as far as the grant computation reads it. STRUCTURAL on
 * purpose — the editor's full `ProfileFields` satisfies it, so this module never imports from the page
 * (which would drag JSX into a test that strips types only).
 *
 * Every member is a HUMAN-ONLY grant key, so a new one added to `AGENT_FORBIDDEN_PROFILE_KEYS` that the
 * editor exposes a control for belongs here AND in {@link grantFieldsOfValues} below — the one place that
 * pairing is made, and the one place a test can see it.
 */
export interface ProfileGrantFormValues {
  connections: string[];
  capabilities: CapabilityGrant[];
  vaultWrite: boolean;
  harness: "claude" | "codex";
  browserTesting: boolean;
  documentConversion: boolean;
  /** The editor holds `allowDelta` as raw textarea text — one permission glob per line. */
  allowText: string;
}

/** The editor's textarea spelling of `allowDelta`, normalized to the array the wire carries. */
export const parseAllowDelta = (text: string): string[] =>
  text.split("\n").map((s) => s.trim()).filter(Boolean);

/**
 * The editor's live field values projected into the grant slice `@loom/shared` compares — the "after"
 * side of a pending save.
 *
 * `allowText` is PARSED here rather than compared raw: a whitespace-only edit must not read as a new
 * permission grant.
 *
 * @decision 6eb31db4 — never pin a key here to a constant because no control exposes it yet: the pin
 * outlives the control, `addedProfileGrants` then sees no change, and the grant saves with no confirm.
 */
export function grantFieldsOfValues(v: ProfileGrantFormValues): ProfileGrantFields {
  return {
    connections: v.connections,
    capabilities: v.capabilities,
    vaultWrite: v.vaultWrite,
    harness: v.harness,
    browserTesting: v.browserTesting,
    documentConversion: v.documentConversion,
    allowDelta: parseAllowDelta(v.allowText),
  };
}

/**
 * The STORED row's grant slice — the baseline a pending save is compared against, matching what the
 * daemon itself compares on the other side of the wire (`existing` vs the merged result).
 *
 * Narrowing to exactly these keys is the point: a whole `ProfileSummary` carries computed state
 * (`customized`, `updateAvailable`, …) that is no part of any grant.
 */
export function grantFieldsOfProfile(p: ProfileGrantFields): ProfileGrantFields {
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

/**
 * What the editor should do with a pending save.
 *
 * - `kind: "save"` — no human-only grant is being added; submit straight through, no prompt.
 * - `kind: "confirm"` — a grant IS being added and at least one agent is already bound. `agents` lists
 *   them; `agentCount` is their number.
 * - `kind: "confirm-unknown"` — a grant IS being added but the bound list could not be loaded. STILL a
 *   prompt, worded as unknown. Never silently a save, and never a false "0 agents".
 *
 * A grant added while the list loaded successfully and NOBODY is bound returns `kind: "save"`: there is no
 * blast radius to show, so a prompt would be noise. The daemon still records the event in that case — the
 * row is of the GRANT, the reach is a field on it.
 */
export type GrantSavePlan =
  | { kind: "save" }
  | { kind: "confirm"; addedKeys: AgentForbiddenProfileKey[]; agents: BoundAgentRef[]; agentCount: number }
  | { kind: "confirm-unknown"; addedKeys: AgentForbiddenProfileKey[] };

/** Copy for the unknown-reach state, so the component and its test agree on one string. */
export const GRANT_REACH_UNKNOWN =
  "Loom could not load the agent list, so it cannot show which agents this already reaches.";

/**
 * Plan a pending profile save.
 *
 * @param before    the profile's stored grant fields as the editor last synced them.
 * @param after     the grant fields this save would land.
 * @param profileId the profile being saved — the binding key.
 * @param agents    every agent across every project, or `null` when that list has not loaded
 *                  SUCCESSFULLY. An empty array is a real answer ("this install has no agents"); `null`
 *                  is not an answer, and must not be spelled as one.
 */
export function planGrantSave(
  before: ProfileGrantFields,
  after: ProfileGrantFields,
  profileId: string,
  agents: readonly AgentListItem[] | null,
): GrantSavePlan {
  const addedKeys = addedProfileGrants(before, after);
  if (addedKeys.length === 0) return { kind: "save" };
  if (agents === null) return { kind: "confirm-unknown", addedKeys };
  const bound = agentsBoundToProfile(agents, profileId);
  if (bound.length === 0) return { kind: "save" };
  return { kind: "confirm", addedKeys, agents: bound, agentCount: bound.length };
}

/** "authenticated-egress connections and vault write" — the granted keys as one readable clause. */
export function grantKeyList(keys: readonly AgentForbiddenProfileKey[]): string {
  const labels = keys.map((k) => AGENT_FORBIDDEN_PROFILE_KEY_LABELS[k]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
