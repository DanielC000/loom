import { randomUUID } from "node:crypto";
import type { Agent, Profile, Project } from "@loom/shared";
import type { Db } from "../db.js";
import { isPlatformProfile } from "../profiles/seed.js";
import { agentAssignableProfileError } from "../profiles/validate.js";
import { agentCreatePromptWarning } from "./promptLint.js";
import { isLoomHomeOrAncestor } from "../vault/versioner.js";

// @decision d25e4ea7 — the ONE predicate for "may a manager session ever start/bind here": call this,
// never re-derive `project.reserved` or `isLoomHomeOrAncestor` separately, or the two can drift apart
// again (ced4285e's "Predicate divergence").
export function managerSessionBarredFrom(project: Pick<Project, "reserved" | "repoPath"> | undefined): boolean {
  if (!project) return false;
  return project.reserved === true || isLoomHomeOrAncestor(project.repoPath);
}

// @decision d25e4ea7 — dedicated session-start refusal text for `managerSessionBarredFrom`; see the
// record's "Session-start refusal text" section for why it replaced OPERATIONAL_HOME_GIT_WRITE_ERROR here.
export const MANAGER_SESSION_BARRED_ERROR =
  "refusing to start a manager session: a manager session can never start in this project (it is a reserved/system project, or its repoPath is the workspace home or an ancestor of it)";

// @decision 39b58667 — resume()'s setup-singleton refusal, hosted here (not service.ts) so
// resume-nudge.ts's RESUME_KNOWN_SAFE_REASONS can list it with no circular import — same reason
// MANAGER_SESSION_BARRED_ERROR lives here; service.ts re-exports it unchanged for its own importers.
export const SETUP_SESSION_RESUME_BARRED_ERROR =
  "refusing to resume: a live setup session already exists for this agent (the Setup operator is a singleton — never two LIVE setup sessions)";

// @decision ced4285e — shared by createAgentCore AND the Platform Lead's reassignment surfaces so the
// create-time and reassign-time reserved-project/manager-role checks cannot drift apart.
// @decision d25e4ea7 — keys on the unified `managerSessionBarredFrom`, not `project.reserved` alone, so
// a non-reserved project whose repoPath IS an operational-home path is barred too.
export function reservedProjectManagerProfileError(
  project: Pick<Project, "reserved" | "repoPath"> | undefined,
  profile: Pick<Profile, "role"> | null | undefined,
): string | null {
  if (managerSessionBarredFrom(project) && profile?.role === "manager") {
    return "cannot bind a manager-role profile to an agent in a project a manager session can never start in (a reserved/system project, or one whose repoPath is the workspace home or an ancestor of it) — only a human may do this.";
  }
  return null;
}

// @decision ced4285e — the SECOND reachable route to the same hazard (profile_update flipping an
// EXISTING shared profile's role to "manager" strands every agent bound to it, without touching any
// agent row). A reserved project can never be archived (mcp/setup.ts's project_archive refuses it).
// @decision d25e4ea7 — scans via `managerSessionBarredFrom`, not `project.reserved` alone, so a
// non-reserved project whose repoPath IS an operational-home path is scanned too.
export function reservedProjectAgentBoundToProfile(db: Db, profileId: string): { agent: Agent; project: Project } | null {
  for (const project of db.listAllProjects()) {
    if (!managerSessionBarredFrom(project)) continue;
    const hit = db.listAgents(project.id).find((a) => a.profileId === profileId);
    if (hit) return { agent: hit, project };
  }
  return null;
}

/**
 * Shared core behind agent_create/agent_clone/agent_clone_batch (mcp/platform.ts) AND the companion
 * provision path (gateway/server.ts, `/api/companion/provision`) — ONE place that mints an Agent row,
 * so every caller reuses the exact same validation instead of forking a second create path.
 *
 * @decision 3de74275 — FIELD check FAIL-CLOSED by default; `opts.humanAuthorized` is the only opt-out,
 * forwarded ONLY from `cloneAgentCore`'s own ONE human-only REST caller (below — templates go through
 * `applyWorkflowTemplate`, not this file). `allowElevatedRoles` is a separate, Lead-only ROLE widening.
 */
