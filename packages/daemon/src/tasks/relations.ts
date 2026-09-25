import { z } from "zod";
import type { Task, TaskRelationRef, TaskRelationType, TaskRelationView } from "@loom/shared";
import { TASK_CHILDREN_ITEMS_CAP, columnKeyForRole, resolveConfig } from "@loom/shared";
import type { Db, TaskRelationRow } from "../db.js";
import { edgesAfterPatch, isLiveEdge, type EdgeBits } from "./edge-state.js";
import { resolveIdPrefix } from "../id-prefix.js";

// Card 3df86c87 — task parent links + blocks/related/discovered-from relations. The contract, the
// blocks-vs-deferredUntilTaskId decision and every "Do not" live in
// docs/decisions/3df86c87-task-parent-and-relations-blocks-vs-deferreduntiltaskid.md.
// @decision 3df86c87 — a `blocks` edge's resolution is DERIVED here at read time (never stored, never
// converted to `related`); a plain edge never sets `deferred`, only a gates_deferral edge does.

/** A top card is depth 0; a card may sit at most this many levels below it (epic → task → subtask). */
export const MAX_PARENT_DEPTH = 2;

/** The structure fields accepted on create/update (MCP tools and the human REST routes share them). */
export interface TaskStructureInput {
  parentId?: string | null;
  blockedBy?: string[];
  blocks?: string[];
  related?: string[];
  discoveredFrom?: string | null;
}

/** The zod input fields the UPDATE tools (tasks_update, project_task_update) share (card 3df86c87). */
export const TASK_STRUCTURE_SHAPE = {
  parentId: z.string().nullable().optional(),
  blockedBy: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  discoveredFrom: z.string().nullable().optional(),
};

/** The CREATE tools' (tasks_create, project_task_create) structure fields: no `related` here — a new card
 *  declares related cards through the existing `relatedTo` (a string or an array of ids). */
export const TASK_CREATE_STRUCTURE_SHAPE = {
  parentId: z.string().nullable().optional(),
  blockedBy: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  discoveredFrom: z.string().nullable().optional(),
};

const RELEASED_NOTE = " Items with `released:true` in a read's blockedBy/blocks are history (a deferral that auto-released): don't send them back.";

const STRUCTURE_DOC_HEAD = " PARENT + RELATIONS (card 3df86c87): `parentId` (a full id or 8-char prefix; null makes the card top-level) puts this card under a parent on the SAME board — at most 2 levels below a top card (epic → task → subtask), no cycles; there is no type field, an \"epic\" is just a card with children. `blockedBy` (array of ids: cards that must finish first), `blocks` (array: cards this one blocks)";
const STRUCTURE_DOC_TAIL = " and `discoveredFrom` (one id: the card you were working when you found this follow-up; null clears) create typed relations, same board only. A `blockedBy` edge stops blocking on its own once the blocker reaches the terminal lane or is merged (derived at read time — nothing to clean up); it never sets `deferred` (use deferredUntilTaskId for \"park this card until X merges\"). Every invalid parent/relation — including a blocks cycle formed by ANY combination of blockedBy/blocks/deferredUntilTaskId in the same call — is rejected with an error saying what would work, and NOTHING in the call is written.";

/** Description text for the UPDATE tools' structure params: each is a whole-set REPLACE of its relation kind. */
export const TASK_STRUCTURE_DOC = STRUCTURE_DOC_HEAD + ", `related` (array)" + STRUCTURE_DOC_TAIL + " On an UPDATE each of parentId/blockedBy/blocks/related/discoveredFrom is a whole-set REPLACE of that relation kind — so when you read a card (tasks_get) and write back \"the current ids + one more\", leave out any blockedBy/blocks item marked `released:true`: those are auto-released deferral HISTORY, not declared dependencies, and sending them back would re-declare them as live edges." + RELEASED_NOTE;

/** Description text for the CREATE tools' structure params (`relatedTo`, not `related`, declares related cards). */
export const TASK_CREATE_STRUCTURE_DOC = STRUCTURE_DOC_HEAD + STRUCTURE_DOC_TAIL + " `relatedTo` (a task id or an array of ids) creates real `related` relations to existing cards." + RELEASED_NOTE;

export const hasStructureInput = (i: TaskStructureInput | undefined): boolean =>
  !!i && (i.parentId !== undefined || i.blockedBy !== undefined || i.blocks !== undefined || i.related !== undefined || i.discoveredFrom !== undefined);

