import { randomUUID } from "node:crypto";
import type { Agent } from "@loom/shared";
import type { Db } from "../db.js";
import { isPlatformProfile } from "../profiles/seed.js";
import { agentCreatePromptWarning } from "./promptLint.js";

/**
 * Shared core behind agent_create/agent_clone/agent_clone_batch (mcp/platform.ts) AND the companion
 * provision path (gateway/server.ts, `/api/companion/provision`) — ONE place that mints an Agent row,
 * so every caller reuses the exact same validation instead of forking a second create path.
 */
export function createAgentCore(
  db: Db,
  { projectId, name, startupPrompt, profileId }:
    { projectId: string; name: string; startupPrompt?: string; profileId?: string | null },
): { ok: true; agent: Agent; promptWarning: string | null } | { ok: false; error: string } {
  if (!db.getProject(projectId)) return { ok: false, error: "project not found" };
  // Option B: a caller may ASSIGN an existing human-authored profile but never create one — a provided
  // profileId MUST resolve (else reject). Absent/null ⇒ profile-less agent.
  if (profileId != null && !db.getProfile(profileId)) return { ok: false, error: "profile not found" };
  const agent: Agent = {
    id: randomUUID(), projectId, name,
    startupPrompt: startupPrompt ?? "", position: db.listAgents(projectId).length,
    profileId: profileId ?? null, // assign the (validated) profile, or stay profile-less
    // An agent created through this core is NEVER an endpoint — publishing an agent as an API
    // endpoint is a HUMAN-only trust-boundary action (the agent-edit REST surface), so this
    // capability-gated create path always mints a non-endpoint agent.
    endpoint: false, ioSchema: null,
  };
  db.insertAgent(agent);
  // Advisory only (card 5338a86a) — never blocks the create; see agents/promptLint.ts.
  return { ok: true, agent, promptWarning: agentCreatePromptWarning(db, { startupPrompt, profileId }) };
}

// Least-privilege guard shared by every clone call site: a clone carries the source agent's profileId
// through VERBATIM (same as any other field), so it must be refused under the exact same condition
// assigning that profileId directly would be refused under — the source's profile role is one of the
// two platform-exclusive roles (isPlatformProfile, profiles/seed.ts).
export function clonedProfileRoleError(db: Db, sourceProfileId: string | null): string | null {
  if (sourceProfileId == null) return null;
  const profile = db.getProfile(sourceProfileId);
  // A dangling profileId (its profile was since deleted) resolves to the plain backstop elsewhere —
  // nothing elevated to guard against.
  if (!profile) return null;
  // Bucket 2b: "operator" gets its OWN explicit check, deliberately NOT folded into isPlatformProfile —
  // isPlatformProfile ALSO drives LOOM_DEV seed-gating (profiles/seed.ts), so adding "operator" there
  // would wrongly make the ungated Elevated Operator rig dev-only. An operator is own-workspace-confined
  // (unlike platform/auditor, which are cross-project by design), so cloning one into ANOTHER project
  // would defeat that confinement just as surely — it must be refused here too.
  if (profile.role === "operator") {
    return `cannot clone agent: its profile role is "operator" — cloning the own-workspace-confined Elevated Operator rig into another project is never allowed`;
  }
  if (!isPlatformProfile(profile)) return null;
  return `cannot clone agent: its profile role is "${profile.role}" — cloning an elevated platform/auditor rig into another project is never allowed (mirrors the least-privilege guard on assigning one directly)`;
}

// Shared core behind agent_clone/agent_clone_batch AND companion provisioning: read the source agent,
// apply the least-privilege guard, then mint the clone through createAgentCore — the SAME validated
// path agent_create uses.
export function cloneAgentCore(
  db: Db,
  sourceAgentId: string, targetProjectId: string,
  patch: { nameOverride?: string; promptPatch?: string },
): { ok: true; agent: Agent; promptWarning: string | null } | { ok: false; error: string } {
  const source = db.getAgent(sourceAgentId);
  if (!source) return { ok: false, error: "source agent not found" };
  const roleErr = clonedProfileRoleError(db, source.profileId);
  if (roleErr) return { ok: false, error: roleErr };
  return createAgentCore(db, {
    projectId: targetProjectId,
    name: patch.nameOverride ?? source.name,
    startupPrompt: patch.promptPatch ?? source.startupPrompt,
    profileId: source.profileId,
  });
}
