// Hermetic unit test for src/lib/laneReorder.ts (card 139cfc3d): the within-lane reorder maths the board's
// drag and Alt+↑/↓ both run — band clamping, the midpoint write, and the renumber fallback when the
// neighbours leave no room. Board.tsx imports the same functions, so this cannot drift from what ships.
//   node --experimental-strip-types packages/web/test/lane-reorder.mjs
import assert from "node:assert/strict";
import { bandSlots, clampSlot, slotForPointer, positionAt, renumberBand, planReorder, REORDER_STEP } from "../src/lib/laneReorder.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };
const card = (id, priority, position) => ({ id, priority, position });

// A lane sorted by priority then position: one P1, three P2, one P3.
const lane = [card("a", "p1", 10), card("b", "p2", 100), card("c", "p2", 200), card("d", "p2", 300), card("e", "p3", 5)];

check("bandSlots spans the band, and an empty band is the slot where it would sort", () => {
  const others = lane.filter((t) => t.id !== "c");
  assert.deepEqual(bandSlots(others, "p2"), [1, 3]);
  assert.deepEqual(bandSlots(others, "p0"), [0, 0]);
  assert.deepEqual(bandSlots(lane.filter((t) => t.id !== "e"), "p3"), [4, 4]);
});

check("a slot past the band edge clamps to that edge (never across into another priority)", () => {
  const others = lane.filter((t) => t.id !== "c");
  assert.equal(clampSlot(others, "p2", 0), 1); // above the P1 → top of P2
  assert.equal(clampSlot(others, "p2", 4), 3); // below the P3 → bottom of P2
  assert.equal(clampSlot(others, "p2", 2), 2);
});

check("an absent priority reads as the p2 default", () => {
  const l = [card("x", undefined, 1), card("y", "p2", 2)];
  assert.deepEqual(bandSlots(l.filter((t) => t.id !== "y"), "p2"), [0, 1]);
});

check("slotForPointer counts the midpoints above the pointer", () => {
  assert.equal(slotForPointer([10, 30, 50], 5), 0);
  assert.equal(slotForPointer([10, 30, 50], 31), 2);
  assert.equal(slotForPointer([10, 30, 50], 99), 3);
});

check("between two neighbours the card takes their midpoint; at a band edge it steps past the neighbour", () => {
  const others = lane.filter((t) => t.id !== "d");
  assert.equal(positionAt(others, "p2", 2), 150);
  assert.equal(positionAt(others, "p2", 1), 100 - REORDER_STEP);
  assert.equal(positionAt(others, "p2", 3), 200 + REORDER_STEP);
});

check("equal neighbours (legacy position 0) leave no midpoint, so positionAt asks for a renumber", () => {
  const others = [card("p", "p2", 0), card("q", "p2", 0)];
  assert.equal(positionAt(others, "p2", 1), null);
});

check("a gap too small for a double to split asks for a renumber", () => {
  const big = 1.7e12;
  const others = [card("p", "p2", big), card("q", "p2", big + 2 ** -12)];
  assert.equal(positionAt(others, "p2", 1), null);
});

check("planReorder: a drop on the card's own slot is a no-op", () => {
  assert.equal(planReorder(lane, "c", 2, lane), null);
  // ...and so is a drop past the band edge that clamps back onto it.
  assert.equal(planReorder(lane, "b", 0, lane), null);
});

check("planReorder: moving the bottom P2 to the top of its band writes ONE position", () => {
  const plan = planReorder(lane, "d", 0, lane.filter((t) => t.priority === "p2"));
  assert.deepEqual(plan, { slot: 1, writes: [{ id: "d", position: 100 - REORDER_STEP }], renumbered: false });
});

check("planReorder: tied neighbours renumber the WHOLE band from its lowest position, changed cards only", () => {
  const tied = [card("a", "p1", 0), card("b", "p2", 0), card("c", "p2", 0), card("d", "p2", 0)];
  const plan = planReorder(tied, "d", 2, tied.filter((t) => t.priority === "p2"));
  assert.equal(plan.renumbered, true);
  // b, d, c — b keeps 0, so only d and c are written.
  assert.deepEqual(plan.writes, [{ id: "d", position: REORDER_STEP }, { id: "c", position: 2 * REORDER_STEP }]);
});

check("renumberBand keeps a card a filter hid in its place relative to the anchor", () => {
  // On screen: b, d (c is filtered out). Moving d before b; c (hidden) stays after b.
  const band = [card("b", "p2", 5), card("c", "p2", 5), card("d", "p2", 5)];
  // d takes the band's lowest value (5, unchanged), so only b and c are written.
  assert.deepEqual(renumberBand(band, "d", "b", null).map((w) => w.id), ["b", "c"]);
  const writes = renumberBand(band, "d", "b", null);
  const pos = new Map(band.map((t) => [t.id, t.position]));
  for (const w of writes) pos.set(w.id, w.position);
  assert.deepEqual([...pos].sort((x, y) => x[1] - y[1]).map(([id]) => id), ["d", "b", "c"]);
});

check("renumberBand with only an after-anchor lands right after it", () => {
  const band = [card("b", "p2", 1), card("c", "p2", 1), card("d", "p2", 1)];
  const pos = new Map(band.map((t) => [t.id, t.position]));
  for (const w of renumberBand(band, "b", null, "c")) pos.set(w.id, w.position);
  assert.deepEqual([...pos].sort((x, y) => x[1] - y[1]).map(([id]) => id), ["c", "b", "d"]);
});

console.log(`\n${pass} checks passed`);
