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
  topics: (projectId: string) => get<Topic[]>(`/api/projects/${projectId}/topics`),
  tasks: (projectId: string) => get<Task[]>(`/api/projects/${projectId}/tasks`),
  sessions: (topicId: string) => get<Session[]>(`/api/topics/${topicId}/sessions`),
  startSession: (topicId: string) => post<Session>(`/api/topics/${topicId}/sessions`),
  resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
  stopSession: (id: string, mode: "graceful" | "hard") =>
    post<{ ok: boolean }>(`/api/sessions/${id}/stop`, { mode }),
};
