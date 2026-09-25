import type { BoardTask, Task } from "@loom/shared";

/**
 * Board-hierarchy read model (the UI half of card 1ae4f88c; the daemon half is card 3df86c87).
 *
 * WHY THE FIELDS ARE DECLARED HERE AND NOT READ OFF `Task`/`BoardTask`: the daemon adds them to the
 * shared types on its own branch, so this module declares the shape it CONSUMES and reads it
 * structurally. That keeps the web package compiling either way and — more importantly — makes the
 * "older daemon" case a real, tested code path rather than an assumption: every accessor below takes an
 * unknown-shaped row and returns a fully-defaulted result, so a response with none of these fields
 * renders exactly as the board did before this card (nothing extra drawn at all).
 *
 * Both accessors are deliberately TOLERANT of a partial/garbled field rather than trusting the
 * contract: a wrong-typed `childCount`, a `blockedByFirst` missing its title, a `relations` key that
 * came back as a string all degrade to "absent" instead of throwing inside a render.
 */

/**
 * One end of a link, as the task-read contract returns it. `resolved`/`released` ride on blocks edges
 * only (both directions).
 *
 * `released` marks AUTO-RELEASED DEFERRAL HISTORY — a blocker a deferral was auto-cleared from. It is
 * display-only and distinct from a merely `resolved` edge, which IS a declared dependency whose blocker
 * happens to be done.
 *
 * @decision 3df86c87 — never send a `released:true` item back in a `blockedBy`/`blocks` write: it
 * re-declares dead deferral history as a live edge. Nothing here writes those fields today; a future
 * relation editor must filter them out.
 */
export type TaskRef = { id: string; title: string; columnKey: string; resolved: boolean; released: boolean };

/** The five relation buckets `GET /api/tasks/:id` returns under `relations`. */
export type RelationKind = "blockedBy" | "blocks" | "related" | "discoveredFrom" | "discoveries";
export const RELATION_KINDS: RelationKind[] = ["blockedBy", "blocks", "related", "discoveredFrom", "discoveries"];

/** What the BOARD LIST row carries: counts and one blocker, never the full relation arrays. */
export type BoardHierarchy = {
  parentId: string | null;
  childCount: number;
  childDone: number;
  blockedByOpen: number;
  blockedByFirst: { id: string; title: string } | null;
};

/**
 * What the single-task read carries: the resolved parent, the children, and every relation edge.
 *
 * Mirrors the FROZEN contract (`docs/decisions/3df86c87-task-parent-and-relations-blocks-vs-deferreduntiltaskid.md`,
 * §"FROZEN contract for the web (item 7)") field-for-field rather than flattening it, so a future reader
 * diffing this against the record sees the same shape on both sides. `parentId` is the RAW column and is
 * what the drawer's Parent write mirrors; `parent` is its resolved display form.
 */
export type TaskLinks = {
  parentId: string | null;
  parent: TaskRef | null;
  /** `items` is capped at 100 by the contract; `done`/`total` are always exact. */
  children: { done: number; total: number; items: TaskRef[] };
  relations: Record<RelationKind, TaskRef[]>;
};

const EMPTY_RELATIONS = (): Record<RelationKind, TaskRef[]> =>
  ({ blockedBy: [], blocks: [], related: [], discoveredFrom: [], discoveries: [] });

// A non-negative integer or 0 — a NaN/negative/fractional/non-number value reads as absent, never as a
// count the UI would then render ("-1/3", "4/NaN").
function count(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

// A link target needs an id to be clickable and a title to be nameable; anything short of both is
// dropped rather than rendered as an empty row. `columnKey` is cosmetic (the lane chip), so it falls
// back to "" — a missing lane must not discard an otherwise-usable link.
function ref(v: unknown): TaskRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.title !== "string" || !o.title) return null;
  // `released` implies history, so it forces `resolved` even if the pair ever arrived inconsistent. The
  // two defaults deliberately fail in OPPOSITE directions, and both toward safety: an unrecognised
  // `resolved` value leaves an edge OPEN (never hide a live blocker in muted history), while an explicit
  // `released:true` moves it to history (never show dead deferral history as something still blocking).
  // Only an explicit `true` ever moves an edge out of "open".
  const released = o.released === true;
  return {
    id: o.id,
    title: o.title,
    columnKey: typeof o.columnKey === "string" ? o.columnKey : "",
    resolved: o.resolved === true || released,
    released,
  };
}

function refs(v: unknown): TaskRef[] {
  if (!Array.isArray(v)) return [];
  const out: TaskRef[] = [];
  for (const item of v) {
    const r = ref(item);
    if (r) out.push(r);
  }
  return out;
}

/** Read the board row's hierarchy counters. Every field defaults to "nothing to draw". */
export function boardHierarchy(task: BoardTask): BoardHierarchy {
  const o = task as unknown as Record<string, unknown>;
  const first = ref(o.blockedByFirst);
  return {
    parentId: typeof o.parentId === "string" && o.parentId ? o.parentId : null,
    childCount: count(o.childCount),
    childDone: count(o.childDone),
    blockedByOpen: count(o.blockedByOpen),
    // blockedByFirst carries only {id,title} by contract, so it reuses `ref`'s id+title guard and
    // discards the columnKey/resolved/released it never sends.
    blockedByFirst: first ? { id: first.id, title: first.title } : null,
  };
}

/**
 * True when the board card has anything hierarchy-related to show. The card's meta row is gated on
 * this so a card with no parent, no children and no blockers is drawn exactly as before this card —
 * which is most cards, and the reason the Overview-embedded board doesn't get taller.
 *
 * `parentId` alone counts: a child card still says who its parent is even with no blockers.
 */
