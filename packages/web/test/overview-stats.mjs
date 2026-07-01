// Hermetic guard for Overview.tsx's header stat labels (UI-audit finding #18).
// Bug: auto-archive redefined the manager/worker sets to RUNNING-only, so the header stats now count
// the ACTIVE fleet — but the bare labels "managers"/"workers" read as the whole fleet and understated
// it. Fix: relabel to "active managers"/"active workers", matching Mission Control's "active fleet"
// wording. This is inline JSX label text (not a pure function) inside a component wired to
// react-router + react-query, so — with no DOM/test-runner in the web package — this guard asserts at
// the SOURCE level that the two header Stats carry the "active" wording (and no longer the bare form),
// pinning the regression a revert would reintroduce. Run it with:
//   node --experimental-strip-types packages/web/test/overview-stats.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../src/pages/Overview.tsx", import.meta.url)), "utf8");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check('the header manager stat is labeled "active managers"', () => {
  assert.match(src, /<Stat label="active managers" value=\{managers\.length\} \/>/);
});

check('the header worker stat is labeled "active workers"', () => {
  assert.match(src, /<Stat label="active workers" value=\{workers\.length\} \/>/);
});

check("no bare managers/workers header stat remains", () => {
  assert.doesNotMatch(src, /<Stat label="managers"/);
  assert.doesNotMatch(src, /<Stat label="workers"/);
});

console.log(`\n${pass} passed`);
