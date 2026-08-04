import { randomUUID } from "node:crypto";
import type { Task, TaskPriority, Question, QuestionType, QuestionState, BoardTask, DeferredItem, DeferredItemStatus } from "@loom/shared";
import { DEFAULT_TASK_PRIORITY, resolveConfig, columnKeyForRole } from "@loom/shared";
import type { Db } from "../db.js";
import { resolveIdPrefix } from "../id-prefix.js";
import { taskRequestGetItem } from "./questionTool.js";
import { getTaskMergedInfo, type MergedCommitInfo } from "../git/worktrees.js";
import { resolveRepo, UnknownRepoKeyError } from "../projects/resolve-repo.js";
import { resolveRepoKeyOrError } from "../projects/repos.js";
import { checkTaskRepoKeyRebind } from "../projects/rebind.js";
import { findSuspectedDuplicate } from "./duplicateDetection.js";

// Task-tool business logic. EVERY function takes the projectId resolved SERVER-SIDE from the
// session id — the agent never passes a projectId, so cross-project access is impossible.

/**
 * A task/board row bolted with its git-derived ship state (card 9983eed6) — `null` when not proven
 * merged (never merged, landed outside the scan window, or a git read failure); see
 * {@link getTaskMergedInfo}'s fail-safe contract. Purely a RESPONSE-layer enrichment: not persisted, not
 * part of the `Task` DB row/type, so create/update payloads are unaffected.
 */
export type TaskWithMerged = Task & { merged: MergedCommitInfo | null };

/** The lightweight task row tasks_list returns by default — no body (the unbounded field). Carries
 *  `repoKey` (multi-repo epic 49136451) so a manager triaging the board can see which cards target a
 *  non-primary repo WITHOUT a per-card tasks_get — the same "summary hides a dispatch-relevant flag"
 *  gotcha already burned an orchestrator on `held`/`deferred`, and matters more here once repoKey drives
 *  worktree creation (phase 2). Also carries `deferred`/`deferredUntilTaskId` (card 793ac76d) so a
 *  manager triaging the board sees WHY a card is deferred without a per-card tasks_get — `deferred` was
 *  not previously in this summary at all; adding it here is scoped to what this card needs (`held` stays
 *  out, a separate pre-existing gap, not this card's concern). */
export type TaskSummary = Pick<TaskWithMerged, "id" | "title" | "columnKey" | "position" | "priority" | "updatedAt" | "merged" | "repoKey" | "deferred" | "deferredUntilTaskId" | "deferredStuck" | "deferredAt" | "deferredReason">;

/**
 * {@link resolveMergedInfo}'s return: the git-derived ship state PLUS which repoKey was actually scanned
 * to produce it (card 1eebc46a, Code Review Minor 2) — `null` = primary, same convention as `Task.repoKey`
 * / `Task.mergedRepoKey`. Distinct from `task.repoKey` itself: this reports where the scan ACTUALLY ran,
 * which diverges from the task's own (possibly stale or since-retargeted) `repoKey` in exactly the case
 * that matters — a stale `UnknownRepoKeyError` degrade below resolves+scans PRIMARY, so `repoKey` here
 * correctly reads `null`, not the stale key the task still carries. A caller that persists ship-state
 * (the drawer's lazy backfill) MUST stamp THIS `repoKey`, never `task.repoKey` — stamping the task's own
 * field would silently disagree with the repo the `merged` sha was actually found on.
 */
export interface ResolvedMergedInfo {
  merged: MergedCommitInfo | null;
  repoKey: string | null;
}

/**
 * Resolve a project's git-derived merged state for one task, or `{merged:null, repoKey:null}` with no git
 * call for a vault-only project (no repoPath) OR when `includeMerged` is false (card f6753002) — the
 * latter lets a latency-sensitive, non-surfacing caller (the companion board) skip the enrichment
 * entirely rather than pay for a field it discards.
 *
 * Multi-repo epic (49136451) phase 1: resolves the task's TARGET repo via {@link resolveRepo} (its
 * `repoKey`, or the project's primary) instead of always reading `project.repoPath` directly. This is a
 * READ path every `tasks_get`/`tasks_list` call goes through, so a STALE `repoKey` (the registry entry
 * was removed after the task was written) must never break the read — `resolveRepo` throwing
 * {@link UnknownRepoKeyError} here is caught and degraded to the project's primary repo (logged, not
 * silent) rather than propagated, so one stale card can never take down a whole board read. The returned
 * `repoKey` reflects that degrade (reads `null`/primary, not the stale key) — see {@link ResolvedMergedInfo}.
 */
export async function resolveMergedInfo(db: Db, projectId: string, task: Pick<Task, "id" | "repoKey">, includeMerged = true): Promise<ResolvedMergedInfo> {
  if (!includeMerged) return { merged: null, repoKey: null };
  const project = db.getProject(projectId);
  if (!project || !project.repoPath) return { merged: null, repoKey: null };
  let repoPath: string;
  let resolvedKey: string | null;
  try {
    const resolved = resolveRepo(project, task);
    repoPath = resolved.path;
    resolvedKey = resolved.key === "primary" ? null : resolved.key;
  } catch (e) {
    if (e instanceof UnknownRepoKeyError) {
      console.warn(`[mcp/tasks] task ${task.id} has a stale repoKey (${e.repoKey}) not in project ${projectId}'s registry — falling back to the primary repo for ship-state`);
      repoPath = project.repoPath;
      resolvedKey = null; // degraded to primary — see this function's own doc
    } else {
      throw e;
    }
  }
  const merged = await getTaskMergedInfo(repoPath, task.id);
  return { merged, repoKey: resolvedKey };
}

/**
 * {@link resolveDeferredEffective}'s return: the EFFECTIVE `deferred`/`deferredStuck` values a read
 * should present, plus whether either differs from the raw stored row (`autoCleared`/`stuckChanged`) —
 * a caller uses those to decide whether a write-through persist is warranted (see that function's own
 * doc for why this must be a genuine-TRANSITION guard, not an unconditional write on every read).
 */
export interface ResolvedDeferredState {
  deferred: boolean;
  autoCleared: boolean;
  /** Card 93669813 — see {@link Task.deferredStuck}'s own doc. Always `false` while `deferred` is `false`. */
  stuck: boolean;
  /** Whether `stuck` differs from the row's raw persisted `deferredStuck` — gates the write-through, same
   *  genuine-transition guard as `autoCleared` (fires on stuck→unstuck too, e.g. a reopened blocker). */
  stuckChanged: boolean;
}

