// The pure merge behind the board-column editor's "the board changed under you" path (card d5946e05).
// JSX-free so test/column-drift.mjs imports the SAME function ColumnManager.tsx ships (mirrors columnDesired.ts).
//
// WHEN: the editor Saved with `baseKeys` and the daemon answered 409 `columns_drifted` — an agent added,
// removed or re-keyed a column since the editor loaded, and NOTHING was written. This re-applies the human's
// staged rows onto the board as it stands NOW, so neither side is silently dropped:
//   • a server column the editor never saw (key in the server's set, not in `baseKeys`) is APPENDED as an
//     ordinary unmodified row (just before the terminal lane), or ADOPTED by a staged new row with that key;
//   • a staged row for a column the server no longer has (its `originalKey` is in `baseKeys` but not on the
//     server) is KEPT and flagged `removedElsewhere` — its identity is cleared (`originalKey` undefined), so
//     Save would RE-CREATE it as a brand-new lane. That is the human's call: the row says so, and ✕ cancels.
// It never re-creates anything by itself: the only write is the Save the human presses afterwards.
import type { KanbanColumn } from "@loom/shared";

/** The row fields the merge reads/writes (ColumnManager's `Row` is a superset). */
export interface DriftRow {
  key: string;
  originalKey?: string;
  role?: string;
  removedElsewhere?: boolean;
}

export interface DriftMerge<R extends DriftRow> {
  /** The staged rows re-based on the server's board. */
  rows: R[];
  /** The server's key set now — the `baseKeys` the next Save should send. */
  baseKeys: string[];
  /** Keys that exist server-side but were not in the editor's base. */
  added: string[];
  /** Keys the editor was based on that the server no longer has. */
  removed: string[];
}

export function mergeDriftedColumns<R extends DriftRow>(
  rows: readonly R[],
  serverColumns: readonly KanbanColumn[],
  baseKeys: readonly string[],
  seedRow: (c: KanbanColumn) => R,
): DriftMerge<R> {
  const serverKeys = new Set(serverColumns.map((c) => c.key));
  const base = new Set(baseKeys);
  const added = serverColumns.filter((c) => !base.has(c.key));
  const removed = [...base].filter((k) => !serverKeys.has(k));
  const removedSet = new Set(removed);

  // 1. A staged row whose column is gone server-side: keep it, flag it, and cut its server identity.
  const out: R[] = rows.map((r) => (r.originalKey && removedSet.has(r.originalKey)
    ? { ...r, originalKey: undefined, removedElsewhere: true }
    : r));

  // 2. A server column the editor never saw. A staged NEW row already using that exact key adopts it (the
  //    human typed the key the agent just created); otherwise append the server's row, before the terminal lane.
  for (const c of added) {
    const adopter = out.findIndex((r) => !r.originalKey && r.key.trim() === c.key);
    if (adopter >= 0) {
      out[adopter] = { ...out[adopter]!, originalKey: c.key, removedElsewhere: false };
      continue;
    }
    const row = seedRow(c);
    const term = out.findIndex((r) => r.role === "terminal");
    if (term >= 0) out.splice(term, 0, row); else out.push(row);
  }

  return { rows: out, baseKeys: serverColumns.map((c) => c.key), added: added.map((c) => c.key), removed };
}
