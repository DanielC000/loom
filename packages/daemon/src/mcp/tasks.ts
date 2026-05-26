import { randomUUID } from "node:crypto";
import type { Task } from "@loom/shared";
import type { Db } from "../db.js";

// Task-tool business logic. EVERY function takes the projectId resolved SERVER-SIDE from the
// session id — the agent never passes a projectId, so cross-project access is impossible.

export function listProjectTasks(db: Db, projectId: string): Task[] {
  return db.listTasks(projectId);
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
  { name: "tasks_list", description: "List all tasks on the current project's board." },
  { name: "tasks_create", description: "Create a task on the current project's board (title, body?, columnKey?)." },
  { name: "tasks_update", description: "Update a task (title?, body?, columnKey?, position?) by id, within the current project." },
] as const;
