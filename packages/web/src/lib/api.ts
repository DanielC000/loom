import type { Project, Agent, AgentListItem, AgentId, SessionRole, Session, Task, BoardTask, SessionListItem, ArchivedSessionListItem, ArchivedSessionsPage, VaultEntry, KanbanColumn, ColumnRole, OrchestrationEvent, Wake, SkillSummary, Profile, ProfileSummary, ProfileMergeResult, ProfileFieldMerge, Schedule, ShellTerminal, ProjectConfigOverride, PlatformConfig, PlatformConfigOverride, RemoteAccessConfig, UsageLimitsStatus, UsageHistory, SessionUsageHistory, AgentRun, RunEvent, ApiKey, ApiKeyCaps, ApiKeyStatus, PresetPrompt, PresetPromptSuggestion, AuditTimeline, AuditDiff, AuditScope, CompanionConfigMasked, CompanionBinding, CompanionAllowedSender, CompanionCapabilityGrant, CompanionCoGrantWarning, CompanionConversationSummary, CompanionMessage, ConnectionMetadata, ConnectionAuthScheme, OAuthProviderSlug, CapabilitySummary, CapabilityProvisionKind, PollJob, Question, QuestionInboxItem, PendingBinding, PermissionAnswer, ProjectLink, EventTrigger, EventTriggerEventKind, ProjectMemoryEntry } from "@loom/shared";
// Type-only — the durable in-app chat history row shape, owned by the chat panel's transport module. Erased
// at build (no runtime import of that module into the api client), and no cycle (companionChat imports nothing here).
import type { CompanionHistoryRow } from "./companionChat";

// A one-time DM-pairing enrollment code, returned ONCE by the mint endpoint (the store keeps only a
// salted hash). The human relays `code` to the person being enrolled; it is never recoverable after.
export interface CompanionPairingCode { codeId: string; code: string; expiresAt: string; }

// The companion's "brain", served over human-only REST (Companion epic — Manage tab). PROMPT: the agent's
// own editable `startupPrompt` (bounded 10k) layered UNDER the server-owned, read-only `baseBrief`
// (ASSISTANT_BASE_BRIEF, echoed verbatim for context — a request body can never override it). SKILL: one
// self-authored skill entry — the companion authors these over MCP; this surface only reads + curates.
export interface CompanionPrompt { sessionId: string; startupPrompt: string; baseBrief: string; }
export interface CompanionSkillEntry { name: string; description: string; }
export interface CompanionMemoryEntry { name: string; description: string; pinned: boolean; }
// One recurring reminder the companion authored for itself over MCP (a cron job that fires a proactive
// turn into its own session). The human-only REST list shape: the `companion_reminders` row minus its
// server-internal `route`, plus a SERVER-COMPUTED `nextFireAt` (null when the cron can't be parsed).
// `nextFireAt` is populated even for a DISABLED row, so the UI must gate the "next fire" display on
// `enabled`. This surface only reads + curates (list / delete) — authoring stays the companion's own job.
export interface CompanionReminderEntry {
  id: string; cron: string; prompt: string; label: string | null;
  enabled: boolean; createdAt: string; nextFireAt: string | null;
}
// The session-ROW restrictedTools flag (blast-radius control) — DISTINCT from the Profile's
// restrictedTools default: this is what a running companion's PTY was actually spawned with, and what a
// restart re-applies from. See db.setRestrictedTools + sessions/service.ts resolveAgentSpawn.
export interface CompanionRestrictedTools { sessionId: string; restrictedTools: boolean; }

// Per-conflict resolution for a profile adopt-update: pick the user's value or the shipped value,
// wholesale (the field-level analog of the skills resolver's per-hunk mine/shipped choice).
export type ProfileFieldResolution = "mine" | "shipped";

// One desired column in the atomic board-column layout PUT (card B). `prevKey` (when set) marks a KEY
// RENAME — the server re-keys that column's cards old→new. A column omitted from the array is REMOVED;
// its cards auto-move to the defaultLanding column server-side. `accentColor`/`wipLimit` are carried
// through so an editor that rebuilds the whole layout (the board-header editor, card 5d) never strips
// the per-column accent / soft WIP limit it didn't touch — the PUT replaces the entire array.
export interface DesiredColumn { key: string; label: string; role?: ColumnRole; prevKey?: string; accentColor?: string; wipLimit?: number; }

export interface TranscriptTurn { role: "user" | "assistant" | "tool_result"; text: string; }
// One queued (not-yet-delivered) message. `id` is server-minted and stable, so the UI can
// delete/edit/reorder a specific entry even as the FIFO head drains between polls. `source` is who
// enqueued it ('human' composer vs 'system' programmatic) and `kind` classifies a system entry: 'warning'
// = a Loom operational nudge (idle/context watchdog, restart/memory-recall), 'agent' = a message authored
// by an agent/human TO this session (worker report, manager direction). Actionable = the human's own
// ('human') PLUS Loom's own ('warning'); an agent-authored entry (system + 'agent') is read-only.
export interface QueuedMessage { id: string; text: string; source: "human" | "system"; kind: "warning" | "agent"; }
export interface BranchDiff { filesChanged: number; insertions: number; deletions: number; patch: string; uncommitted?: boolean; merged?: boolean; }

// Skill update adoption (end-user customization — card 295a50f9). `update-diff` is the raw base→shipped
// pair (the UI computes the "what shipped changed" line diff); `merge-preview` is the 3-way auto-merge:
// `clean` one-clicks, otherwise `merged` carries git-style conflict markers (<<<<<<< mine / ||||||| base
// / ======= / >>>>>>> shipped) for a whole-file editor and `conflicts[]` enumerates each hunk for a
// per-hunk resolver. POST adopt with the resolved full content (or none, for a clean auto-merge).
export interface SkillUpdateDiff { base: string; shipped: string; }
export interface SkillMergeConflict { mine: string; base: string; shipped: string; }
export type SkillMergePreview =
  | { clean: true; merged: string }
  | { clean: false; merged: string; conflicts: SkillMergeConflict[] };
// Epic 2c-2 — the daemon's npm "update available" status (GET /api/update-status). The banner shows ONLY
// when `packaged && updateAvailable`; a from-source daemon reports packaged:false → no banner ever.
export interface UpdateStatus {
  packaged: boolean;
  channel: "stable" | "beta";
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
}

// The shared Loom-managed Python venv provisioning status (GET /api/python/provisioning). ONE venv backs
// every `documentConversion` rig, so this is a CAPABILITY-wide status, not per-profile. `failed` carries a
// classified `reason` + the captured ~4KB `errorTail` (the real proxy/SSL/resolver cause). Human-only
// loopback REST — the retry POST re-kicks provisioning off the daemon's event loop. See pty/host.ts +
// python/venv.ts in the daemon.
export type PythonProvisioningReason = "no-base-python" | "venv-create-failed" | "pip-failed" | "timeout" | "disabled";
export interface PythonProvisioning {
  state: "idle" | "installing" | "ready" | "failed";
  reason?: PythonProvisioningReason;
  errorTail?: string;
  binary?: string;
  lastAttemptAt?: number;
}

// Host-tool integrations (card 8dc5ebb9, GET /api/integrations) — one row per optional host tool (Open
// Design, Codescape, …). `state` mirrors the daemon's live resolver (never a re-derived client-side
// check); `detail` is a one-line human hint present whenever state !== "detected". See
// packages/daemon/src/integrations/detect.ts.
export type IntegrationSource = "db" | "env" | "none";
export type IntegrationState = "detected" | "not-found" | "unreachable";
export interface IntegrationStatus {
  slug: "openDesign" | "codescape";
  label: string;
  path: string | null;
  source: IntegrationSource;
  state: IntegrationState;
  detail?: string;
}

// Guided-onboarding workflow templates (onboarding C3 REST — GET /api/setup/templates). The human-only
// mirror of the agent-facing template_list tool: each bundled preset's name + one-line purpose + its
// agent→profile roster, plus a `boardSeed` summary (card count + title(s)) so the wizard's pre-apply
// Review screen can show exactly what will be seeded — the AUTHORITATIVE created counts still come from
// the apply response below (a template could seed a card whose title changes between list and apply, in
// theory; boardSeed here is a preview, not a guarantee). Each agent is bound to an existing bundled
// Profile by name; the wizard resolves that name against GET /api/profiles for the role sigil +
// browser/no-commit badges.
export interface SetupTemplate {
  name: string;
  description: string;
  agents: { name: string; profileName: string }[];
  boardSeed: { count: number; titles: string[] };
}
// The POST /api/setup/templates/apply result: the agents + starter board cards actually created in the
// target project (the authoritative counts the Done screen shows). Mirrors applyWorkflowTemplate's return.
export interface TemplateApplyResult { agents: Agent[]; tasks: Task[]; }

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}
// GET that resolves to `null` on an EXPECTED 404 (not found) instead of throwing — for a by-id lookup a
// caller probes optimistically (e.g. "is this id archived?") and treats absence as a normal outcome, not
// a query error.
async function getOrNull<T>(url: string): Promise<T | null> {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}
// GET that surfaces the server's JSON `{ error }` body as the thrown message — for the audit diff
// reader, whose EXPECTED 400 ("no predecessor — pass an explicit 'b'") carries a reason the replay
// panel shows verbatim instead of an opaque "-> 400".
async function getErr<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `${url} -> ${r.status}`;
    try { const j = (await r.json()) as { error?: string }; if (j?.error) msg = j.error; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  // Only declare a JSON content-type when we actually send a body — Fastify's JSON parser rejects an
  // EMPTY body under content-type: application/json with 400 FST_ERR_CTP_EMPTY_JSON_BODY, which would
  // silently fail every no-body POST (resumeSession, no-role startSession). No body → no header.
  const r = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}
