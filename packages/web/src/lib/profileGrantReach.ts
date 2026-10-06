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
  type ProfileGrantFields,
} from "@loom/shared";

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
