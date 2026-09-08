import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card df14d55e (split from Platform Lead codex-pilot report 8f2025fc, DEFECT 4) — the 0-commit-merge
// parenthetical shared by the [loom:worker-idle] and [loom:worker-exited] nudges used to read as a
// REASSURANCE ("full credit and no visible error") instead of the HAZARD it actually is: a
// worker_merge_confirm on an empty branch closes the task done, full credit, no visible error, whether
// the branch is empty because there was genuinely nothing to do OR because the worker was structurally
// blocked — two cases that demand opposite manager responses. The fix reframes both sites (via the
// shared `zeroCommitMergeHazardNote()` helper, service.ts) to tell the manager to first establish WHY
// the branch is empty before confirming.
//
// Asserts, INDEPENDENTLY per site (a genuine assertion on each site's OWN emitted text, not one
// assertion over the shared constant — so fixing only ONE site still fails this test):
//   (1) the [loom:worker-idle] nudge (notifyManagerOfIdleWorker, stranded-worker path) carries the
//       hazard framing.
//   (2) the [loom:worker-exited] nudge (notifyManagerOfExitedWorker, genuine-no-report path) carries
//       the hazard framing.
//   (3) neither site regresses to the OLD bare-reassurance-only parenthetical.
// Proven HERMETICALLY (no claude, no daemon) — same harness shape as worker-exited-without-report.mjs:
// own temp .db, a recording fake PtyHost, the methods driven directly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date();

// The exact OLD parenthetical (card df14d55e's DEFECT) — a pure reassurance, no hazard framing at all.
// Neither site's emitted text may contain this substring after the fix.
const OLD_REASSURANCE_ONLY = "closes as a 0-commit done with full credit and no visible error";

function hasHazardFraming(text) {
  return text.includes("confirm WHY it's empty") && text.includes("nothing to do vs. blocked");
}

function makeEnv({ projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-0commit-hazard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `hz-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `hza-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "ZeroCommitHazard", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const enqueued = [];
  const pendingBySession = new Map();
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: (id) => pendingBySession.get(id) ?? [],
    hasFirstTurnStarted: () => true,
  };
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  return { dbFile, db, projId, agentId, enqueued, sessions, pendingBySession };
}

function seedSession(e, id, { role = "worker", processState = "exited", parentSessionId = null, taskId = null, branch = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState, resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
    worktreePath: null, branch, recycledFrom: null,
  });
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (1) [loom:worker-idle] — genuinely stranded worker ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-idle", { role: "manager", processState: "live" });
  seedTask(e, "tk-idle");
  seedSession(e, "wkr-idle", { role: "worker", processState: "live", parentSessionId: "mgr-idle", taskId: "tk-idle", branch: "loom/tk-idle" });
  // No pending direction, no prior report — a genuine strand, the "stranded" fallthrough branch.

  e.sessions.notifyManagerOfIdleWorker("wkr-idle");
  const idleNudge = e.enqueued.find((x) => x.id === "mgr-idle" && /worker-idle/.test(x.text));
  check("(1) precondition: a [loom:worker-idle] nudge fires for a genuinely stranded worker", !!idleNudge);
  check("(1) the [loom:worker-idle] nudge's OWN text carries the hazard framing (not just a reassurance)",
    !!idleNudge && hasHazardFraming(idleNudge.text));
  check("(1) the [loom:worker-idle] nudge does NOT regress to the old bare-reassurance parenthetical",
    !!idleNudge && !idleNudge.text.includes(OLD_REASSURANCE_ONLY));
  cleanup(e);
}

// ============================ (2) [loom:worker-exited] — genuine no-report exit ============================
{
  // crashRecoveryMaxAttempts:0 — same rationale as worker-exited-without-report.mjs case (b): with crash
  // recovery on (the project default), this exit would instead draw the DISTINCT provisional "auto-resume
  // in flight" copy, not the definitive one this test targets.
  const e = makeEnv({ projectConfig: { orchestration: { crashRecoveryMaxAttempts: 0 } } });
  seedSession(e, "mgr-exited", { role: "manager", processState: "live" });
  seedTask(e, "tk-exited");
  seedSession(e, "wkr-exited", { role: "worker", processState: "exited", parentSessionId: "mgr-exited", taskId: "tk-exited", branch: "loom/tk-exited" });

  e.sessions.notifyManagerOfExitedWorker("wkr-exited", false);
  const exitedNudge = e.enqueued.find((x) => x.id === "mgr-exited" && /worker-exited/.test(x.text));
  check("(2) precondition: a [loom:worker-exited] nudge fires for a genuine no-report exit", !!exitedNudge);
  check("(2) the [loom:worker-exited] nudge's OWN text carries the hazard framing (not just a reassurance)",
    !!exitedNudge && hasHazardFraming(exitedNudge.text));
  check("(2) the [loom:worker-exited] nudge does NOT regress to the old bare-reassurance parenthetical",
    !!exitedNudge && !exitedNudge.text.includes(OLD_REASSURANCE_ONLY));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — both the [loom:worker-idle] and [loom:worker-exited] nudges independently carry the 0-commit-merge HAZARD framing (confirm WHY the branch is empty before confirming), and neither regresses to the old bare-reassurance-only parenthetical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
