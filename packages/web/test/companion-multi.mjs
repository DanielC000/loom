// Hermetic source-scan test for the MULTI-companion Companion page (card: "build the 'create additional
// companion' UI"). The multi-companion runtime (55f1b62 — the daemon arms EVERY enabled config concurrently,
// the single-companion provision 409 is gone) means the page can no longer structurally enforce one companion.
// It now:
//   1. Surfaces a "+ New companion" affordance (always available) that POSTs to /api/companion/provision to
//      create an ADDITIONAL companion, and a CompanionSwitcher picker to switch which companion is in focus.
//   2. Branches on existence + a `creating` flag: no companion (or the owner opted to create) → the
//      CompanionCreate box; else the switcher + the focused companion's CompanionDetail. Selection is
//      client-only via `selectedId`, tolerating a stale/deleted selection by falling back to companions[0].
//   3. The daemon-GLOBAL proactive HOME still lives INSIDE the companion's Manage tab as a <section>
//      (unchanged from the single-companion design).
//   4. Settings.tsx is untouched — no companion surface leaked into it.
//
// The web package has no component test runner (Companion.tsx is real runtime JSX that node's
// --experimental-strip-types can't execute), so — like test/orchestration-page-removed.mjs and
// test/fleet.mjs — this asserts on the shipped SOURCE TEXT, which can't drift from what actually ships.
// The live DOM behavior (the picker renders, switching re-scopes the panes, create opens/cancels) is covered
// by the Playwright spec e2e/companion.spec.ts. Auto-globbed by test/run-all.mjs. Run standalone with:
//   node --experimental-strip-types packages/web/test/companion-multi.mjs
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

// ── 1. The "+ New companion" affordance + the CompanionSwitcher picker exist ──────────────────────────

check("the '+ New companion' affordance is present", () => {
  assert.ok(compSrc.includes("+ New companion"), "the '+ New companion' button must exist so an additional companion can be provisioned");
});

check("a CompanionSwitcher picker component exists and is rendered", () => {
  assert.ok(compSrc.includes("function CompanionSwitcher"), "a CompanionSwitcher component exists");
  assert.ok(compSrc.includes("<CompanionSwitcher"), "the switcher is rendered above the focused companion");
  // The picker only appears with 2+ companions (nothing to pick between with one) — the guard reads length > 1.
  assert.ok(compSrc.includes("companions.length > 1"), "the picker is gated on there being more than one companion");
});

// ── 2. Selector + creating state wiring is present ────────────────────────────────────────────────────

check("per-companion selection + create-mode state wiring is present", () => {
  assert.ok(compSrc.includes("const [selectedId"), "the `selectedId` selection state exists");
  assert.ok(compSrc.includes("setSelectedId"), "setSelectedId is wired (the picker sets the focus)");
  assert.ok(compSrc.includes("const [creating"), "the `creating` mode state exists (create OVER an existing companion)");
  assert.ok(compSrc.includes("setCreating"), "setCreating is wired");
});

// ── 3. Branch on existence + creating: create box, else switcher + the focused companion ──────────────

check("the page resolves the focused companion, tolerating a stale selection via a companions[0] fallback", () => {
  assert.ok(compSrc.includes("companions.find((c) => c.sessionId === selectedId)"), "the focus is resolved by selectedId");
  assert.ok(compSrc.includes("?? companions[0] ?? null"), "a stale/absent selection falls back to the first companion");
  assert.ok(compSrc.includes("<CompanionDetail"), "the focused companion renders CompanionDetail");
  assert.ok(compSrc.includes("<CompanionCreate"), "the create box renders CompanionCreate");
});

check("provisioning focuses the newly created companion", () => {
  // onSuccess captures the created companion and focuses it so its Chat surface opens straight away.
  assert.ok(/onSuccess:\s*\(created[^)]*\)\s*=>\s*\{[^}]*setSelectedId\(created\.sessionId\)/.test(compSrc),
    "provision.onSuccess sets the selection to the new companion's sessionId");
});

check("CompanionCreate's onCancel is optional (it can be the whole page when there's no companion)", () => {
  assert.ok(/onCancel\?:\s*\(\)\s*=>\s*void/.test(compSrc), "onCancel must be optional so the create box needs no cancel target");
  assert.ok(compSrc.includes("{onCancel && <Button"), "the Cancel button renders only when an onCancel is provided");
});

// ── 4. Proactive home stays INSIDE the Manage tab as a <section> (unchanged) ──────────────────────────

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

// ── 5. The Manage-tab copy is correct; nothing leaked into Settings ───────────────────────────────────

check("the proactive-home pointer names the Manage tab (not the removed sidebar)", () => {
  assert.ok(!compSrc.includes("in the sidebar"), "the 'Proactive home in the sidebar' copy must be gone");
  assert.ok(compSrc.includes("in this Manage tab"), "the pointer now names the Manage tab");
});

check("Settings.tsx is untouched — no companion surface leaked into it", () => {
  assert.ok(!settingsSrc.includes("Companion"), "Settings must not host any companion control");
  assert.ok(!settingsSrc.includes("companion"), "Settings must not reference the companion api/lib");
});

console.log(`\n${pass} checks passed`);
