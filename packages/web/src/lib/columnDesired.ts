// The desired-layout projection behind the board-column editor's atomic PUT (PUT /api/projects/:id/columns).
// JSX-free so test/column-desired.mjs can import it directly — ColumnManager.tsx imports the SAME function,
// so the test can never drift from what ships (mirrors lib/columnSort.ts + test/column-sort.mjs).
//
// @decision 654869e2 — carry the UNMODELLED remainder of each server column through verbatim; never
// re-enumerate the known KanbanColumn fields here.
//
// WHY: the PUT REPLACES the whole column array, and the daemon's planner (tasks/columns.ts) keeps a
// KanbanColumn field only when the request actually carried it. So any field this editor does not model
// has to travel back out untouched, or a human renaming ONE column silently strips it from EVERY column.
// That is what bit `excludeFromIdleWatchdog` (set only by the manager-side `board_column_*` MCP tools —
// there is no web control for it at all, and zero references to it anywhere in packages/web/src): losing
// it re-arms the idle watcher, the pending-request gate and wake-impact on a lane deliberately marked a
// dead end, so parked cards start counting as actionable again. Enumerating the known fields is what let
// that happen. Round-tripping the remainder is what keeps the NEXT field added to KanbanColumn safe with
// no edit here — and `CarriedColumnFields` widens automatically, so a field that ever becomes REQUIRED on
// KanbanColumn fails the typecheck here instead of being quietly dropped.
import type { ColumnRole, KanbanColumn } from "@loom/shared";
import type { DesiredColumn } from "./api";

/** The KanbanColumn fields the row editor owns as its own editable state. */
export const EDITED_COLUMN_FIELDS = ["key", "label", "role", "accentColor", "wipLimit"] as const;

/** Every OTHER KanbanColumn field — daemon/agent-owned, carried through untouched. */
export type CarriedColumnFields = Omit<KanbanColumn, (typeof EDITED_COLUMN_FIELDS)[number]>;

/** Split off the remainder of a server column that this editor does NOT model. */
export function carriedColumnFields(c: KanbanColumn): CarriedColumnFields {
  // Destructured-and-discarded rather than key-listed so the remainder is whatever is LEFT, by
  // construction — a key-listed copy would reintroduce the enumeration this module exists to avoid.
  const { key: _key, label: _label, role: _role, accentColor: _accent, wipLimit: _wip, ...carried } = c;
  return carried;
}

/** One staged row, reduced to just what the projection reads (ColumnManager's `Row` is a superset). */
export interface DesiredColumnInput {
  key: string;
  label: string;
  role?: ColumnRole;
  accentColor?: string;
  wipLimit?: number;
  /** The key this column has on the SERVER; undefined for a freshly-added column. A drift = a rename. */
  originalKey?: string;
  /** The unmodelled server-owned remainder, captured when this row was seeded. */
  carried?: CarriedColumnFields;
}

/**
 * Project the staged rows into the layout to PUT: strip the client-only fields, carry the unmodelled
 * remainder, and set `prevKey` only on a real rename of a column that already existed server-side.
 */
export function toDesired(rows: DesiredColumnInput[]): DesiredColumn[] {
  return rows.map((r) => {
    const key = r.key.trim();
    // `carried` spreads FIRST so a modelled field always wins over a stale carried copy of itself.
    const d: DesiredColumn = { ...(r.carried ?? {}), key, label: r.label.trim() };
    if (r.role) d.role = r.role;
    if (r.accentColor !== undefined) d.accentColor = r.accentColor;
    if (r.wipLimit !== undefined) d.wipLimit = r.wipLimit;
    if (r.originalKey && r.originalKey !== key) d.prevKey = r.originalKey;
    return d;
  });
}
