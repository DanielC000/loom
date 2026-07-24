import type { Db } from "../db.js";
import type { SessionRole } from "@loom/shared";

/**
 * Warn (never block) at agent create/update time when a startupPrompt names a tool that is NOT on
 * the resolved role's actual tool surface (card 5338a86a) — e.g. a Reddit Scout's kickoff saying
 * "use vault_write" when its role never mounts that tool, burning failed lookups every cold run.
 *
 * Two independent gaps this closes vs. hoping the prompt author remembers the surface by heart:
 *  (1) match precision — scans for BOTH `mcp__<server>__<tool>` tokens AND bare snake_case tool
 *      names (every real Loom tool name is multi-word snake_case with an underscore — vault_write,
 *      worker_spawn, tasks_create — so requiring an underscore before checking membership in the
 *      known-tool universe below keeps plain English prose from false-positiving);
 *  (2) the per-role surface tables below are Layer B (the exact tool names inside a role-gated
 *      router) — Layer A (which MCP SERVERS mount for a role: buildMcpServers in pty/host.ts) is
 *      already pure/reusable, but no resolver for the individual tool names existed. These tables
 *      are HAND-AUTHORED from the real router registrations (verified against a live introspection
 *      dump at authoring time) and are guarded against drift by
 *      test/agent-prompt-lint-surface-drift.mjs, which instantiates the REAL routers and asserts
 *      their registered tool sets still equal these tables — so a future tool added to a router
 *      without updating this file fails that test instead of silently rotting this lint.
 *
 * Deliberately NOT modeled here (accepted approximation gaps, all erring toward NOT warning):
 *  - Companion-only tools (chat_reply, skill_author/list/read/remove, board_create/board_update on
 *    loom-orchestration) are gated on a LIVE `companionSessionIds` binding, not resolvable from a
 *    role alone, and reachable from manager OR worker OR assistant — see COMPANION_APPROX_ALLOW.
 *  - Manager tools further gated on live DB/project state (peer links, deployCommand configured)
 *    are treated as always-on-surface for "manager" here (the manager static list already includes
 *    them) — an approximation that never causes a spurious "did you mean" for a live-gated tool.
 *  - operator role's platform.operatorEnabled live gate: not modeled; a profile with role:"operator"
 *    is checked against the full operator tool list regardless of whether the flag is currently on.
 *  - External/dynamic MCP servers (playwright's full tool set, any owner-added capability-catalog
 *    server) are NOT enumerated — their tool names aren't statically known in this codebase, so a
 *    prompt naming one of those tools is never flagged (false-negative, not false-positive).
 */

// --- Layer B: hand-authored per-router tool tables (verified against a live buildServer() dump) ---

export const PLATFORM_TOOLS: readonly string[] = [
  "agent_clone", "agent_clone_batch", "agent_create", "agent_delete", "agent_get", "agent_prompt_search",
  "agent_update", "daemon_restart", "end_me", "events_search", "git_checkout", "git_commit",
  "git_create_branch", "git_push", "idle_report", "list_all_agents", "list_all_profiles",
  "list_all_projects", "list_all_schedules", "list_all_sessions", "list_all_tasks",
  "platform_config_get", "profile_assign", "profile_create", "profile_delete",
  "profile_get", "profile_update", "project_archive", "project_configure", "project_create",
  "project_get", "project_init", "project_task_create", "project_task_get", "project_task_update",
  "project_update", "question_ask", "question_cancel", "question_pull", "question_resolve",
  "recycle_me", "schedule_create", "schedule_delete", "schedule_get", "schedule_update",
  "session_message", "session_reap", "session_spawn", "session_stop", "session_transcript", "skill_edit",
  "skill_list", "skill_write", "template_apply", "template_list", "vault_write",
];

export const SETUP_TOOLS: readonly string[] = [
  "agent_create", "agent_get", "agent_update", "end_me", "list_all_agents", "list_all_projects",
  "list_all_sessions", "profile_assign", "profile_create", "profile_get", "profile_update",
  "project_archive", "project_configure", "project_create", "project_get", "project_init",
  "project_update", "session_spawn", "skill_list", "skill_write", "template_apply", "template_list",
];

export const AUDIT_TOOLS: readonly string[] = [
  "audit_file_finding", "end_me", "list_sessions", "preset_suggestion_suggest", "repo_glob",
  "repo_grep", "repo_read_file", "requests_list", "transcript_read",
];

export const USER_AUDIT_TOOLS: readonly string[] = [
  "agent_prompt_read", "audit_handoff", "audit_suggest_improvement", "end_me", "list_sessions",
  "preset_suggestion_suggest", "repo_glob", "repo_grep", "repo_read_file", "skill_list",
  "skill_read", "transcript_read",
];

export const OPERATOR_TOOLS: readonly string[] = [
  "end_me", "git_checkout", "git_commit", "git_create_branch", "git_push", "my_project", "vault_write",
];

export const RUN_TOOLS: readonly string[] = ["submit_result"];