export function createAgentCore(
  db: Db,
  { projectId, name, startupPrompt, profileId }:
    { projectId: string; name: string; startupPrompt?: string; profileId?: string | null },
  opts?: { allowElevatedRoles?: boolean; skipRoleCheck?: boolean; humanAuthorized?: boolean },
): { ok: true; agent: Agent; promptWarning: string | null } | { ok: false; error: string } {
  const project = db.getProject(projectId);
  if (!project) return { ok: false, error: "project not found" };
  // Option B: a caller may ASSIGN an existing human-authored profile but never create one — a provided
  // profileId MUST resolve (else reject). Absent/null ⇒ profile-less agent.
  let profile: Profile | undefined;
  if (profileId != null) {
    profile = db.getProfile(profileId);
    if (!profile) return { ok: false, error: "profile not found" };
    const assignErr = agentAssignableProfileError(profile, opts);
    if (assignErr) return { ok: false, error: assignErr };
  }
  // card 73c16ec8: unlike the setup surface (mcp/setup.ts ~474), this core otherwise allows minting a
  // non-manager agent into a reserved/system project (the Platform Lead legitimately administers its own
  // home's standing agents, e.g. cloning the Auditor).
  // @decision ced4285e — the manager-role check moved to the shared reservedProjectManagerProfileError
  // (above) so create-time and reassign-time checks cannot drift apart.
  const reservedErr = reservedProjectManagerProfileError(project, profile);
  if (reservedErr) return { ok: false, error: reservedErr };
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

// Least-privilege ROLE guard shared by every clone call site (incl. the human-only REST companion
// auto-clone, gateway/server.ts): a clone carries the source agent's profileId through VERBATIM, so an
// operator/platform/auditor source must be refused the same way assigning that profileId directly would
// be. FIELD-only (agentAssignableProfileError's own human-only-field list): see cloneSourceFieldError
// below, NOT here — this function's own narrower role check is the ONLY role axis for every
// cloneAgentCore caller, agent-facing or not; it never calls the shared predicate at all.
//
// @decision 3de74275 — clone's ROLE axis stays its OWN narrower, pre-existing check, never the shared
// predicate's full locked-role set — a non-elevated role here (incl. "assistant") is load-bearing.
export function clonedProfileRoleError(db: Db, sourceProfileId: string | null): string | null {
  if (sourceProfileId == null) return null;
  const profile = db.getProfile(sourceProfileId);
  // A dangling profileId (its profile was since deleted) resolves to the plain backstop elsewhere —
  // nothing elevated to guard against.
  if (!profile) return null;
  // Bucket 2b: "operator" gets its OWN explicit check — an operator rig is own-workspace-confined
  // (unlike platform/auditor), so cloning one into ANOTHER project would defeat that confinement even
  // though "operator" is not itself cross-project-exclusive.
  if (profile.role === "operator") {
    return `cannot clone agent: its profile role is "operator" — cloning the own-workspace-confined Elevated Operator rig into another project is never allowed`;
  }
  if (isPlatformProfile(profile)) {
    return `cannot clone agent: its profile role is "${profile.role}" — cloning an elevated platform/auditor rig into another project is never allowed (mirrors the least-privilege guard on assigning one directly)`;
  }
  return null;
}

// @decision 3de74275 — fix round card a06650d2: the agent-facing early pre-check below is no longer
// the only defense; createAgentCore's own field check (unconditional unless humanAuthorized) backstops it.
//
// Shared core behind agent_clone/agent_clone_batch AND companion provisioning: read the source agent,
// apply the least-privilege ROLE guard (unconditional, every caller), then mint the clone through
// createAgentCore with `skipRoleCheck:true` (role already vetted above — createAgentCore's own generic
// role branch must not re-check it) and `humanAuthorized` forwarded straight from THIS function's own
// `opts` — so createAgentCore's FIELD check still runs by default and is skipped only when THIS
// function's own ONE human-only REST caller (gateway/server.ts's companion auto-clone) passes
// `humanAuthorized:true` here. Every agent-facing caller (mcp/platform.ts's agent_clone/agent_clone_batch)
// omits `opts` entirely, so the field check fires there too — on top of their own early pre-check below.
export function cloneAgentCore(
  db: Db,
  sourceAgentId: string, targetProjectId: string,
  patch: { nameOverride?: string; promptPatch?: string },
  opts?: { humanAuthorized?: boolean },
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
  }, { skipRoleCheck: true, humanAuthorized: opts?.humanAuthorized });
}

/**
 * EARLY, agent-surface-only field check for a clone (`mcp/platform.ts`'s `agent_clone`/`agent_clone_batch`
 * call this BEFORE `cloneAgentCore`, for a clearer error at the point of the actual request) — NOT the
 * only defense any more: `cloneAgentCore` → `createAgentCore`'s own field check (unconditional unless
 * `humanAuthorized`) backstops it, per the 3de74275 record's fix-round ruling. Checks the SOURCE agent's
 * profile (a clone carries it over verbatim) with `skipRoleCheck:true` — role is `clonedProfileRoleError`'s
 * job. Returns null for a profile-less source or one that's clean.
 */
export function cloneSourceFieldError(db: Db, sourceProfileId: string | null): string | null {
  if (sourceProfileId == null) return null;
  const profile: Pick<Profile, "role" | "connections" | "capabilities" | "vaultWrite" | "documentConversion" | "harness" | "allowDelta"> | undefined = db.getProfile(sourceProfileId);
  if (!profile) return null;
  const assignErr = agentAssignableProfileError(profile, { skipRoleCheck: true });
  return assignErr ? `cannot clone agent: ${assignErr}` : null;
}