/**
 * Card 793ac76d — derive a task's EFFECTIVE `deferred` state at read time from its optional
 * `deferredUntilTaskId` companion, WITHOUT persisting any new cached flag: when the row is `deferred:true`
 * and names a blocker task, the blocker's git-derived `merged` state is resolved the SAME way
 * {@link resolveMergedInfo} already resolves it for every row on this read (the SAME cached, bounded
 * per-repo git-log scan — this is one more O(1) map lookup against it, not a new git call) — a non-null
 * `merged` means the blocker has landed, so `deferred` reads `false` here.
 *
 * Returns `autoCleared:true` ONLY on a genuine `true → false` transition (the row's raw `deferred` was
 * true and this call resolved it to false) — never on a row that was already `deferred:false`, never on
 * a row with no `deferredUntilTaskId`, never on a still-blocked row. Callers use this to gate a
 * write-through persist (`db.updateTask(id, {deferred:false})`) to fire EXACTLY ONCE per real transition,
 * not on every subsequent read of an already-cleared row — an unconditional write-on-every-read would
 * write-storm every deferred card on every `tasks_list` poll and needlessly bump `updatedAt` repeatedly.
 *
 * A missing/cross-project/dangling blocker (deleted since being validly set, or somehow not on this
 * project — the set-time guard in {@link updateProjectTask} prevents the latter going forward, but a
 * read must still degrade safely for data written before that guard, or a blocker deleted afterward)
 * falls through to "stays deferred, no clear" — never throws, never silently drops the card's deferred
 * state.
 *
 * Card 93669813 — ALSO derives `stuck` (see {@link Task.deferredStuck}'s own doc for the full contract
 * and its deliberate fail-toward-visible false-positive route): `true` when the blocker is unreachable
 * (missing / cross-project — the same dangling case above) OR when it's sitting in the project's
 * `terminal`-role column while `merged` is still null (closed without ever producing a squash commit —
 * the doctrine-sanctioned 0-commit `done` outcome). `stuck` never flips `deferred` itself; it rides the
 * SAME blocker lookup and merged-state resolution already done for the auto-clear check above, so it
 * costs nothing extra when `deferred` is about to auto-clear anyway (that path returns `stuck:false`,
 * since a merged blocker was never stuck).
 *
 * ⚠️ `includeMerged:false` (the companion board's latency-sensitive skip — {@link resolveMergedInfo}'s
 * own doc) means the blocker's merged state was NEVER RESOLVED on THIS read: `stuck` is UNKNOWN here,
 * not `false`. This is handled as its OWN branch, separate from `!raw`/`!deferredUntilTaskId` (those two
 * ARE genuine "not stuck" determinations, independent of merged state, and correctly self-heal a stale
 * persisted `deferredStuck`) — collapsing all three into one "return not-stuck" path would assert a
 * measurement that was never taken, and the write-through below would then PERSIST that false assertion,
 * silently clearing a genuinely-stuck card's flag the next time anything reads with `includeMerged:false`
 * (review finding on card 93669813: the companion board's `listProjectTasks`/`getProjectTask` calls do
 * exactly this — a routine companion board read must never be able to un-stick a stuck card). So the
 * `includeMerged:false` branch PRESERVES whatever `stuck` was already persisted and reports
 * `stuckChanged:false` unconditionally — never writes, whichever way the stored value happens to read.
 */
export async function resolveDeferredEffective(
  db: Db, projectId: string, task: Pick<Task, "id" | "deferred" | "deferredUntilTaskId" | "deferredStuck">, includeMerged: boolean,
): Promise<ResolvedDeferredState> {
  const raw = task.deferred === true;
  const rawStuck = task.deferredStuck === true;
  // Genuine determinations, independent of merged state — deferred:false or a blocker-less deferral
  // (a manual, owner/upstream-gated sequencing marker) are NEVER stuck. Self-heals a stale `deferredStuck`
  // left over from a since-cleared or re-pointed deferral.
  if (!raw || !task.deferredUntilTaskId) {
    return { deferred: raw, autoCleared: false, stuck: false, stuckChanged: rawStuck !== false };
  }
  // UNMEASURED, not a determination — see this function's own doc. Preserve, never write.
  if (!includeMerged) return { deferred: true, autoCleared: false, stuck: rawStuck, stuckChanged: false };
  const blocker = db.getTask(task.deferredUntilTaskId);
  if (!blocker || blocker.projectId !== projectId) {
    return { deferred: true, autoCleared: false, stuck: true, stuckChanged: rawStuck !== true }; // dangling/cross-project blocker
  }
  const { merged } = await resolveMergedInfo(db, projectId, blocker, true);
  if (merged) return { deferred: false, autoCleared: true, stuck: false, stuckChanged: rawStuck !== false };
  const cols = resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
  const terminalKey = columnKeyForRole(cols, "terminal");
  const stuck = blocker.columnKey === terminalKey; // closed with no proven merge → stuck
  return { deferred: true, autoCleared: false, stuck, stuckChanged: stuck !== rawStuck };
}

/**
 * Write-through persist for {@link resolveDeferredEffective}'s `autoCleared`/`stuckChanged` transitions —
 * updates the EXISTING `deferred`/`deferredStuck` columns to the derived truth (never a new cached flag
 * beyond the persisted `deferredStuck` column itself), so downstream consumers that read them straight off
 * the DB (the idle watchdog, `db.listTasks`) self-heal on the next read that happens to pass through this
 * MCP layer, without needing any knowledge of `deferredUntilTaskId` themselves. Best-effort / NON-FATAL by
 * design (card 793ac76d review): a board read must never fail or alter its OWN result because this persist
 * failed — the caller already computed the correct in-memory value from `resolveDeferredEffective` and
 * returns that regardless of whether this write lands.
 *
 * On an `autoCleared` transition, also clears `deferredUntilTaskId` to `null` in the SAME write (card
 * cf62c1ef) — once a named blocker's merge has been observed and acted on, the companion field has served
 * its purpose. Leaving it set was a footgun: a LATER, unrelated `tasks_update(deferred:true)` (with no new
 * `deferredUntilTaskId`) would silently inherit the stale blocker reference, and since that blocker is
 * already merged, the very next read would auto-clear the manager's fresh, deliberate re-defer without
 * ever reporting it. Clearing the companion here means a re-defer always starts clean — it lands on the
 * plain "deferred with no blocker" path (never auto-clears, see resolveDeferredEffective) unless the
 * caller explicitly names a NEW blocker. A `stuckChanged`-only write (deferred stays true) leaves
 * `deferredUntilTaskId` untouched — the blocker reference is still exactly what made it stuck.
 *
 * Card c90e9525: an `autoCleared` transition ALSO nulls `deferredAt`/`deferredReason` in the same write —
 * once `deferred` flips false, a stale reason/date left behind would misdescribe a card that is no longer
 * deferred at all. This is NOT new auto-clear logic for a MANUAL deferral (the card's DoD-1 forbids that);
 * it only extends the ALREADY-EXISTING route-(a) auto-clear (card 93669813, unrelated to this card's own
 * scope) to also clear the two fields it happens to share a write with — a manual deferral is never
 * auto-cleared by anything, so this branch is unreachable for one.
 */