// loom-orchestration: ONE router, THREE very different per-role surfaces (see orchestration.ts).
export const ORCH_MANAGER_TOOLS: readonly string[] = [
  "agent_assign_profile", "agent_delete", "agent_get", "agent_list", "agent_update",
  "board_column_create", "board_column_delete", "board_column_rename", "daemon_restart", "end_me",
  "escalation_status", "gate_queue", "gate_status", "idle_report", "inbox_pull", "my_context",
  "platform_escalate", "profile_delete", "project_archive", "project_update", "question_ask",
  "question_cancel", "question_pull", "question_resolve", "recycle_me", "requests_list",
  "schedule_create", "schedule_update", "served_status", "worker_list", "worker_merge",
  "worker_merge_confirm", "worker_message", "worker_reap", "worker_recycle", "worker_redirect",
  "worker_relink", "worker_set_mode", "worker_spawn", "worker_status", "worker_stop", "worker_transcript",
];
// The worker's tested depth-1 surface (orchestration.ts's own comment: "EXACTLY { gate_status,
// my_context, run_gate, worker_report }" — pinned by 5 existing hermetic tests there).
export const ORCH_WORKER_TOOLS: readonly string[] = ["gate_status", "my_context", "run_gate", "worker_report"];
export const ORCH_ASSISTANT_TOOLS: readonly string[] = ["my_context", "notify_lead"];

// loom-tasks: universal across every role except assistant (which loses the two write tools).
export const TASKS_UNIVERSAL_TOOLS: readonly string[] = [
  "memory_forget", "memory_list", "memory_read", "memory_write", "task_request_get",
  "task_requests_list", "tasks_create", "tasks_get", "tasks_list", "tasks_update", "wake_cancel",
  "wake_list", "wake_me",
];
export const TASKS_ASSISTANT_EXCLUDED_TOOLS: readonly string[] = ["tasks_create", "tasks_update"];
// Conditional on the resolved profile, not the role — see resolveKnownToolSurface.
export const TASKS_VAULT_WRITE_TOOL = "vault_write";
export const TASKS_AUTHENTICATED_REQUEST_TOOL = "authenticated_request";

// Companion-gated (live `companionSessionIds` binding, reachable from manager OR worker OR
// assistant — unresolvable from role alone). Approximated as always-allowed for the three
// orchestration-mounted roles; see the module doc's approximation-gap note.
export const COMPANION_APPROX_ALLOW: readonly string[] = [
  "chat_reply", "skill_author", "skill_remove", "board_create", "board_update",
];

// Capability-provided bare tool names resolvable from a profile flag (document conversion mounts
// ONE named tool; browser-testing mounts a whole external server whose tool names aren't statically
// known here — see the module doc's accepted gap).
export const DOCUMENT_CONVERSION_TOOL = "convert_to_markdown";

const ORCHESTRATION_ROLES: ReadonlySet<SessionRole> = new Set(["manager", "worker", "assistant"] as SessionRole[]);

/** The full universe of known Loom bare tool names — used to recognize a candidate token as a REAL
 *  tool reference before checking it against a resolved surface (never flags an arbitrary word). */
export const ALL_KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PLATFORM_TOOLS, ...SETUP_TOOLS, ...AUDIT_TOOLS, ...USER_AUDIT_TOOLS, ...OPERATOR_TOOLS,
  ...RUN_TOOLS, ...ORCH_MANAGER_TOOLS, ...ORCH_WORKER_TOOLS, ...ORCH_ASSISTANT_TOOLS,
  ...TASKS_UNIVERSAL_TOOLS, ...COMPANION_APPROX_ALLOW,
  TASKS_VAULT_WRITE_TOOL, TASKS_AUTHENTICATED_REQUEST_TOOL, DOCUMENT_CONVERSION_TOOL,
]);

/** The resolved-profile inputs the surface depends on — mirrors buildMcpServers' inputs (pty/host.ts)
 *  plus the two loom-tasks conditional flags (vaultWrite, connections) that live outside the
 *  registry-capabilities system. */
export interface ToolSurfaceProfile {
  role: SessionRole | null | undefined;
  browserTesting?: boolean | null;
  documentConversion?: boolean | null;
  vaultWrite?: boolean | null;
  connections?: readonly string[] | null;
}

/** Resolve the known bare tool names on a profile's actual surface (Layer A role→server selection
 *  folded with Layer B's per-server tool tables). Never throws — an unknown/null role just resolves
 *  to the loom-tasks-only ("plain") surface, matching buildMcpServers' own default branch. */
