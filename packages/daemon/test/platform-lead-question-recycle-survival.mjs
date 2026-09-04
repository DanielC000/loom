import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bb4ff73e regression: a Platform Lead's PENDING decision-inbox question (an owner Request) must
// survive a Lead self-recycle the same way a manager's already does. recycleManager has always called
// db.reparentQuestions; recyclePlatformLead did not — its own comment ("Mirrors recycleManager, minus
// the worker re-parent") named only the worker gap, silently omitting this second one. The old
// lineage-scoped hasPendingQuestionForAgent predicate ACCIDENTALLY masked the omission (same agent_id,
// so suppression worked anyway); card 8e87f3b5's session-scoped hasPendingQuestionForSession unmasked
// it — a successor Lead legitimately parked on its predecessor's still-pending owner Request would get
// idle-nudged, since the question row still pointed at the retired predecessor's session id.
//
// THE PREDICATE THIS TEST EXERCISES: db.hasPendingQuestionForSession(sessionId) is the EXACT suppression
// check idle-watcher.ts calls for both managers and platform Leads alike (`hasOwnPendingRequest =
// db.hasPendingQuestionForSession(m.id)`, m ranging over listLiveManagers() + listLivePlatformSessions())
// — asserting against it directly (rather than driving a full IdleWatcher tick, which needs an unrelated
// task-board fixture) is a faithful regression check of the real suppression path.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, mirrors platform-lead-recycle.mjs: a REAL Db + real
// SessionService driven against a FAKE pty (createPty/stop seam). A real temp git repo backs the spawn
// cwd; the only thing faked is the claude pty. The question itself is seeded directly via db.insertQuestion
// (mirrors question-fresh-spawn-survival.mjs's cross-project-isolation seed) rather than routed through
// the platform MCP router's question_ask handler — the router wiring is orthogonal to what this card fixes.
//
// PROVES the DoD-2 acceptance case:
//   (1) predecessor Lead has a still-PENDING owner Request → suppressed (hasPendingQuestionForSession true).
//   (2) recyclePlatformLead → the question row is REPARENTED onto the successor's session id (not lost,
//       not left stranded on the retired predecessor), and its state is UNCHANGED ('pending' throughout —
//       the recycle itself never answers or consumes anything).
//   (3) THE FIX: the SUCCESSOR is now suppressed too (hasPendingQuestionForSession(successor) === true) —
//       this assertion FAILS against pre-fix code (recyclePlatformLead never called reparentQuestions, so
//       the row stayed on the dead predecessor's id and the successor read false).
//   (4) the retired predecessor's id no longer matches anything (moved, not copied).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-lead-question-recycle-survival.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-lead-q-recycle-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// --- a real temp git repo so a spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-lead-q-recycle-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform lead question-recycle-survival test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=lqr@loom -c user.name=lqr");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Platform", startupPrompt: "LEAD WARMUP BRIEF", position: 0, profileId: null });

// Fake pty: no real claude, no real signals — only spawn/stop bookkeeping is exercised.
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; }
  createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
  stop(id, mode) { this.stopped.push({ id, mode }); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

try {
  // ============================ (setup) predecessor Lead + its still-pending owner Request ============
  const pred = svc.startPlatformLead("agentLead");
  check("(setup) the predecessor Lead is live", pred.processState === "live" && pred.role === "platform");

  const qid = "lqr-question-1";
  db.insertQuestion({
    id: qid, sessionId: pred.id, projectId: "pHome", title: "Authorize the new companion rollout?",
    body: "owner Request, taskId:null (typical for an owner-facing Request)", options: ["yes", "no"],
    recommendation: "yes", taskId: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });
  check("(setup) the question was seeded scoped to the PREDECESSOR's session id", db.getQuestion(qid).sessionId === pred.id);
  check("(setup) it's pending", db.getQuestion(qid).state === "pending");

  // ============================ (1) pre-recycle: the predecessor is suppressed ===========================
  check("(1) pre-recycle: the predecessor IS suppressed (hasPendingQuestionForSession true)", db.hasPendingQuestionForSession(pred.id) === true);

  // ============================ (2) recycle the Lead =====================================================
  const succ = await svc.recyclePlatformLead(pred.id, "HANDOFF: 1 owner Request still outstanding, nothing else actionable");
  check("(2) recyclePlatformLead minted a NEW session id (not the predecessor's)", succ.id !== pred.id);
  check("(2) the question's session_id was REPARENTED onto the successor", db.getQuestion(qid).sessionId === succ.id);
  check("(2) the question is UNREACHABLE at the predecessor's old id (moved, not copied)", db.listQuestionsForSession(pred.id).length === 0);
  check("(2) it's still 'pending' post-recycle (the recycle itself never answers/consumes anything)", db.getQuestion(qid).state === "pending");

  // ============================ (3) THE FIX: the SUCCESSOR is now suppressed too =========================
  // This is the assertion that fails against pre-fix code: recyclePlatformLead never called
  // reparentQuestions, so the question stayed on the dead predecessor's session id and this read false —
  // a successor Lead legitimately parked on the still-pending owner Request would get idle-nudged.
  check("(3) THE FIX: the SUCCESSOR is suppressed (hasPendingQuestionForSession(successor) true)", db.hasPendingQuestionForSession(succ.id) === true);

  // ============================ (4) the retired predecessor's id no longer matches anything ===============
  check("(4) the retired predecessor's id is no longer suppressed by a row it no longer holds", db.hasPendingQuestionForSession(pred.id) === false);
} finally {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a Platform Lead's pending owner Request now survives self-recycle exactly like a manager's: reparentQuestions moves the row onto the successor's session id (still 'pending', never lost, never left stranded on the retired predecessor), and the successor reads suppressed via the SAME hasPendingQuestionForSession predicate the idle-watcher uses for both managers and Leads."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
