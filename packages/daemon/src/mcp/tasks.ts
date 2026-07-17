import { randomUUID } from "node:crypto";
import type { Task, TaskPriority, Question, QuestionType, QuestionState, BoardTask } from "@loom/shared";
import { DEFAULT_TASK_PRIORITY, resolveConfig, columnKeyForRole } from "@loom/shared";
import type { Db } from "../db.js";
import { resolveIdPrefix } from "../id-prefix.js";
import { taskRequestGetItem } from "./questionTool.js";

// Task-tool business logic. EVERY function takes the projectId resolved SERVER-SIDE from the
// session id — the agent never passes a projectId, so cross-project access is impossible.

/** The lightweight task row tasks_list returns by default — no body (the unbounded field). */
export type TaskSummary = Pick<Task, "id" | "title" | "columnKey" | "position" | "priority" | "updatedAt">;

/**
 * Backstop cap on a DEFAULT board read so a big board can't overflow the tool-result token cap with no
 * explicit limit — the EXACT sibling of DEFAULT_AGENT_SUMMARY_CAP (agentView) / DEFAULT_SESSION_SUMMARY_CAP
 * (sessionView). The CALLER applies it as the default `limit` (see server.ts tasks_list + platform
 * list_all_tasks), so an `includeBody:true` read on a board with hundreds of cards is bounded by row count
 * rather than dumping every body. Callers page past it with an explicit limit/offset.
 */
export const DEFAULT_TASK_SUMMARY_CAP = 100;

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
  /**
   * Return only tasks whose id STARTS WITH this prefix — a scoped read the caller reaches for INSTEAD
   * of paging a huge offset/limit window when they already know (part of) the id (card dc647ae2). A
   * plain filter, not a resolve: no match is just an empty list, never an "ambiguous"/"not found" error.
   */
  idPrefix?: string;
  /** Return only tasks whose title contains this (case-insensitive) substring — the name-based sibling of `idPrefix`. */
  titleContains?: string;
  /** Skip the first N rows (after filtering, before limit) — bounded-read pagination. Omit = 0. */
  offset?: number;
  /** Return at most N rows (after offset) — bounded-read pagination. Omit = no slice (caller caps). */
  limit?: number;
}

/** Project ONE Task row down to its summary (drops the unbounded body). Mirrors toAgentSummary. */
export const toTaskSummary = (t: Task): TaskSummary => ({
  id: t.id, title: t.title, columnKey: t.columnKey, position: t.position, priority: t.priority, updatedAt: t.updatedAt,
});

/**
 * Project a project's tasks to the board LIST shape the REST board route returns (card 4fa2c146 — the
 * 2026-07-16 perf profile found that route shipping every DONE card's full markdown body every 4s poll:
 * 2.79MB / 1263 tasks, 1230 of them done). Mirrors the tasks_list summary-vs-full split, but at column
 * granularity instead of an all-or-nothing switch: a LIVE (non-terminal-column) task keeps its full
 * `body` — the common card-open/edit path pays no extra round trip — while a DONE task's body is dropped
 * to a `hasBody` flag; its drawer lazy-fetches the body on open via GET /api/tasks/:id. `terminalKey` is
 * the resolved terminal column key (`columnKeyForRole(cols, "terminal")`), or undefined on a board with
 * no terminal role assigned — nothing is ever dropped in that case, matching listProjectTasks's fallback.
 */
export function toBoardTasks(tasks: Task[], terminalKey: string | undefined): BoardTask[] {
  return tasks.map((t) => {
    const hasBody = !!t.body?.trim();
    if (terminalKey && t.columnKey === terminalKey) {
      const { body: _body, ...rest } = t;
      return { ...rest, hasBody };
    }
    return { ...t, hasBody };
  });
}

/**
 * List a project's board tasks, filtered + projected. DEFAULTS to a lightweight SUMMARY (no body)
 * with terminal cards excluded — a bounded board read that doesn't grow without limit as cards pile
 * up in the terminal lane. The terminal column is DERIVED from the resolved config by its `terminal`
 * ROLE (with last-column fallback for legacy boards), never hardcoded. Pass includeBody:true for full
 * bodies (or use {@link getProjectTask}).
 *
 * Bounded-read pagination (offset/limit) is applied AFTER all filtering and BEFORE projection — the pure
 * slicing sibling of projectAgentList/projectSessionList (no internal default cap; the caller computes the
 * effective limit from {@link DEFAULT_TASK_SUMMARY_CAP}). Slicing before projection keeps the body off the
 * dropped rows.
 */
