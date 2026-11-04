import { cacheHitRatio, type SessionUsageHistory, type SessionUsageTask, type SessionUsageTotals } from "@loom/shared";
import type { RelationKind, TaskRef } from "./taskHierarchy";

// PER-PROJECT USAGE, BROKEN DOWN BY TASK — the pure read model behind pages/ProjectUsage.tsx (card
// 30266229; owner item, verbatim: `Add new per project "Usage" tab. - Breakdown usage by tasks and
// related tasks too.`).
//
// The daemon (card 58d5a36f) already answers "how much did each task cost" — `byTask` +
// `orchestrationOverhead` + `unattributed`, a STRICT PARTITION of every in-window sample. What is left,
// and all this module does, is the two shaping rules the owner's "and related tasks too" needs:
//
//   ⭐ CHILDREN ROLL UP INTO THEIR PARENT. `parentId` is a containment edge — a card and its subtasks
//     are mutually exclusive branches of ONE tree — so a parent's number is its own usage plus every
//     descendant's, each descendant counted EXACTLY ONCE (it has one parent, by construction).
//
//   ⛔ A RELATION NEVER ROLLS UP. `blockedBy`/`blocks`/`related`/`discoveredFrom`/`discoveries` are
//     dependency and provenance edges with no containment semantics. Summing one into the viewed task
//     would attribute effort that was never shared — and because relations are not a tree, the same
//     task is reachable from several cards, so a per-view sum double-counts it. They render as separate
//     rows carrying their OWN totals instead.
//
// @decision 30266229 — never fold a relation edge's usage into a task's own total, and never sum a
// child twice by walking both the tree and a relation list. The visible rows must add up to `totals`.

/** Zeroed measures — a parent that has no usage of its OWN but whose children do. */
export function zeroTotals(): SessionUsageTotals {
  return {
    samples: 0, inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, cacheHitRatio: null,
  };
}

/**
 * Sum any number of measure rows, recomputing `cacheHitRatio` from the SUMMED token columns via the
 * shared `cacheHitRatio` — never averaging the inputs' own ratios, which would weight a 3-sample row
 * the same as a 3000-sample one.
 */
export function addTotals(rows: readonly SessionUsageTotals[]): SessionUsageTotals {
  const out = zeroTotals();
  for (const r of rows) {
    out.samples += r.samples;
    out.inputTokens += r.inputTokens;
    out.outputTokens += r.outputTokens;
    out.cacheCreationTokens += r.cacheCreationTokens;
    out.cacheReadTokens += r.cacheReadTokens;
    out.costUsd += r.costUsd;
  }
  out.cacheHitRatio = cacheHitRatio(out);
  return out;
}

/** Every billed token class on a measure row summed — the row's magnitude, for the meter + the sort. */
export function taskTotalTokens(t: SessionUsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
}

/** What the tree needs to know about a board card: its name, its lane, and who its parent is. */
export type UsageTaskMeta = { id: string; title: string; columnKey: string; parentId: string | null };

/** One node of the task-usage tree. */
export type UsageTaskNode = {
  taskId: string;
  /** The card's title — from the usage row, else the board row, else null for a card since deleted. */
  title: string | null;
  columnKey: string | null;
  /** This task's OWN usage (zeroed for a parent that only contains usage). */
  own: SessionUsageTotals;
  /** This task + every descendant, each counted once. Equals `own` for a leaf. */
  rolled: SessionUsageTotals;
  children: UsageTaskNode[];
  /** Descendants with usage rows, at any depth — what the expand affordance is gated on. */
  descendantsWithUsage: number;
};

/** A relation edge's own usage — NEVER added into the viewed task's number. */
export type UsageRelationRow = { kind: RelationKind; ref: TaskRef; totals: SessionUsageTotals };

// How far a parent chain is walked before it is treated as unresolvable. The board caps real hierarchies
// at two levels below a top card, so this is only a cycle/corruption bound — a `parentId` loop would
// otherwise spin forever inside a render.
const MAX_PARENT_DEPTH = 16;

/**
 * Build the task-usage tree from the daemon's `byTask` rows plus the project's own board cards.
 *
 * The BOARD is what supplies parentage (a usage row carries only a task id), and it also supplies a
 * title for a parent that has no usage of its own. A task whose parent is not on the board — deleted,
 * or simply not loaded — is kept as a ROOT rather than dropped: losing a card's usage because its
 * parent is missing would silently shrink the total.
 *
 * Roots are the nodes with no resolvable parent. `Σ roots.rolled` is therefore exactly `Σ byTask`.
 */
