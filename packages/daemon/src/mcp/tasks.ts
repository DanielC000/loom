import { randomUUID } from "node:crypto";
import type { Task } from "@loom/shared";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";

// Task-tool business logic. EVERY function takes the projectId resolved SERVER-SIDE from the
// session id — the agent never passes a projectId, so cross-project access is impossible.

/** The lightweight task row tasks_list returns by default — no body (the unbounded field). */
export type TaskSummary = Pick<Task, "id" | "title" | "columnKey" | "position" | "updatedAt">;

/** Filters + projection for {@link listProjectTasks}. (Priority filter lands here in a follow-on.) */
export interface ListTasksOptions {
  /** Return only tasks in these column keys; omit/empty = all columns. */
  columns?: string[];
  /** Drop terminal ("done") cards — the resolved board's LAST column. Default true. */
  excludeDone?: boolean;
  /** Return full Task rows (with body) instead of lightweight summaries. Default false. */
  includeBody?: boolean;
}

const toSummary = (t: Task): TaskSummary => ({
  id: t.id, title: t.title, columnKey: t.columnKey, position: t.position, updatedAt: t.updatedAt,
});

/**
 * List a project's board tasks, filtered + projected. DEFAULTS to a lightweight SUMMARY (no body)
 * with terminal ("done") cards excluded — a bounded board read that doesn't grow without limit as
 * cards pile up in Done. The terminal column is DERIVED from the resolved config (last kanban
 * column), never hardcoded. Pass includeBody:true for full bodies (or use {@link getProjectTask}).
 */
export function listProjectTasks(
  db: Db, projectId: string, opts: ListTasksOptions = {},
): Task[] | TaskSummary[] {
  const { columns, excludeDone = true, includeBody = false } = opts;
  let tasks = db.listTasks(projectId);
  if (excludeDone) {
    const cols = resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
    const terminalKey = cols.at(-1)?.key;
    if (terminalKey) tasks = tasks.filter((t) => t.columnKey !== terminalKey);
  }
  if (columns && columns.length) {
    const want = new Set(columns);
    tasks = tasks.filter((t) => want.has(t.columnKey));
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
  input: { title: string; body?: string; columnKey?: string },
): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    projectId,
    title: input.title,
    body: input.body ?? "",
    columnKey: input.columnKey ?? "backlog",
    position: Date.now(),
    createdAt: now,
    updatedAt: now,
  };
  db.insertTask(task);
  return task;
}

export function updateProjectTask(
  db: Db, projectId: string, taskId: string,
  patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position">>,
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
  { name: "tasks_create", description: "Create a task on the current project's board (title, body?, columnKey?)." },
  { name: "tasks_update", description: "Update a task (title?, body?, columnKey?, position?) by id, within the current project." },
] as const;
