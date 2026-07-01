// Hermetic test for card 3fd4d245: the expanded fleet card must stay BOUNDED when a project has many
// sessions — the outer FleetCockpitRow list is capped + internally scrollable — AND fold in card
// efd191ea: the live+archived accordion merge must dedupe by session id (keeping the LIVE row) so a
// session mid-transition live→archived doesn't render two siblings with the same React key.
//
// Two layers, no DOM/test-runner in the web package:
//   • UNIT — imports the pure `dedupeSessionsById` from src/lib/sessions.ts (Node type-stripping erases
//     only the `import type`) and asserts it on plain objects, so it exercises the REAL shipped helper.
//   • SOURCE-SCAN — asserts on Overview.tsx's shipped text (like test/fleet.mjs / overview-stats.mjs)
//     that the outer row-list carries the maxHeight cap + overflowY:auto and that BOTH merged lists are
//     routed through the dedupe before render.
// Run standalone with:
//   node --experimental-strip-types packages/web/test/fleet-list-bounded.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dedupeSessionsById } from "../src/lib/sessions.ts";

const overviewSrc = readFileSync(fileURLToPath(new URL("../src/pages/Overview.tsx", import.meta.url)), "utf8");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── UNIT: dedupeSessionsById ────────────────────────────────────────────────────
const row = (id, tag) => ({ id, tag });

check("dedupe drops a repeated id, keeping the FIRST (live-first ⇒ live) occurrence", () => {
  // Mirrors [...workers(live), ...archivedWorkers]: the live row for "dup" leads, so it wins.
  const merged = dedupeSessionsById([row("dup", "live"), row("b", "live"), row("dup", "archived")]);
  assert.deepEqual(merged.map((r) => r.id), ["dup", "b"]);
  assert.equal(merged.find((r) => r.id === "dup").tag, "live", "the LIVE row must be the one kept");
});

check("dedupe is a no-op (identity of contents) when every id is unique", () => {
  const input = [row("a"), row("b"), row("c")];
  assert.deepEqual(dedupeSessionsById(input).map((r) => r.id), ["a", "b", "c"]);
});

check("dedupe preserves order and handles the empty list", () => {
  assert.deepEqual(dedupeSessionsById([]), []);
  assert.deepEqual(dedupeSessionsById([row("z"), row("a"), row("z"), row("m")]).map((r) => r.id), ["z", "a", "m"]);
});

// ── SOURCE-SCAN: Overview.tsx ────────────────────────────────────────────────────
check("both live+archived merges are routed through dedupeSessionsById before render", () => {
  assert.ok(overviewSrc.includes('import { bySessionActivity, byCreatedStable, byManagerThenCreated, dedupeSessionsById } from "../lib/sessions"'),
    "Overview must import dedupeSessionsById");
  assert.match(overviewSrc, /accordionManagers\s*=\s*dedupeSessionsById\(\[\.\.\.managers, \.\.\.archivedManagers\]\)/,
    "accordionManagers must dedupe the live+archived manager merge");
  assert.match(overviewSrc, /accordionWorkers\s*=\s*dedupeSessionsById\(\[\.\.\.workers, \.\.\.archivedWorkers\]\)/,
    "accordionWorkers must dedupe the live+archived worker merge (card efd191ea)");
});

check("the outer FleetCockpitRow list is bounded + internally scrollable", () => {
  assert.ok(overviewSrc.includes("const FLEET_LIST_MAX_HEIGHT ="),
    "a named cap constant for the outer list must exist");
  // The scroll container binds the cap to maxHeight and enables vertical overflow scrolling.
  assert.match(overviewSrc, /maxHeight:\s*FLEET_LIST_MAX_HEIGHT,\s*overflowY:\s*"auto"/,
    "the outer row-list container must set maxHeight + overflowY:auto");
});

check("the inner session cockpit stays independently bounded (not re-capped by this change)", () => {
  // The row's own cockpit pane keeps its pre-existing 440 bound — we cap the OUTER list, not the inner.
  assert.ok(overviewSrc.includes("height: 440"), "the inner cockpit pane must retain its own 440 bound");
});

console.log(`\n${pass} passed`);
