// The drawer relation EDITOR's pure logic — the write-side twin of lib/taskHierarchy's read model: that
// module turns a task read into a display shape, this one turns a display shape plus the user's clicks
// back into a `POST /api/tasks/:id` body. Separated from the component so every rule is directly
// assertable (packages/web/test/task-relations-edit.mjs).
//
// @decision 03d9db6e — the relation write is a WHOLE-SET REPLACE per kind, so never send back a
// `released:true` item (it re-declares dead deferral history as a live edge) and never drop a merely
// `resolved` one (it is a declared edge the user never touched). Both directions are asserted.
import type { TaskLinks, TaskRef } from "./taskHierarchy";

/**
 * The relation kinds this card can WRITE about itself. `discoveries` is deliberately absent: it is the
 * inverse projection of some OTHER card's `discoveredFrom`, so there is no field on this card's write
 * body that could change it — it stays read-only in the UI and the editor never offers it.
 */
export type EditableRelationKind = "blockedBy" | "blocks" | "related" | "discoveredFrom";

export const EDITABLE_RELATION_KINDS: EditableRelationKind[] = ["blockedBy", "blocks", "related", "discoveredFrom"];

/**
 * Kinds the REST body carries as a single `string | null` rather than an array (`discoveredFrom`: a card
 * is spun out of at most one other card). The draft still models them as a list so one code path covers
 * every kind; these are capped at one entry, and adding to a full one REPLACES.
 */
export type SingleValueRelationKind = "discoveredFrom";

export const SINGLE_VALUE_KINDS: SingleValueRelationKind[] = ["discoveredFrom"];

// A type PREDICATE, not a bare boolean: `relationPatch` below needs the narrowing to assign a
// `string | null` to the single-value key and a `string[]` to the others off the SAME loop variable.
// Honest because the array it reads can only ever hold that literal type.
export const isSingleValueKind = (kind: EditableRelationKind): kind is SingleValueRelationKind =>
  (SINGLE_VALUE_KINDS as EditableRelationKind[]).includes(kind);

/** Human labels + direction hints, matching components/taskLinks' read-side vocabulary exactly. */
export const EDIT_RELATION_LABEL: Record<EditableRelationKind, string> = {
  blockedBy: "Blocked by",
  blocks: "Blocking",
  related: "Related",
  discoveredFrom: "Discovered from",
};

export const EDIT_RELATION_HINT: Record<EditableRelationKind, string> = {
  blockedBy: "this card is waiting on these",
  blocks: "these are waiting on this card",
  related: "related, with no ordering implied",
  discoveredFrom: "the card this one was spun out of — one only, picking another replaces it",
};

/** The staged relation set, one id list per writable kind. Ids are always FULL ids, never prefixes. */
export type RelationDraft = Record<EditableRelationKind, string[]>;

/** One card as the picker lists it. A subset of the board row — the picker needs no more than this. */
export type PickerCard = { id: string; title: string; columnKey: string };

export const emptyRelationDraft = (): RelationDraft =>
  ({ blockedBy: [], blocks: [], related: [], discoveredFrom: [] });

/**
 * The id set that would have to be SENT BACK to leave each relation kind exactly as the server has it —
 * i.e. the draft's starting point and the diff's base.
 *
 * `released:true` items are dropped (see this file's header): they are not declared edges, so they are
 * not part of the declared set a write replaces, and including them would promote them to live ones.
 * `resolved` items are KEPT, since a resolved edge is still declared.
 */
export function relationBaseline(links: TaskLinks): RelationDraft {
  const out = emptyRelationDraft();
  for (const kind of EDITABLE_RELATION_KINDS) {
    out[kind] = (links.relations[kind] ?? [])
      .filter((r) => !r.released)
      .map((r) => r.id);
  }
  return out;
}

/**
 * The `released:true` items of one kind — display-only history the editor shows muted and WITHOUT a
 * remove control, because there is no live edge there to remove. Returned separately from the baseline
 * so the UI can still show them while the write never carries them.
 */
export function releasedHistory(links: TaskLinks, kind: EditableRelationKind): TaskRef[] {
  return (links.relations[kind] ?? []).filter((r) => r.released);
}

/** Look one id up in the served refs of a kind, for a chip's title/lane. Missing → the caller falls back. */
export function refById(links: TaskLinks, kind: EditableRelationKind, id: string): TaskRef | null {
  return (links.relations[kind] ?? []).find((r) => r.id === id) ?? null;
}

/**
 * Stage an addition. Immutable, de-duplicating, and self-excluding: a card cannot be its own blocker or
 * relation (the daemon refuses it, so the UI must not let it be staged in the first place). A
 * single-value kind REPLACES rather than appends — that is what the REST field can express.
 */
export function addRelation(draft: RelationDraft, kind: EditableRelationKind, id: string, selfId: string): RelationDraft {
  if (!id || id === selfId) return draft;
  const current = draft[kind];
  if (isSingleValueKind(kind)) {
    return current.length === 1 && current[0] === id ? draft : { ...draft, [kind]: [id] };
  }
  if (current.includes(id)) return draft;
  return { ...draft, [kind]: [...current, id] };
}

