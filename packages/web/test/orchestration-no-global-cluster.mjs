// Hermetic unit test for UI-audit finding #6 (card 8d076b99) + finding #11 (card 48b6c23d).
// Bug: Orchestration.tsx duplicated MissionControl.tsx's global Pause/Resume/Kill-all cluster
// verbatim — two places to hit the same global orchestration controls. Fix: the cluster now lives
// ONLY on Mission Control; Orchestration is trimmed to its unique manager→worker→diff drill-down
// and demoted in the nav (out of the Project group, into Config, since it's reached from a fleet
// card rather than being a primary standalone destination).
//
// Orchestration.tsx has no separable pure function to import (it's all JSX), and the web package has
// no component test runner, so — like test/terminal-chrome.mjs's source-scan style — this asserts
// directly on the shipped SOURCE TEXT of the two files, which can't drift from what actually ships.
// Run it with:
//   node --experimental-strip-types packages/web/test/orchestration-no-global-cluster.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const orchestrationSrc = readFileSync(path.join(dir, "../src/pages/Orchestration.tsx"), "utf8");
const missionControlSrc = readFileSync(path.join(dir, "../src/pages/MissionControl.tsx"), "utf8");
const navSrc = readFileSync(path.join(dir, "../src/nav.tsx"), "utf8");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("Orchestration no longer renders the global Kill all control", () => {
  assert.ok(!orchestrationSrc.includes("Kill all"), "\"Kill all\" must not appear in Orchestration.tsx");
});

check("Orchestration no longer wires the global pause/resume/kill mutations", () => {
  for (const fn of ["pauseOrchestration", "resumeOrchestration", "killOrchestration"]) {
    assert.ok(!orchestrationSrc.includes(fn), `Orchestration.tsx must not call api.${fn}`);
  }
});

check("Orchestration keeps its unique manager→worker→diff drill-down", () => {
  for (const marker of ["workerDiff", "orchEvents", "WorkerCard", "DiffView"]) {
    assert.ok(orchestrationSrc.includes(marker), `expected Orchestration.tsx to still contain ${marker}`);
  }
});

check("exactly one place in the cockpit owns the global kill/pause/resume cluster: Mission Control", () => {
  assert.ok(missionControlSrc.includes("Kill all"), "Mission Control must still own the global Kill all control");
  for (const fn of ["pauseOrchestration", "resumeOrchestration", "killOrchestration"]) {
    assert.ok(missionControlSrc.includes(fn), `Mission Control must still call api.${fn}`);
  }
});

check("Orchestration's nav entry is demoted out of the Project group into Config", () => {
  const match = navSrc.match(/\{ label: "Orchestration",[^}]*\}/);
  assert.ok(match, "expected an Orchestration entry in nav.tsx");
  assert.ok(match[0].includes('group: "config"'), "Orchestration should be grouped under config, not project");
  assert.ok(!match[0].includes("primary: true"), "Orchestration must not be a primary header tab");
});

console.log(`\n${pass} passed`);
