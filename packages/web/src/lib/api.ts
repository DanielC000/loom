import type { Project, Topic, Session, Task } from "@loom/shared";

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  projects: () => get<Project[]>("/api/projects"),
  createProject: (b: { name: string; repoPath: string; vaultPath: string }) =>
    post<Project>("/api/projects", b),
  topics: (projectId: string) => get<Topic[]>(`/api/projects/${projectId}/topics`),
  createTopic: (projectId: string, b: { name: string; startupPrompt?: string }) =>
    post<Topic>(`/api/projects/${projectId}/topics`, b),
  tasks: (projectId: string) => get<Task[]>(`/api/projects/${projectId}/tasks`),
  createTask: (projectId: string, b: { title: string; body?: string; columnKey?: string }) =>
    post<Task>(`/api/projects/${projectId}/tasks`, b),
  sessions: (topicId: string) => get<Session[]>(`/api/topics/${topicId}/sessions`),
  startSession: (topicId: string) => post<Session>(`/api/topics/${topicId}/sessions`),
  resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
  stopSession: (id: string, mode: "graceful" | "hard") =>
    post<{ ok: boolean }>(`/api/sessions/${id}/stop`, { mode }),
};
