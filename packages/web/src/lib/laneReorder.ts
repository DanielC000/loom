// Within-lane card reorder (card 139cfc3d) — the pure arithmetic behind the board's drag and Alt+↑/↓
// reorder, kept free of React and of runtime imports so test/lane-reorder.mjs can run it under bare node.
//
// @decision 139cfc3d — a manual order lives INSIDE a priority band: a reorder past the band's edge is
// clamped to that edge, never turned into a priority change, and the done lane is never reorderable.
//
// A live lane sorts by priority, then position (components/priority.tsx › byPriorityThenPosition), so a
// position write can only ever order cards that share a priority.
//
// Slots are counted in the lane's card list WITH THE MOVED CARD REMOVED ("others"): slot k means "lands
// before others[k]", and slot others.length means "lands last". A card's own current slot is therefore
// its index in the full list.
import type { TaskPriority } from "@loom/shared";

/** The minimum a card needs for the reorder maths: its id, priority (absent = the p2 default) and position. */
export type Orderable = { id: string; priority?: TaskPriority; position: number };

/** Gap between neighbours when a card lands at a band edge, and between cards after a renumber. */
export const REORDER_STEP = 1024;

const pri = (t: Pick<Orderable, "priority">): TaskPriority => t.priority ?? "p2";
/** `list[i]` when it exists and is in band `p`, else null. */
const inBand = (list: readonly Orderable[], i: number, p: TaskPriority): Orderable | null => {
  const t = list[i];
  return t && pri(t) === p ? t : null;
};

/** The [start, end] slot range (both inclusive) the band of priority `p` occupies in `others`, a list
 *  already sorted by priority then position. A band with no other card is the single slot where a card
 *  of that priority would sort. */
export function bandSlots(others: readonly Orderable[], p: TaskPriority): [number, number] {
  let start = others.findIndex((t) => pri(t) >= p);
  if (start < 0) start = others.length;
  let end = start;
  while (inBand(others, end, p)) end++;
  return [start, end];
}

/** Clamp a wanted slot into the moved card's own band. */
export function clampSlot(others: readonly Orderable[], p: TaskPriority, slot: number): number {
  const [start, end] = bandSlots(others, p);
  return Math.min(end, Math.max(start, slot));
}

/** Where the pointer puts the card: the number of other cards whose vertical midpoint sits above `y`.
 *  `mids` are those midpoints, in the same order as `others`. */
export function slotForPointer(mids: readonly number[], y: number): number {
  let n = 0;
  for (const m of mids) if (m < y) n++;
  return n;
}

/** A single new position for the moved card at `slot` (already clamped), between its new band
 *  neighbours — or null when no such number exists (equal neighbours, or a gap too small for a double to
 *  split), in which case the band has to be renumbered. */
export function positionAt(others: readonly Orderable[], p: TaskPriority, slot: number): number | null {
  const prev = slot > 0 ? inBand(others, slot - 1, p) : null;
  const next = inBand(others, slot, p);
  if (prev && next) {
    const mid = (prev.position + next.position) / 2;
    return mid > prev.position && mid < next.position ? mid : null;
  }
  if (prev) return prev.position + REORDER_STEP;
  if (next) return next.position - REORDER_STEP;
  return null; // alone in its band: there is nothing to order against
}

/** The writes that renumber one whole band so `movedId` sits before `beforeId` (or, with `beforeId`
 *  null, after `afterId`; with both null, last). `band` is every card of that priority in the lane —
 *  the FULL set, not just what a filter left on screen — sorted by position. Positions restart at the
 *  band's lowest current value and step by REORDER_STEP; only cards whose position changes are returned,
 *  in band order. */
export function renumberBand(band: readonly Orderable[], movedId: string, beforeId: string | null, afterId: string | null): { id: string; position: number }[] {
  const moved = band.find((t) => t.id === movedId);
  if (!moved) return [];
  const rest = band.filter((t) => t.id !== movedId);
  let at = rest.length;
  if (beforeId !== null) { const i = rest.findIndex((t) => t.id === beforeId); if (i >= 0) at = i; }
  else if (afterId !== null) { const i = rest.findIndex((t) => t.id === afterId); if (i >= 0) at = i + 1; }
  const order = [...rest.slice(0, at), moved, ...rest.slice(at)];
  const base = Math.min(...band.map((t) => t.position));
  const writes: { id: string; position: number }[] = [];
  order.forEach((t, i) => {
    const position = base + i * REORDER_STEP;
    if (position !== t.position) writes.push({ id: t.id, position });
  });
  return writes;
}

/** The whole plan for moving `movedId` to `slot` within `lane` (its sorted, on-screen cards), given the
 *  lane's FULL band for the renumber fallback. Returns null when the move is a no-op: the clamped slot is
 *  where the card already is. */
export function planReorder(lane: readonly Orderable[], movedId: string, slot: number, fullBand: readonly Orderable[]):
  { slot: number; writes: { id: string; position: number }[]; renumbered: boolean } | null {
  const from = lane.findIndex((t) => t.id === movedId);
  if (from < 0) return null;
  const p = pri(lane[from]!);
  const others = lane.filter((t) => t.id !== movedId);
  const to = clampSlot(others, p, slot);
  if (to === from) return null;
  const position = positionAt(others, p, to);
  if (position !== null) return { slot: to, writes: [{ id: movedId, position }], renumbered: false };
  const before = inBand(others, to, p)?.id ?? null;
  const after = before === null && to > 0 ? inBand(others, to - 1, p)?.id ?? null : null;
  const sorted = [...fullBand].sort((a, b) => a.position - b.position);
  return { slot: to, writes: renumberBand(sorted, movedId, before, after), renumbered: true };
}
