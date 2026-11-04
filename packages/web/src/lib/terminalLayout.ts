// The Sessions tab's per-project tile LAYOUT preference — how many columns the live-terminal grid
// draws, and a reader-chosen order laid over the derived one. Pure and JSX-free so
// test/terminal-layout.mjs can import the real functions rather than a copy of them (the same shape
// as lib/projectOrder.ts + test/project-order.mjs); the two storage helpers at the bottom are the
// only impure part, and they exist so the key shape has exactly one home.
//
// WHY THE ORDER IS A LAYER AND NOT A REPLACEMENT: the grid's own order is the shared stable key every
// session list in the app uses (`byManagerThenCreated` / `byCreatedStable`, lib/sessions.ts), and a
// session the reader has never moved must keep the slot that key gave it. So the preference is a
// RANKING of the ids it names, applied to whatever list it is handed — an id it does not name keeps
// its derived position, after the ranked ones. That is also what makes it survive the churn it is
// stored against: a session id is ephemeral (a session stops, its replacement gets a new id), so a
// saved order decays into a list of ids that are no longer live. Ranking the ones still present and
// leaving the rest alone degrades to the derived order on its own, with nothing to migrate or clean.

/** The column counts the grid offers. `"auto"` is the pre-card behaviour — fit as many as fit. */
export const GRID_COLUMN_CHOICES = ["auto", "1", "2", "3"] as const;
export type GridColumns = (typeof GRID_COLUMN_CHOICES)[number];

/**
 * The `auto` template, and the one the classic god-eye page keeps unconditionally. 560px is the width
 * `auto` refuses to wrap below — comfortable for a scaled pinned grid at this tile height. An explicit
 * column count is the reader trading that comfort for density, down to (but not past) the floor below.
 */
export const AUTO_GRID_TEMPLATE = "repeat(auto-fill, minmax(560px, 1fr))";

/**
 * The narrowest tile an explicit column count may produce, and the grid's own `gap` (pages/
 * Terminals.tsx `gridStyle`) that the share-out has to account for.
 *
 * 320px is MEASURED, not chosen: at a 291px tile the shared card's own header stops ellipsising
 * cleanly and the identity text collides with its action cluster, and the pane hits the font solver's
 * 6px floor (`components/Terminal.tsx`) and starts clipping columns off its right instead of scaling
 * further. Both were observed at 291px and both were clean at 324px. Before this card no tile on this
 * page could get there at all — `auto`'s own 560px floor kept it out — so the floor is this control's
 * to carry.
 */
const MIN_EXPLICIT_TILE_PX = 320;
const GRID_GAP_PX = 12;

export interface TileLayout {
  columns: GridColumns;
  /** Session ids, most-preferred first. Empty ⇒ no reader order; the derived one stands. */
  order: string[];
}

/**
 * The layout of a mount with no stored preference — and the god-eye page's layout, unconditionally.
 *
 * DEEP-FROZEN, and every fallback below returns a FRESH object via `freshDefaultLayout` rather than a
 * spread of this one. A `{ ...DEFAULT_TILE_LAYOUT }` spread is shallow, so it hands back THIS `order`
 * array by reference — one caller pushing into what it believes is its own empty order would then be
 * editing the default every later caller reads. The freeze makes that a thrown error instead of a
 * silent one, and the fresh copies mean no caller has to know.
 */
export const DEFAULT_TILE_LAYOUT: TileLayout = Object.freeze({
  columns: "auto" as GridColumns, order: Object.freeze([]) as unknown as string[],
});

function freshDefaultLayout(): TileLayout {
  return { columns: DEFAULT_TILE_LAYOUT.columns, order: [] };
}

function isGridColumns(v: unknown): v is GridColumns {
  return typeof v === "string" && (GRID_COLUMN_CHOICES as readonly string[]).includes(v);
}

/**
 * Read a stored layout back, defensively. Every unreadable shape — absent, non-JSON, a JSON scalar or
 * array, an unknown column count, a non-array order, a non-string or empty id inside it, a duplicate —
 * falls back to that field's default INDEPENDENTLY of the others, so one corrupt field never discards a
 * good one. This is a browser-storage read: the value can be hand-edited, left behind by an older build,
 * or shared with a newer one, and none of those may throw on a page the reader is trying to use.
 */
