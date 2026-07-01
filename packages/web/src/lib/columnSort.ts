import type { KanbanColumn } from "@loom/shared";

/** The minimal shape isDoneColumn needs — KanbanColumn satisfies it. */
export type DoneColumnShape = Pick<KanbanColumn, "key" | "role">;

// A column counts as "done" when its ROLE is terminal — the same signal `columnTone`/`roleTone` reads
// for the accent tint (Board.tsx), so a terminal-role lane always tints AND sorts done-first together,
// whatever it's labeled (UI-audit finding #16: a "Shipped" terminal-role lane used to tint but not sort,
// because the old test was a key/name substring for "done"/"complete"/"merged"). A role-less column
// (legacy boards predating role assignment) falls back to that substring guess so it isn't left
// permanently unsorted.
export function isDoneColumn(col: DoneColumnShape): boolean {
  if (col.role) return col.role === "terminal";
  const k = col.key.toLowerCase();
  return k.includes("done") || k.includes("complete") || k.includes("merged");
}
