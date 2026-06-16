import type { Project, Agent, AgentId, SessionRole, Session, Task, SessionListItem, ArchivedSessionListItem, VaultEntry, KanbanColumn, OrchestrationEvent, Wake, SkillSummary, Profile, Schedule, ShellTerminal, ProjectConfigOverride, PlatformConfig, PlatformConfigOverride, UsageLimitsStatus, AgentRun, RunEvent, ApiKey, ApiKeyCaps, ApiKeyStatus, PresetPrompt, PresetPromptSuggestion } from "@loom/shared";

export interface TranscriptTurn { role: "user" | "assistant"; text: string; }
// One queued (not-yet-delivered) message. `id` is server-minted and stable, so the UI can
// delete/edit/reorder a specific entry even as the FIFO head drains between polls. `source` is who
// enqueued it: 'human' (the composer — adjustable) vs 'system' (worker reports / nudges — read-only).
export interface QueuedMessage { id: string; text: string; source: "human" | "system"; }
export interface BranchDiff { filesChanged: number; insertions: number; deletions: number; patch: string; uncommitted?: boolean; merged?: boolean; }

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
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
  createProject: (b: { name: string; repoPath: string; vaultPath: string }) =>
    post<Project>("/api/projects", b),
  // --- HUMAN-only project/agent management (rename / archive / restore / PERMANENT delete + agent
  // delete). DESTRUCTIVE, loopback-only — there is NO agent MCP path to any of these (same posture as
  // session archive/delete + gateCommand). All surface the server's `{ error }` body verbatim (via
  // *Err) so the reserved-home + live-session ("stop the fleet first") guards show inline. ---
  // STRUCTURAL edit (name / vaultPath) — distinct from updateProjectConfig (the validated machine config).
  updateProject: (id: string, body: { name?: string; vaultPath?: string }) =>
    patch<Project>(`/api/projects/${id}`, body),
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
  getPlatformConfig: () =>
    get<{ override: PlatformConfigOverride; resolved: PlatformConfig }>("/api/platform/config"),
  updatePlatformConfig: (config: PlatformConfigOverride) =>
    patch<{ ok: boolean; override: PlatformConfigOverride }>("/api/platform/config", { config }),
  agents: (projectId: string) => get<Agent[]>(`/api/projects/${projectId}/agents`),
  createAgent: (projectId: string, b: { name: string; startupPrompt?: string }) =>
    post<Agent>(`/api/projects/${projectId}/agents`, b),
  // `endpoint` flags an agent as API-exposable (Agent Runs R1) — only an endpoint=true agent may be put
  // on a key's allowlist. HUMAN-only trust-boundary surface (no agent MCP path); reuses this same route.
  updateAgent: (id: string, patch: { name?: string; startupPrompt?: string; profileId?: string | null; endpoint?: boolean }) =>
    post<Agent>(`/api/agents/${id}`, patch),
  tasks: (projectId: string) => get<Task[]>(`/api/projects/${projectId}/tasks`),
  createTask: (projectId: string, b: { title: string; body?: string; columnKey?: string; priority?: Task["priority"] }) =>
    post<Task>(`/api/projects/${projectId}/tasks`, b),
  sessions: (agentId: string) => get<Session[]>(`/api/agents/${agentId}/sessions`),
  // role omitted/undefined = auto (the agent's profile role applies, server-side); "manager"/"platform"
  // = explicit role; "auditor" = the read-and-file-only Platform Auditor (P5; locked role server-side);
  // "setup" = the ungated, user-facing Setup Assistant (singleton, reused server-side — startSetup);
  // "plain" = force-plain (ignore the profile's role → a role-null session).
  startSession: (agentId: string, role?: "manager" | "platform" | "auditor" | "setup" | "plain") =>
    post<Session>(`/api/agents/${agentId}/sessions`, role ? { role } : undefined),
  resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
  forkSession: (id: string) => post<Session>(`/api/sessions/${id}/fork`),
  sendInput: (id: string, text: string) =>
    post<{ delivered: boolean; position?: number }>(`/api/sessions/${id}/input`, { text }),
  stopSession: (id: string, mode: "graceful" | "hard") =>
    post<{ ok: boolean }>(`/api/sessions/${id}/stop`, { mode }),
  // Manual per-session rate-limit override + retry-now (HUMAN-only; mirrors stop — no agent MCP
  // surface). Clears the park + episode deadline, drops the global usage latch, and re-submits the
  // held turn if the session is live; returns the updated session (rateLimitedUntil now null).
  clearSessionRateLimit: (id: string) => post<Session>(`/api/sessions/${id}/rate-limit/clear`),
  allSessions: () => get<SessionListItem[]>("/api/sessions"),

  // --- Per-project session Archive (HUMAN-only; mirrors stop/fork — no agent MCP surface). archive
  // cascades a manager to its workers and 400s (with reason) if any group member is still live;
  // restore brings one back to the rail (view-only if dead); deleteArchived is permanent (row(s) +
  // snapshot). archivedSessions feeds the Archive tab (each row tagged snapshotExists). ---
  archivedSessions: (projectId: string) => get<ArchivedSessionListItem[]>(`/api/projects/${projectId}/archive`),
  // Cross-project (god-eye) archive: archived sessions across ALL projects, each enriched with
  // projectId/projectName + snapshotExists — feeds the grouped Project → Agent Archive page.
  allArchivedSessions: () => get<ArchivedSessionListItem[]>("/api/archived-sessions"),
  archiveSession: (id: string) => postErr<{ archived: string[] }>(`/api/sessions/${id}/archive`),
  restoreSession: (id: string) => postErr<{ restored: string }>(`/api/sessions/${id}/restore`),
  deleteArchivedSession: (id: string) => delErr<{ deleted: string[] }>(`/api/sessions/${id}/archive`),
  vaultTree: (projectId: string) => get<VaultEntry[]>(`/api/projects/${projectId}/vault`),
  vaultFile: (projectId: string, path: string) =>
    get<{ path: string; content: string }>(`/api/projects/${projectId}/vault/file?path=${encodeURIComponent(path)}`),
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
    get<{ columns: KanbanColumn[]; tasks: Task[] }>(`/api/projects/${projectId}/board`),
  updateTask: (id: string, patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority">>) =>
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
  orchestrationStatus: () => get<{ pausedScopes: string[] }>("/api/orchestration/status"),
  // Releases v1 Part 3 — the daemon's `loom` package version, surfaced unobtrusively in the header.
  version: () => get<{ version: string }>("/api/version"),
  // The user's REAL Claude plan-usage (account-wide rate-limit headroom) — one daemon-side cached
  // poll of the OAuth usage endpoint. Always 200; `available:false`+reason when the daemon can't fetch it.
  usageLimits: () => get<UsageLimitsStatus>("/api/usage/limits"),
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

  // --- Profiles (platform-level rig: role + allow/skills/model/icon + a UI-only description; the
  // injected prompt comes from the agent). HUMAN-managed only — there is no agent-writable MCP
  // surface, just this web client + REST. createProfile validates
  // → 201; updateProfile is a partial-merge (omitted fields are preserved server-side); resetProfile
  // restores a bundled profile to its shipped fields. ---
  profiles: () => get<Profile[]>("/api/profiles"),
  profile: (id: string) => get<Profile>(`/api/profiles/${encodeURIComponent(id)}`),
  createProfile: (b: Omit<Profile, "id">) => post<Profile>("/api/profiles", b),
  updateProfile: (id: string, patch: Partial<Omit<Profile, "id">>) => put<Profile>(`/api/profiles/${encodeURIComponent(id)}`, patch),
  deleteProfile: (id: string) => del<{ ok: boolean }>(`/api/profiles/${encodeURIComponent(id)}`),
  resetProfile: (id: string) => post<Profile>(`/api/profiles/${encodeURIComponent(id)}/reset`),

  // --- Schedules (phase-2 Pillar B): cron triggers that boot a manager in `agentId` on each due
  // boundary. HUMAN-managed (this page + REST) — there is no agent-writable MCP surface. createSchedule
  // → 201; updateSchedule patches cron/enabled only (agentId is immutable) and recomputes nextFireAt
  // server-side on a cron change. Both the create and the cron patch 400 on an invalid cron expression. ---
  schedules: () => get<Schedule[]>("/api/schedules"),
  // `kind` (Platform Manager P5) selects what a fire spawns — "manager" (default) or "auditor" (the
  // read-and-file-only Platform Auditor). The Platform section puts the Auditor on a cadence with it.
  createSchedule: (b: { agentId: string; cron: string; enabled?: boolean; kind?: Schedule["kind"] }) => post<Schedule>("/api/schedules", b),
  updateSchedule: (id: string, patch: { cron?: string; enabled?: boolean }) => post<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, patch),
  deleteSchedule: (id: string) => del<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}`),

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
};