export function buildTaskUsageTree(
  byTask: readonly SessionUsageTask[],
  tasks: readonly UsageTaskMeta[],
): UsageTaskNode[] {
  const meta = new Map<string, UsageTaskMeta>();
  for (const t of tasks) meta.set(t.id, t);

  const nodes = new Map<string, UsageTaskNode>();
  const node = (taskId: string, usage?: SessionUsageTask): UsageTaskNode => {
    const existing = nodes.get(taskId);
    if (existing) {
      // A parent synthesized by a child's walk, now reached by its own usage row (or vice versa): fill
      // in whichever half is missing rather than minting a second node for the same card.
      if (usage) {
        existing.own = usageMeasures(usage);
        existing.title = usage.taskTitle ?? existing.title;
        existing.columnKey = usage.taskColumnKey ?? existing.columnKey;
      }
      return existing;
    }
    const m = meta.get(taskId) ?? null;
    const fresh: UsageTaskNode = {
      taskId,
      title: usage?.taskTitle ?? m?.title ?? null,
      columnKey: usage?.taskColumnKey ?? m?.columnKey ?? null,
      own: usage ? usageMeasures(usage) : zeroTotals(),
      rolled: zeroTotals(),
      children: [],
      descendantsWithUsage: 0,
    };
    nodes.set(taskId, fresh);
    return fresh;
  };

  // Pass 1 — a node per usage row, then its parent chain, so a parent with no usage of its own still
  // gets a node to roll into. De-duplicated through `nodes`, so a shared parent is created once.
  for (const row of byTask) node(row.taskId, row);
  // A card's parent, as far as THIS tree is concerned: null unless the board knows the parent card too
  // (an unknown parent makes the child a root — see this function's own doc).
  const declaredParent = (id: string): string | null => {
    const p = meta.get(id)?.parentId ?? null;
    return p != null && p !== id && meta.has(p) ? p : null;
  };
  const parentOf = new Map<string, string | null>();
  // Snapshot the keys: the walk below mints ancestor nodes, and every one of them is covered by the
  // walk that created it, so re-iterating them would be redundant.
  for (const id of [...nodes.keys()]) {
    // Already resolved by an earlier walk that passed through it. Re-walking is not merely wasted work:
    // in a `parentId` CYCLE the second walk would overwrite the first walk's deliberate `null` with the
    // edge that closes the loop, leaving every node in the cycle parented and the whole cycle unreachable
    // from any root — i.e. its usage silently dropped from the page. Measured, before this guard.
    if (parentOf.has(id)) continue;
    let cur = id;
    // The ancestors already on THIS walk. A `parentId` that points back into them is corruption, not a
    // hierarchy — it becomes a root rather than a cycle the roll-up would recurse through forever.
    const path = new Set<string>([cur]);
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
      const p = declaredParent(cur);
      const usable = p != null && !path.has(p) ? p : null;
      parentOf.set(cur, usable);
      if (usable == null) break;
      path.add(usable);
      node(usable);
      cur = usable;
      // Already walked from another child — its own chain above is resolved, so stop here.
      if (parentOf.has(cur)) break;
    }
  }

  // Pass 2 — wire children. Declaration order is irrelevant here; the caller sorts.
  const roots: UsageTaskNode[] = [];
  for (const [id, n] of nodes) {
    const p = parentOf.get(id) ?? null;
    const parent = p != null ? nodes.get(p) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }

  // Pass 3 — roll up, depth-first. `seen` is belt and braces over the cycle guard above: a node is
  // summed at most once no matter what shape pass 1 produced.
  const seen = new Set<string>();
  const roll = (n: UsageTaskNode): void => {
    if (seen.has(n.taskId)) { n.rolled = n.own; return; }
    seen.add(n.taskId);
    let withUsage = 0;
    for (const c of n.children) {
      roll(c);
      withUsage += c.descendantsWithUsage + (c.own.samples > 0 ? 1 : 0);
    }
    n.descendantsWithUsage = withUsage;
    n.rolled = addTotals([n.own, ...n.children.map((c) => c.rolled)]);
  };
  for (const r of roots) roll(r);
  return roots;
}

/** The measure half of a `byTask` row, without its task identity. */
function usageMeasures(row: SessionUsageTask): SessionUsageTotals {
  return {
    samples: row.samples,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    costUsd: row.costUsd,
    cacheHitRatio: row.cacheHitRatio,
  };
}

/** Flatten a node and its descendants in render order (parent, then each child's subtree). */
export function flattenTree(nodes: readonly UsageTaskNode[]): UsageTaskNode[] {
  const out: UsageTaskNode[] = [];
  const walk = (n: UsageTaskNode) => { out.push(n); for (const c of n.children) walk(c); };
  for (const n of nodes) walk(n);
  return out;
}

/** `taskId → that task's ROLLED subtree total`, so a relation row quotes the same number the task's own
 *  row shows. Absent id ⇒ the task has no usage in this window at all. */
export function rolledByTaskId(nodes: readonly UsageTaskNode[]): Map<string, SessionUsageTotals> {
  const out = new Map<string, SessionUsageTotals>();
  for (const n of flattenTree(nodes)) out.set(n.taskId, n.rolled);
  return out;
}

export type UsageSortKey = "cost" | "tokens";

