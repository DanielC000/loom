// Hermetic source-scan test for card bde7957f: the standalone Orchestration page was REMOVED and its two
// unique views (the per-manager orchestration_events TIMELINE + the worker branch-DIFF) were RELOCATED
// into the Overview fleet-card expansion (FleetAccordion → SessionCockpit) as role-scoped tabs. This
// replaces test/orchestration-no-global-cluster.mjs, whose premise (the page still exists) is now gone.
//
// The web package has no component test runner, so — like the file it replaces and test/fleet.mjs — this
// asserts on the shipped SOURCE TEXT, which can't drift from what actually ships. Run standalone with:
//   node --experimental-strip-types packages/web/test/orchestration-page-removed.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(dir, rel), "utf8");
const navSrc = read("../src/nav.tsx");
const appSrc = read("../src/App.tsx");
const overviewSrc = read("../src/pages/Overview.tsx");
const missionControlSrc = read("../src/pages/MissionControl.tsx");
const paletteSrc = read("../src/components/CommandPalette.tsx");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("the Orchestration page component is deleted", () => {
  assert.ok(!existsSync(path.join(dir, "../src/pages/Orchestration.tsx")), "pages/Orchestration.tsx must be removed");
});

check("no /orchestration route or nav entry survives", () => {
  assert.ok(!navSrc.includes('to: "/orchestration"'), "nav.tsx must not declare a /orchestration route");
  assert.ok(!navSrc.includes('label: "Orchestration"'), "nav.tsx must not list an Orchestration nav page");
  assert.ok(!navSrc.includes("pages/Orchestration"), "nav.tsx must not import the Orchestration page");
});

check("App.tsx no longer imports the Orchestration page", () => {
  assert.ok(!appSrc.includes("pages/Orchestration"), "App.tsx must not import the Orchestration page");
});

check("the Command Palette derives from the nav list (so no orchestration entry can linger)", () => {
  // The palette builds its page commands from useVisibleNavPages() → NAV_PAGES, so removing the nav entry
  // removes it from the palette. Assert the derivation holds and no literal /orchestration is hardcoded.
  assert.ok(paletteSrc.includes("useVisibleNavPages"), "CommandPalette must derive pages from useVisibleNavPages");
  assert.ok(!paletteSrc.includes("/orchestration"), "CommandPalette must not hardcode a /orchestration link");
});

check("the events-timeline + branch-diff are relocated into the Overview fleet-card expansion", () => {
  for (const marker of ["ManagerTimeline", "WorkerDiffPanel", "orchestrationEvents", "workerDiff", "DiffView", "EventRow"]) {
    assert.ok(overviewSrc.includes(marker), `expected Overview.tsx to contain the relocated ${marker}`);
  }
});

check("the relocated views are role-scoped tabs in the session cockpit", () => {
  // Manager rows gain a Timeline tab; worker rows gain a Diff tab — the manager→worker→live-diff drill-down.
  assert.ok(/role === "manager"[\s\S]*?"timeline"|"timeline"[\s\S]*?role === "manager"/.test(overviewSrc)
    || overviewSrc.includes('{ key: "timeline", label: "Timeline" }'), "Timeline tab must be manager-scoped");
  assert.ok(overviewSrc.includes('{ key: "diff", label: "Diff" }'), "Diff tab must be a cockpit tab");
  assert.ok(overviewSrc.includes('if (role === "manager") tabs.push({ key: "timeline"'), "Timeline tab is pushed only for managers");
  assert.ok(overviewSrc.includes('if (role === "worker") tabs.push({ key: "diff"'), "Diff tab is pushed only for workers");
});

check("Mission Control still owns the global kill/pause/resume cluster (unchanged by this move)", () => {
  assert.ok(missionControlSrc.includes("Kill all"), "Mission Control must still own the global Kill all control");
  for (const fn of ["pauseOrchestration", "resumeOrchestration", "killOrchestration"]) {
    assert.ok(missionControlSrc.includes(fn), `Mission Control must still call api.${fn}`);
  }
});

console.log(`\n${pass} passed`);