export function listProjectTasks(
  db: Db, projectId: string, opts: ListTasksOptions = {},
): Task[] | TaskSummary[] {
  const { columns, excludeDone = true, includeBody = false, minPriority, idPrefix, titleContains, offset, limit } = opts;
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
  if (idPrefix) tasks = tasks.filter((t) => t.id.startsWith(idPrefix));
  if (titleContains) {
    const needle = titleContains.toLowerCase();
    tasks = tasks.filter((t) => t.title.toLowerCase().includes(needle));
  }
  if (offset !== undefined) tasks = tasks.slice(offset);
  if (limit !== undefined) tasks = tasks.slice(0, limit);
  return includeBody ? tasks : tasks.map(toTaskSummary);
}

/**
 * card 342e433d: resolve `taskId` against this project's OWN tasks as EITHER a full id OR an
 * unambiguous id-PREFIX (mirrors id-prefix.ts › getByIdPrefix, generalized to tasks — the
 * candidate list is `db.listTasks(projectId)`, so prefix-scanning IS the ownership check: a
 * cross-project id can never appear in the candidate set). An ambiguous prefix names BOTH
 * candidate ids rather than silently picking one; kept HERE so getProjectTask/updateProjectTask
 * (and their platform cross-project callers) resolve identically.
 */
function resolveProjectTaskId(db: Db, projectId: string, taskId: string): Task | { error: string } {
  const r = resolveIdPrefix(db.listTasks(projectId), taskId);
  if (r.kind === "found") return r.record;
  if (r.kind === "ambiguous") {
    return { error: `ambiguous task id-prefix '${taskId}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` };
  }
  // Not on THIS project's board. Distinguish "no such id anywhere" from "exists on another project's
  // board" (card dc647ae2 part B) — the latter is a SCOPE error (a worker handed an out-of-scope id),
  // not a missing card, and the two should never read the same to a caller trying to tell them apart.
  const elsewhere = resolveIdPrefix(
    db.listAllProjects().filter((p) => p.id !== projectId).flatMap((p) => db.listTasks(p.id)),
    taskId,
  );
  if (elsewhere.kind !== "none") {
    return { error: `task '${taskId}' not found in this project — it exists on another project's board (out of scope for this session)` };
  }
  return { error: "task not found in this project" };
}

/**
 * The connected-requests summary {@link getProjectTask}/tasks_get attaches to a task (card 988bb585) —
 * lets an agent working a card see AT A GLANCE whether it has prior owner Requests (pending or already
 * answered) it should read via task_requests_list/task_request_get before proceeding, instead of missing
 * them entirely (the root problem: the read side used to ignore `task_id` altogether). `answered` counts
 * BOTH 'answered' and 'consumed' rows — both already carry the human's answer; 'consumed' only means the
 * ASKING agent already drained it via question_pull, not that the answer is unavailable here.
 */
export interface TaskRequestsSummary {
  total: number;
  answered: number;
  pending: number;
  items: Array<{ id: string; type: QuestionType; title: string; state: QuestionState }>;
}

/** A task extended with its connected-requests summary — what getProjectTask/tasks_get returns. */
export type TaskWithRequests = Task & { requests: TaskRequestsSummary };

function summarizeTaskRequests(questions: Question[]): TaskRequestsSummary {
  const pending = questions.filter((q) => q.state === "pending").length;
  return {
    total: questions.length,
    pending,
    answered: questions.length - pending,
    items: questions.map((q) => ({ id: q.id, type: q.type, title: q.title, state: q.state })),
  };
}

/**
 * Read ONE full task (title + body) by id, project-scoped: a cross-project id resolves to
 * not-found (same server-side guard posture as updateProjectTask). `taskId` accepts the full id
 * OR an unambiguous 8-char id-prefix (mirrors project_get / worker_spawn's agentId). Includes the
 * task's connected-requests summary (card 988bb585) — every Request whose `task_id` matches this task
 * AND whose own `project_id` matches THIS project (CR follow-up: `question_ask`'s `taskId` is
 * agent-supplied and unvalidated against the asking session's project, so a foreign-project question
 * that happens to carry this project's task id must never surface here — see `db.listQuestionsForTask`).
 */
export function getProjectTask(db: Db, projectId: string, taskId: string): TaskWithRequests | { error: string } {
  const found = resolveProjectTaskId(db, projectId, taskId);
  if ("error" in found) return found;
  return { ...found, requests: summarizeTaskRequests(db.listQuestionsForTask(projectId, found.id)) };
}

/** The lightweight row {@link listProjectTaskRequests} returns per connected request — title-altitude, not
 *  the full body/answer (use {@link getProjectTaskRequest} for that). */
export interface TaskRequestSummaryRow {
  id: string; type: QuestionType; title: string; state: QuestionState; answeredAt: string | null;
}

/**
 * List every request connected to ONE task (pending + answered + consumed alike), NON-CONSUMING — a
 * stable, re-readable reference distinct from `question_pull`'s agent-scoped drain-and-consume (card
 * 988bb585). `taskId` accepts the full id OR an unambiguous 8-char id-prefix (mirrors getProjectTask).
 * Project-scoped symmetrically with {@link getProjectTaskRequest}'s single-request get — a foreign-
 * project question carrying this project's task id is filtered out (see `db.listQuestionsForTask`).
 */