/** Rank a level of the tree by the chosen measure — recursively, so a child list reads the same way. */
export function sortTree(nodes: readonly UsageTaskNode[], by: UsageSortKey): UsageTaskNode[] {
  const cmp = (a: UsageTaskNode, b: UsageTaskNode) => by === "cost"
    ? (b.rolled.costUsd - a.rolled.costUsd || taskTotalTokens(b.rolled) - taskTotalTokens(a.rolled))
    : (taskTotalTokens(b.rolled) - taskTotalTokens(a.rolled) || b.rolled.costUsd - a.rolled.costUsd);
  return [...nodes].sort(cmp).map((n) => ({ ...n, children: sortTree(n.children, by) }));
}

/**
 * The three buckets that must ADD UP to the window's grand total, plus whatever does not.
 *
 * The daemon guarantees the partition, so `residual` is zero on every healthy response. It is computed
 * and surfaced anyway: a tab whose stated claim is "the visible rows add up to the total" must be able
 * to SHOW a discrepancy rather than quietly presenting rows that do not sum, which is exactly what a
 * reader cannot detect by eye across four separate figures.
 */
export type UsagePartition = {
  tasks: SessionUsageTotals;
  overhead: SessionUsageTotals;
  unattributed: SessionUsageTotals;
  total: SessionUsageTotals;
  /** `total − (tasks + overhead + unattributed)`, per column. Zero on a healthy response. */
  residual: SessionUsageTotals;
  /** True when every column of `residual` is zero — the claim the disclosure makes. */
  balanced: boolean;
  /** False when the response carried no task breakdown at all (an unscoped or unknown-project read). */
  present: boolean;
};

export function usagePartition(history: SessionUsageHistory | undefined): UsagePartition {
  const total = history?.totals ?? zeroTotals();
  // The three ride TOGETHER by contract — `byTask` present without the other two is not a shape the
  // route can return — so one check gates all three rather than three independent fallbacks that would
  // silently report a lossy partition as a balanced one.
  const present = history != null && history.byTask != null
    && history.orchestrationOverhead != null && history.unattributed != null;
  const tasks = addTotals(history?.byTask ?? []);
  const overhead = history?.orchestrationOverhead ?? zeroTotals();
  const unattributed = history?.unattributed ?? zeroTotals();
  const residual: SessionUsageTotals = {
    samples: total.samples - tasks.samples - overhead.samples - unattributed.samples,
    inputTokens: total.inputTokens - tasks.inputTokens - overhead.inputTokens - unattributed.inputTokens,
    outputTokens: total.outputTokens - tasks.outputTokens - overhead.outputTokens - unattributed.outputTokens,
    cacheCreationTokens: total.cacheCreationTokens - tasks.cacheCreationTokens - overhead.cacheCreationTokens - unattributed.cacheCreationTokens,
    cacheReadTokens: total.cacheReadTokens - tasks.cacheReadTokens - overhead.cacheReadTokens - unattributed.cacheReadTokens,
    // Cost is a float sum, so an exact-equality residual would read as "unbalanced" off a rounding
    // artifact. Snapped to the cent the UI actually renders.
    costUsd: Math.round((total.costUsd - tasks.costUsd - overhead.costUsd - unattributed.costUsd) * 100) / 100,
    cacheHitRatio: null,
  };
  const balanced = residual.samples === 0 && residual.inputTokens === 0 && residual.outputTokens === 0
    && residual.cacheCreationTokens === 0 && residual.cacheReadTokens === 0 && residual.costUsd === 0;
  return { tasks, overhead, unattributed, total, residual, balanced, present };
}

/** The relation kinds the tab draws as separate rows, in the order it draws them. `discoveredFrom` and
 *  `discoveries` are provenance ("this card came out of that one"), which is still a different card's
 *  work and so is shown the same way — as its own row, never merged. */
export const USAGE_RELATION_KINDS: RelationKind[] = ["blockedBy", "blocks", "related", "discoveredFrom", "discoveries"];

/** Human label per relation kind — the row's only explanation of WHY another card is listed here. */
export const USAGE_RELATION_LABEL: Record<RelationKind, string> = {
  blockedBy: "blocked by",
  blocks: "blocks",
  related: "related",
  discoveredFrom: "discovered from",
  discoveries: "discovered",
};

/**
 * One row per relation edge, carrying that other card's OWN rolled total.
 *
 * De-duplicated by (kind, id) and with the viewed task itself excluded, so a self-edge or a repeated
 * edge cannot make the same number appear twice under one card. A card that appears under two DIFFERENT
 * kinds legitimately gets a row each — the kinds answer different questions — which is safe precisely
 * because none of these rows is ever summed into anything.
 */
export function relationRows(
  taskId: string,
  relations: Record<RelationKind, TaskRef[]>,
  rolled: Map<string, SessionUsageTotals>,
): UsageRelationRow[] {
  const out: UsageRelationRow[] = [];
  for (const kind of USAGE_RELATION_KINDS) {
    const seen = new Set<string>();
    for (const ref of relations[kind] ?? []) {
      if (ref.id === taskId || seen.has(ref.id)) continue;
      seen.add(ref.id);
      out.push({ kind, ref, totals: rolled.get(ref.id) ?? zeroTotals() });
    }
  }
  return out;
}
