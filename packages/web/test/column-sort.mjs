// Hermetic unit test for Board.tsx's done-column sort test (UI-audit finding #16).
// Bug: isDoneColumn used a column key/name SUBSTRING heuristic ("done"/"complete"/"merged") to decide
// whether a lane sorts done-first, while the accent tint (columnTone/roleTone) already reads the
// column's `role`. A terminal-role column labeled e.g. "Shipped" tinted terminal but never sorted
// done-first — tint and sort disagreed. Fix: role is now the single source of truth when present.
//
// The web package has no test runner, so this is a self-contained node script that imports the pure
// function directly out of src/lib/columnSort.ts (only `import type` is stripped), mirroring
// test/sessions-order.mjs / test/archive-invalidate.mjs. Board.tsx imports the same function, so the
// test can't drift from what actually ships. Run it with:
//   node --experimental-strip-types packages/web/test/column-sort.mjs
import assert from "node:assert/strict";
import { isDoneColumn } from "../src/lib/columnSort.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("a terminal-role column sorts done-first regardless of its label", () => {
  assert.equal(isDoneColumn({ key: "shipped", role: "terminal" }), true);
});

check("a non-terminal-role column never sorts done-first, even with a done-ish label", () => {
  assert.equal(isDoneColumn({ key: "done_review", role: "review" }), false);
  assert.equal(isDoneColumn({ key: "merged_pending_audit", role: "active" }), false);
});

check("a role-less column falls back to the key/name substring guess", () => {
  assert.equal(isDoneColumn({ key: "done" }), true);
  assert.equal(isDoneColumn({ key: "complete" }), true);
  assert.equal(isDoneColumn({ key: "merged" }), true);
  assert.equal(isDoneColumn({ key: "backlog" }), false);
});

console.log(`\n${pass} passed`);