export function hasBoardHierarchy(h: BoardHierarchy): boolean {
  return h.parentId !== null || h.childCount > 0 || h.blockedByOpen > 0;
}

/**
 * Read the single-task link model. `children.total` is the server's own exact count — `items` is capped
 * at 100 — so a capped list still reports true progress; it falls back to the item count only when the
 * server sent no total at all, which is the older-daemon case.
 */
export function taskLinks(task: Task | null | undefined): TaskLinks {
  const o = (task ?? {}) as unknown as Record<string, unknown>;
  const kids = o.children && typeof o.children === "object" ? (o.children as Record<string, unknown>) : {};
  const items = refs(kids.items);
  const rel = EMPTY_RELATIONS();
  const raw = o.relations;
  if (raw && typeof raw === "object") {
    for (const kind of RELATION_KINDS) rel[kind] = refs((raw as Record<string, unknown>)[kind]);
  }
  const parent = ref(o.parent);
  return {
    // Prefer the RAW column over the resolved object's id: `parentId` is the field the write mirrors, so
    // the edit control and the request it sends read the same value. Falls back to the resolved parent so
    // a response carrying only `parent` still drives the control.
    parentId: typeof o.parentId === "string" && o.parentId ? o.parentId : parent?.id ?? null,
    parent,
    children: {
      done: count(kids.done),
      total: typeof kids.total === "number" && Number.isInteger(kids.total) && kids.total >= 0
        ? kids.total
        : items.length,
      items,
    },
    relations: rel,
  };
}

/** True when the drawer's Links block has anything to render (else it renders nothing at all). */
export function hasTaskLinks(l: TaskLinks): boolean {
  return l.parent !== null || l.children.total > 0 || RELATION_KINDS.some((k) => l.relations[k].length > 0);
}

/**
 * The two relation buckets whose items carry `resolved` — BOTH directions. Per the contract, `resolved`
 * sits on the edge's BLOCKER side either way: for `blockedBy` that's the OTHER card (has my blocker
 * landed?), for `blocks` it's THIS card (have I stopped blocking them?).
 *
 * ⚠️ The daemon does not do that for `blocks` yet — it derives `resolved` from the BLOCKED card instead
 * (bug dc1e27fe; the contract is authoritative and the code is wrong). Two consequences while that
 * stands: a `blocks` bucket is MIXED per-item rather than all-open-or-all-resolved together, and an edge
 * can read live when its blocker is already done. Nothing here relies on the uniformity either way —
 * `splitResolved` works per item — so this UI is correct before and after the fix, and needs no change
 * when it lands. Do not "simplify" on the assumption that a `blocks` bucket is uniform.
 */
export const RESOLVABLE_KINDS: RelationKind[] = ["blockedBy", "blocks"];

/**
 * Split a blocks-edge bucket into live blockers and resolved history. A resolved blocker is kept and
 * shown muted (the contract's own "blocked-by X (resolved)") rather than dropped — it's the record of
 * what this card WAS waiting on, which is the question you ask when a card sat still for a week. The
 * contract DERIVES `resolved` at read time and never stores it, so this can't go stale.
 */
export function splitResolved(items: TaskRef[]): { open: TaskRef[]; resolved: TaskRef[] } {
  return { open: items.filter((r) => !r.resolved), resolved: items.filter((r) => r.resolved) };
}

/** What the drawer's parent field made of what was typed. `id` is non-null only for `state:"ok"`. */
export type ParentResolution =
  | { state: "empty"; id: null; title: null }
  | { state: "ok"; id: string; title: string }
  | { state: "self"; id: null; title: null }
  | { state: "ambiguous"; id: null; title: null; matches: number }
  | { state: "unknown"; id: null; title: null };

/**
 * Resolve what a human typed into the drawer's Parent field against the loaded board.
 *
 * Accepts a FULL card id or any unambiguous PREFIX, because an 8-char prefix is how this system actually
 * refers to cards everywhere else (board chips, commit trailers, agent reports, the drawer's own header)
 * — so a picker that demanded a full uuid would be the odd one out. Resolution happens client-side and
 * the FULL id is what gets sent; the server validates it again regardless.
 *
 * Every failure mode is NAMED rather than collapsed into one "invalid": a prefix matching several cards
 * is a different problem from one matching none, and only the first is fixed by typing more.
 * `state:"self"` is called out separately because a card parented to itself is the one input that looks
 * perfectly well-formed and would still be rejected server-side.
 */
export function resolveParentInput(
  input: string,
  taskId: string,
  titleById: Map<string, string>,
): ParentResolution {
  const q = input.trim().toLowerCase();
  if (q === "") return { state: "empty", id: null, title: null };
  const exact = titleById.get(q);
  if (exact !== undefined) {
    return q === taskId ? { state: "self", id: null, title: null } : { state: "ok", id: q, title: exact };
  }
  // Counts EVERY match rather than bailing at the second: the ambiguous message quotes this number, and a
  // count truncated by an early exit would always read "2" no matter how many cards actually matched. A
  // full pass over a few thousand ids per keystroke is free.
  const hits: string[] = [];
  for (const id of titleById.keys()) if (id.startsWith(q)) hits.push(id);
  if (hits.length === 0) return { state: "unknown", id: null, title: null };
  if (hits.length > 1) return { state: "ambiguous", id: null, title: null, matches: hits.length };
  const [id] = hits;
  const title = id === undefined ? undefined : titleById.get(id);
  // Unreachable — a single hit came out of titleById's own keys, so its title is there by construction.
  // Narrowed rather than asserted so a future refactor can't turn this into an `undefined` in the UI.
  if (id === undefined || title === undefined) return { state: "unknown", id: null, title: null };
  if (id === taskId) return { state: "self", id: null, title: null };
  return { state: "ok", id, title };
}