async function del<T>(url: string): Promise<T> {
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}
async function put<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}
// POST/DELETE that surface the server's JSON `{ error }` body as the thrown message — for the archive
// surfaces, where an EXPECTED 400 (live group / not archived) carries a reason the UI shows verbatim.
async function postErr<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `${url} -> ${r.status}`;
    try { const j = (await r.json()) as { error?: string }; if (j?.error) msg = j.error; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}
async function delErr<T>(url: string): Promise<T> {
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) {
    let msg = `${url} -> ${r.status}`;
    try { const j = (await r.json()) as { error?: string }; if (j?.error) msg = j.error; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

// PUT that surfaces the server's JSON `{ error }` body as the thrown message — for the preset-prompts
// edit surface, whose label/prompt validation 400s ({ error }) the inline editor shows verbatim.
async function putErr<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = `${url} -> ${r.status}`;
    try { const j = (await r.json()) as { error?: string }; if (j?.error) msg = j.error; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

// One live worktree session blocking a repoPath rebind (the daemon's shared rebind guard). Surfaced
// in the Settings UI so the user can name + stop them before retrying.
export interface LiveWorktreeSession { sessionId: string; branch: string | null; worktreePath: string; }
// An Error from a project PATCH that, on the live-worktree rebind refusal, also carries the named
// liveSessions[] the daemon returned alongside `{ error }` — so the UI lists them, not just the message.
export interface ProjectPatchError extends Error { liveSessions?: LiveWorktreeSession[]; }

// PATCH /api/projects/:id (the human STRUCTURAL path — name / vaultPath / repoPath rebind). Surfaces the
// server's `{ error }` body verbatim (non-repo / non-empty validation) AND attaches the live-worktree
// refusal's `liveSessions[]` to the thrown Error so the rebind UI can list the sessions to stop.
async function patchProject(url: string, body: unknown): Promise<Project> {
  const r = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = `${url} -> ${r.status}`;
    let liveSessions: LiveWorktreeSession[] | undefined;
    try {
      const j = (await r.json()) as { error?: string; liveSessions?: LiveWorktreeSession[] };
      if (j?.error) msg = j.error;
      if (Array.isArray(j?.liveSessions)) liveSessions = j.liveSessions;
    } catch { /* non-JSON body */ }
    const e = new Error(msg) as ProjectPatchError;
    if (liveSessions) e.liveSessions = liveSessions;
    throw e;
  }
  return r.json() as Promise<Project>;
}

// PATCH that surfaces the server's JSON `{ error }` body as the thrown message — the config schema is
// strict zod, so a rejected override comes back 400 with a readable reason the Settings UI shows verbatim.
async function patch<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = `${url} -> ${r.status}`;
    try { const j = (await r.json()) as { error?: string }; if (j?.error) msg = j.error; } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

// An Error from the companion PROVISION POST that also carries the HTTP status, so the create UI can tell
// the single-companion 409 precondition (surfaced as a calm "you already have one" — see lib/companion.ts
// › provisionErrorMessage) apart from a genuine failure, rather than rendering the raw server string.
export interface CompanionProvisionError extends Error { status?: number; }

// POST /api/companion/provision — the simple, in-app-first create. A bare `{ name }` provisions a working
// IN-APP-ONLY companion (no session id, no bot token, no external config) and returns the MASKED companion.
// Surfaces the server's `{ error }` verbatim AND attaches the status (409 = single-companion guard) so the
// create flow can render a friendly, non-alarming message instead of a raw error.
async function provisionCompanionReq(body: { name?: string }): Promise<CompanionConfigMasked> {
  const r = await fetch("/api/companion/provision", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `/api/companion/provision -> ${r.status}`;
    try { const j = (await r.json()) as { error?: string }; if (j?.error) msg = j.error; } catch { /* non-JSON */ }
    const e = new Error(msg) as CompanionProvisionError;
    e.status = r.status;
    throw e;
  }
  return r.json() as Promise<CompanionConfigMasked>;
}

export const api = {
  projects: () => get<Project[]>("/api/projects"),
  // Platform Manager P6 — discover the reserved "Loom Platform" home (hidden from the ordinary picker)
  // + its seeded agents (the Lead + Auditor), for the dedicated Platform section. READ-ONLY discovery;
  // spawn/stop/schedule reuse the existing startSession / stopSession / createSchedule routes below.
  // liveSessions: each platform agent's currently-LIVE sessions (live-over-recency — see server.ts), so a
  // spawn decision can see an existing live Lead/Auditor before minting a second. role is the singleton key.
  platformHome: () => get<{
    project: Project;
    agents: Agent[];
    liveSessions: { id: string; agentId: string; role: SessionRole | null; processState: string; busy: boolean; createdAt: string; lastActivity: string }[];
  }>("/api/platform/home"),
  // Setup Assistant E1-7 — discover the reserved "Getting Started" home (hidden from the ordinary
  // picker, like the Platform home) + its Setup Assistant agent(s), for the dedicated Setup page.
  // MIRRORS platformHome but NAME-SCOPED server-side to the SETUP home. READ-ONLY discovery; spawn =
  // startSession(role "setup") below. liveSessions surfaces an already-live setup session so the page
  // attaches/reuses it instead of minting a second (startSetup is a server-side singleton regardless).
  setupHome: () => get<{
    project: Project;
    agents: Agent[];
    liveSessions: { id: string; agentId: string; role: SessionRole | null; processState: string; busy: boolean; createdAt: string; lastActivity: string }[];
  }>("/api/setup/home"),
  // --- Guided onboarding & templates (onboarding C3/C5). HUMAN-only loopback REST mirror of the
  // agent-facing template_list/template_apply MCP tools — the setup wizard consumes these directly.
  // `setupTemplates` lists the bundled workflow presets (name + purpose + agent→profile roster);
  // `applyTemplate` stands up a template's agents + starter card into an ALREADY-EXISTING project and
  // returns the created agents/tasks. applyTemplate surfaces the server's `{ error }` body verbatim (an
  // unknown template / elevated-role guard 400s) via postErr, so the wizard shows the reason inline. ---
  setupTemplates: () => get<SetupTemplate[]>("/api/setup/templates"),
  applyTemplate: (projectId: string, templateName: string) =>
    postErr<TemplateApplyResult>("/api/setup/templates/apply", { projectId, templateName }),
  // `referenceRepos` (optional) binds read-only sibling repos at creation — each validated absolute +
  // isGitRepo server-side; a bad entry 400s with a reason. postErr (not post) surfaces that `{ error }`
  // body verbatim so the wizard/creation UI can show it inline instead of a bare `-> 400`.
  createProject: (b: { name: string; repoPath: string; vaultPath: string; referenceRepos?: string[] }) =>
    postErr<Project>("/api/projects", b),
  // The wizard's "Create new" mode: init a BRAND-NEW project dir under Loom's sanctioned workspace base
  // (confined + traversal-rejected server-side — see setup/bootstrap.ts) instead of registering a
  // user-typed path. kind "git" (default) `git init`s it; kind "vault" leaves a plain notes folder.
  // `referenceRepos` binds read-only sibling repos (same absolute + isGitRepo validation as POST
  // /api/projects). postErr surfaces the confinement/traversal-rejection/ref-repo `{ error }` verbatim.
  projectInit: (b: { name: string; kind?: "git" | "vault"; referenceRepos?: string[] }) =>
    postErr<Project & { identityWarning?: string }>("/api/setup/project-init", b),
  // --- HUMAN-only project/agent management (rename / archive / restore / PERMANENT delete + agent
  // delete). DESTRUCTIVE, loopback-only — there is NO agent MCP path to any of these (same posture as
  // session archive/delete + gateCommand). All surface the server's `{ error }` body verbatim (via
  // *Err) so the reserved-home + live-session ("stop the fleet first") guards show inline. ---
  // STRUCTURAL edit (name / vaultPath / repoPath rebind) — distinct from updateProjectConfig (the
  // validated machine config). A repoPath rebind goes through the daemon's shared guard (isGitRepo +
  // live-worktree refusal); patchProject surfaces both the `{ error }` reason AND the named liveSessions[].
  updateProject: (id: string, body: { name?: string; vaultPath?: string; repoPath?: string; referenceRepos?: string[] }) =>
    patchProject(`/api/projects/${id}`, body),
  // Soft-archive (reversible "delete"). 400s on the reserved home or a live fleet (surfaced via delErr).
  archiveProject: (id: string) => delErr<{ ok: boolean }>(`/api/projects/${id}`),
  // Soft-archived projects (the "Archived" section) → restore / permanent-delete.
  archivedProjects: () => get<Project[]>("/api/projects/archived"),
  restoreProject: (id: string) => postErr<Project>(`/api/projects/${id}/restore`),
  // IRREVERSIBLE cascade (agents/sessions/tasks/schedules/keys/runs + on-disk snapshots) — distinct from
  // the bare archive. The strong type-the-name confirm is the web's job; the server just runs the guards.
  deleteProjectPermanent: (id: string) =>
    delErr<{ ok: boolean; deleted: { project: string; sessions: number } }>(`/api/projects/${id}/permanent`),
  // Permanently delete an agent (cascade its sessions). 400s while any of its sessions is live.
  deleteAgent: (id: string) => delErr<{ ok: boolean; deleted: { agent: string; sessions: number } }>(`/api/agents/${id}`),
  // --- Project config override (the human/REST path: full schema, gateCommand editable). The list
  // endpoint already carries each project's stored override, so `projectConfig` reads it from there
  // (no single-project GET exists); `updateProjectConfig` PATCHes the replacement override and returns
  // the updated Project. The PATCH validator is strict zod — an invalid override 400s with a reason. ---
  projectConfig: (id: string) =>
    get<Project[]>("/api/projects").then((ps) => {
      const p = ps.find((x) => x.id === id);
      if (!p) throw new Error("project not found");
      return p.config;
    }),
  updateProjectConfig: (id: string, config: ProjectConfigOverride) =>
    patch<Project>(`/api/projects/${id}/config`, { config }),
  // --- Daemon-global platform tuning (HUMAN-only; NOT project-scoped — one shared daemon). GET returns
  // the stored override + the RESOLVED effective platform group (for the "effective:" hints); update
  // PATCHes the replacement override under `{ config }`. The validator is strict zod with §bounds — an
  // out-of-range value 400s with a reason the Global section shows verbatim (same as projectConfig). ---
  // `resolved.remoteAccess` (the daemon-global bind posture) rides along on this same GET — see
  // gateway/server.ts's handler, which merges it onto the resolved `platform` group in one response.
  getPlatformConfig: () =>
    get<{ override: PlatformConfigOverride; resolved: PlatformConfig & { remoteAccess: RemoteAccessConfig } }>("/api/platform/config"),
  updatePlatformConfig: (config: PlatformConfigOverride) =>
    patch<{ ok: boolean; override: PlatformConfigOverride }>("/api/platform/config", { config }),
  agents: (projectId: string) => get<Agent[]>(`/api/projects/${projectId}/agents`),
  // Every agent across every project, enriched with its project name — ONE round-trip in place of the
  // client N+1 (api.projects() + Promise.all(projects.map(p => api.agents(p.id)))) that Schedules/
  // Settings/EventTriggers each used to run independently to build a "Project / Agent" label map.
  allAgents: () => get<AgentListItem[]>("/api/agents"),
  createAgent: (projectId: string, b: { name: string; startupPrompt?: string }) =>
    post<Agent>(`/api/projects/${projectId}/agents`, b),
  // `endpoint` flags an agent as API-exposable (Agent Runs R1) — only an endpoint=true agent may be put
  // on a key's allowlist. HUMAN-only trust-boundary surface (no agent MCP path); reuses this same route.
  updateAgent: (id: string, patch: { name?: string; startupPrompt?: string; profileId?: string | null; endpoint?: boolean }) =>
    post<Agent>(`/api/agents/${id}`, patch),
  tasks: (projectId: string) => get<Task[]>(`/api/projects/${projectId}/tasks`),
  // Lore — the read-only per-project project_memory list (pinned first, then most-recently-updated).
  // Full entries incl. the note `text`, so client-side search (title+key+content) + the note-detail
  // body render off this one read. Human-only; there is deliberately no write/forget counterpart.
  projectMemory: (projectId: string) => get<ProjectMemoryEntry[]>(`/api/projects/${projectId}/memory`),
  createTask: (projectId: string, b: { title: string; body?: string; columnKey?: string; priority?: Task["priority"] }) =>
    post<Task>(`/api/projects/${projectId}/tasks`, b),
  sessions: (agentId: string) => get<Session[]>(`/api/agents/${agentId}/sessions`),
  // role omitted/undefined = auto (the agent's profile role applies, server-side); "manager"/"platform"
  // = explicit role; "auditor" = the read-and-file-only Platform Auditor (P5; locked role server-side);
  // "setup" = the ungated, user-facing Setup Assistant (singleton, reused server-side — startSetup);
  // "workspace-auditor" = the de-privileged end-user Workspace Auditor (B5; locked role server-side,
  // CREATE-ONLY — each Review spawns a fresh run); "plain" = force-plain (role-null session).
  startSession: (agentId: string, role?: "manager" | "platform" | "auditor" | "setup" | "workspace-auditor" | "plain") =>
    post<Session>(`/api/agents/${agentId}/sessions`, role ? { role } : undefined),
  resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
  forkSession: (id: string) => post<Session>(`/api/sessions/${id}/fork`),
  sendInput: (id: string, text: string) =>
    post<{ delivered: boolean; position?: number }>(`/api/sessions/${id}/input`, { text }),
  // One-click graceful wrap-up (HUMAN-only; non-worker only — mirrors stop/input, no agent MCP surface):
  // injects a /session-end + end_me turn so the session logs progress, stays resumable, then self-stops.
  endSession: (id: string) =>
    post<{ delivered: boolean; position?: number }>(`/api/sessions/${id}/end`),
  stopSession: (id: string, mode: "graceful" | "hard") =>
    post<{ ok: boolean }>(`/api/sessions/${id}/stop`, { mode }),
  // Manual per-session rate-limit override + retry-now (HUMAN-only; mirrors stop — no agent MCP
  // surface). Clears the park + episode deadline, drops the global usage latch, and re-submits the
  // held turn if the session is live; returns the updated session (rateLimitedUntil now null).
  clearSessionRateLimit: (id: string) => post<Session>(`/api/sessions/${id}/rate-limit/clear`),
  allSessions: () => get<SessionListItem[]>("/api/sessions"),

  // --- Per-project session Archive (HUMAN-only; mirrors stop/fork — no agent MCP surface). Archiving
  // is now AUTOMATIC on session exit (the manual archive endpoint was removed), so there is no
  // archiveSession client. restore brings one back to the rail (view-only if dead); deleteArchived is
  // permanent (row(s) + snapshot). archivedSessions feeds the Archive tab — PAGINATED (default/max page
  // size live server-side; a list-rendering page grows `limit` for its own "Load more"), returning
  // `{items, total}` rather than the full per-project archived set. ---
  archivedSessions: (projectId: string, opts?: { limit?: number; offset?: number }) =>
    get<ArchivedSessionsPage>(`/api/projects/${projectId}/archive?limit=${opts?.limit ?? 100}&offset=${opts?.offset ?? 0}`),
  // Cross-project (god-eye) archive: archived sessions across ALL projects, each enriched with
  // projectId/projectName + snapshotExists — feeds the grouped Project → Agent Archive page + Mission
  // Control/Overview/RunHistory's history views. PAGINATED, same `{items, total}` shape as above.
  // Optional `role` scopes the page server-side to one SessionRole (e.g. "manager") BEFORE the
  // limit/offset apply, so a role-scoped caller's page budget isn't diluted by unrelated rows.
  allArchivedSessions: (opts?: { limit?: number; offset?: number; role?: string }) =>
    get<ArchivedSessionsPage>(`/api/archived-sessions?limit=${opts?.limit ?? 100}&offset=${opts?.offset ?? 0}${opts?.role ? `&role=${opts.role}` : ""}`),
  // A single archived session BY ID, cross-project — for a by-id consumer (SessionView resolving a
  // deep-linked/attention-queue session) that must not depend on that session still being on the FIRST
  // page of the bounded list above. Resolves to `null` (not a thrown error) on the expected 404 — "not
  // archived (or never existed)" is a normal outcome for a caller that's still also checking the live feed.
  archivedSessionById: (id: string) => getOrNull<ArchivedSessionListItem>(`/api/archived-sessions/${id}`),
  restoreSession: (id: string) => postErr<{ restored: string }>(`/api/sessions/${id}/restore`),
  deleteArchivedSession: (id: string) => delErr<{ deleted: string[] }>(`/api/sessions/${id}/archive`),
  vaultTree: (projectId: string) => get<VaultEntry[]>(`/api/projects/${projectId}/vault`),
  vaultFile: (projectId: string, path: string) =>
    get<{ path: string; content: string }>(`/api/projects/${projectId}/vault/file?path=${encodeURIComponent(path)}`),
  // Raw bytes of a vault file, served with a content-type by extension + X-Content-Type-Options: nosniff
  // (daemon `vault/raw`). Returns the URL string — used directly as an `<img>`/`<iframe>`/`<object>`/
  // download `src`/`href` (the vite dev proxy forwards /api to the live daemon); the browser fetches it.
  vaultRawUrl: (projectId: string, path: string) =>
    `/api/projects/${projectId}/vault/raw?path=${encodeURIComponent(path)}`,
  // HEAD the raw endpoint for a binary file's size/content-type without downloading the bytes — for the
  // "Binary file · <size> · Download" card. Returns nulls if the headers are absent.
  vaultRawHead: async (projectId: string, path: string): Promise<{ size: number | null; contentType: string | null }> => {
    const r = await fetch(`/api/projects/${projectId}/vault/raw?path=${encodeURIComponent(path)}`, { method: "HEAD" });
    if (!r.ok) throw new Error(`vault/raw HEAD -> ${r.status}`);
    const len = r.headers.get("content-length");
    return { size: len ? Number(len) : null, contentType: r.headers.get("content-type") };
  },
  // Vault WRITE (HUMAN-only; mirrors skills/profiles — no agent MCP surface). Each op commits
  // through the daemon's shared vault-commit path. saveVaultFile = write/overwrite (PUT),
  // createVaultFile = new file, 409 if exists (POST), deleteVaultFile = remove (DELETE).
  saveVaultFile: (projectId: string, path: string, content: string) =>
    put<{ ok: boolean; path: string; committed: boolean }>(`/api/projects/${projectId}/vault/file`, { path, content }),
  createVaultFile: (projectId: string, path: string, content = "") =>
    post<{ ok: boolean; path: string; committed: boolean }>(`/api/projects/${projectId}/vault/file`, { path, content }),
  deleteVaultFile: (projectId: string, path: string) =>
    del<{ ok: boolean; path: string; committed: boolean }>(`/api/projects/${projectId}/vault/file?path=${encodeURIComponent(path)}`),
  gitLog: (projectId: string) =>
    get<{ hash: string; date: string; message: string; author: string }[]>(`/api/projects/${projectId}/git/log`),
  gitBranches: (projectId: string) =>
    get<{ current: string; all: string[] }>(`/api/projects/${projectId}/git/branches`),
  // Read-only git log for a bound reference repo (reference-repos epic Phase 5). `index` is the position
  // in the project's OWN referenceRepos[] — the server resolves the path server-side, so this can never
  // reach an arbitrary host path. An out-of-range index 404s.
  referenceRepoGitLog: (projectId: string, index: number) =>
    get<{ hash: string; date: string; message: string; author: string }[]>(`/api/projects/${projectId}/git/reference-repos/${index}/log`),
  // Git WRITE (HUMAN-only; mirrors the vault writer — no agent MCP surface). Each returns a structured
  // { ok, error? } so the UI shows an expected git failure (dirty tree, no upstream, conflict) instead
  // of a generic throw. commit takes ONLY a message (repo-configured identity, no overrides/trailer).
  gitCheckout: (projectId: string, branch: string) =>
    post<{ ok: boolean; branch?: string; error?: string }>(`/api/projects/${projectId}/git/checkout`, { branch }),
  gitCreateBranch: (projectId: string, name: string) =>
    post<{ ok: boolean; branch?: string; error?: string }>(`/api/projects/${projectId}/git/branch`, { name }),
  gitCommit: (projectId: string, message: string) =>
    post<{ ok: boolean; hash?: string; error?: string }>(`/api/projects/${projectId}/git/commit`, { message }),
  gitPush: (projectId: string) =>
    post<{ ok: boolean; branch?: string; error?: string }>(`/api/projects/${projectId}/git/push`),
  board: (projectId: string) =>
    get<{ columns: KanbanColumn[]; tasks: BoardTask[] }>(`/api/projects/${projectId}/board`),
  // One task's full row (incl. body) — the board drawer's lazy fetch for a DONE card, whose body the
  // board() list route above omits (card 4fa2c146).
  getTask: (id: string) => get<Task>(`/api/tasks/${id}`),
  // Atomic safe board-column layout change (card B's endpoint) — the column-manager editor's ONLY
  // mutation path, NOT the blind config PATCH (which still owns every other setting). Sends the FULL
  // desired layout; the server diffs vs current, re-keys cards (renames + removals → defaultLanding) in
  // ONE transaction, and HARD-rejects a guard violation (no/duplicate required role, <1-column floor,
  // bad rename) with a 400 whose `{ error }` body surfaces verbatim via putErr. `warnings` are soft
  // (e.g. dropping a non-required role lane) — shown but non-blocking.
  updateProjectColumns: (id: string, columns: DesiredColumn[]) =>
    putErr<{ ok: boolean; columns: KanbanColumn[]; warnings: string[] }>(`/api/projects/${id}/columns`, { columns }),
  updateTask: (id: string, patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority" | "held" | "deferred">>) =>
    post<{ ok: boolean }>(`/api/tasks/${id}`, patch),
  // PERMANENTLY delete a task card (drawer Delete button). HUMAN/loopback REST only — no MCP path. Uses
  // delErr so the server's live-session guard 400 ({ error }) surfaces verbatim to the user.
  deleteTask: (id: string) => delErr<{ ok: boolean }>(`/api/tasks/${id}`),
  transcript: (sessionId: string) => get<TranscriptTurn[]>(`/api/sessions/${sessionId}/transcript`),

  // --- Agent Runs (R4b Runs UI; HUMAN/loopback REST, project-scoped, no auth — mirrors the other
  // /api/projects/:id surfaces, DELIBERATELY off the R3 key-authed path). list returns FULL AgentRun
  // rows newest-first (across every key); run is one full row; cancelRun teardowns an in-flight run
  // (idempotent no-op on a terminal one) and returns its now-final status. The key-admin / endpoint-flag
  // surface (the trust-boundary write side) lives in the separate block below + the Keys & Endpoints view. ---
  runs: (projectId: string) => get<AgentRun[]>(`/api/projects/${projectId}/runs`),
  run: (projectId: string, runId: string) => get<AgentRun>(`/api/projects/${projectId}/runs/${runId}`),
  // A run's transcript: the live engine JSONL while it exists, else the retained snapshot (transcriptRef).
  // Run-scoped (NOT the session-transcript route, which only snapshot-falls-back on archivedAt — runs
  // never get it, so old runs read "" there despite a retained snapshot).
  runTranscript: (projectId: string, runId: string) =>
    get<TranscriptTurn[]>(`/api/projects/${projectId}/runs/${runId}/transcript`),
  cancelRun: (projectId: string, runId: string) =>
    post<{ runId: string; status: AgentRun["status"] }>(`/api/projects/${projectId}/runs/${runId}/cancel`),
  // Run audit trail (follow-up #1) — chiefly cap-rejections (a 429 at POST /api/runs makes NO run row, so
  // it's invisible in the runs list). Project-scoped, newest-first, bounded; same unauthed-loopback posture.
  runEvents: (projectId: string) => get<RunEvent[]>(`/api/projects/${projectId}/run-events`),

  // --- Agent Runs key & endpoint admin (R1 + R4a kill-switch). HUMAN/loopback REST, project-scoped,
  // NO auth and NO agent MCP path — the trust-boundary key surface (mint/rotate/revoke/kill a key,
  // mirroring how gateCommand / profile role are gated). `keys` returns PUBLIC metadata only (no secret
  // or hash). `createKey` + `rotateKey` return the plaintext token EXACTLY ONCE as `{ key, plaintext }`
  // — the caller must store it immediately; it is never recoverable after (never persist/refetch it).
  // `killKey` pauses the key + cancels its in-flight runs (`{ cancelled }`). Mutations 400 with a
  // readable `{ error }` (bad caps / non-endpoint agent in the allowlist), surfaced inline via postErr. ---
  keys: (projectId: string) => get<ApiKey[]>(`/api/projects/${projectId}/keys`),
  createKey: (projectId: string, b: { name: string; endpointAgentIds: AgentId[]; caps: ApiKeyCaps; status?: ApiKeyStatus }) =>
    postErr<{ key: ApiKey; plaintext: string }>(`/api/projects/${projectId}/keys`, b),
  updateKey: (keyId: string, patch: { name?: string; endpointAgentIds?: AgentId[]; caps?: ApiKeyCaps; status?: ApiKeyStatus }) =>
    postErr<ApiKey>(`/api/keys/${keyId}`, patch),
  rotateKey: (keyId: string) => postErr<{ key: ApiKey; plaintext: string }>(`/api/keys/${keyId}/rotate`),
  killKey: (keyId: string) => postErr<{ cancelled: number }>(`/api/keys/${keyId}/kill`),
  deleteKey: (keyId: string) => delErr<{ ok: boolean }>(`/api/keys/${keyId}`),
  // Pending one-shot wake-ups scheduled for a session (the wake_me primitive).
  sessionWakes: (sessionId: string) => get<Wake[]>(`/api/sessions/${sessionId}/wakes`),
  cancelWake: (sessionId: string, wakeId: string) =>
    del<{ cancelled: boolean }>(`/api/sessions/${sessionId}/wakes/${wakeId}`),
  // Queued inbound messages held for a session (worker reports / turns waiting for it to free up).
  // Entries carry a stable id so the UI can address a specific one for delete/edit/reorder.
  sessionQueue: (sessionId: string) => get<{ pending: QueuedMessage[] }>(`/api/sessions/${sessionId}/queue`),
  // Bulk counterparts of the two above — ONE round-trip for a whole grid of session cards (Overview's
  // ProjectTerminals + the Terminals page) instead of 2×N per poll window. Keyed by sessionId; a
  // session absent from the response has nothing pending. Empty `ids` short-circuits to `{}` client-side
  // (no round-trip for an empty grid).
  sessionQueuesBulk: (ids: string[]) =>
    ids.length === 0
      ? Promise.resolve<Record<string, QueuedMessage[]>>({})
      : get<Record<string, QueuedMessage[]>>(`/api/sessions/queues?ids=${ids.join(",")}`),
  sessionWakesBulk: (ids: string[]) =>
    ids.length === 0
      ? Promise.resolve<Record<string, Wake[]>>({})
      : get<Record<string, Wake[]>>(`/api/sessions/wakes?ids=${ids.join(",")}`),
  // Mutate the held queue (human-only; id-addressed). A stale id (already drained) is a graceful no-op.
  deleteQueued: (sessionId: string, entryId: string) =>
    del<{ deleted: boolean }>(`/api/sessions/${sessionId}/queue/${entryId}`),
  editQueued: (sessionId: string, entryId: string, text: string) =>
    patch<{ edited: boolean }>(`/api/sessions/${sessionId}/queue/${entryId}`, { text }),
  reorderQueued: (sessionId: string, orderedIds: string[]) =>
    patch<{ reordered: boolean }>(`/api/sessions/${sessionId}/queue`, { orderedIds }),

  // --- phase-2 orchestration (#18b view) ---
  orchestrationEvents: (managerId: string) =>
    get<OrchestrationEvent[]>(`/api/orchestration/events?managerId=${encodeURIComponent(managerId)}`),
  workerDiff: (sessionId: string) => get<BranchDiff>(`/api/sessions/${sessionId}/diff`),
  // Human-initiated merge of a worker's branch — runs the daemon's fail-closed build gate then
  // merges (manager derived from the worker's parentSessionId server-side).
  mergeWorker: (sessionId: string) => post<{ merged: boolean; reason?: string }>(`/api/sessions/${sessionId}/merge`),
  // `schedulerEnabled` is the boot-time cron-Scheduler gate (LOOM_SCHEDULER_ENABLED=1 OR resolved
  // orchestration.schedulerEnabled). Read-only; the Schedules page uses it to warn, honestly, when
  // created schedules will NOT fire because the scheduler is off (the default).
  orchestrationStatus: () => get<{ pausedScopes: string[]; schedulerEnabled: boolean }>("/api/orchestration/status"),

  // --- Manager→human DECISION INBOX (card 8701bdbb, child B). READ side: `openQuestions` is the GLOBAL
  // "waiting on me" queue (pending+answered across ALL projects, enriched with the asking agent/project
  // names + sessionLive), newest-first; `question` fetches one for the answer page (404 → readable via
  // getErr). WRITE side: `answerQuestion` is the ONLY writer of chosenOption/note — it POSTs the existing
  // human-only answer route (options question → a chosenOption from options; pure-blocker → note only,
  // required). All human-only loopback REST — there is NO agent MCP path (the agent can only ask/pull). ---
  openQuestions: (includeConsumed = false) =>
    get<QuestionInboxItem[]>(`/api/questions${includeConsumed ? "?includeConsumed=true" : ""}`),
  question: (id: string) => getErr<QuestionInboxItem>(`/api/questions/${encodeURIComponent(id)}`),
  // The answer route (POST /api/questions/:id/answer) branches its body SHAPE by the question's `type`
  // server-side (see gateway/server.ts): decision/input → {chosenOption?,note?}; permission →
  // {decision,note?}; credential → {secret} (NEVER-ECHO — the plaintext is envelope-encrypted at that one
  // write boundary and never returned). Three typed clients so each caller sends exactly its type's body;
  // all surface the route's `{ error }` verbatim via postErr. The response is always the bare Question
  // (which, for credential, never carries the secret).
  answerQuestion: (id: string, body: { chosenOption?: string | null; note?: string }) =>
    postErr<Question>(`/api/questions/${encodeURIComponent(id)}/answer`, body),
  answerPermissionQuestion: (id: string, decision: PermissionAnswer, note?: string) =>
    postErr<Question>(`/api/questions/${encodeURIComponent(id)}/answer`, { decision, note }),
  answerCredentialQuestion: (id: string, secret: string) =>
    postErr<Question>(`/api/questions/${encodeURIComponent(id)}/answer`, { secret }),
  // Human dismiss (POST /api/questions/:id/dismiss) — the missing exit from a moot/superseded PENDING
  // request; mirrors dismissPresetPromptSuggestion's shape (a stale/already-non-pending row 409s, surfaced
  // via postErr like every other answer route above). Returns the cancelled Question (state:"cancelled").
  dismissQuestion: (id: string, reason?: string) =>
    postErr<Question>(`/api/questions/${encodeURIComponent(id)}/dismiss`, reason ? { reason } : {}),

  // --- Session/run AUDIT LOG (replayable timeline + run-vs-run diff). READ-ONLY, HUMAN-only loopback
  // readers over the existing `orchestration_events` record — NEVER an agent MCP tool (mirrors
  // orchestrationEvents). `auditSession` = every event where the session is the manager OR worker;
  // `auditWave` = a manager + all its workers, de-duped. `auditDiff` aligns two timelines (scope applies
  // to both sides); omit `b` to compare A against its recycledFrom predecessor — that case 400s with a
  // readable reason when A has none, surfaced via getErr. ---
  auditSession: (id: string) => get<AuditTimeline>(`/api/audit/session/${encodeURIComponent(id)}`),
  auditWave: (managerId: string) => get<AuditTimeline>(`/api/audit/wave/${encodeURIComponent(managerId)}`),
  auditDiff: (a: string, b: string | undefined, scope: AuditScope) => {
    const params = new URLSearchParams({ a, scope });
    if (b) params.set("b", b);
    return getErr<AuditDiff>(`/api/audit/diff?${params.toString()}`);
  },
  // Releases v1 Part 3 — the daemon's `loom` package version, surfaced unobtrusively in the header.
  version: () => get<{ version: string }>("/api/version"),
  // Epic 2c-2 — the daemon's npm "update available" status (read-only, polled into the banner).
  updateStatus: () => get<UpdateStatus>("/api/update-status"),
  // Epic 2c-2 — trigger the self-update (stop→install→start). Loopback-only + packaged-only on the daemon
  // (a source daemon 409s); NOT an agent MCP tool — same trust boundary as /internal/shutdown. The daemon
  // acks then restarts, so this connection drops mid-flight — the caller treats that as "update started".
  triggerUpdate: () => postErr<{ ok: boolean; updating?: boolean }>("/internal/update"),
  // The user's REAL Claude plan-usage (account-wide rate-limit headroom) — one daemon-side cached
  // poll of the OAuth usage endpoint. Always 200; `available:false`+reason when the daemon can't fetch it.
  usageLimits: () => get<UsageLimitsStatus>("/api/usage/limits"),
  // HISTORICAL run usage (GET /api/usage/history) — timespan + project-scoped token/cost totals
  // aggregated from the `runs` table (Loom's only persisted time-series usage; interactive sessions
  // keep none). `sinceIso` is the window cutoff (server-clamped to (now-1yr, now]); `projectId` omitted
  // or "all" = every project. The applied since + filter are echoed back. Human-only loopback, like
  // usageLimits — NOT an agent MCP tool. DISTINCT from the live per-session occupancy on the Usage page.
  usageHistory: (sinceIso: string, projectId?: string) => {
    const params = new URLSearchParams({ since: sinceIso });
    if (projectId && projectId !== "all") params.set("projectId", projectId);
    return get<UsageHistory>(`/api/usage/history?${params.toString()}`);
  },
  // INTERACTIVE-SESSION usage telemetry (GET /api/usage/sessions/history) — the OWNER'S OWN
  // interactive-session BILLED usage over time, sampled token-free from transcripts (epic c9924bcd).
  // Mirrors usageHistory's since/projectId handling exactly (drop projectId when "all"); the server
  // echoes the clamped since + applied filter and adds a per-DAY breakdown (byDay) for the over-time
  // chart. Human-only loopback — NOT an agent MCP tool. DISTINCT from the runs-backed usageHistory.
  sessionUsageHistory: (sinceIso: string, projectId?: string) => {
    const params = new URLSearchParams({ since: sinceIso });
    if (projectId && projectId !== "all") params.set("projectId", projectId);
    return get<SessionUsageHistory>(`/api/usage/sessions/history?${params.toString()}`);
  },
  // Drop the GLOBAL usage-awareness latch so new worker_spawn is unblocked without touching any
  // session — for a transient overload with real headroom (HUMAN-only; no agent MCP surface).
  clearUsageHold: () => post<{ cleared: boolean }>("/api/usage/clear-hold"),
  pauseOrchestration: (scope?: string) =>
    post<{ ok: boolean; pausedScopes: string[] }>("/api/orchestration/pause", scope ? { scope } : {}),
  resumeOrchestration: (scope?: string) =>
    post<{ ok: boolean; pausedScopes: string[] }>("/api/orchestration/resume", scope ? { scope } : {}),
  killOrchestration: () => post<{ stopped: number }>("/api/orchestration/kill"),

  // --- Plain shell terminals (HUMAN-only; spawned via REST, never an MCP tool) ---
  terminals: () => get<ShellTerminal[]>("/api/terminals"),
  defaultShell: () => get<{ command: string }>("/api/terminals/default-shell"),
  createTerminal: (b: { projectId: string; command?: string; args?: string[]; label?: string }) =>
    post<ShellTerminal>("/api/terminals", b),
  killTerminal: (id: string) => del<{ ok: boolean }>(`/api/terminals/${id}`),

  // --- Loom-managed skills (UI-editable; injected into every session as project-local) ---
  skills: () => get<SkillSummary[]>("/api/skills"),
  skill: (name: string) => get<{ name: string; content: string }>(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (name: string, content: string) => put<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`, { content }),
  createSkill: (name: string) => post<{ name: string }>("/api/skills", { name }),
  deleteSkill: (name: string) => del<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`),
  resetSkill: (name: string) => post<{ name: string; content: string }>(`/api/skills/${encodeURIComponent(name)}/reset`),
  publishSkill: (name: string) => post<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}/publish`),
  // --- Skill update adoption (3-way merge; only meaningful when a skill reports updateAvailable). ---
  // The raw base→shipped pair; the UI renders the computed line diff ("what shipped changed").
  skillUpdateDiff: (name: string) => get<SkillUpdateDiff>(`/api/skills/${encodeURIComponent(name)}/update-diff`),
  // Dry-run the 3-way merge: { clean } → one-click adopt; otherwise conflicts to resolve. 409 if no update.
  skillMergePreview: (name: string) => get<SkillMergePreview>(`/api/skills/${encodeURIComponent(name)}/merge-preview`),
  // Adopt the update: empty content one-clicks the clean auto-merge; resolved full content lands a
  // conflict resolution. Advances base=shipped. 409 (surfaced via postErr) if it isn't a clean auto-merge
  // and no content was supplied, or there's no update to adopt.
  adoptSkill: (name: string, content?: string) =>
    postErr<{ name: string; content: string }>(`/api/skills/${encodeURIComponent(name)}/adopt`, content !== undefined ? { content } : undefined),

  // --- Profiles (platform-level rig: role + allow/skills/model/icon + a UI-only description; the
  // injected prompt comes from the agent). HUMAN-managed only — there is no agent-writable MCP
  // surface, just this web client + REST. createProfile validates
  // → 201; updateProfile is a partial-merge (omitted fields are preserved server-side); resetProfile
  // restores a bundled profile to its shipped fields. The list/get/reset/adopt responses carry the
  // computed customization state (bundled + customized/updateAvailable for bundled-by-name rows). ---
  profiles: () => get<ProfileSummary[]>("/api/profiles"),
  profile: (id: string) => get<ProfileSummary>(`/api/profiles/${encodeURIComponent(id)}`),
  createProfile: (b: Omit<Profile, "id">) => post<Profile>("/api/profiles", b),
  updateProfile: (id: string, patch: Partial<Omit<Profile, "id">>) => put<Profile>(`/api/profiles/${encodeURIComponent(id)}`, patch),
  deleteProfile: (id: string) => del<{ ok: boolean }>(`/api/profiles/${encodeURIComponent(id)}`),
  resetProfile: (id: string) => post<ProfileSummary>(`/api/profiles/${encodeURIComponent(id)}/reset`),
  // --- Bundled-profile update adoption (field-level 3-way merge; only meaningful when a bundled-by-name
  // profile reports updateAvailable). The profiles analog of the skill adoption routes, but FIELD-level
  // (profiles are structured, not text). ---
  // "What shipped changed" since last sync: the base→shipped field changes (each carries mine/base/shipped).
  profileUpdateDiff: (id: string) => get<{ changed: ProfileFieldMerge[] }>(`/api/profiles/${encodeURIComponent(id)}/update-diff`),
  // Dry-run the field-level 3-way merge: { clean } → one-click adopt; otherwise conflicts to resolve. 409 if no update.
  profileMergePreview: (id: string) => get<ProfileMergeResult>(`/api/profiles/${encodeURIComponent(id)}/merge-preview`),
  // Adopt the update: empty/absent resolutions one-clicks a clean auto-merge; a resolutions map (per
  // conflict field → mine|shipped) lands a conflict resolution. Advances base=shipped, returns the updated
  // profile + computed state. 409 (surfaced via postErr) if conflicts are left unresolved or there's no update.
  adoptProfile: (id: string, resolutions?: Record<string, ProfileFieldResolution>) =>
    postErr<ProfileSummary>(`/api/profiles/${encodeURIComponent(id)}/adopt`, resolutions ? { resolutions } : undefined),

  // --- Shared Python venv provisioning (document conversion). HUMAN-only loopback REST — provisioning
  // launches a host process (venv create + pip install), same trust posture as the git/vault writers, so
  // there is NO agent MCP path. `pythonProvisioning` reads the live status (poll while `installing`);
  // `retryPythonProvisioning` re-kicks it off the daemon's event loop and returns the same status shape. ---
  pythonProvisioning: () => get<PythonProvisioning>("/api/python/provisioning"),
  retryPythonProvisioning: () => post<PythonProvisioning>("/api/python/provisioning/retry"),

  // --- Host-tool integrations (card 8dc5ebb9): live detect/validate for the Settings › Integrations
  // panel. HUMAN-only loopback REST, read-only — writing a path goes through updatePlatformConfig above
  // (the `integrations` key on PlatformConfigOverride), there is no separate write call. ---
  integrations: () => get<{ integrations: IntegrationStatus[] }>("/api/integrations"),

  // --- Schedules (phase-2 Pillar B): cron triggers that boot a manager in `agentId` on each due
  // boundary. HUMAN-managed (this page + REST) — there is no agent-writable MCP surface. createSchedule
  // → 201; updateSchedule patches cron/enabled/prompt only (agentId is immutable) and recomputes
  // nextFireAt server-side on a cron change. Both the create and the cron patch 400 on an invalid cron
  // expression. `prompt` (optional, editable in BOTH create and edit — unlike agentId) is a custom task
  // description appended to the agent's own startupPrompt when the schedule fires. ---
  schedules: () => get<Schedule[]>("/api/schedules"),
  // `kind` (Platform Manager P5 / B6) selects what a fire spawns — "manager" (default), "auditor" (the
  // dev read-and-file-only Platform Auditor), or "workspace-auditor" (the end-user Workspace Auditor).
  // The Platform page's Auditor card puts the Workspace Auditor on a cadence with it.
  // `name` is MANDATORY on create (Schedules UI redesign — the daemon 400s a missing/blank name). The
  // Platform page's Auditor cadences pass a fixed kind-derived name.
  createSchedule: (b: { name: string; agentId: string; cron: string; enabled?: boolean; kind?: Schedule["kind"]; prompt?: string | null }) => post<Schedule>("/api/schedules", b),
  updateSchedule: (id: string, patch: { name?: string; cron?: string; enabled?: boolean; kind?: Schedule["kind"]; prompt?: string | null }) => post<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, patch),
  deleteSchedule: (id: string) => del<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}`),
  // Preview a cron for the builder: the human summary + the REAL next-3 fires, computed server-side with
  // the SAME matcher the Scheduler fires on (so the preview can never drift from what actually runs).
  previewSchedule: (cron: string) => post<{ valid: boolean; summary: string; next: string[] }>("/api/schedules/preview", { cron }),

  // --- Event Triggers (Loom Event Triggers subsystem, card f5d07121): when an INTERNAL orchestration
  // event of kind `eventKind` fires (optionally scoped to `projectId` — null = every project), WAKE an
  // existing session (mode "wake" → targetSessionId) or SPAWN a fresh agent session (mode "spawn" →
  // agentId). The internal-event counterpart to Schedules' cron: the dispatcher is ALWAYS ON (zero rows =
  // a no-op tick), so a created trigger fires on its next matching event — no enable gate to surface.
  // HUMAN-managed (this page + REST) — there is NO agent-writable MCP surface. create → 201; update
  // patches any field (the effective mode↔target pairing is re-validated server-side). Both create and
  // update 400/404 with a readable `{ error }` (unknown kind, missing project/session/agent, or a
  // wake-without-session / spawn-without-agent mismatch) surfaced verbatim via *Err so the modal shows the
  // reason inline. Toggling `enabled` re-seeds the watermark server-side (no history replay on re-enable). ---
  eventTriggers: () => get<EventTrigger[]>("/api/event-triggers"),
  createEventTrigger: (b: { eventKind: EventTriggerEventKind; projectId: string | null; mode: EventTrigger["mode"]; targetSessionId?: string | null; agentId?: string | null; enabled?: boolean }) =>
    postErr<EventTrigger>("/api/event-triggers", b),
  updateEventTrigger: (id: string, patch: { eventKind?: EventTriggerEventKind; projectId?: string | null; mode?: EventTrigger["mode"]; targetSessionId?: string | null; agentId?: string | null; enabled?: boolean }) =>
    postErr<EventTrigger>(`/api/event-triggers/${encodeURIComponent(id)}`, patch),
  deleteEventTrigger: (id: string) => del<{ ok: boolean }>(`/api/event-triggers/${encodeURIComponent(id)}`),

  // --- Preset Prompts (the GLOBAL "terminal action-buttons" store — one shared list, same on every
  // terminal card). HUMAN/UI data managed inline in the terminal popover; there is intentionally NO MCP
  // path. POST appends (→201); PUT is a partial patch (→200/404); DELETE is idempotent (→200). create/
  // update surface the server's `{ error }` body verbatim (label/prompt bounds) via *Err for inline display. ---
  presetPrompts: () => get<PresetPrompt[]>("/api/preset-prompts"),
  createPresetPrompt: (b: { label: string; prompt: string }) => postErr<PresetPrompt>("/api/preset-prompts", b),
  updatePresetPrompt: (id: string, patch: { label?: string; prompt?: string; position?: number }) =>
    putErr<PresetPrompt>(`/api/preset-prompts/${id}`, patch),
  deletePresetPrompt: (id: string) => del<{ ok: boolean }>(`/api/preset-prompts/${id}`),

  // --- Preset-prompt SUGGESTIONS (the "Suggested from your usage" surface — pending candidates the
  // Platform Auditor proposed, mirroring presetPrompts). list returns the PENDING rows (the server
  // filters to status=pending), ordered by position. adopt mints a real PresetPrompt from the
  // suggestion's label+prompt (201) and drops it off pending; dismiss drops it (200). Both surface the
  // server's `{ error }` body via *Err — a 409 (already adopted/dismissed: stale list / double-click)
  // carries a reason the UI shows verbatim before it refetches. There is NO MCP path (human/UI data). ---
  presetPromptSuggestions: () => get<PresetPromptSuggestion[]>("/api/preset-prompt-suggestions"),
  adoptPresetPromptSuggestion: (id: string) => postErr<PresetPrompt>(`/api/preset-prompt-suggestions/${id}/adopt`),
  dismissPresetPromptSuggestion: (id: string) => postErr<{ ok: boolean }>(`/api/preset-prompt-suggestions/${id}/dismiss`),

  // --- Loom Companion management (Companion epic Phase 3). HUMAN-only loopback REST — there is
  // INTENTIONALLY NO agent MCP path for ANY of these (a chat-reachable, injection-exposed companion must
  // never read/write its own bot token or authorize senders for itself; same trust posture as the
  // git/vault/api_keys human-only writers). SECURITY: `companionConfigs`/reads return the MASKED shape
  // only — the bot token is ENCRYPTED at rest on the daemon and NEVER returned in clear (configured +
  // last-4 only). create/update surface the server's `{ error }` body verbatim (token/cadence/home
  // validation) via *Err for inline display; an omitted `botToken` on update keeps the stored token. ---
  companionConfigs: () => get<CompanionConfigMasked[]>("/api/companion/config"),
  // The simple, in-app-first create: a bare `{ name }` provisions a working IN-APP-ONLY companion (spawns
  // the assistant session + writes the in-app binding + arms it) with ZERO external config. Status-aware
  // (409 = single-companion guard) so the create flow can render a friendly precondition message.
  provisionCompanion: (b: { name?: string }) => provisionCompanionReq(b),
  createCompanionConfig: (b: Record<string, unknown>) => postErr<CompanionConfigMasked>("/api/companion/config", b),
  updateCompanionConfig: (sessionId: string, b: Record<string, unknown>) =>
    putErr<CompanionConfigMasked>(`/api/companion/config/${encodeURIComponent(sessionId)}`, b),
  deleteCompanionConfig: (sessionId: string) => del<{ ok: boolean }>(`/api/companion/config/${encodeURIComponent(sessionId)}`),
  // Access routes: the durable session↔chat bindings + the per-binding group sender allowlist. The
  // binding create 409s ({ error }) when the (channel, chatId) route is already bound to another session.
  companionBindings: () => get<CompanionBinding[]>("/api/companion/bindings"),
  createCompanionBinding: (b: { sessionId: string; channel: string; chatId: string; scope: "dm" | "group" }) =>
    postErr<CompanionBinding>("/api/companion/bindings", b),
  // Delete a session's binding(s). With `channel` set, removes ONLY that channel's binding and keeps the
  // others (multi-channel per-channel disconnect — the daemon contract: `?channel=<channel>`); omit it and
  // the daemon deletes ALL of the session's bindings (byte-identical to the pre-multi-channel behavior).
  deleteCompanionBinding: (sessionId: string, channel?: string) =>
    del<{ ok: boolean }>(
      `/api/companion/bindings/${encodeURIComponent(sessionId)}${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`,
    ),
  companionAllowedSenders: (sessionId: string) =>
    get<CompanionAllowedSender[]>(`/api/companion/allowed-senders?sessionId=${encodeURIComponent(sessionId)}`),
  addCompanionAllowedSender: (b: { sessionId: string; channel: string; senderId: string; label?: string | null }) =>
    postErr<CompanionAllowedSender>("/api/companion/allowed-senders", b),
  removeCompanionAllowedSender: (id: string) => del<{ ok: boolean }>(`/api/companion/allowed-senders/${encodeURIComponent(id)}`),
  // DM-pairing: mint a one-time enrollment code for a companion session + grant type. The plaintext code
  // is returned ONCE (the store keeps only a salted hash); the human relays it to the person enrolling.
  mintCompanionPairing: (b: { sessionId: string; grantType: "dm-bind" | "group-sender"; ttlMinutes?: number }) =>
    postErr<CompanionPairingCode>("/api/companion/pairing", b),
  // Proactive HOME — the PER-COMPANION outbound target where that companion's heartbeats post (an
  // app_meta value keyed by sessionId, never shared across companions — the multi-companion
  // cross-delivery fix). `setCompanionHome` surfaces the server's `{ error }` verbatim; clearing turns
  // THIS companion's proactive heartbeat OFF (no route ⇒ nothing to chat_reply) until a home is set again.
  companionHome: (sessionId: string) =>
    get<{ channel: string; chatId: string } | null>(`/api/companion/home?sessionId=${encodeURIComponent(sessionId)}`),
  setCompanionHome: (sessionId: string, b: { channel: string; chatId: string }) =>
    putErr<{ channel: string; chatId: string } | null>("/api/companion/home", { sessionId, ...b }),
  clearCompanionHome: (sessionId: string) =>
    del<{ ok: boolean }>(`/api/companion/home?sessionId=${encodeURIComponent(sessionId)}`),

  // --- Companion "brain": persona prompt + self-authored skills (Companion epic — the Manage tab's home
  // for everything companion). HUMAN-only loopback REST, resolved by sessionId, same trust posture as the
  // config/bindings writers above (NO agent MCP path). PROMPT: GET reads the editable startupPrompt + the
  // read-only baseBrief; PUT writes only startupPrompt (bounded 10k → 400 with a reason, surfaced via
  // putErr). SKILLS: read (list + single content) + curate (delete) over the companion's OWN isolated skill
  // store — authoring stays the companion's on-demand MCP job, this surface only reviews + prunes. delete
  // returns the updated list (404 with a reason on an unknown skill, surfaced via delErr). ---
  companionPrompt: (sessionId: string) =>
    getErr<CompanionPrompt>(`/api/companion/prompt/${encodeURIComponent(sessionId)}`),
  updateCompanionPrompt: (sessionId: string, startupPrompt: string) =>
    putErr<CompanionPrompt>(`/api/companion/prompt/${encodeURIComponent(sessionId)}`, { startupPrompt }),
  companionSkills: (sessionId: string) =>
    get<{ skills: CompanionSkillEntry[] }>(`/api/companion/skills/${encodeURIComponent(sessionId)}`).then((r) => r.skills),
  companionSkill: (sessionId: string, name: string) =>
    getErr<{ name: string; content: string }>(`/api/companion/skills/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`),
  deleteCompanionSkill: (sessionId: string, name: string) =>
    delErr<{ ok: boolean; skills: CompanionSkillEntry[] }>(`/api/companion/skills/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`),

  // MEMORY: the sibling read/curate surface over the companion's OWN isolated MEMORY.md store — same
  // posture as SKILLS above (authoring stays the companion's own on-demand job, this only reviews + prunes).
  companionMemories: (sessionId: string) =>
    get<{ memories: CompanionMemoryEntry[] }>(`/api/companion/memory/${encodeURIComponent(sessionId)}`).then((r) => r.memories),
  companionMemory: (sessionId: string, name: string) =>
    getErr<{ name: string; content: string }>(`/api/companion/memory/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`),
  deleteCompanionMemory: (sessionId: string, name: string) =>
    delErr<{ ok: boolean; memories: CompanionMemoryEntry[] }>(`/api/companion/memory/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`),

  // CONVERSATION HISTORY (card 85f62475): browse a companion's PAST conversations + drill into one's full
  // transcript. Same human-only loopback posture as the reads above (NO agent MCP path). `companionConversations`
  // returns summaries newest-first (seq DESC); `endedAt === null` marks the CURRENT (open, live) conversation,
  // a closed one carries an `endedAt`. `companionConversation` fetches one conversation's full unified message
  // list (every channel, chronological) — 404 (surfaced via getErr) on an unknown/invalid seq.
  // The durable in-app chat history seed for the cockpit chat panel (GET /api/companion/messages/:sessionId).
  // CompanionChat loads this BEFORE opening its WebSocket (load-then-connect, bug 0f01f234). Same human-only
  // loopback posture as the reads above (NO agent MCP path).
  companionMessages: (sessionId: string) =>
    get<{ messages?: CompanionHistoryRow[] }>(`/api/companion/messages/${encodeURIComponent(sessionId)}`),
  companionConversations: (sessionId: string) =>
    get<{ conversations: CompanionConversationSummary[] }>(`/api/companion/conversations/${encodeURIComponent(sessionId)}`).then((r) => r.conversations),
  companionConversation: (sessionId: string, seq: number) =>
    getErr<{ conversation: { seq: number; startedAt: string; endedAt: string | null }; messages: CompanionMessage[] }>(
      `/api/companion/conversations/${encodeURIComponent(sessionId)}/${seq}`,
    ),

  // REMINDERS: the sibling read/curate surface over the companion's OWN `companion_reminders` rows — same
  // VIEW + PRUNE posture as MEMORY/SKILLS (authoring is the companion's own MCP job; this only lists +
  // deletes). List unwraps { reminders }; DELETE returns the post-prune { ok, reminders } to refresh the cache.
  companionReminders: (sessionId: string) =>
    get<{ reminders: CompanionReminderEntry[] }>(`/api/companion/reminders/${encodeURIComponent(sessionId)}`).then((r) => r.reminders),
  deleteCompanionReminder: (sessionId: string, reminderId: string) =>
    delErr<{ ok: boolean; reminders: CompanionReminderEntry[] }>(`/api/companion/reminders/${encodeURIComponent(sessionId)}/${encodeURIComponent(reminderId)}`),

  // Session-ROW restrictedTools (live-apply fix): GET/PUT the flag the running companion's PTY actually
  // spawned with — distinct from the Profile default, and re-read on every resume. A write here needs a
  // restart (stop+resume) to take effect; the caller drives that explicitly (see RestrictToolsSection).
  companionRestrictedTools: (sessionId: string) =>
    getErr<CompanionRestrictedTools>(`/api/companion/restricted-tools/${encodeURIComponent(sessionId)}`),
  updateCompanionRestrictedTools: (sessionId: string, restrictedTools: boolean) =>
    putErr<CompanionRestrictedTools>(`/api/companion/restricted-tools/${encodeURIComponent(sessionId)}`, { restrictedTools }),

  // --- Companion CAPABILITY GRANTS (Companion Capability & Permission-Lever Framework — the fleet-monitoring
  // "levers": session-status, decisions-relay, board-reach, vault-read, attention-push, media-out,
  // session-steer). HUMAN-only loopback REST — INTENTIONALLY NO agent MCP path: an injection-exposed
  // companion must never widen its OWN capability (same trust posture as the config/bindings/restricted-tools
  // writers above). A lever is ON iff a grant row exists (default-OFF), scoped per project. `upsertCompanionGrant`
  // POSTs (create OR change mode/config — the server upserts on the (capability, projectId) key); an omitted
  // mode/config PRESERVES the stored value. `deleteCompanionGrant` removes one (capability, projectId) grant.
  // Both surface the server's `{ error }` body verbatim (per-lever config validation — e.g. an unknown
  // decisionClass) via *Err. A grant change takes effect on the companion's NEXT respawn (its MCP tool
  // surface is fixed at OS-process-start) — see `upgradeCompanionSession`. ---
  // Returns the grant rows PLUS `liveProcessStartedAt` (ISO, or null if the companion has no live process) —
  // the server truth the Capabilities panel compares each grant's createdAt against to derive an
  // apply-pending state that survives a page reload (a grant newer than the running process isn't yet on
  // its respawn-fixed tool surface).
  // `warnings` = server-computed grant-time co-grant advisories over the WHOLE grant set (owner decision
  // 4c33a1bc) — the Capabilities panel renders them as a persistent risk banner (a risky pair stays
  // flagged across reloads, since GET re-derives it every refetch). `[]` for a benign grant set.
  companionGrants: (sessionId: string) =>
    get<{ grants: CompanionCapabilityGrant[]; liveProcessStartedAt: string | null; warnings: CompanionCoGrantWarning[] }>(`/api/companion/${encodeURIComponent(sessionId)}/grants`),
  upsertCompanionGrant: (sessionId: string, b: { capability: string; projectId?: string | null; mode?: "read" | "act"; config?: Record<string, unknown> }) =>
    postErr<CompanionCapabilityGrant & { warnings: CompanionCoGrantWarning[] }>(`/api/companion/${encodeURIComponent(sessionId)}/grants`, b),
  deleteCompanionGrant: (sessionId: string, capability: string, projectId?: string | null) => {
    const params = new URLSearchParams({ capability });
    if (projectId) params.set("projectId", projectId); // omitted ⇒ the null-scope grant (companion's own project)
    return delErr<{ ok: boolean; grants: CompanionCapabilityGrant[] }>(
      `/api/companion/${encodeURIComponent(sessionId)}/grants?${params.toString()}`,
    );
  },
  // The conversation-preserving RESPAWN that APPLIES a grant change: stops the old companion process and
  // resumes a fresh one under the re-resolved capability surface, keeping the SAME conversation thread. A
  // grant write does NOT auto-respawn (a respawn has a brief availability gap, so the owner picks WHEN); the
  // Capabilities panel drives this explicitly after a change. Human-only loopback — NO agent MCP path (an
  // injection-exposed companion must never trigger its own respawn). 409 (surfaced via postErr) if a
  // concurrent lifecycle op is in flight.
  upgradeCompanionSession: (sessionId: string) =>
    postErr<{ sessionId: string; session: Session }>(`/api/companion/${encodeURIComponent(sessionId)}/upgrade`),

  // --- Owner-controlled encrypted credential store (agent-tooling epic, P1 foundation). HUMAN-only
  // loopback REST — INTENTIONALLY NO agent MCP path (same trust posture as the companion/vault/git
  // human-only writers). Reads are ALWAYS metadata only (name/host/authScheme/createdAt); the secret is
  // write-only (accepted on create, never returned by any read). ---
  connections: () => get<ConnectionMetadata[]>("/api/connections"),
  // Pending profile→connection grants awaiting the owner's deliberate approval (credential
  // auto-provisioning v1 binding UX, card 12dc7fc9). READ-ONLY — the grant is committed by an explicit
  // Save on the Profile's connection allowlist (updateProfile), never by a write here.
  pendingBindings: () => get<PendingBinding[]>("/api/pending-bindings"),
  // `projectId` (card f2abce7e) scopes the connection to that ONE project — usable only by its own
  // sessions; omitted/null creates a GLOBAL connection, reachable by any profile that allowlists it.
  createConnection: (b: { name: string; host: string; authScheme: ConnectionAuthScheme; secret: string; projectId?: string | null }) =>
    postErr<ConnectionMetadata>("/api/connections", b),
  deleteConnection: (id: string) => delErr<{ ok: boolean }>(`/api/connections/${encodeURIComponent(id)}`),
  // agent-tooling P5a: register a new oauth2 connection (provider app registration — no token exchange
  // yet, `connected:false` until a consent round-trip completes) + initiate consent for an EXISTING one
  // (returns the provider's auth URL for the caller to open in a new tab; the daemon's own fixed loopback
  // `GET /oauth/callback` completes the exchange once the provider redirects back). Both human-only REST.
  createOAuthConnection: (b: {
    name: string; host: string; provider: OAuthProviderSlug; clientId: string; clientSecret: string;
    authUrl?: string; tokenUrl?: string; scopes?: string[]; projectId?: string | null;
  }) => postErr<ConnectionMetadata>("/api/connections/oauth", b),
  initiateOAuthConsent: (id: string) =>
    postErr<{ authUrl: string }>(`/api/connections/${encodeURIComponent(id)}/oauth/consent`),

  // --- Poll jobs (agent-tooling epic P3): scheduled local poll triggers. On each due tick the daemon
  // fetches through a connection (server-side authenticated_request path — the secret is injected/redacted
  // there, never carried by the row) and, on a NEW item vs the previous poll's id snapshot, wakes an
  // existing session (mode "wake") or spawns a fresh one (mode "spawn"). HUMAN-only loopback REST —
  // INTENTIONALLY NO agent MCP path (same trust posture as connections/schedules). create/update surface
  // the server's `{ error }` body verbatim (path/interval-floor/target-exists validation) via postErr;
  // `connectionId` is immutable after create (the update handler doesn't accept it — mirrors a schedule's
  // fixed agentId). ---
  pollJobs: () => get<PollJob[]>("/api/poll-jobs"),
  createPollJob: (b: {
    connectionId: string; path: string; method?: string; intervalMs: number;
    itemsPath?: string; idPath?: string; mode: PollJob["mode"]; sessionId?: string; agentId?: string; enabled?: boolean;
  }) => postErr<PollJob>("/api/poll-jobs", b),
  updatePollJob: (id: string, patch: {
    path?: string; method?: string; intervalMs?: number; itemsPath?: string; idPath?: string;
    mode?: PollJob["mode"]; sessionId?: string; agentId?: string; enabled?: boolean;
  }) => postErr<PollJob>(`/api/poll-jobs/${encodeURIComponent(id)}`, patch),
  deletePollJob: (id: string) => del<{ ok: boolean }>(`/api/poll-jobs/${encodeURIComponent(id)}`),

  // --- Capability registry catalog (agent-tooling epic P4): the two BUILTIN capabilities PLUS any
  // owner-added rows, as ONE unified list — the Profile editor's capability picker + a future Settings
  // catalog panel both read this. HUMAN-only loopback REST — NO agent MCP path. ---
  capabilities: () => get<CapabilitySummary[]>("/api/capabilities"),
  createCapability: (b: {
    slug: string; name: string; description: string; transport: "stdio" | "http"; kind: CapabilityProvisionKind;
    provision: unknown; toolAllowlist: string[]; wantsScratchDir?: boolean; requiresConnection?: boolean; secretEnvVar?: string;
  }) => postErr<CapabilitySummary>("/api/capabilities", b),
  deleteCapability: (id: string) => delErr<{ ok: boolean }>(`/api/capabilities/${encodeURIComponent(id)}`),

  // --- Owner-declared project links (board card 2349d90c): a symmetric link between two projects — the
  // sole gate for the manager↔manager `peer_message` cross-project channel. HUMAN-only loopback REST —
  // INTENTIONALLY NO agent MCP path (same trust posture as connections/capabilities above). ---
  projectLinks: () => get<ProjectLink[]>("/api/project-links"),
  createProjectLink: (b: { projectA: string; projectB: string }) => postErr<ProjectLink>("/api/project-links", b),
  deleteProjectLink: (id: string) => delErr<{ ok: boolean }>(`/api/project-links/${encodeURIComponent(id)}`),
};

// Stop + (once fully exited) resume a companion's own session — the only way a spawn-time property like
// restrictedTools actually takes effect on an already-running companion (see RestrictToolsSection in
// pages/Companion.tsx, the sole caller today). `resume()` server-side is a no-op SHORT-CIRCUIT while the
// pty is still alive (sessions/service.ts), so calling it immediately after stop would silently do nothing
// — this polls the session's processState until it truly exited (graceful stop escalates to a hard kill
// within a bounded window server-side, so this always converges) before resuming. If the deadline is hit
// while the session is STILL live/starting, this THROWS rather than calling resume() anyway — a resume()
// against a still-alive pty is ALSO a no-op, so calling it here would silently fail to apply the new
// setting while reporting success.
export async function restartCompanionSession(sessionId: string): Promise<void> {
  await api.stopSession(sessionId, "graceful");
  const deadline = Date.now() + 15_000;
  let exited = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const sessions = await api.allSessions();
    const s = sessions.find((x) => x.id === sessionId);
    if (!s || (s.processState !== "live" && s.processState !== "starting")) { exited = true; break; }
  }
  if (!exited) throw new Error("Companion didn't stop in time — try again.");
  await api.resumeSession(sessionId);
}