/**
 * Is `blocker` still blocking? OPEN while it exists, is not in the terminal-role column, and has no merged
 * ship-state. A card closed with 0 commits is terminal, so it RESOLVES a plain edge (unlike the deferral
 * alias, which stays `deferredStuck` — docs/decisions/93669813). `mergedSha` is the persisted cache; a
 * merged card is always in the terminal column, so the cache never lets a truly-open blocker read resolved.
 * A missing blocker is RESOLVED — a dangling edge must never read as a false block.
 */
export function isOpenBlocker(blocker: Pick<Task, "columnKey" | "mergedSha"> | undefined, terminalKey: string | undefined): boolean {
  if (!blocker) return false;
  return !isCardDone(blocker, terminalKey);
}

/** THE "done" predicate (card 3df86c87): in the terminal-role lane, or carrying a persisted merged ship-state.
 *  Used by isOpenBlocker (resolution), the board roll-up's childDone and the view's children.done — one copy. */
export function isCardDone(t: Pick<Task, "columnKey" | "mergedSha">, terminalKey: string | undefined): boolean {
  return (!!terminalKey && t.columnKey === terminalKey) || !!t.mergedSha;
}

const terminalKeyFor = (db: Db, projectId: string): string | undefined =>
  columnKeyForRole(resolveConfig(db.getProject(projectId)?.config).kanbanColumns, "terminal");

/** Per-task open-blocker roll-up: edge order = creation order, so `first` is stable. */
export interface OpenBlockers { count: number; first: { id: string; title: string } | null }

export function openBlockersByTask(tasks: Task[], edges: TaskRelationRow[], terminalKey: string | undefined): Map<string, OpenBlockers> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, OpenBlockers>();
  for (const e of edges) {
    if (e.type !== "blocks" || !isLiveEdge({ declared: e.declared, gates: e.gatesDeferral })) continue; // a released edge is history, not a dependency
    const blocker = byId.get(e.fromTaskId);
    if (!isOpenBlocker(blocker, terminalKey)) continue;
    const cur = out.get(e.toTaskId) ?? { count: 0, first: null };
    cur.count++;
    if (!cur.first && blocker) cur.first = { id: blocker.id, title: blocker.title };
    out.set(e.toTaskId, cur);
  }
  return out;
}

/** Board-list roll-up fields for every task in one project (one edge query, no per-row work). */
export function boardRollup(db: Db, projectId: string, tasks: Task[]): Map<string, { childCount: number; childDone: number; blockedByOpen: number; blockedByFirst: OpenBlockers["first"] }> {
  const terminalKey = terminalKeyFor(db, projectId);
  const open = openBlockersByTask(tasks, db.listRelations(projectId), terminalKey);
  const kids = new Map<string, { total: number; done: number }>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const k = kids.get(t.parentId) ?? { total: 0, done: 0 };
    k.total++;
    if (isCardDone(t, terminalKey)) k.done++;
    kids.set(t.parentId, k);
  }
  const out = new Map<string, { childCount: number; childDone: number; blockedByOpen: number; blockedByFirst: OpenBlockers["first"] }>();
  for (const t of tasks) {
    const k = kids.get(t.id);
    const o = open.get(t.id);
    out.set(t.id, { childCount: k?.total ?? 0, childDone: k?.done ?? 0, blockedByOpen: o?.count ?? 0, blockedByFirst: o?.first ?? null });
  }
  return out;
}

