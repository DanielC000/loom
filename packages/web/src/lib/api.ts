import type { Project, Topic, Session, Task, SessionListItem, VaultEntry, KanbanColumn, OrchestrationEvent, Wake, SkillSummary } from "@loom/shared";

export interface TranscriptTurn { role: "user" | "assistant"; text: string; }
export interface BranchDiff { filesChanged: number; insertions: number; deletions: number; patch: string; }

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
  topics: (projectId: string) => get<Topic[]>(`/api/projects/${projectId}/topics`),
  createTopic: (projectId: string, b: { name: string; startupPrompt?: string }) =>
    post<Topic>(`/api/projects/${projectId}/topics`, b),
  updateTopic: (id: string, patch: { name?: string; startupPrompt?: string }) =>
    post<Topic>(`/api/topics/${id}`, patch),
  tasks: (projectId: string) => get<Task[]>(`/api/projects/${projectId}/tasks`),
  createTask: (projectId: string, b: { title: string; body?: string; columnKey?: string }) =>
    post<Task>(`/api/projects/${projectId}/tasks`, b),
  sessions: (topicId: string) => get<Session[]>(`/api/topics/${topicId}/sessions`),
  startSession: (topicId: string, role?: "manager") =>
    post<Session>(`/api/topics/${topicId}/sessions`, role ? { role } : undefined),
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

  // --- Loom-managed skills (UI-editable; injected into every session as project-local) ---
  skills: () => get<SkillSummary[]>("/api/skills"),
  skill: (name: string) => get<{ name: string; content: string }>(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (name: string, content: string) => put<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`, { content }),
  createSkill: (name: string) => post<{ name: string }>("/api/skills", { name }),
  deleteSkill: (name: string) => del<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`),
};
