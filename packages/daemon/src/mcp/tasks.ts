import { randomUUID } from "node:crypto";
import type { Task, TaskPriority } from "@loom/shared";
import { DEFAULT_TASK_PRIORITY, resolveConfig, columnKeyForRole } from "@loom/shared";
import type { Db } from "../db.js";

// Task-tool business logic. EVERY function takes the projectId resolved SERVER-SIDE from the
// session id — the agent never passes a projectId, so cross-project access is impossible.

/** The lightweight task row tasks_list returns by default — no body (the unbounded field). */
export type TaskSummary = Pick<Task, "id" | "title" | "columnKey" | "position" | "priority" | "updatedAt">;

/** Filters + projection for {@link listProjectTasks}. */
export interface ListTasksOptions {
  /** Return only tasks in these column keys; omit/empty = all columns. */
  columns?: string[];
  /** Drop terminal cards — the column with the `terminal` role (last-column fallback). Default true. */
  excludeDone?: boolean;
  /** Return full Task rows (with body) instead of lightweight summaries. Default false. */
  includeBody?: boolean;
  /**
   * Return only tasks at or above this priority level (lower number = higher priority): e.g.
   * minPriority:'p1' keeps p0 + p1 and drops p2 + p3. Omit = all priorities.
   */
  minPriority?: TaskPriority;
}

const toSummary = (t: Task): TaskSummary => ({
  id: t.id, title: t.title, columnKey: t.columnKey, position: t.position, priority: t.priority, updatedAt: t.updatedAt,
});

/**
 * List a project's board tasks, filtered + projected. DEFAULTS to a lightweight SUMMARY (no body)
 * with terminal cards excluded — a bounded board read that doesn't grow without limit as cards pile
 * up in the terminal lane. The terminal column is DERIVED from the resolved config by its `terminal`
 * ROLE (with last-column fallback for legacy boards), never hardcoded. Pass includeBody:true for full
 * bodies (or use {@link getProjectTask}).
 */
export function listProjectTasks(
  db: Db, projectId: string, opts: ListTasksOptions = {},
): Task[] | TaskSummary[] {
  const { columns, excludeDone = true, includeBody = false, minPriority } = opts;
  let tasks = db.listTasks(projectId);
  if (excludeDone) {
    const cols = resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
    const terminalKey = columnKeyForRole(cols, "terminal");
    if (terminalKey) tasks = tasks.filter((t) => t.columnKey !== terminalKey);
  }
  if (columns && columns.length) {
    const want = new Set(columns);
    tasks = tasks.filter((t) => want.has(t.columnKey));
  }
  if (minPriority) {
    // Lower priority string sorts lower (p0 < p1 < …), and lower = higher priority, so "at or above
    // minPriority" is a simple string <= comparison.
    tasks = tasks.filter((t) => t.priority <= minPriority);
  }
  return includeBody ? tasks : tasks.map(toSummary);
}

/**
 * Read ONE full task (title + body) by id, project-scoped: a cross-project id resolves to
 * not-found (same server-side guard posture as updateProjectTask).
 */
export function getProjectTask(db: Db, projectId: string, taskId: string): Task | { error: string } {
  const t = db.getTask(taskId);
  if (!t || t.projectId !== projectId) return { error: "task not found in this project" };
  return t;
}

export function createProjectTask(
  db: Db, projectId: string,
  input: { title: string; body?: string; columnKey?: string; priority?: TaskPriority },
): Task {
  const now = new Date().toISOString();
  // New cards land in the project's `defaultLanding` column (role-resolved, not the hardcoded key) so a
  // renamed/reordered landing lane still receives them; "backlog" is a defensive backstop only.
  const landing = columnKeyForRole(resolveConfig(db.getProject(projectId)?.config).kanbanColumns, "defaultLanding") ?? "backlog";
  const task: Task = {
    id: randomUUID(),
    projectId,
    title: input.title,
    body: input.body ?? "",
    columnKey: input.columnKey ?? landing,
    position: Date.now(),
    priority: input.priority ?? DEFAULT_TASK_PRIORITY,
    createdAt: now,
    updatedAt: now,
  };
  db.insertTask(task);
  return task;
}

export function updateProjectTask(
  db: Db, projectId: string, taskId: string,
  patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority">>,
): Task | { error: string } {
  // Guard: the task must belong to this project (defense even though id is opaque).
  const owned = db.listTasks(projectId).find((t) => t.id === taskId);
  if (!owned) return { error: "task not found in this project" };
  db.updateTask(taskId, patch);
  return { ...owned, ...patch, updatedAt: new Date().toISOString() };
}

/** Tool descriptors (name/description/input shape) for wiring to the MCP SDK. */
export const TASK_TOOL_DESCRIPTORS = [
  { name: "tasks_list", description: "List the current project's board tasks. Defaults to a lightweight summary (no body) with done cards excluded; pass includeBody:true or use tasks_get(id) for bodies." },
  { name: "tasks_get", description: "Read ONE full task (title + body) by id, within the current project." },
  { name: "tasks_create", description: "Create a task on the current project's board (title, body?, columnKey?, priority?). priority is p0|p1|p2|p3 (low number = higher priority), default p2." },
  { name: "tasks_update", description: "Update a task (title?, body?, columnKey?, position?, priority?) by id, within the current project. priority is p0|p1|p2|p3." },
] as const;