export function listProjectTaskRequests(db: Db, projectId: string, taskId: string): TaskRequestSummaryRow[] | { error: string } {
  const owned = resolveProjectTaskId(db, projectId, taskId);
  if ("error" in owned) return owned;
  return db.listQuestionsForTask(projectId, owned.id).map((q) => ({ id: q.id, type: q.type, title: q.title, state: q.state, answeredAt: q.answeredAt }));
}

/**
 * Read ONE connected request in full (body/options/recommendation/state + its answer-by-type),
 * project-scoped — the get-side sibling of {@link listProjectTaskRequests}. NON-CONSUMING: never flips
 * `state`, unlike `question_pull`. NEVER returns `secret_blob` for a "credential" request — see
 * {@link taskRequestGetItem} (mirrors `questionPullItem`'s credential branch exactly). An optional
 * `taskId` further scopes the lookup — if given (full id or an unambiguous prefix), the request must be
 * connected to THAT task or this errors instead of silently returning a request tied to a different one.
 */
export function getProjectTaskRequest(
  db: Db, projectId: string, id: string, taskId?: string,
): Record<string, unknown> | { error: string } {
  const q = db.getQuestion(id);
  if (!q || q.projectId !== projectId) return { error: "request not found in this project" };
  if (taskId) {
    const owned = resolveProjectTaskId(db, projectId, taskId);
    if ("error" in owned) return owned;
    // Prefix-tolerant, mirroring db.listQuestionsForTask: a legacy question's stored `q.taskId` may be
    // an 8-char prefix of the full task id rather than the full id itself.
    const linked = q.taskId === owned.id || (!!q.taskId && q.taskId.length === 8 && owned.id.startsWith(`${q.taskId}-`));
    if (!linked) return { error: "request is not connected to that task" };
  }
  return taskRequestGetItem(q);
}

