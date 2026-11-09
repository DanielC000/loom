// Hermetic unit test for lib/bottomDock.ts › clearanceFor (card 3094c4aa, Atlas audit B-02): the bottom
// offset at which the request pill clears every registered bottom-docked control in its corner.
//   node --experimental-strip-types packages/web/test/bottom-dock-clearance.mjs
import assert from "node:assert/strict";
import { clearanceFor } from "../src/lib/bottomDock.ts";

const VW = 1440, VH = 900;
const PILL = { width: 270, height: 34, right: 16, base: 16, gap: 8 };
const box = (left, top, right, bottom) => ({ left, top, right, bottom });

// No docks → the base offset.
assert.equal(clearanceFor([], VW, VH, PILL), 16);

// A full-width sticky bar whose top is at 820 overlaps the pill's default zone (850..884) → rise to
// 900 - 820 + 8 = 88.
assert.equal(clearanceFor([box(260, 820, 1420, 890)], VW, VH, PILL), 88);

// A dock in the bottom-LEFT, clear of the pill's horizontal band, does not move it.
assert.equal(clearanceFor([box(260, 820, 700, 890)], VW, VH, PILL), 16);

// A dock entirely above the pill's zone does not move it.
assert.equal(clearanceFor([box(260, 500, 1420, 600)], VW, VH, PILL), 16);

// Two stacked docks: clearing the lower one lands the pill on the upper one, so it clears both.
assert.equal(clearanceFor([box(1000, 820, 1420, 890), box(1000, 760, 1420, 815)], VW, VH, PILL), 900 - 760 + 8);

// A zero-height (collapsed) dock is ignored.
assert.equal(clearanceFor([box(260, 850, 1420, 850)], VW, VH, PILL), 16);

console.log("bottom-dock-clearance: 6 assertions passed");