/** The full parent/children/relations view of ONE task (`GET /api/tasks/:id`, `tasks_get`). */
export function buildRelationView(db: Db, task: Task): TaskRelationView {
  const tasks = db.listTasks(task.projectId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const terminalKey = terminalKeyFor(db, task.projectId);
  const edges = db.listRelations(task.projectId);
  const ref = (id: string, withResolved: boolean, releasedOnly = false): TaskRelationRef | undefined => {
    const t = byId.get(id);
    if (!t) return undefined; // a dangling id has nothing to show
    return withResolved
      ? { id: t.id, title: t.title, columnKey: t.columnKey, resolved: releasedOnly || !isOpenBlocker(t, terminalKey), ...(releasedOnly ? { released: true as const } : {}) }
      : { id: t.id, title: t.title, columnKey: t.columnKey };
  };
  const releasedOnly = (e: TaskRelationRow) => e.released && !isLiveEdge({ declared: e.declared, gates: e.gatesDeferral });
  const pick = (list: Array<TaskRelationRef | undefined>): TaskRelationRef[] => list.filter((x): x is TaskRelationRef => !!x);
  const parent = task.parentId ? byId.get(task.parentId) : undefined;
  const kids = tasks.filter((t) => t.parentId === task.id);
  return {
    parentId: task.parentId ?? null,
    parent: parent ? { id: parent.id, title: parent.title, columnKey: parent.columnKey } : null,
    children: {
      done: kids.filter((k) => isCardDone(k, terminalKey)).length,
      total: kids.length,
      items: kids.slice(0, TASK_CHILDREN_ITEMS_CAP).map((t) => ({ id: t.id, title: t.title, columnKey: t.columnKey, priority: t.priority })),
    },
    relations: {
      blockedBy: pick(edges.filter((e) => e.type === "blocks" && e.toTaskId === task.id).map((e) => ref(e.fromTaskId, true, releasedOnly(e)))),
      blocks: pick(edges.filter((e) => e.type === "blocks" && e.fromTaskId === task.id).map((e) => ref(e.toTaskId, true, releasedOnly(e)))),
      related: pick(edges.filter((e) => e.type === "related" && (e.fromTaskId === task.id || e.toTaskId === task.id)).map((e) => ref(e.fromTaskId === task.id ? e.toTaskId : e.fromTaskId, false))),
      discoveredFrom: pick(edges.filter((e) => e.type === "discovered-from" && e.fromTaskId === task.id).map((e) => ref(e.toTaskId, false))),
      discoveries: pick(edges.filter((e) => e.type === "discovered-from" && e.toTaskId === task.id).map((e) => ref(e.fromTaskId, false))),
    },
  };
}

// ---- validation + apply -------------------------------------------------------------------------------

type Ref = { task: Task } | { error: string };

/** Resolve one task ref (full id or unambiguous 8-char prefix) against THIS project's board. */
function resolveRef(db: Db, tasks: Task[], projectId: string, raw: string, field: string): Ref {
  const r = resolveIdPrefix(tasks, raw);
  if (r.kind === "found") return { task: r.record };
  if (r.kind === "ambiguous") return { error: `${field}: ambiguous task id-prefix '${raw}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` };
  const elsewhere = resolveIdPrefix(db.listAllProjects().filter((p) => p.id !== projectId).flatMap((p) => db.listTasks(p.id)), raw);
  if (elsewhere.kind !== "none") {
    return { error: `${field}: task '${raw}' is on another project's board — parents and relations are same-project only; create or file the card on this project's board, or drop it from ${field}` };
  }
  return { error: `${field}: task '${raw}' not found in this project — check the id (full id or an unambiguous 8-char prefix)` };
}

function resolveAll(db: Db, tasks: Task[], projectId: string, raws: string[] | undefined, field: string): { tasks: Task[] } | { error: string } {
  const out: Task[] = [];
  for (const raw of raws ?? []) {
    const r = resolveRef(db, tasks, projectId, raw, field);
    if ("error" in r) return r;
    if (!out.some((t) => t.id === r.task.id)) out.push(r.task);
  }
  return { tasks: out };
}

function depthOf(byId: Map<string, Task>, id: string): number {
  let d = 0;
  let cur = byId.get(id)?.parentId ?? null;
  const seen = new Set<string>([id]);
  while (cur && !seen.has(cur)) { d++; seen.add(cur); cur = byId.get(cur)?.parentId ?? null; }
  return d;
}

function heightOf(kidsOf: Map<string, Task[]>, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  let h = 0;
  for (const k of kidsOf.get(id) ?? []) h = Math.max(h, 1 + heightOf(kidsOf, k.id, seen));
  return h;
}

function isDescendant(kidsOf: Map<string, Task[]>, ancestorId: string, id: string): boolean {
  const stack = [...(kidsOf.get(ancestorId) ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const t = stack.pop()!;
    if (t.id === id) return true;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    stack.push(...(kidsOf.get(t.id) ?? []));
  }
  return false;
}

/** Path `from` → … → `to` over `blocks` edges (blocker → blocked), or undefined. */
function blocksPath(adj: Map<string, string[]>, from: string, to: string): string[] | undefined {
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set<string>([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) {
      const path = [to];
      let p = to;
      while (p !== from) { p = prev.get(p)!; path.unshift(p); }
      return path;
    }
    for (const nxt of adj.get(cur) ?? []) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, cur);
      queue.push(nxt);
    }
  }
  return undefined;
}

const short = (id: string) => id.slice(0, 8);

/** A VALIDATED structure patch: resolved full ids only. `planTaskStructure` is the ONLY producer and
 *  `applyTaskPlan` executes it without re-validating — validation happens exactly once, against the COMBINED
 *  proposed graph, so a plan can never half-apply (card 3df86c87 review, Major 1). */
