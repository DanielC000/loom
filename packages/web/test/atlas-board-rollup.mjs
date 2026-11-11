// Hermetic unit test for the project node's board roll-up over a WINDOWED board read (card acbb6df6).
// src/lib/atlasHome.ts › boardRollup. The project node now shares the Board tab's `?doneLimit=` read
// (card a483cbec's window) instead of fetching the whole done lane, so its `tasks` carry only the newest
// page of the terminal lane. These checks pin that every count still reads the TRUE figure.
//
// Run it with: node --experimental-strip-types packages/web/test/atlas-board-rollup.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// atlasHome.ts has REAL runtime imports written extensionless (bundler style), which Node's own resolver
// cannot follow; the import below must therefore be DYNAMIC so it runs after `register()`.
register("./_tsxLoaderHook.mjs", import.meta.url);

const { boardRollup } = await import("../src/lib/atlasHome.ts");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const COLS = [
  { key: "todo", label: "To Do", role: "workReady" },
  { key: "review", label: "Review", role: "review" },
  { key: "waiting", label: "Waiting", role: "parked" },
  { key: "done", label: "Done", role: "terminal" },
];
const cards = (key, n) => Array.from({ length: n }, () => ({ columnKey: key }));
const laneCount = (r, key) => r.lanes.find((l) => l.key === key)?.count;

check("an unwindowed read counts every lane off its tasks (unchanged)", () => {
  const r = boardRollup(COLS, [...cards("todo", 3), ...cards("review", 2), ...cards("done", 7)]);
  assert.equal(laneCount(r, "done"), 7);
  assert.equal(r.total, 12);
  assert.equal(r.open, 5);
  assert.equal(r.inReview, 2);
});

check("a windowed read: the terminal lane and the total read doneTotal, not the window's length", () => {
  // 50 done cards came back of 61; the other lanes are always returned in full.
  const r = boardRollup(COLS, [...cards("todo", 3), ...cards("waiting", 1), ...cards("done", 50)], 61);
  assert.equal(laneCount(r, "done"), 61);
  assert.equal(r.total, 3 + 1 + 61);
  // The non-terminal figures are untouched by the window.
  assert.equal(r.open, 4);
  assert.equal(r.waiting, 1);
  assert.equal(laneCount(r, "todo"), 3);
});

check("a windowed read of an EMPTY done lane counts 0, not undefined", () => {
  const r = boardRollup(COLS, cards("todo", 2), 0);
  assert.equal(laneCount(r, "done"), 0);
  assert.equal(r.total, 2);
});

check("no terminal ROLE ⇒ the last column is terminal, exactly as the daemon windows it", () => {
  // columnKeyForRole's last-column fallback: a board whose lanes carry no `terminal` role still has one.
  const cols = COLS.map((c) => (c.role === "terminal" ? { ...c, role: undefined } : c));
  const r = boardRollup(cols, [...cards("todo", 1), ...cards("done", 50)], 80);
  assert.equal(laneCount(r, "done"), 80);
  assert.equal(r.total, 81);
});

console.log(`\n${pass} passed`);
