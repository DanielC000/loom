// Hermetic unit test for src/lib/laneOverflow.ts (card c315f579): which board lanes are out of view, and
// where the "N more lanes" chip scrolls to. Board.tsx calls the SAME functions, so this can't drift from
// what ships. Run it with:
//   node --experimental-strip-types packages/web/test/lane-overflow.mjs
import assert from "node:assert/strict";
import { laneOverflow, scrollTargetFor } from "../src/lib/laneOverflow.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// Seven 240px lanes with a 10px gap, the measured 1440 shape: lane i spans [i*250, i*250+240].
const KEYS = ["inbox", "backlog", "todo", "in_progress", "waiting", "review", "done"];
const lanes = KEYS.map((key, i) => ({ key, left: i * 250, right: i * 250 + 240 }));

check("a board that fits shows nothing on either side", () => {
  assert.deepEqual(laneOverflow(lanes, 0, 1740), { before: [], after: [] });
});

check("a lane sliced mid-word counts as more, not just fully hidden lanes", () => {
  // 1100px window: waiting [1000,1240] is cut, review and done are fully off.
  assert.deepEqual(laneOverflow(lanes, 0, 1100), { before: [], after: ["waiting", "review", "done"] });
});

check("sub-pixel overhang is not a hidden lane", () => {
  assert.deepEqual(laneOverflow(lanes, 0, 1739.4).after, []);
});

check("scrolled to the end, the lanes behind are on the left", () => {
  assert.deepEqual(laneOverflow(lanes, 640, 1740), { before: ["inbox", "backlog", "todo"], after: [] });
});

check("the chip scrolls the next lane fully in, leaving fade room when more remain", () => {
  // Bring waiting's right edge (1240) in with 48px to spare: 1240 - 1100 + 48.
  assert.equal(scrollTargetFor(lanes, 0, 1100, "after", 48), 188);
  // At the last hidden lane there is nothing beyond, so no fade room: 1740 - 1100.
  assert.equal(scrollTargetFor(lanes, 600, 1700, "after", 48), 640);
});

check("the left chip scrolls back to the nearest hidden lane", () => {
  // From 640, todo [500,740] is the nearest cut lane; more remain before it, so 32px of room.
  assert.equal(scrollTargetFor(lanes, 640, 1740, "before", 32), 468);
  assert.equal(scrollTargetFor(lanes, 100, 1200, "before", 32), 0);
});

check("nothing hidden on a side means no target", () => {
  assert.equal(scrollTargetFor(lanes, 0, 1740, "after", 48), null);
  assert.equal(scrollTargetFor(lanes, 0, 1100, "before", 32), null);
});

console.log(`\n${pass} passed`);