function persistDeferredStateBestEffort(
  db: Db, taskId: string, state: Pick<ResolvedDeferredState, "autoCleared" | "stuck" | "stuckChanged">,
): void {
  if (!state.autoCleared && !state.stuckChanged) return;
  try {
    const patch: Parameters<Db["updateTask"]>[1] = state.autoCleared
      ? { deferred: false, deferredUntilTaskId: null, deferredStuck: false, deferredAt: null, deferredReason: null }
      : { deferredStuck: state.stuck };
    db.updateTask(taskId, patch);
  } catch (e) {
    console.warn(`[mcp/tasks] best-effort deferred/deferredStuck write-through failed for task ${taskId} (read result is unaffected):`, e);
  }
}

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
  /**
   * Compute the git-derived `merged` enrichment per row. Default true (preserves tasks_list /
   * list_all_tasks behavior). Pass false to skip the enrichment ENTIRELY (no `readHeadSha`, no
   * cached-map lookup, no scan) for a caller — e.g. the companion board — that never surfaces
   * `merged` and would otherwise pay for a field it discards (card f6753002).
   */
  includeMerged?: boolean;
}

/** Project ONE (already merged-enriched) Task row down to its summary (drops the unbounded body). Mirrors toAgentSummary. */
export const toTaskSummary = (t: TaskWithMerged): TaskSummary => ({
  id: t.id, title: t.title, columnKey: t.columnKey, position: t.position, priority: t.priority, updatedAt: t.updatedAt, merged: t.merged, repoKey: t.repoKey ?? null,
  deferred: t.deferred === true, deferredUntilTaskId: t.deferredUntilTaskId ?? null, deferredStuck: t.deferredStuck === true,
  deferredAt: t.deferredAt ?? null, deferredReason: t.deferredReason ?? null,
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
 * dropped rows, and (when this call is given an offset/limit) bounds the merged-state enrichment below
 * to whatever rows this call actually returns.
 *
 * Every row (summary or full) also carries `merged` (card 9983eed6) — the task's git-derived ship state,
 * or `null` if not proven merged; see {@link getTaskMergedInfo}'s fail-safe contract. ASYNC because that
 * lookup shells out to git, but stays cheap even over an unpaginated per-project call: ONE bounded,
 * cached git-log scan backs every task's O(1) map lookup here, not one git subprocess per task.
 */
export async function listProjectTasks(
  db: Db, projectId: string, opts: ListTasksOptions = {},
): Promise<TaskWithMerged[] | TaskSummary[]> {
  const { columns, excludeDone = true, includeBody = false, minPriority, idPrefix, titleContains, offset, limit, includeMerged = true } = opts;
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
  // Merged-state enrichment (card 9983eed6): one cached, bounded git-log scan per repo backs every
  // task's O(1) map lookup here — see getTaskMergedInfo — so this stays cheap regardless of board size.
  // Skipped entirely when includeMerged is false (card f6753002).
  // Deferred auto-clear (card 793ac76d): rides the SAME per-row pass — see resolveDeferredEffective's
  // own doc for why the write-through only fires on a genuine transition.
  const withMerged: TaskWithMerged[] = await Promise.all(
    tasks.map(async (t) => {
      const merged = (await resolveMergedInfo(db, projectId, t, includeMerged)).merged;
      const { deferred, autoCleared, stuck, stuckChanged } = await resolveDeferredEffective(db, projectId, t, includeMerged);
      persistDeferredStateBestEffort(db, t.id, { autoCleared, stuck, stuckChanged });
      // autoCleared also nulls deferredUntilTaskId in the DB (see persistDeferredStateBestEffort) —
      // mirror that in THIS response too, so the read that reports the clear never echoes a stale
      // non-null blocker id alongside deferred:false (card cf62c1ef).
      return { ...t, deferred, deferredUntilTaskId: autoCleared ? null : t.deferredUntilTaskId, deferredStuck: stuck, merged };
    }),
  );
  return includeBody ? withMerged : withMerged.map(toTaskSummary);
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
 * ASKING agent already drained it via question_pull, not that the answer is unavailable here. `cancelled`
 * (question_cancel/dismiss, card feat(orchestration): question_cancel + dismiss) is counted SEPARATELY —
 * a cancelled request was NEVER answered, so it must never be folded into `answered` (nor derived as
 * `total - pending`, which would silently do exactly that once a fourth state exists). `total` still
 * counts every row regardless of state; `pending + answered + cancelled === total`.
 */
export interface TaskRequestsSummary {
  total: number;
  answered: number;
  pending: number;
  cancelled: number;
  items: Array<{ id: string; type: QuestionType; title: string; state: QuestionState }>;
}

/** A task extended with its connected-requests summary + git-derived merged state — what getProjectTask/tasks_get returns. */
export type TaskWithRequests = TaskWithMerged & { requests: TaskRequestsSummary; incomingDeferredItems: IncomingDeferredItemsSummary };

function summarizeTaskRequests(questions: Question[]): TaskRequestsSummary {
  // Each bucket is derived EXPLICITLY by state — never `total - pending` (that silently mis-groups any
  // state besides pending/answered/consumed, which is exactly the bug a cancelled row exposed here).
  let pending = 0, answered = 0, cancelled = 0;
  for (const q of questions) {
    if (q.state === "pending") pending++;
    else if (q.state === "answered" || q.state === "consumed") answered++;
    else if (q.state === "cancelled") cancelled++;
  }
  return {
    total: questions.length,
    pending, answered, cancelled,
    items: questions.map((q) => ({ id: q.id, type: q.type, title: q.title, state: q.state })),
  };
}

/**
 * ONE hand-off {@link getProjectTask}'s `incomingDeferredItems` surfaces on the RECEIVING task (card
 * 0d4bc3f0) — the same entry a donor task stores in its own `deferredItems`, re-presented from the other
 * end plus which task it came from, so the recipient never has to already know the donor's id.
 */
export interface IncomingDeferredItem {
  itemId: string;
  text: string;
  status: DeferredItemStatus;
  fromTaskId: string;
  fromTaskTitle: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * {@link getProjectTask}/tasks_get's INBOUND deferred-items summary (card 0d4bc3f0) — mirrors
 * {@link TaskRequestsSummary}'s shape/placement exactly: every {@link DeferredItem} ANY task on this
 * board has recorded with `toTaskId` naming THIS one, regardless of that donor task's own state (open,
 * in progress, or already closed) — a donor that closed without ever getting an "acknowledged"/"declined"
 * answer is exactly the drop this mechanism exists to make visible, so a closed donor is never filtered
 * out here. `open` is the count that matters for detectability (DoD-4): a card reading its OWN
 * `tasks_get` sees, structurally, every hand-off nobody has yet said anything about — no need to go
 * re-read a donor card's prose to notice one was never answered.
 */
export interface IncomingDeferredItemsSummary {
  total: number;
  open: number;
  acknowledged: number;
  declined: number;
  items: IncomingDeferredItem[];
}

/**
 * Computed by scanning THIS project's OTHER tasks for a `deferredItems` entry whose `toTaskId` names
 * `taskId` (card 0d4bc3f0) — there is no separate table to index by `toTaskId` the way `questions.task_id`
 * backs {@link summarizeTaskRequests}; `deferredItems` lives ON the donor task by design (see
 * `Task.deferredItems`'s own doc for why), so the inbound view is necessarily a project-wide scan rather
 * than a targeted lookup. `db.listTasks(projectId)` is already the same per-project read
 * `resolveProjectTaskId` performs for id-prefix resolution, so this costs one more in-memory pass over an
 * already-fetched row set, not an extra DB round trip.
 */
function summarizeIncomingDeferredItems(db: Db, projectId: string, taskId: string): IncomingDeferredItemsSummary {
  let open = 0, acknowledged = 0, declined = 0;
  const items: IncomingDeferredItem[] = [];
  for (const t of db.listTasks(projectId)) {
    if (t.id === taskId || !t.deferredItems?.length) continue;
    for (const it of t.deferredItems) {
      if (it.toTaskId !== taskId) continue;
      if (it.status === "open") open++;
      else if (it.status === "acknowledged") acknowledged++;
      else declined++;
      items.push({ itemId: it.id, text: it.text, status: it.status, fromTaskId: t.id, fromTaskTitle: t.title, createdAt: it.createdAt, updatedAt: it.updatedAt });
    }
  }
  return { total: items.length, open, acknowledged, declined, items };
}

/**
 * Defer a sub-item from `fromTaskId` onto ANOTHER task on the same board (card 0d4bc3f0) — the structured
 * hand-off `tasks_defer_item` writes, alongside (never instead of) a `Related:`/prose note in the body.
 * `toTaskId` accepts the full id or an unambiguous 8-char prefix (mirrors `deferredUntilTaskId`), resolved
 * to the full id before it's written so a later read never has to re-resolve a stale prefix. Rejects a
 * self-reference (a card can't defer an item onto itself) and an id that doesn't resolve on this board —
 * whole call rejected, nothing written, same convention as every other cross-task reference this surface
 * validates (`deferredUntilTaskId`, `supersedes`/`relatedTo`).
 */
export function deferTaskItem(
  db: Db, projectId: string, fromTaskId: string, input: { text: string; toTaskId: string },
): DeferredItem | { error: string } {
  const from = resolveProjectTaskId(db, projectId, fromTaskId);
  if ("error" in from) return from;
  const to = resolveProjectTaskId(db, projectId, input.toTaskId);
  if ("error" in to) return { error: `toTaskId ${to.error}` };
  if (to.id === from.id) return { error: "toTaskId cannot reference the task itself" };
  const text = input.text.trim();
  if (!text) return { error: "text is required" };
  const item = db.appendDeferredItem(from.id, { text, toTaskId: to.id });
  if (!item) return { error: "task not found (deleted concurrently)" };
  return item;
}

/**
 * Flip a deferred item's status (card 0d4bc3f0) — the acknowledge/decline/reopen write, addressed by the
 * OWNING task's id (the donor that recorded it via `tasks_defer_item`) plus the item's own `id` (from that
 * donor's own `tasks_get`, or from the RECEIVING task's `incomingDeferredItems.items[].itemId` +
 * `fromTaskId` — either party can call this; nothing here checks WHICH task the caller currently holds).
 * `taskId` accepts the full id or an unambiguous 8-char prefix.
 */
export function updateDeferredItemStatus(
  db: Db, projectId: string, taskId: string, itemId: string, status: DeferredItemStatus,
): DeferredItem | { error: string } {
  const owned = resolveProjectTaskId(db, projectId, taskId);
  if ("error" in owned) return owned;
  const result = db.setDeferredItemStatus(owned.id, itemId, status);
  if (!result) return { error: "task not found (deleted concurrently)" };
  return result;
}

/**
 * Read ONE full task (title + body) by id, project-scoped: a cross-project id resolves to
 * not-found (same server-side guard posture as updateProjectTask). `taskId` accepts the full id
 * OR an unambiguous 8-char id-prefix (mirrors project_get / worker_spawn's agentId). Includes the
 * task's connected-requests summary (card 988bb585) — every Request whose `task_id` matches this task
 * AND whose own `project_id` matches THIS project (CR follow-up: `question_ask`'s `taskId` is
 * agent-supplied and unvalidated against the asking session's project, so a foreign-project question
 * that happens to carry this project's task id must never surface here — see `db.listQuestionsForTask`).
 * Also includes `merged` (card 9983eed6) — the task's git-derived ship state on this project's repo, or
 * `null` if not proven merged; see {@link getTaskMergedInfo}'s fail-safe contract. Pass
 * `includeMerged:false` (default true) to skip that git lookup entirely for a caller that never
 * surfaces `merged` — e.g. the companion board (card f6753002).
 */
export async function getProjectTask(
  db: Db, projectId: string, taskId: string, opts: { includeMerged?: boolean } = {},
): Promise<TaskWithRequests | { error: string }> {
  const found = resolveProjectTaskId(db, projectId, taskId);
  if ("error" in found) return found;
  const includeMerged = opts.includeMerged ?? true;
  const merged = (await resolveMergedInfo(db, projectId, found, includeMerged)).merged;
  // Deferred auto-clear + stuck-visibility (card 793ac76d / 93669813) — see resolveDeferredEffective's own doc.
  const { deferred, autoCleared, stuck, stuckChanged } = await resolveDeferredEffective(db, projectId, found, includeMerged);
  persistDeferredStateBestEffort(db, found.id, { autoCleared, stuck, stuckChanged });
  // autoCleared also nulls deferredUntilTaskId in the DB (see persistDeferredStateBestEffort) — mirror
  // that here too, so this same read never echoes a stale non-null blocker id alongside deferred:false.
  return {
    ...found, deferred, deferredUntilTaskId: autoCleared ? null : found.deferredUntilTaskId, deferredStuck: stuck, merged,
    requests: summarizeTaskRequests(db.listQuestionsForTask(projectId, found.id)),
    incomingDeferredItems: summarizeIncomingDeferredItems(db, projectId, found.id),
  };
}

/** The lightweight row {@link listProjectTaskRequests} returns per connected request — title-altitude, not
 *  the full body/answer (use {@link getProjectTaskRequest} for that). */
export interface TaskRequestSummaryRow {
  id: string; type: QuestionType; title: string; state: QuestionState; answeredAt: string | null;
}

/**
 * List every request connected to ONE task (pending + answered + consumed + cancelled alike), NON-CONSUMING — a
 * stable, re-readable reference distinct from `question_pull`'s agent-scoped drain-and-consume (card
 * 988bb585). `taskId` accepts the full id OR an unambiguous 8-char id-prefix (mirrors getProjectTask).
 * Project-scoped symmetrically with {@link getProjectTaskRequest}'s single-request get — a foreign-
 * project question carrying this project's task id is filtered out (see `db.listQuestionsForTask`).
 *
 * Returns the RESOLVED full task id alongside `rows` (not just the rows) so a caller that spills the
 * NDJSON rendering of `rows` to a scratch file can key that spill by the CANONICAL id rather than by
 * whatever prefix string the caller happened to pass — two different unambiguous prefixes naming the
 * SAME task must land on the SAME scratch path (spillTextIfLarge's "same content overwrites" contract),
 * which the raw, unresolved `taskId` argument can't guarantee.
 */
export function listProjectTaskRequests(db: Db, projectId: string, taskId: string): { taskId: string; rows: TaskRequestSummaryRow[] } | { error: string } {
  const owned = resolveProjectTaskId(db, projectId, taskId);
  if ("error" in owned) return owned;
  const rows = db.listQuestionsForTask(projectId, owned.id).map((q) => ({ id: q.id, type: q.type, title: q.title, state: q.state, answeredAt: q.answeredAt }));
  return { taskId: owned.id, rows };
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
  input: { title: string; body?: string; columnKey?: string; priority?: TaskPriority; repoKey?: string | null },
): Task | { error: string } {
  const now = new Date().toISOString();
  const project = db.getProject(projectId);
  const cols = resolveConfig(project?.config).kanbanColumns;
  // Column guard (the create-side mirror of updateProjectTask's move guard): an EXPLICIT columnKey must name
  // a column that EXISTS on this project's board, so a typo'd key can never store a card OFF-BOARD — apparent
  // success but an invisible card (Board.tsx filters strictly). Applied in the SHARED backing function, so the
  // in-project tasks_create and the cross-project project_task_create reject an unknown key identically.
  if (input.columnKey !== undefined && !cols.some((c) => c.key === input.columnKey)) {
    return { error: `unknown column "${input.columnKey}" on this project's board (valid: ${cols.map((c) => c.key).join(", ")})` };
  }
  // repoKey guard (multi-repo epic 49136451, phase 1): an EXPLICIT repoKey must name an entry in this
  // project's `repos` registry (or the reserved "primary") — a typo'd key must never store a card
  // silently pointed at nothing. Shares the ONE validator `resolveRepoKeyOrError` with updateProjectTask
  // and the REST task routes, so "unknown key" reads identically everywhere a task can be written.
  let repoKey: string | null = null;
  if (input.repoKey !== undefined) {
    const check = resolveRepoKeyOrError(project?.repos ?? [], input.repoKey);
    if (!check.ok) return { error: check.error };
    repoKey = check.value;
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
    repoKey,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  db.insertTask(task);
  return task;
}

/** {@link createProjectTaskChecked}'s override params — any ONE of these skips the duplicate refusal. */
export interface CreateTaskDedupeOptions {
  /** Explicit "yes, I know, create it anyway." */
  allowDuplicate?: boolean;
  /** This new card supersedes an existing one (full id or an unambiguous prefix) — noted on the new
   *  card's body. Skips the refusal like `allowDuplicate`. */
  supersedes?: string;
  /** This new card is related to (but not a straight duplicate of) an existing one — same effect as
   *  `supersedes`, different relationship recorded on the body. */
  relatedTo?: string;
}

/**
 * ⛔ §SCOPE FENCE (board card 5b221bf2, widened by card 0ef0270b) — this wraps {@link createProjectTask}
 * with a cross-channel duplicate check, and is called from EXACTLY TWO places: the agent-facing
 * `tasks_create` MCP tool (mcp/server.ts) and the Platform Lead's cross-project `project_task_create`
 * (mcp/platform.ts). Both satisfy the fence's own criterion — the caller is an AGENT reading a tool
 * result and can ACT on a refusal (retry with `allowDuplicate`/`supersedes`/`relatedTo`, or drop it) —
 * unlike every OTHER path that reaches `createProjectTask`, which must NEVER be substituted for the raw
 * helper. `createProjectTask` itself is a SHARED helper — reached not only from those two callers but
 * also from the companion's `board_create` (companion/capabilities.ts) — and, transitively through it,
 * from every automated BOARDING path that calls `db.insertTask` directly with a delivery guarantee
 * (`peer_message` boarding, platform-escalation landing, workspace-audit suggestions, project seeding,
 * human REST card creation). A refusal on any of those silently drops a message instead of failing an
 * agent call an agent can read and retry — see the card for the full enumeration. Do not "simplify" this
 * by moving the check into `createProjectTask` or `db.insertTask`; that would be exactly the
 * regression DoD 8 (`5b221bf2`) / M1-regression (`0ef0270b`) tests guard against.
 *
 * Refuses (returns `{error}`, inserts nothing) when {@link findSuspectedDuplicate} flags an existing
 * task as a likely duplicate of `input`, UNLESS `dedupe.allowDuplicate`/`supersedes`/`relatedTo` is
 * given — an explicit assertion the caller had to type, never a silent auto-merge or auto-drop. A
 * `supersedes`/`relatedTo` target is resolved the same way every other task-id param on this surface
 * is (full id or unambiguous 8-char prefix, against THIS `projectId`'s board — for `project_task_create`
 * that is the DESTINATION project, never the Lead's own) and noted on the new card's body; an
 * unresolvable target is rejected (whole create rejected, nothing written) rather than silently ignored.
 *
 * m7 (card 0ef0270b): a `supersedes`/`relatedTo` relationship is recorded on BOTH cards, not just the new
 * one — the superseded/related (loser) card's body is back-noted with a pointer to the new card
 * ("Superseded by: <id>" / "Related to: <id>") once the create actually succeeds. Without this, only the
 * new card names the relationship; a reader who lands on the loser card directly (the exact failure mode
 * `5b221bf2` was filed about) has no way to discover it's been superseded. The back-note write happens
 * strictly AFTER the new card is created — if the create itself failed, no back-note is written for a
 * card that doesn't exist (a race with the target being deleted between resolution and insert isn't
 * possible: this function is synchronous end-to-end — no `await` between `resolveProjectTaskId` and
 * `createProjectTask`, and better-sqlite3 is sync — so nothing can interleave between them; this stops
 * being true the day this function gains an `await` in that span). The back-note `db.updateTask` call's
 * result is NOT inspected — a failed update here degrades to a one-directional link (visible on read: the
 * new card's body still names the target, just not vice versa) rather than silently losing the relation
 * entirely, but it is not itself checked or retried.
 */
export function createProjectTaskChecked(
  db: Db, projectId: string,
  input: { title: string; body?: string; columnKey?: string; priority?: TaskPriority; repoKey?: string | null },
  dedupe?: CreateTaskDedupeOptions,
): Task | { error: string } {
  let body = input.body ?? "";
  let relationNote: string | undefined;
  let backlinkTarget: Task | undefined;
  if (dedupe?.supersedes && dedupe?.relatedTo) {
    // Never silently prefer one over the other (house "never silently ignore" posture) — a caller
    // that passed both meant something distinct by each; ask them to pick one instead of guessing.
    return { error: "pass only ONE of supersedes/relatedTo, not both" };
  }
  if (dedupe?.supersedes || dedupe?.relatedTo) {
    const targetId = dedupe.supersedes ?? dedupe.relatedTo;
    const resolved = resolveProjectTaskId(db, projectId, targetId as string);
    if ("error" in resolved) return resolved;
    relationNote = dedupe.supersedes ? `Supersedes: ${resolved.id}` : `Related to: ${resolved.id}`;
    backlinkTarget = resolved;
  }
  const bypassed = !!(dedupe?.allowDuplicate || dedupe?.supersedes || dedupe?.relatedTo);
  if (!bypassed) {
    const candidateText = `${input.title}\n${body}`;
    const suspect = findSuspectedDuplicate(db.listTasks(projectId), candidateText);
    if (suspect) {
      // Legibility, not narrowing (card abdaecda) — a match that qualified on weak evidence alone (no
      // strong session-id/branch hit) is exactly the shape that can coincidentally collide on a shared
      // code landmark or naming convention between substantively unrelated cards (see
      // findSuspectedDuplicate's SECOND DISCLOSED LIMITATION). Naming that explicitly, alongside BOTH
      // card titles, makes an absurd flag dismissible in one read instead of a mysterious "shared: X, Y".
      const weakOnlyCaveat = suspect.strongMatch
        ? ""
        : ` — matched only on ${suspect.weakCategories.join("+")} (a shared code location and/or naming ` +
          `convention can coincidentally collide between unrelated cards; verify before assuming duplication)`;
      return {
        error: `"${input.title}" suspected duplicate of task ${suspect.taskId} ("${suspect.title}")${weakOnlyCaveat} — shared: ` +
          `${suspect.sharedIdentifiers.join(", ")}. Pass allowDuplicate:true, or supersedes/relatedTo:"${suspect.taskId}" to create anyway.`,
      };
    }
  }
  if (relationNote) body = body ? `${body}\n\n${relationNote}` : relationNote;
  const created = createProjectTask(db, projectId, { ...input, body });
  // m7 back-link (see the doc above): the loser card must be reachable FROM the new one AND reach it
  // back — a one-directional note only solves the problem for a reader who already found the winner.
  if (backlinkTarget && !("error" in created)) {
    const backNote = dedupe?.supersedes ? `Superseded by: ${created.id}` : `Related to: ${created.id}`;
    const targetBody = backlinkTarget.body ? `${backlinkTarget.body}\n\n${backNote}` : backNote;
    db.updateTask(backlinkTarget.id, { body: targetBody });
  }
  return created;
}

/**
 * The trimmed ack {@link updateProjectTask} returns for a patch that does NOT touch `body` (card
 * 3be9389b) — a column/priority/deferred/held-only move (the common case during board repair)
 * used to echo the ENTIRE updated task back, including a full multi-hundred-word body the caller
 * never asked to see. Still a valid task-ish object (id + the small fields), just without the
 * heavy field — plus `changed`, the patch keys the caller actually passed.
 */
export type TaskUpdateAck = Pick<Task, "id" | "title" | "columnKey" | "priority" | "position" | "updatedAt" | "held" | "deferred" | "heldBy" | "repoKey" | "deferredUntilTaskId" | "deferredAt" | "deferredReason" | "version"> & {
  changed: string[];
};

/**
 * {@link updateProjectTask}'s rejection shape for a stale-or-omitted `baseVersion` on a title/body write
 * (card d0978321) — mirrors `memory_write`'s `MemoryWriteConflict` exactly, same error text, same
 * "return the current record so the caller can reconcile" contract: one idiom for the same concept
 * across both stores. `current` is the raw current task (not merged/requests-enriched — the caller
 * already has read access via `tasks_get`/`getProjectTask` if it wants that).
 */
export interface TaskUpdateConflict {
  error: string;
  conflict: true;
  current: Task;
}

/**
 * The calling agent session's identity, threaded through {@link updateProjectTask} to (a) stamp the
 * `task_held_cleared` audit event's `managerSessionId` (card 9b0373c0), and (b) — since the repoKey
 * authority fix below — gate a `repoKey` write to a manager/platform actor. `role` was NOT used for
 * authorization before that fix (the doc here used to say so explicitly); it now is, for repoKey ONLY —
 * every other field this function writes stays open to any agent-facing caller, unchanged. This function
 * is reachable ONLY from agent MCP surfaces (see its doc below); the human-only REST route (POST
 * /api/tasks/:id) writes via db.updateTask directly and never reaches this guard (human is the top
 * authority, same posture as the held-clear guard). Omitted (e.g. an existing test calling this directly)
 * falls back to `sessionId: ""` / `role: undefined` — "" mirrors the established "no session was spawned"
 * convention already used by `schedule_fire_deferred`/`schedule_fire_failed`; an undefined role is treated
 * as NOT manager/platform, so a caller that skips this param can never accidentally gain repoKey authority.
 */
export interface TaskUpdateActor {
  sessionId: string;
  role?: string | null;
}

export async function updateProjectTask(
  db: Db, projectId: string, taskId: string,
  patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority" | "held" | "deferred" | "repoKey" | "deferredUntilTaskId" | "deferredReason">>,
  actor?: TaskUpdateActor,
  /**
   * Card d0978321 — the `version` the caller last read for this task (`tasks_get`/`tasks_list`/a prior
   * `tasks_update` response), REQUIRED to write `title`/`body` on an EXISTING task; irrelevant for
   * field-only patches (see the gate below). Mirrors `memory_write`'s `baseVersion` exactly.
   */
  baseVersion?: number,
): Promise<Task | TaskUpdateAck | { error: string } | TaskUpdateConflict> {
  // Guard: the task must belong to this project — and taskId may be a full id OR an unambiguous
  // 8-char id-prefix (card 342e433d). Resolve to the FULL id before writing: `db.updateTask` takes
  // an exact id, so a prefix must never be written straight through.
  const owned = resolveProjectTaskId(db, projectId, taskId);
  if ("error" in owned) return owned;
  const project = db.getProject(projectId);
  // Column-move guard: a move must target a column that EXISTS on this project's board, so a move can never
  // orphan a card onto a non-existent key (the HARD INVARIANT board-column lifecycle code upholds). Applied
  // in the SHARED backing function, so the in-project tasks_update and the cross-project project_task_update
  // honor it identically. Resolved columns (override merged over defaults), so a custom/renamed column works.
  if (patch.columnKey !== undefined) {
    const cols = resolveConfig(project?.config).kanbanColumns;
    if (!cols.some((c) => c.key === patch.columnKey)) {
      return { error: `unknown column "${patch.columnKey}" on this project's board (valid: ${cols.map((c) => c.key).join(", ")})` };
    }
  }
  // repoKey guard (multi-repo epic 49136451, phases 1+2). Three checks, all whole-patch-reject (nothing
  // written, not even other fields in the same patch — same convention as the held-clear guard below):
  //  (a) AUTHORITY (code-review ruling): from phase 2 on, repoKey decides which repo a worktree is cut
  //      from and which gateCommand runs — a DISPATCH decision, and dispatch is the manager's job
  //      everywhere else in Loom (a worker can't spawn, merge, or redirect). Restrict the WRITE to a
  //      manager/platform actor; `tasks_create`'s repoKey is deliberately NOT gated here — a worker filing
  //      a follow-up card on the repo it's already working in is legitimate, this guard is update-only.
  //  (b) the unknown-key check (shared validator, same as create).
  //  (c) TASK-SCOPED RETARGET GUARD (phase 2, widened by Code Review Major 1): a worker's worktree is
  //      physically cut from ONE repo, stamped onto its OWN session (Session.repoKey) at spawn time and
  //      never re-derived from the task afterward (see that field's doc). Retargeting THIS task's repoKey
  //      while a session still holds that worktree on disk (or an undeleted branch) would let a LATER
  //      confirm on that session gate/merge/squash into the OLD repo while ship-state (`resolveMergedInfo`
  //      above) scans the NEW one — the card would then read as never-merged, permanently, with no error
  //      anywhere. `checkTaskRepoKeyRebind` checks this WIDER than mere `process_state='live'` (a rejected
  //      merge or `worker_stop` RETAINS the worktree/branch by design — see its own doc for the reachable
  //      sequence this closes) and is scoped to THIS task ONLY — unlike the project-wide `repos` registry
  //      guard, an UNRELATED task's retained worktree must never block this one's retarget. Exempt a
  //      genuine no-op (the resolved value already matches the task's current repoKey): it changes
  //      nothing, so it can never cause the divergence this guard exists to prevent.
  if (patch.repoKey !== undefined) {
    if (actor?.role !== "manager" && actor?.role !== "platform") {
      return { error: "repoKey is a dispatch decision — only a manager or the Platform Lead may set it, not a worker" };
    }
    const check = resolveRepoKeyOrError(project?.repos ?? [], patch.repoKey);
    if (!check.ok) return { error: check.error };
    if (project && check.value !== (owned.repoKey ?? null)) {
      const retargetCheck = await checkTaskRepoKeyRebind(db, project, owned.id);
      if (!retargetCheck.ok) return { error: retargetCheck.error };
    }
    patch = { ...patch, repoKey: check.value };
  }
  // deferredUntilTaskId guard (card 793ac76d) — set-time validation, whole-patch-reject (same convention
  // as the column/repoKey guards above): a non-null value must resolve to a REAL task on THIS board (full
  // id or an unambiguous prefix — resolveProjectTaskId), and a self-reference is rejected (a card can't
  // un-defer itself). Normalized to the FULL id before it's written: resolveDeferredEffective's read-time
  // lookup does an exact-id db.getTask, so a stored prefix would silently fail to resolve later. `null`
  // (explicit clear) or `undefined` (omit) need no validation — omit is byte-identical to today.
  if (patch.deferredUntilTaskId !== undefined && patch.deferredUntilTaskId !== null) {
    if (patch.deferredUntilTaskId === owned.id) {
      return { error: "deferredUntilTaskId cannot reference the task itself" };
    }
    const blocker = resolveProjectTaskId(db, projectId, patch.deferredUntilTaskId);
    if ("error" in blocker) return { error: `deferredUntilTaskId ${blocker.error}` };
    patch = { ...patch, deferredUntilTaskId: blocker.id };
  }
  // Manual-deferral self-explaining guard (card c90e9525) — whole-patch-reject, same convention as the
  // guards above: `deferred` is a stored verdict with no reason/date attached is exactly the defect this
  // card fixes, so a write that would LEAVE the card manually deferred (deferred:true, no
  // deferredUntilTaskId — route (a) has its own release condition, the named blocker task, and is
  // untouched here) with no reason recorded either before or after this patch is refused outright. A date
  // alone would not satisfy this (the card's own DoD-1 is explicit) — hence a REASON is the thing gated,
  // never just a timestamp. `deferredAt` is never a caller-suppliable field (not in this function's patch
  // type) — it is stamped SERVER-SIDE only, below, so it can never be forged to a false start time.
  const resultingDeferred = patch.deferred !== undefined ? patch.deferred === true : owned.deferred === true;
  const resultingDeferredUntilTaskId = patch.deferredUntilTaskId !== undefined ? patch.deferredUntilTaskId : (owned.deferredUntilTaskId ?? null);
  const isManualDeferral = resultingDeferred && resultingDeferredUntilTaskId == null;
  let deferredReasonPatch: string | null | undefined;
  if (patch.deferredReason !== undefined) {
    const trimmed = patch.deferredReason == null ? null : patch.deferredReason.trim();
    deferredReasonPatch = trimmed && trimmed.length > 0 ? trimmed : null;
  }
  if (patch.deferred === false) {
    // Explicit manual clear — reset deferral provenance, mirrors heldBy resetting on a held clear below.
    deferredReasonPatch = null;
  } else if (isManualDeferral) {
    const resultingReason = deferredReasonPatch !== undefined ? deferredReasonPatch : (owned.deferredReason ?? null);
    if (!resultingReason) {
      return { error: "a manual deferral (deferred:true with no deferredUntilTaskId) needs a reason — pass deferredReason explaining why it's parked and what would release it, so a future reader can tell it apart from a forgotten card" };
    }
  }
  // deferredAt: the instant a manual deferral starts documenting itself — a fresh false→true transition,
  // or the first time real provenance lands on a legacy row that predates these columns (owned.deferredAt
  // is still null). Never touched on a later edit that only updates the reason text on an already-dated
  // row — updatedAt already tracks "last touched"; this field means "since when has it actually been
  // deferred" (see Task.deferredAt's own doc for why updatedAt can't serve that role), so it stays put.
  let deferredAtPatch: string | null | undefined;
  if (patch.deferred === false) {
    deferredAtPatch = null;
  } else if (isManualDeferral && (owned.deferred !== true || !owned.deferredAt)) {
    deferredAtPatch = new Date().toISOString();
  }
  if (deferredReasonPatch !== undefined) patch = { ...patch, deferredReason: deferredReasonPatch };
  // held-clear guard (card 9b0373c0, Platform-Audit bb23d15a): this function is the ONE choke point both
  // agent-facing task-update surfaces share — the in-project `tasks_update` AND the Lead's cross-project
  // `project_task_update` (mcp/platform.ts) — reachable ONLY from an agent MCP session; the human-only
  // REST route (POST /api/tasks/:id) writes via db.updateTask directly and never reaches this guard. A
  // HUMAN-set hold (heldBy:"human") can be cleared ONLY via that REST/UI path: an agent session clearing
  // held:false here is refused outright (whole-patch reject — nothing is written, INCLUDING any other
  // fields in the same patch) whenever the card is currently human-held. An agent clearing its OWN (or
  // any other agent's) agent-set hold is unaffected — `held` stays a freely agent-settable discount
  // signal; only clearing the owner's brake is restricted. The Platform Lead gets NO exemption here
  // (owner decision, card 9b0373c0) — it's a standing, potentially prompt-injectable agent session like
  // any other, so it shares this exact guard rather than a privileged carve-out.
  let heldByPatch: Task["heldBy"] | undefined;
  if (patch.held !== undefined) {
    if (patch.held === false) {
      if (owned.held === true && owned.heldBy === "human") {
        return { error: "held was set by the owner — an agent session cannot clear it; ask the owner to clear it via the board UI" };
      }
      heldByPatch = null; // clearing always resets provenance, whatever it was
    } else {
      // Setting held:true never DOWNGRADES an existing human hold's provenance — otherwise an agent
      // could "refresh" held:true on an already-human-held card to silently reclassify it as
      // agent-held, then clear it on the very next call. Every OTHER held:true here is agent-initiated
      // (this function is agent-only), so it always stamps "agent".
      heldByPatch = owned.held === true && owned.heldBy === "human" ? "human" : "agent";
    }
  }
  const dbPatch0 = heldByPatch !== undefined ? { ...patch, heldBy: heldByPatch } : patch;
  // deferredAt is stamped/reset SERVER-SIDE only (computed above) — merged into the DB write here, never
  // into `patch` itself, so it can never leak into the caller-echoed `changed` list (mirrors heldByPatch's
  // own exclusion from `patch` for the same reason).
  const dbPatch = deferredAtPatch !== undefined ? { ...dbPatch0, deferredAt: deferredAtPatch } : dbPatch0;
  // Optimistic-concurrency gate (card d0978321): a title/body write is the ONLY thing gated — a
  // column/priority/held/deferred/repoKey/deferredUntilTaskId-only patch (the common board-repair case)
  // still needs no baseVersion at all, unaffected by anything below. `patch` (not `dbPatch`) is checked:
  // `heldByPatch` never adds title/body, so the two are equivalent here, but `patch` is the caller's own
  // intent, which is what this gate is actually about.
  const touchesContent = patch.title !== undefined || patch.body !== undefined;
  let updated: Task;
  if (touchesContent) {
    const result = db.updateTaskChecked(owned.id, dbPatch, baseVersion);
    if (!result.ok) {
      if ("notFound" in result) return { error: "task not found (deleted concurrently)" };
      return {
        error: "this task's title/body changed since you last read it (or you never read it) — re-read it " +
          "(tasks_get) and retry with the current version as baseVersion, merging your change into the current body",
        conflict: true,
        current: result.current,
      };
    }
    updated = result.task;
  } else {
    db.updateTask(owned.id, dbPatch);
    updated = { ...owned, ...dbPatch, updatedAt: new Date().toISOString() };
  }
  // Audit trail: a real clear just went through. Only reachable here for an AGENT-set hold — a
  // human-set hold already returned above, so this fires on the DoD's "agent-set-then-agent-clear"
  // path, never on a refused clear.
  if (patch.held === false && owned.held === true) {
    db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: actor?.sessionId ?? "", taskId: owned.id, kind: "task_held_cleared",
      detail: { clearedBy: "agent", previousHeldBy: owned.heldBy ?? null },
    });
  }
  // A patch that doesn't touch `body` doesn't need it echoed back — trim to the small fields. A patch
  // that DOES pass `body` returns the full task (the caller is intentionally editing it and wants to
  // see the result).
  if (patch.body === undefined) {
    const { id, title, columnKey, priority, position, held, deferred, heldBy, repoKey, deferredUntilTaskId, deferredAt, deferredReason, updatedAt, version } = updated;
    return { id, title, columnKey, priority, position, held, deferred, heldBy, repoKey, deferredUntilTaskId, deferredAt, deferredReason, updatedAt, version, changed: Object.keys(patch) };
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