export function parseTileLayout(raw: string | null | undefined): TileLayout {
  if (!raw) return freshDefaultLayout();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return freshDefaultLayout(); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return freshDefaultLayout();
  const rec = parsed as Record<string, unknown>;
  const columns = isGridColumns(rec.columns) ? rec.columns : DEFAULT_TILE_LAYOUT.columns;
  const order: string[] = [];
  if (Array.isArray(rec.order)) {
    const seen = new Set<string>();
    for (const id of rec.order) {
      if (typeof id !== "string" || id === "" || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }
  return { columns, order };
}

/**
 * The `grid-template-columns` value for a choice.
 *
 * @decision ac0cfe91 — never emit `repeat(N, …)` here. An explicit count is a MAXIMUM floored at a
 * tile width the shared card can actually draw, so `auto-fill` gives up a column rather than drawing
 * one too narrow; no media query can express it (the rail's own fold moves the row width under it).
 */
export function gridTemplateColumns(columns: GridColumns): string {
  if (columns === "auto") return AUTO_GRID_TEMPLATE;
  const n = Number(columns);
  // An exact 1/N share of the row, gaps taken out first. While it clears the floor, `auto-fill` fits
  // exactly N; once it does not, the floor wins and `auto-fill` fits however many DO clear it.
  const share = `calc((100% - ${(n - 1) * GRID_GAP_PX}px) / ${n})`;
  // `min(100%, …)` so the floor can never become a sideways scrollbar on a narrower container.
  return `repeat(auto-fill, minmax(min(100%, max(${MIN_EXPLICIT_TILE_PX}px, ${share})), 1fr))`;
}

/**
 * Lay a saved order over one already-derived list.
 *
 * `pinnedFirstId`, when it names a member, is held at index 0 whatever the order says. That is the
 * manager of a manager row: the row's own header names `list[0]` as its manager and counts the rest as
 * its workers (pages/Terminals.tsx `RowHeader`), so a worker promoted above it would relabel both. The
 * reader reorders the workers under a manager, never the manager out from under its own heading.
 *
 * Never mutates `list` — the caller's array is memoised render state shared with the bulk queue/wakes
 * poll that keys off it.
 */
export function applyTileOrder<T extends { id: string }>(
  list: readonly T[],
  order: readonly string[],
  opts?: { pinnedFirstId?: string },
): T[] {
  const pinnedId = opts?.pinnedFirstId;
  const pinned = pinnedId === undefined ? undefined : list.find((s) => s.id === pinnedId);
  const rest = pinned ? list.filter((s) => s !== pinned) : list.slice();
  const lead = pinned ? [pinned] : [];
  if (order.length === 0) return [...lead, ...rest];
  const rank = new Map<string, number>();
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  const ranked: T[] = [];
  const unranked: T[] = [];
  for (const s of rest) (rank.has(s.id) ? ranked : unranked).push(s);
  // A new session the reader has never moved is UNRANKED, so it lands after every ranked tile, in the
  // derived order it arrived in. Appending (rather than letting the derived newest-first key put it on
  // top) is what makes a chosen order hold still: a reader who placed four tiles keeps those four
  // places, and the fifth to appear does not displace them.
  ranked.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...lead, ...ranked, ...unranked];
}

/**
 * Move `id` by `delta` slots within `ids`, returning a new array. A move off either end, an absent id
 * and a zero delta are all no-ops that still return a copy — the caller writes the result back
 * unconditionally, so "nothing moved" must be a valid, non-throwing answer rather than a special case.
 */
export function moveTileInOrder(ids: readonly string[], id: string, delta: number): string[] {
  const next = ids.slice();
  const from = next.indexOf(id);
  if (from < 0 || delta === 0) return next;
  const to = from + delta;
  if (to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * The storage key. Per PROJECT, because the preference is about one project's own fleet — a column
 * count that suits a project running two sessions is the wrong one for a project running nine, and an
 * order is a list of that project's session ids. Same `<area>.<field>.<projectId>` shape the Overview
 * fleet accordion already stores its per-project disclosure under (pages/Overview.tsx).
 */
export function tileLayoutStorageKey(projectId: string): string {
  return `loom.sessionsLayout.${projectId}`;
}

/** Read one project's stored layout. Storage can be unavailable or throw; the default is the answer then. */
export function readTileLayout(projectId: string): TileLayout {
  try { return parseTileLayout(localStorage.getItem(tileLayoutStorageKey(projectId))); }
  catch { return freshDefaultLayout(); }
}

/** Persist one project's layout, best-effort. A write that cannot land leaves the session-local state. */
export function writeTileLayout(projectId: string, layout: TileLayout): void {
  try { localStorage.setItem(tileLayoutStorageKey(projectId), JSON.stringify(layout)); }
  catch { /* storage unavailable (private mode, blocked site data) — the in-memory state still applies */ }
}