/** Stage a removal. A no-op (same object back) when the id isn't staged under that kind. */
export function removeRelation(draft: RelationDraft, kind: EditableRelationKind, id: string): RelationDraft {
  const current = draft[kind];
  if (!current.includes(id)) return draft;
  return { ...draft, [kind]: current.filter((x) => x !== id) };
}

/** Order-insensitive id-set equality — the server returns its own order, so a reorder is NOT an edit. */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((x) => seen.has(x));
}

/**
 * What `POST /api/tasks/:id` should carry. ONLY kinds that actually changed — same rule the drawer
 * already applies to `repoKey`/`parentId`, and for the same reason: an untouched relation kind must not
 * be replaced (a whole-set write of an unchanged set is a no-op at best, and at worst re-declares a
 * released edge the baseline deliberately dropped).
 */
export type RelationPatch = {
  blockedBy?: string[];
  blocks?: string[];
  related?: string[];
  discoveredFrom?: string | null;
};

export function relationPatch(draft: RelationDraft, baseline: RelationDraft): RelationPatch {
  const patch: RelationPatch = {};
  for (const kind of EDITABLE_RELATION_KINDS) {
    if (sameIdSet(draft[kind], baseline[kind])) continue;
    if (isSingleValueKind(kind)) patch[kind] = draft[kind][0] ?? null;
    else patch[kind] = [...draft[kind]]; // narrowed to the array-valued kinds by the predicate above
  }
  return patch;
}

/** True when a Save would carry any relation field at all (drives the drawer's own `dirty`). */
export function relationsDirty(draft: RelationDraft, baseline: RelationDraft): boolean {
  return EDITABLE_RELATION_KINDS.some((kind) => !sameIdSet(draft[kind], baseline[kind]));
}

/**
 * Search the board for a card to link. Matches an ID PREFIX or a TITLE SUBSTRING, because those are the
 * two handles this system actually uses for a card (the drawer header, commit trailers and every agent
 * report name cards by an 8-char prefix; humans know them by title).
 *
 * Ranked id-prefix hits first, then title hits by where the match lands, then by title — so typing the
 * prefix you already know puts that card at the top rather than behind an alphabetical wall. `total` is
 * the TRUE candidate count so the UI can say the list is capped instead of implying it is the whole set.
 */
export function searchCards(
  cards: PickerCard[],
  query: string,
  opts: { selfId: string; excludeIds: Iterable<string>; limit: number },
): { matches: PickerCard[]; total: number } {
  const excluded = new Set(opts.excludeIds);
  excluded.add(opts.selfId);
  const q = query.trim().toLowerCase();
  const scored: Array<{ card: PickerCard; rank: number; at: number }> = [];
  for (const card of cards) {
    if (excluded.has(card.id)) continue;
    if (q === "") {
      scored.push({ card, rank: 2, at: 0 });
      continue;
    }
    if (card.id.toLowerCase().startsWith(q)) {
      scored.push({ card, rank: 0, at: 0 });
      continue;
    }
    const at = card.title.toLowerCase().indexOf(q);
    if (at >= 0) scored.push({ card, rank: 1, at });
  }
  scored.sort((a, b) =>
    a.rank - b.rank || a.at - b.at || a.card.title.localeCompare(b.card.title) || a.card.id.localeCompare(b.card.id));
  return { matches: scored.slice(0, Math.max(0, opts.limit)).map((s) => s.card), total: scored.length };
}

/**
 * Where a server validation error belongs on screen. The daemon's structure validator prefixes a
 * field-scoped error with the field name (`blockedBy: …`, `parentId: …`) and opens a graph-wide one with
 * `blocks cycle (…)`, so the message itself says which control the human has to go fix.
 *
 * This exists so the error lands AT the edit rather than only in the generic line beside Save: a cycle
 * or a depth refusal is actionable ("drop one of the edges"), and an actionable message 300px away from
 * the control it names reads as a mystery. The message is passed through VERBATIM either way — this only
 * decides placement, never wording.
 *
 * `null` means "not a relation error" and leaves it to the generic line, so an unrecognised message is
 * never swallowed.
 */
export type RelationErrorTarget =
  | { scope: "kind"; kind: EditableRelationKind }
  | { scope: "parent" }
  | { scope: "graph" }
  | null;

export function relationErrorTarget(message: string | null | undefined): RelationErrorTarget {
  if (!message) return null;
  // A cycle names several edges across both directions, so it belongs to the section, not one row.
  if (/^blocks cycle\b/.test(message)) return { scope: "graph" };
  if (/^parentId\b/.test(message)) return { scope: "parent" };
  // Longest-first so `blockedBy` is never shadowed by the `blocks` prefix it starts with.
  for (const kind of ["blockedBy", "discoveredFrom", "related", "blocks"] as EditableRelationKind[]) {
    if (new RegExp(`^${kind}\\b`).test(message)) return { scope: "kind", kind };
  }
  return null;
}