export interface StructurePlan {
  parent?: { set: string | null };
  blockedBy?: string[];
  blocks?: string[];
  related?: string[];
  discoveredFrom?: string | null;
}

const NEW_NODE = "(this new card)";

/**
 * Resolve + validate a structure patch WHOLE-PATCH and return the plan (nothing is written). `taskId` is
 * `undefined` for a card being CREATED (a synthetic node stands in for it in the graph, so cycle/self
 * checks run on create too). `deferral` is the RESOLVED full-id set the same call proposes for the
 * deferredUntilTaskId alias (`undefined` = untouched, `null`/[] = clear): its edges are blocks edges, so they
 * are part of the same combined graph. Every error says what WOULD work.
 * The cycle check runs over ALL edges, resolved ones included: a resolved edge re-opens when its blocker
 * leaves the terminal lane, so a cycle through one is still a cycle.
 */
export function planTaskStructure(
  db: Db, projectId: string, taskId: string | undefined, input: TaskStructureInput, deferral?: string[] | null,
): { plan: StructurePlan } | { error: string } {
  const tasks = db.listTasks(projectId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kidsOf = new Map<string, Task[]>();
  for (const t of tasks) if (t.parentId) kidsOf.set(t.parentId, [...(kidsOf.get(t.parentId) ?? []), t]);
  const plan: StructurePlan = {};

  if (input.parentId !== undefined) {
    if (input.parentId === null) {
      plan.parent = { set: null };
    } else {
      const p = resolveRef(db, tasks, projectId, input.parentId, "parentId");
      if ("error" in p) return p;
      if (taskId && p.task.id === taskId) return { error: "parentId cannot be the card itself — pick a different parent, or pass null to make it a top-level card" };
      if (taskId && isDescendant(kidsOf, taskId, p.task.id)) {
        return { error: `parentId: ${short(p.task.id)} is a descendant of ${short(taskId)}, so this would create a cycle — pick a parent outside this card's own subtree` };
      }
      const height = taskId ? heightOf(kidsOf, taskId) : 0;
      const pDepth = depthOf(byId, p.task.id);
      if (pDepth + 1 + height > MAX_PARENT_DEPTH) {
        const grand = p.task.parentId ? ` — attach it to ${short(p.task.parentId)} (its own parent) instead, or make it a top-level card (parentId:null)` : "";
        return { error: `parentId: too deep — ${short(p.task.id)} sits ${pDepth} level(s) below its top card and this card carries ${height} level(s) of its own children; at most ${MAX_PARENT_DEPTH} levels below a top card are allowed (epic → task → subtask)${grand}` };
      }
      plan.parent = { set: p.task.id };
    }
  }

  const bb = resolveAll(db, tasks, projectId, input.blockedBy, "blockedBy");
  if ("error" in bb) return bb;
  const bl = resolveAll(db, tasks, projectId, input.blocks, "blocks");
  if ("error" in bl) return bl;
  const rel = resolveAll(db, tasks, projectId, input.related, "related");
  if ("error" in rel) return rel;
  let df: Task | null | undefined;
  if (input.discoveredFrom !== undefined) {
    if (input.discoveredFrom === null) df = null;
    else { const r = resolveRef(db, tasks, projectId, input.discoveredFrom, "discoveredFrom"); if ("error" in r) return r; df = r.task; }
  }
  for (const [field, list] of [["blockedBy", bb.tasks], ["blocks", bl.tasks], ["related", rel.tasks]] as const) {
    if (taskId && list.some((t) => t.id === taskId)) return { error: `${field} cannot include the card itself — list other cards` };
  }
  if (taskId && df && df.id === taskId) return { error: "discoveredFrom cannot be the card itself — name the card this one was discovered while working" };

  // ONE combined-graph blocks-cycle check on the EXACT post-patch graph: the same pure edgesAfterPatch the
  // writers use (edge present iff declared || gates after this call's replacements), so what is validated is what
  // gets written. Any new cycle must pass through this card.
  if (input.blockedBy !== undefined || input.blocks !== undefined || deferral !== undefined) {
    const T = taskId ?? NEW_NODE;
    const rows: EdgeBits[] = taskId
      ? db.listRelations(projectId).filter((e) => e.type === "blocks").map((e) => ({ from: e.fromTaskId, to: e.toTaskId, declared: e.declared, gates: e.gatesDeferral, released: e.released }))
      : [];
    const after = edgesAfterPatch(rows, {
      taskId: T,
      ...(input.blockedBy !== undefined ? { blockedBy: bb.tasks.map((t) => t.id) } : {}),
      ...(input.blocks !== undefined ? { blocks: bl.tasks.map((t) => t.id) } : {}),
      ...(deferral !== undefined ? { deferral: deferral ?? [] } : {}),
    });
    const adj = new Map<string, string[]>();
    for (const e of after) if (isLiveEdge(e)) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    for (const n of adj.get(T) ?? []) {
      const path = blocksPath(adj, n, T);
      if (path) {
        const names = [T, ...path].map((x) => (x === NEW_NODE ? "this card" : short(x))).join(" → ");
        return { error: `blocks cycle (${names}) — drop one of the edges (blockedBy / blocks / deferredUntilTaskId), or use "related" if the cards are only connected` };
      }
    }
  }

  if (input.blockedBy !== undefined) plan.blockedBy = bb.tasks.map((t) => t.id);
  if (input.blocks !== undefined) plan.blocks = bl.tasks.map((t) => t.id);
  if (input.related !== undefined) plan.related = rel.tasks.map((t) => t.id);
  if (input.discoveredFrom !== undefined) plan.discoveredFrom = df ? df.id : null;
  return { plan };
}

/**
 * Resolve + sanity-check a RAW `deferredUntilTaskId` value (bare id, array, null) into full ids, with the same
 * rules the agent-facing updateProjectTask applies: no empty array, no self reference, every id must resolve on
 * THIS board. `ids:null` means "clear". Used by the human REST update route so a raw deferredUntilTaskId can
 * never reach the db unvalidated.
 */
export function resolveDeferralInput(db: Db, projectId: string, taskId: string, raw: string | string[] | null): { ids: string[] | null } | { error: string } {
  if (raw === null) return { ids: null };
  const raws = Array.isArray(raw) ? raw : [raw];
  if (raws.length === 0) return { error: "deferredUntilTaskId cannot be an empty array — omit the field, or pass null to clear an existing pairing" };
  const tasks = db.listTasks(projectId);
  const ids: string[] = [];
  for (const r of raws) {
    if (r === taskId) return { error: "deferredUntilTaskId cannot reference the task itself" };
    const resolved = resolveRef(db, tasks, projectId, r, "deferredUntilTaskId");
    if ("error" in resolved) return resolved;
    if (resolved.task.id === taskId) return { error: "deferredUntilTaskId cannot reference the task itself" };
    if (!ids.includes(resolved.task.id)) ids.push(resolved.task.id);
  }
  return { ids };
}

/**
 * Execute a plan from {@link planTaskStructure} against an EXISTING card. It never re-validates and never
 * returns an error: callers run it in the SAME transaction as the card's own row write, so either everything
 * lands or nothing does. Replace semantics: `blockedBy` replaces the DECLARED bit of the card's incoming blocks edges
 * (the gates_deferral bit belongs to deferredUntilTaskId and is untouched), `blocks` the declared bit of its
 * outgoing ones, `related` every related edge touching it, `discoveredFrom` its outgoing discovered-from edge.
 */
export function applyTaskPlan(db: Db, projectId: string, taskId: string, plan: StructurePlan): void {
  db.runInTransaction(() => {
    const edges = db.listRelations(projectId);
    if (plan.parent) db.setTaskParent(taskId, plan.parent.set);
    if (plan.blockedBy || plan.blocks) db.applyBlocksPatch(projectId, { taskId, blockedBy: plan.blockedBy, blocks: plan.blocks });
    if (plan.related) {
      for (const e of edges.filter((x) => x.type === "related" && (x.fromTaskId === taskId || x.toTaskId === taskId))) {
        const other = e.fromTaskId === taskId ? e.toTaskId : e.fromTaskId;
        if (!plan.related.includes(other)) db.deleteRelation(e.fromTaskId, e.toTaskId, "related");
      }
      for (const o of plan.related) { const [a, b] = taskId < o ? [taskId, o] : [o, taskId]; db.insertRelation(projectId, a, b, "related"); }
    }
    if (plan.discoveredFrom !== undefined) {
      for (const e of edges.filter((x) => x.type === "discovered-from" && x.fromTaskId === taskId && x.toTaskId !== plan.discoveredFrom)) db.deleteRelation(e.fromTaskId, e.toTaskId, "discovered-from");
      if (plan.discoveredFrom) db.insertRelation(projectId, taskId, plan.discoveredFrom, "discovered-from");
    }
  });
}

export type { TaskRelationType };
