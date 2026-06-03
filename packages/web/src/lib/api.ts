import type { Project, Agent, Session, Task, SessionListItem, VaultEntry, KanbanColumn, OrchestrationEvent, Wake, SkillSummary, Profile, Schedule, ShellTerminal } from "@loom/shared";

export interface TranscriptTurn { role: "user" | "assistant"; text: string; }
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

export const api = {
  projects: () => get<Project[]>("/api/projects"),
  createProject: (b: { name: string; repoPath: string; vaultPath: string }) =>
    post<Project>("/api/projects", b),
  archiveProject: (id: string) => del<{ ok: boolean }>(`/api/projects/${id}`),
  agents: (projectId: string) => get<Agent[]>(`/api/projects/${projectId}/agents`),
  createAgent: (projectId: string, b: { name: string; startupPrompt?: string }) =>
    post<Agent>(`/api/projects/${projectId}/agents`, b),
  updateAgent: (id: string, patch: { name?: string; startupPrompt?: string; profileId?: string | null }) =>
    post<Agent>(`/api/agents/${id}`, patch),
  tasks: (projectId: string) => get<Task[]>(`/api/projects/${projectId}/tasks`),
  createTask: (projectId: string, b: { title: string; body?: string; columnKey?: string }) =>
    post<Task>(`/api/projects/${projectId}/tasks`, b),
  sessions: (agentId: string) => get<Session[]>(`/api/agents/${agentId}/sessions`),
  // role omitted/undefined = auto (the agent's profile role applies, server-side); "manager"/"platform"
  // = explicit role; "plain" = force-plain (ignore the profile's role → a role-null session).
  startSession: (agentId: string, role?: "manager" | "platform" | "plain") =>
    post<Session>(`/api/agents/${agentId}/sessions`, role ? { role } : undefined),
  resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
  forkSession: (id: string) => post<Session>(`/api/sessions/${id}/fork`),
  sendInput: (id: string, text: string) =>
    post<{ delivered: boolean; position?: number }>(`/api/sessions/${id}/input`, { text }),
  stopSession: (id: string, mode: "graceful" | "hard") =>
    post<{ ok: boolean }>(`/api/sessions/${id}/stop`, { mode }),
  allSessions: () => get<SessionListItem[]>("/api/sessions"),
  vaultTree: (projectId: string) => get<VaultEntry[]>(`/api/projects/${projectId}/vault`),
  vaultFile: (projectId: string, path: string) =>
    get<{ path: string; content: string }>(`/api/projects/${projectId}/vault/file?path=${encodeURIComponent(path)}`),
  gitLog: (projectId: string) =>
    get<{ hash: string; date: string; message: string; author: string }[]>(`/api/projects/${projectId}/git/log`),
  gitBranches: (projectId: string) =>
    get<{ current: string; all: string[] }>(`/api/projects/${projectId}/git/branches`),
  board: (projectId: string) =>
    get<{ columns: KanbanColumn[]; tasks: Task[] }>(`/api/projects/${projectId}/board`),
  updateTask: (id: string, patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position">>) =>
    post<{ ok: boolean }>(`/api/tasks/${id}`, patch),
  transcript: (sessionId: string) => get<TranscriptTurn[]>(`/api/sessions/${sessionId}/transcript`),
  // Pending one-shot wake-ups scheduled for a session (the wake_me primitive).
  sessionWakes: (sessionId: string) => get<Wake[]>(`/api/sessions/${sessionId}/wakes`),
  cancelWake: (sessionId: string, wakeId: string) =>
    del<{ cancelled: boolean }>(`/api/sessions/${sessionId}/wakes/${wakeId}`),
  // Queued inbound messages held for a session (worker reports / turns waiting for it to free up).
  sessionQueue: (sessionId: string) => get<{ pending: string[] }>(`/api/sessions/${sessionId}/queue`),

  // --- phase-2 orchestration (#18b view) ---
  orchestrationEvents: (managerId: string) =>
    get<OrchestrationEvent[]>(`/api/orchestration/events?managerId=${encodeURIComponent(managerId)}`),
  workerDiff: (sessionId: string) => get<BranchDiff>(`/api/sessions/${sessionId}/diff`),
  // Human-initiated merge of a worker's branch — runs the daemon's fail-closed build gate then
  // merges (manager derived from the worker's parentSessionId server-side).
  mergeWorker: (sessionId: string) => post<{ merged: boolean; reason?: string }>(`/api/sessions/${sessionId}/merge`),
  orchestrationStatus: () => get<{ pausedScopes: string[] }>("/api/orchestration/status"),
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
  createSchedule: (b: { agentId: string; cron: string; enabled?: boolean }) => post<Schedule>("/api/schedules", b),
  updateSchedule: (id: string, patch: { cron?: string; enabled?: boolean }) => post<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, patch),
  deleteSchedule: (id: string) => del<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}`),
};
