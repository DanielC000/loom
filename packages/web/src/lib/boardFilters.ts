import type { BoardTask, QuestionInboxItem } from "@loom/shared";

// The board's card-DETAIL filters (card cea577af). They replaced per-column chips: a lane already shows
// which column a card is in, so filtering by it only re-said what the layout says. Everything here reads
// fields the board response (or an already-cached app-wide query) carries, so filtering costs no request.

/** The bucket for a title that is not in `type(scope): summary` form. */
export const OTHER_TYPE = "other";

// `type`, an optional `(scope)`, an optional breaking `!`, then the colon. Lowercased so a stray
// `Fix(web):` still lands with `fix` rather than inventing a second bucket.
const CONVENTIONAL = /^([a-z]+)(\([^)]*\))?!?:/i;

/** The Conventional-Commits type a card's title declares, or {@link OTHER_TYPE}. */
export function commitType(title: string): string {
  const m = CONVENTIONAL.exec(title.trim());
  return m?.[1] ? m[1].toLowerCase() : OTHER_TYPE;
}

// The order the Type chips render in: the common types first, in the order CLAUDE.md lists them, then
// anything else alphabetically, then "other" last. Only types that actually occur get a chip.
const TYPE_ORDER = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
export function sortTypes(types: Iterable<string>): string[] {
  const rank = (t: string) => (t === OTHER_TYPE ? 2 : TYPE_ORDER.includes(t) ? 0 : 1);
  return [...new Set(types)].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0 ? TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b) : a.localeCompare(b)));
}

/** The State group. Each is a yes/no fact about one card. */
export type CardState = "held" | "deferred" | "policy" | "request" | "blocked";
export const CARD_STATES: { key: CardState; label: string; aria: string }[] = [
  { key: "held", label: "held", aria: "held cards (the owner's brake)" },
  { key: "deferred", label: "deferred", aria: "deferred cards (a manager's sequencing marker)" },
  { key: "policy", label: "policy unmet", aria: "cards with an unmet card-policy requirement" },
  { key: "request", label: "awaiting request", aria: "cards with a pending Request" },
  { key: "blocked", label: "blocked by card", aria: "cards with an open blocker card" },
];

/** What a state check needs beyond the card row itself. */
export type StateContext = {
  /** Per-card count of policy requirements that would block it today (useCardPolicyStatus). */
  policyBlocking: (taskId: string) => number;
  /** Ids of cards with at least one PENDING Request (see {@link pendingRequestTaskIds}). */
  pendingRequest: Set<string>;
};

export function hasState(task: BoardTask, state: CardState, ctx: StateContext): boolean {
  switch (state) {
    case "held": return !!task.held;
    case "deferred": return !!task.deferred;
    case "policy": return ctx.policyBlocking(task.id) > 0;
    case "request": return ctx.pendingRequest.has(task.id);
    case "blocked": return (task.blockedByOpen ?? 0) > 0;
  }
}

/**
 * The cards of `projectId` with a pending Request, resolved to FULL card ids. Same matching as the card
 * dialog's connected-requests rail: scoped by project AND task, plus the legacy 8-char id-PREFIX rows
 * filed before `question_ask` stored the resolved full id.
 */
export function pendingRequestTaskIds(questions: QuestionInboxItem[], projectId: string, taskIds: string[]): Set<string> {
  const out = new Set<string>();
  const exact = new Set(taskIds);
  for (const q of questions) {
    if (q.state !== "pending" || q.projectId !== projectId || !q.taskId) continue;
    if (exact.has(q.taskId)) { out.add(q.taskId); continue; }
    for (const id of taskIds) if (id.startsWith(`${q.taskId}-`)) out.add(id);
  }
  return out;
}

/**
 * Whether `task` sits anywhere under `epicId`: its parent, or its parent's parent (the hierarchy is at
 * most epic → task → subtask, so two hops is the whole subtree). The epic card itself is NOT included —
 * picking an epic shows the work under it, and the epic is one click away in its own lane.
 */
export function isUnderEpic(task: Pick<BoardTask, "parentId">, epicId: string, parentOf: Map<string, string | null | undefined>): boolean {
  const p = task.parentId;
  if (!p) return false;
  return p === epicId || parentOf.get(p) === epicId;
}

/** How many cards sit anywhere under each card — the count beside an epic in the Epic picker. */
export function descendantCounts(tasks: Pick<BoardTask, "id" | "parentId">[]): Map<string, number> {
  const parentOf = new Map(tasks.map((t) => [t.id, t.parentId]));
  const out = new Map<string, number>();
  for (const t of tasks) {
    const p = t.parentId;
    if (!p) continue;
    out.set(p, (out.get(p) ?? 0) + 1);
    const gp = parentOf.get(p);
    if (gp) out.set(gp, (out.get(gp) ?? 0) + 1);
  }
  return out;
}
