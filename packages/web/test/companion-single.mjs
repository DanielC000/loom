// Hermetic source-scan test for the single-companion Companion page (manager redirect on card:
// "single-companion Companion page — create-when-empty, proactive home into Manage, drop the companions
// list"). The owner-corrected design keeps EVERYTHING on the Companion page (nothing moves to Settings):
//   1. The "Companions" list/selector card + the "+ New companion" button are GONE — only ONE companion
//      can ever exist, so there is nothing to list or select.
//   2. The page branches on existence: NO companion → the CompanionCreate box IS the page; a companion
//      EXISTS → that companion is shown directly (chat + Manage), no selector. This structurally enforces
//      single-companion (no "new" affordance once one exists).
//   3. The daemon-GLOBAL proactive HOME moved from a standalone sidebar card INTO the companion's Manage
//      tab, rendered as a <section> alongside persona / skills / memory / … — behavior unchanged.
//   4. Settings.tsx is untouched — no companion surface leaked into it.
//
// The web package has no component test runner (Companion.tsx is real runtime JSX that node's
// --experimental-strip-types can't execute), so — like test/orchestration-page-removed.mjs and
// test/fleet.mjs — this asserts on the shipped SOURCE TEXT, which can't drift from what actually ships.
// Auto-globbed by test/run-all.mjs (wired into @loom/web's build). Run standalone with:
//   node --experimental-strip-types packages/web/test/companion-single.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(dir, rel), "utf8");
const compSrc = read("../src/pages/Companion.tsx");
const settingsSrc = read("../src/pages/Settings.tsx");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── 1. The companions list/selector + "New companion" button are removed ──────────────────────────────

check("no 'Companions' list/selector card survives", () => {
  assert.ok(!compSrc.includes("<SectionLabel>Companions</SectionLabel>"), "the Companions list panel header must be gone");
  assert.ok(!compSrc.includes("+ New companion"), "the '+ New companion' button must be gone");
});

check("no selector state or per-companion selection wiring survives", () => {
  assert.ok(!compSrc.includes("const [selected"), "the `selected` selector state must be gone");
  assert.ok(!compSrc.includes("setSelected"), "no setSelected calls remain");
  assert.ok(!compSrc.includes("const [creating"), "the `creating` mode state must be gone");
  assert.ok(!compSrc.includes("setCreating"), "no setCreating calls remain");
  // The old selector highlighted the active row via `c.sessionId === selected` — no such comparison remains.
  assert.ok(!compSrc.includes("=== selected"), "no `=== selected` row-selection comparison remains");
});

// ── 2. Branch on existence: create-when-empty, else show the one companion directly ───────────────────

check("the page takes the single companion (companions[0]) and renders it directly", () => {
  assert.ok(compSrc.includes("companions[0] ?? null"), "must take the first (only) companion — single-companion");
  assert.ok(compSrc.includes("<CompanionDetail"), "an existing companion renders CompanionDetail directly");
  assert.ok(compSrc.includes("<CompanionCreate"), "no companion renders the CompanionCreate box");
});

check("CompanionCreate is the fallback (no companion) branch, gated after CompanionDetail", () => {
  const detailAt = compSrc.indexOf("<CompanionDetail");
  const createAt = compSrc.indexOf("<CompanionCreate");
  assert.ok(detailAt !== -1 && createAt !== -1, "both branches present");
  // CompanionCreate is the else-fallback, so it appears AFTER the CompanionDetail branch in the JSX.
  assert.ok(createAt > detailAt, "CompanionCreate must be the create-when-empty fallback, after the detail branch");
});

check("CompanionCreate's onCancel is optional (it can be the whole page)", () => {
  assert.ok(/onCancel\?:\s*\(\)\s*=>\s*void/.test(compSrc), "onCancel must be optional so the create box needs no cancel target");
  assert.ok(compSrc.includes("{onCancel && <Button"), "the Cancel button renders only when an onCancel is provided");
});

// ── 3. Proactive home moved INTO the Manage tab as a <section> ────────────────────────────────────────

check("the standalone GlobalHome sidebar card is gone; ProactiveHomeSection replaces it", () => {
  assert.ok(!compSrc.includes("function GlobalHome"), "the standalone GlobalHome component must be gone");
  assert.ok(compSrc.includes("function ProactiveHomeSection"), "a ProactiveHomeSection (Manage-tab section) exists");
  assert.ok(compSrc.includes("<ProactiveHomeSection />"), "ProactiveHomeSection is rendered");
});

check("ProactiveHomeSection is rendered INSIDE the Manage tab panel", () => {
  const managePanelAt = compSrc.indexOf('id="companion-panel-manage"');
  const homeRenderAt = compSrc.indexOf("<ProactiveHomeSection />");
  const pairingAt = compSrc.indexOf("<PairingSection");
  assert.ok(managePanelAt !== -1, "the Manage tab panel exists");
  assert.ok(homeRenderAt > managePanelAt, "the proactive home renders within the Manage panel");
  // It sits among the Manage sections (before the last one, Pairing) — i.e. genuinely alongside them.
  assert.ok(homeRenderAt < pairingAt, "the proactive home is grouped among the Manage sections");
});

check("proactive-home behavior is preserved (set / change / clear the daemon-global home)", () => {
  assert.ok(compSrc.includes("api.setCompanionHome"), "set/change home write preserved");
  assert.ok(compSrc.includes("api.clearCompanionHome"), "clear home write preserved");
  assert.ok(compSrc.includes("api.companionHome"), "home read preserved");
});

// ── 4. The now-stale copy is fixed; nothing leaked into Settings ──────────────────────────────────────

check("the stale 'in the sidebar' pointer is fixed to point at the Manage tab", () => {
  assert.ok(!compSrc.includes("in the sidebar"), "the 'Proactive home in the sidebar' copy must be gone");
  assert.ok(compSrc.includes("in this Manage tab"), "the pointer now names the Manage tab");
});

check("Settings.tsx is untouched — no companion surface leaked into it", () => {
  assert.ok(!settingsSrc.includes("Companion"), "Settings must not host any companion control");
  assert.ok(!settingsSrc.includes("companion"), "Settings must not reference the companion api/lib");
});

console.log(`\n${pass} checks passed`);