export function resolveKnownToolSurface(profile: ToolSurfaceProfile): Set<string> {
  const role = profile.role ?? null;
  const surface = new Set<string>();

  if (role === "run") {
    for (const t of RUN_TOOLS) surface.add(t);
    return surface; // Agent Runs R2: a `run` session mounts ONLY loom-run, not even loom-tasks.
  }

  for (const t of TASKS_UNIVERSAL_TOOLS) surface.add(t);
  if (role === "assistant") for (const t of TASKS_ASSISTANT_EXCLUDED_TOOLS) surface.delete(t);
  if (profile.vaultWrite) surface.add(TASKS_VAULT_WRITE_TOOL);
  if (profile.connections && profile.connections.length > 0) surface.add(TASKS_AUTHENTICATED_REQUEST_TOOL);

  if (role === "manager") for (const t of ORCH_MANAGER_TOOLS) surface.add(t);
  else if (role === "worker") for (const t of ORCH_WORKER_TOOLS) surface.add(t);
  else if (role === "assistant") for (const t of ORCH_ASSISTANT_TOOLS) surface.add(t);
  else if (role === "platform") for (const t of PLATFORM_TOOLS) surface.add(t);
  else if (role === "auditor") for (const t of AUDIT_TOOLS) surface.add(t);
  else if (role === "workspace-auditor") for (const t of USER_AUDIT_TOOLS) surface.add(t);
  else if (role === "setup") for (const t of SETUP_TOOLS) surface.add(t);
  else if (role === "operator") for (const t of OPERATOR_TOOLS) surface.add(t);

  if (role != null && ORCHESTRATION_ROLES.has(role)) {
    for (const t of COMPANION_APPROX_ALLOW) surface.add(t);
  }
  if (profile.documentConversion) surface.add(DOCUMENT_CONVERSION_TOOL);
  // browserTesting mounts a whole external MCP server whose individual tool names aren't statically
  // known here (see module doc) — deliberately not added, so those names are never flagged either way.

  return surface;
}

/** Resolve the ToolSurfaceProfile for an agent from its assigned profile row (or the profile-less
 *  "plain" default — role:null, matching config.ts's own profile-less resolution). */
export function toolSurfaceProfileForAgentProfile(db: Db, profileId: string | null | undefined): ToolSurfaceProfile {
  if (!profileId) return { role: null };
  const profile = db.getProfile(profileId);
  if (!profile) return { role: null };
  return {
    role: profile.role ?? null,
    browserTesting: profile.browserTesting,
    documentConversion: profile.documentConversion,
    vaultWrite: profile.vaultWrite,
    connections: profile.connections,
  };
}

const MCP_TOKEN_RE = /\bmcp__([\w-]+)\b/g;
const BARE_TOKEN_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Scan `startupPrompt` for tool references NOT on the resolved profile's tool surface. Returns the
 * (sorted, deduped) list of offending bare tool names, or [] if the prompt is clean / empty. Never
 * throws — a warning-only check must never block an agent create/update.
 */
export function lintStartupPromptToolSurface(startupPrompt: string | null | undefined, profile: ToolSurfaceProfile): string[] {
  if (!startupPrompt) return [];
  const surface = resolveKnownToolSurface(profile);
  const offending = new Set<string>();

  for (const m of startupPrompt.matchAll(MCP_TOKEN_RE)) {
    const blob = m[1]; // e.g. "loom-platform__vault_write", or just "playwright" (server-only mention)
    if (!blob) continue;
    const parts = blob.split("__");
    if (parts.length < 2) continue;
    const tool = parts[parts.length - 1] ?? "";
    if (tool && ALL_KNOWN_TOOL_NAMES.has(tool) && !surface.has(tool)) offending.add(tool);
  }
  for (const m of startupPrompt.matchAll(BARE_TOKEN_RE)) {
    const tool = m[0];
    if (ALL_KNOWN_TOOL_NAMES.has(tool) && !surface.has(tool)) offending.add(tool);
  }

  return [...offending].sort();
}

/** Render the offending-tool list as a human-readable warning string, or null if there's nothing to warn about. */
export function toolSurfaceWarning(offendingTools: readonly string[]): string | null {
  if (offendingTools.length === 0) return null;
  const list = offendingTools.join(", ");
  return `startupPrompt names tool(s) not on this agent's resolved role surface: ${list}. Double-check the role/profile actually has access, or the agent will burn failed lookups at runtime.`;
}

/** Convenience for an agent_create-shaped write: lint the prompt against the (about-to-be-assigned)
 *  profileId. Never throws. */
export function agentCreatePromptWarning(db: Db, args: { startupPrompt?: string | null; profileId?: string | null }): string | null {
  const profile = toolSurfaceProfileForAgentProfile(db, args.profileId);
  return toolSurfaceWarning(lintStartupPromptToolSurface(args.startupPrompt, profile));
}

/** Convenience for an agent_update-shaped PATCH: lint the EFFECTIVE prompt/profile (the patch's
 *  value where present, else the existing agent's) — a patch that touches only `name`, say, still
 *  gets checked against the agent's unchanged startupPrompt/profile. Never throws. */
export function agentUpdatePromptWarning(
  db: Db,
  existing: { startupPrompt: string; profileId: string | null },
  patch: { startupPrompt?: string; profileId?: string | null },
): string | null {
  const effectivePrompt = patch.startupPrompt !== undefined ? patch.startupPrompt : existing.startupPrompt;
  const effectiveProfileId = patch.profileId !== undefined ? patch.profileId : existing.profileId;
  const profile = toolSurfaceProfileForAgentProfile(db, effectiveProfileId);
  return toolSurfaceWarning(lintStartupPromptToolSurface(effectivePrompt, profile));
}
