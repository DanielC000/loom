// Hermetic source-scan test for card bde7957f: the standalone Orchestration page was REMOVED and its two
// unique views (the per-manager orchestration_events TIMELINE + the worker branch-DIFF) were RELOCATED
// as role-scoped session tabs. They first lived in the classic Overview's fleet-card expansion; card
// acbb6df6 deleted that page, and their home is now the Atlas session node (components/SessionNode.tsx),
// which is what this asserts. The global kill/pause/resume cluster likewise moved from the deleted
// Mission Control page to the fleet-controls bar (components/fleetControls.tsx).
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
const sessionNodeSrc = read("../src/components/SessionNode.tsx");
const terminalCardSrc = read("../src/components/TerminalCard.tsx");
const tabsSrc = read("../src/lib/sessionNodeTabs.ts");
const fleetControlsSrc = read("../src/components/fleetControls.tsx");
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

check("the events-timeline + branch-diff are role-scoped tabs on the session node", () => {
  // Manager nodes carry a Timeline tab; worker nodes a Diff tab — the manager→worker→live-diff drill-down.
  // The node passes the role-scoped panels to the shared <TerminalCard>'s `tabs` prop.
  assert.match(sessionNodeSrc, /nodeTabs\.includes\("timeline"\)[\s\S]*?timeline:\s*<ManagerTimeline/,
    "the Timeline panel must be offered only where the role's tab set includes it");
  assert.match(sessionNodeSrc, /diff:\s*<ReviewSurface/, "the Diff panel must be the review surface");
  // The STATIC files the old checks named must be gone for real, or a stale copy could still be mounted.
  for (const gone of ["../src/pages/Overview.tsx", "../src/pages/MissionControl.tsx"]) {
    assert.ok(!existsSync(path.join(dir, gone)), `${gone} must stay deleted (card acbb6df6)`);
  }
  // The Timeline/Diff tab labels were lifted OUT of the inline cockpit by card bde7957f, and card
  // 525c8ad9 lifted them one level further — out of TerminalCard too, into lib/sessionNodeTabs.ts, so
  // the Atlas frame's crumb trail names a tab by the SAME string the tab row renders. The claim this
  // check makes is unchanged in strength: the labels have ONE home, and the surfaces that show them
  // READ it rather than re-spelling it. Re-spelling is the regression, wherever it reappears.
  assert.match(tabsSrc, /SESSION_NODE_TAB_LABEL[\s\S]*?timeline:\s*"Timeline"/,
    "lib/sessionNodeTabs.ts must define the Timeline tab's label");
  assert.match(tabsSrc, /SESSION_NODE_TAB_LABEL[\s\S]*?diff:\s*"Diff"/,
    "lib/sessionNodeTabs.ts must define the Diff tab's label");
  // A LABEL existing is not the same claim as the tab being OFFERED — the old `label: "Timeline"`
  // literal inside TerminalCard's tabDefs happened to assert both at once, and splitting the
  // declaration split the claim too. `SESSION_NODE_TAB_ORDER` is what TerminalCard maps over, so a
  // tab dropped from it would vanish from every surface while its label sat here looking healthy.
  const order = tabsSrc.match(/SESSION_NODE_TAB_ORDER[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "";
  assert.notEqual(order, "", "lib/sessionNodeTabs.ts must declare SESSION_NODE_TAB_ORDER as a literal array");
  for (const key of ["timeline", "diff"]) {
    assert.ok(order.includes(`"${key}"`),
      `SESSION_NODE_TAB_ORDER must still offer the ${key} tab — a label alone does not put it on the row`);
  }
  assert.ok(terminalCardSrc.includes("SESSION_NODE_TAB_LABEL[key]"),
    "TerminalCard must build its tab labels FROM lib/sessionNodeTabs.ts, not re-spell them");
  for (const src of [[sessionNodeSrc, "SessionNode.tsx"], [terminalCardSrc, "TerminalCard.tsx"]]) {
    assert.ok(!src[0].includes('label: "Timeline"') && !src[0].includes('label: "Diff"'),
      `${src[1]} must not re-spell a tab label — they belong to lib/sessionNodeTabs.ts`);
  }
});

check("the fleet-controls bar owns the global kill/pause/resume cluster", () => {
  assert.ok(fleetControlsSrc.includes("Kill all"), "the fleet-controls bar must own the global Kill all control");
  for (const fn of ["pauseOrchestration", "resumeOrchestration", "killOrchestration"]) {
    assert.ok(fleetControlsSrc.includes(`api.${fn}(`), `the fleet-controls bar must call api.${fn}`);
  }
});

console.log(`\n${pass} passed`);
