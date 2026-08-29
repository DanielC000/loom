import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6483ddfa — REGRESSION for a P0 silent data-destruction bug: the manager's project_update
// (sessions/service.ts updateProjectStructural) stored the VALIDATED CONFIG PATCH as the WHOLE
// config instead of merging it onto the existing override, so a valid one-key patch silently
// dropped every OTHER key. Fired for real 2026-07-31T23:57:28Z on project 046fda54 (Codescape),
// wiping sessionEnv + orchestration.gateCommand/gateCommandTimeoutMs in one patch.
//
// This must cover BOTH a top-level key (sessionEnv) and a NESTED key (orchestration.gateCommand)
// — the forensic evidence showed both were lost, and a fix that merges only at the top level would
// preserve sessionEnv while still flattening orchestration, passing a naive single-field test.
//
// HERMETIC + CLAUDE-FREE (real Db + SessionService against a no-op fake pty, in the style of
// mgr-own-project-scope.mjs). Also proves the trap the fix must avoid: a human-only key
// (orchestration.gateCommand) the agent validator would REJECT if resubmitted must survive
// UNTOUCHED through a patch that never re-validates the merged whole.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-update-config-merge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-projcfgmerge-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));

// Seed a project with a config override carrying: a top-level human-only key (sessionEnv), a
// NESTED human-only key (orchestration.gateCommand, paired with its timeout), a benign nested
// agent-settable key (orchestration.maxConcurrentWorkers), kanbanColumns, and a memory setting —
// mirroring the real Codescape config shape from the incident's audit row.
const seededConfig = {
  sessionEnv: { LOOM_DEJA_BIN: "C:/deja/dist/cli.js" },
  orchestration: { gateCommand: "npm run typecheck && npm run build && npm test", gateCommandTimeoutMs: 700000, maxConcurrentWorkers: 3 },
  kanbanColumns: [{ key: "todo", label: "Todo", role: "defaultLanding" }, { key: "done", label: "Done", role: "terminal" }],
  memory: { budgetTokens: 5000 },
};
db.insertProject({ id: "pCfg", name: "CfgProj", repoPath: tmpHome, vaultPath: tmpHome, config: seededConfig, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "aCfg", projectId: "pCfg", name: "Lead", startupPrompt: "do it", position: 0, profileId: null });
db.insertSession({
  id: "M", projectId: "pCfg", agentId: "aCfg", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null,
});

const pty = { enqueueStdin: () => ({ delivered: false }) };
const svc = new SessionService(db, pty, new OrchestrationControl());

try {
  check("sanity: seeded config landed as given", db.getProject("pCfg").config.orchestration.gateCommand === seededConfig.orchestration.gateCommand);

  // The manager patches ONE unrelated orchestration subkey — recycleAtContextRatio, an agent-settable
  // benign tuning number that has nothing to do with gateCommand/sessionEnv/kanbanColumns/memory.
  const result = svc.updateProjectStructural("M", "pCfg", { config: { orchestration: { recycleAtContextRatio: 0.8 } } });
  check("project_update: the patch call itself succeeds (no error thrown)", !!result && result.id === "pCfg");

  const after = db.getProject("pCfg").config;

  // The patched key landed.
  check("project_update: the patched key (orchestration.recycleAtContextRatio) landed", after.orchestration?.recycleAtContextRatio === 0.8);

  // ════════ THE REGRESSION: everything NOT in the patch must survive ════════
  check("project_update MERGE: top-level sessionEnv survives an unrelated orchestration patch",
    after.sessionEnv?.LOOM_DEJA_BIN === "C:/deja/dist/cli.js");
  check("project_update MERGE: nested orchestration.gateCommand (human-only) survives untouched",
    after.orchestration?.gateCommand === "npm run typecheck && npm run build && npm test");
  check("project_update MERGE: nested orchestration.gateCommandTimeoutMs survives untouched",
    after.orchestration?.gateCommandTimeoutMs === 700000);
  check("project_update MERGE: sibling orchestration.maxConcurrentWorkers survives untouched (deep-merge, not orchestration-key replace)",
    after.orchestration?.maxConcurrentWorkers === 3);
  check("project_update MERGE: top-level kanbanColumns survives untouched", Array.isArray(after.kanbanColumns) && after.kanbanColumns.length === 2);
  check("project_update MERGE: top-level memory.budgetTokens survives untouched", after.memory?.budgetTokens === 5000);

  // A second patch targeting a DIFFERENT top-level key (kanbanColumns) must not disturb orchestration/sessionEnv either.
  svc.updateProjectStructural("M", "pCfg", { config: { kanbanColumns: [{ key: "todo", label: "Todo", role: "defaultLanding" }, { key: "wip", label: "WIP", role: "terminal" }] } });
  const after2 = db.getProject("pCfg").config;
  check("project_update MERGE: a kanbanColumns-only patch still preserves sessionEnv + orchestration.gateCommand",
    after2.sessionEnv?.LOOM_DEJA_BIN === "C:/deja/dist/cli.js" && after2.orchestration?.gateCommand === seededConfig.orchestration.gateCommand);
  check("project_update MERGE: the kanbanColumns patch itself still applies", after2.kanbanColumns.some((c) => c.key === "wip"));

  // ════════ THE TRAP — re-submitting gateCommand through the agent path must still be REJECTED,
  // and that rejection must not disturb the already-preserved value from the merge above. ════════
  let rejectedMsg = null;
  try { svc.updateProjectStructural("M", "pCfg", { config: { orchestration: { gateCommand: "calc.exe" } } }); }
  catch (e) { rejectedMsg = e instanceof Error ? e.message : String(e); }
  check("project_update: an agent-submitted gateCommand is still REJECTED (validator runs on the PATCH, not skipped)",
    typeof rejectedMsg === "string" && /invalid config/.test(rejectedMsg));
  check("project_update: the rejected gateCommand attempt left the preserved value UNCHANGED",
    db.getProject("pCfg").config.orchestration.gateCommand === seededConfig.orchestration.gateCommand);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_update's config write is a deep MERGE onto the existing override, not a replace: an unrelated patch preserves top-level (sessionEnv) AND nested (orchestration.gateCommand/gateCommandTimeoutMs/maxConcurrentWorkers) keys, kanbanColumns, and memory settings, while the patch itself still lands and a human-only key is still rejected on write without corrupting the preserved value — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