export function createProjectTask(
  db: Db, projectId: string,
  input: { title: string; body?: string; columnKey?: string; priority?: TaskPriority },
): Task | { error: string } {
  const now = new Date().toISOString();
  const cols = resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
  // Column guard (the create-side mirror of updateProjectTask's move guard): an EXPLICIT columnKey must name
  // a column that EXISTS on this project's board, so a typo'd key can never store a card OFF-BOARD — apparent
  // success but an invisible card (Board.tsx filters strictly). Applied in the SHARED backing function, so the
  // in-project tasks_create and the cross-project project_task_create reject an unknown key identically.
  if (input.columnKey !== undefined && !cols.some((c) => c.key === input.columnKey)) {
    return { error: `unknown column "${input.columnKey}" on this project's board (valid: ${cols.map((c) => c.key).join(", ")})` };
  }
  // New cards land in the project's `defaultLanding` column (role-resolved, not the hardcoded key) so a
  // renamed/reordered landing lane still receives them; "backlog" is a defensive backstop only.
  const landing = columnKeyForRole(cols, "defaultLanding") ?? "backlog";
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

/**
 * The trimmed ack {@link updateProjectTask} returns for a patch that does NOT touch `body` (card
 * 3be9389b) — a column/priority/deferred/held-only move (the common case during board repair)
 * used to echo the ENTIRE updated task back, including a full multi-hundred-word body the caller
 * never asked to see. Still a valid task-ish object (id + the small fields), just without the
 * heavy field — plus `changed`, the patch keys the caller actually passed.
 */
export type TaskUpdateAck = Pick<Task, "id" | "title" | "columnKey" | "priority" | "position" | "updatedAt" | "held" | "deferred"> & {
  changed: string[];
};

export function updateProjectTask(
  db: Db, projectId: string, taskId: string,
  patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority" | "held" | "deferred">>,
): Task | TaskUpdateAck | { error: string } {
  // Guard: the task must belong to this project — and taskId may be a full id OR an unambiguous
  // 8-char id-prefix (card 342e433d). Resolve to the FULL id before writing: `db.updateTask` takes
  // an exact id, so a prefix must never be written straight through.
  const owned = resolveProjectTaskId(db, projectId, taskId);
  if ("error" in owned) return owned;
  // Column-move guard: a move must target a column that EXISTS on this project's board, so a move can never
  // orphan a card onto a non-existent key (the HARD INVARIANT board-column lifecycle code upholds). Applied
  // in the SHARED backing function, so the in-project tasks_update and the cross-project project_task_update
  // honor it identically. Resolved columns (override merged over defaults), so a custom/renamed column works.
  if (patch.columnKey !== undefined) {
    const cols = resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
    if (!cols.some((c) => c.key === patch.columnKey)) {
      return { error: `unknown column "${patch.columnKey}" on this project's board (valid: ${cols.map((c) => c.key).join(", ")})` };
    }
  }
  db.updateTask(owned.id, patch);
  const updated = { ...owned, ...patch, updatedAt: new Date().toISOString() };
  // A patch that doesn't touch `body` doesn't need it echoed back — trim to the small fields. A patch
  // that DOES pass `body` returns the full task (the caller is intentionally editing it and wants to
  // see the result).
  if (patch.body === undefined) {
    const { id, title, columnKey, priority, position, held, deferred, updatedAt } = updated;
    return { id, title, columnKey, priority, position, held, deferred, updatedAt, changed: Object.keys(patch) };
  }
  return updated;
}

/**
 * Reassign a MISFILED card from one project's board to another (`board_relocate`'s backing op, card
 * bfa25ea5) — the one cross-project move {@link updateProjectTask} cannot do (its patch type has no
 * `projectId`, and `db.updateTask` never writes that column). Resolves `taskId` GLOBALLY (`db.getTask`,
 * unscoped — the caller already knows the source project from that same read) and validates `toProject`
 * names a real project. Lands the card in the SAME `columnKey` on the destination board if that column
 * exists there, else falls back to the destination's first/landing column (`columnKeyForRole`'s
 * `defaultLanding` role IS "the first column" — mirrors `createProjectTask`'s own landing-column
 * fallback) — never orphans the card onto a non-existent key, mirroring `updateProjectTask`'s
 * column-validation discipline. Assigns a fresh `position` (mirrors `createProjectTask`'s own
 * `Date.now()` convention for "a card landing fresh on a board"). Single atomic `db.relocateTask` write
 * (project_id + column_key + position together).
 */
export function relocateProjectTask(db: Db, taskId: string, toProject: string): Task | { error: string } {
  const task = db.getTask(taskId);
  if (!task) return { error: `no task "${taskId}"` };
  const destProject = db.getProject(toProject);
  if (!destProject) return { error: `no project "${toProject}"` };
  const destCols = resolveConfig(destProject.config).kanbanColumns;
  const columnKey = destCols.some((c) => c.key === task.columnKey)
    ? task.columnKey
    : (columnKeyForRole(destCols, "defaultLanding") ?? destCols[0]?.key ?? task.columnKey);
  const position = Date.now();
  db.relocateTask(taskId, { projectId: toProject, columnKey, position });
  return { ...task, projectId: toProject, columnKey, position, updatedAt: new Date().toISOString() };
}

/** Tool descriptors (name/description/input shape) for wiring to the MCP SDK. */
export const TASK_TOOL_DESCRIPTORS = [
  { name: "tasks_list", description: "List the current project's board tasks. Defaults to a lightweight summary (no body) with done cards excluded; pass includeBody:true or use tasks_get(id) for bodies." },
  { name: "tasks_get", description: "Read ONE full task (title + body) by id, within the current project. id accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get). Also returns a `requests` summary ({total, answered, pending, items:[{id,type,title,state}]}) of any Requests connected to this task (via taskId at question_ask time) — a task may carry prior owner decisions you'd otherwise miss; read them in full with task_requests_list/task_request_get." },
  { name: "tasks_create", description: "Create a task on the current project's board (title, body?, columnKey?, priority?). priority is p0|p1|p2|p3 (low number = higher priority), default p2." },
  { name: "tasks_update", description: "Update a task (title?, body?, columnKey?, position?, priority?, held?, deferred?) by id, within the current project. PATCH-style: pass only the field(s) you're changing. id accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get); `taskId` is accepted as an ALIAS for `id` (matches the taskId param name every sibling task tool uses) — pass either one (if both, id wins). priority is p0|p1|p2|p3; held=true is the owner-gated 'don't nag' flag the idle watchdog discounts; deferred=true is YOUR OWN (manager) sequencing/dependency-gating marker — also discounted from the idle watchdog's actionable count, but unlike held it never blocks worker_spawn. A column/priority/deferred/held-only move needs ONLY id + those fields — no body — and returns a TRIMMED ack (no body) instead of echoing the full card; pass body when intentionally editing it to get the full task back." },
  { name: "task_requests_list", description: "List every Request connected to a task (pending + answered + consumed alike), title-altitude only: {id,type,title,state,answeredAt}. NON-CONSUMING — re-readable across turns/agents, unlike question_pull's drain-and-consume. taskId accepts the full id OR an unambiguous 8-char id-prefix." },
  { name: "task_request_get", description: "Read ONE connected Request in full (body, options, recommendation, type, state) plus its answer by type — chosenOption/note for decision|input, approved/note for permission, ack ONLY (never the secret) for credential. NON-CONSUMING. id is the request id; an optional taskId further scopes the lookup." },
] as const;
