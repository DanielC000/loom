import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f88e91f0 regression: a decision-inbox question must survive a FRESH (non-recycle) manager
// respawn, not just a recycle. question_pull used to be scoped by EXACT session_id; reparentQuestions
// only moves a row's session_id on the RECYCLE path (db.recycleManager). A manual stop + fresh spawn on
// the SAME agent is NOT a recycle (recycledFrom stays null, gen resets to 0) — the row's session_id is
// never rewritten, so it was stranded on the dead predecessor's id, invisible to the fresh successor's
// pull. Live-proven: DevToolbox Orchestrator 73623b9c (fresh, recycledFrom:null) couldn't see d247bf30's
// (stopped) decision c2660a36.
//
// The fix: all THREE decision-delivery paths now resolve by AGENT LINEAGE, not the exact asking session
// id — question_pull (db.pullAnsweredQuestionsForAgent), the answer route's IMMEDIATE push-nudge, and
// the answered-stuck watchdog (both via db.getLiveSessionForAgent).
//
// HERMETIC, claude-free (mirrors question-recycle-survival.mjs): a real Db + the REAL
// OrchestrationMcpRouter tool handlers + the REAL IdleWatcher, no live daemon, no real claude.
//
//   (1) predecessor asks a question, then is manually stopped (exited) — NEVER recycled.
//   (2) a FRESH successor session is spawned on the SAME agent (recycledFrom: null, gen 0) — the
//       question row's session_id still points at the dead predecessor (reparentQuestions never ran).
//   (3) the human answers it via the REAL REST route — the IMMEDIATE push-nudge must reach the live
//       fresh successor, not the dead predecessor's id (updated.sessionId).
//   (4) the fresh successor's question_pull (the REAL MCP tool handler) sees + consumes it.
//   (5) a DIFFERENT project's manager (different agent) does NOT see it — cross-project isolation holds
//       under agent-scoping too.
//   (6) the answered-stuck watchdog (IdleWatcher.tickAnsweredStuckQuestions), given a stuck question
//       whose asker is the dead predecessor, nudges the LIVE fresh successor — never the dead id.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-fresh-spawn-survival.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { buildServer } from "../dist/gateway/server.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-q-fresh-spawn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const dbFile = path.join(tmpHome, "qfs.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "qfs-proj", agentId = "qfs-agent", oldMgrId = "qfs-mgr-old", freshMgrId = "qfs-mgr-fresh";
const otherProjId = "qfs-other-proj", otherAgentId = "qfs-other-agent", otherMgrId = "qfs-other-mgr";

try {
  db.insertProject({ id: projId, name: "QFS", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: oldMgrId, projectId: projId, agentId, engineSessionId: "eng-old", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // A second, UNRELATED project + agent + live manager — the cross-project isolation control group.
  db.insertProject({ id: otherProjId, name: "QFS-Other", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: otherAgentId, projectId: otherProjId, name: "OtherManager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: otherMgrId, projectId: otherProjId, agentId: otherAgentId, engineSessionId: "eng-other", title: null, cwd: otherProjId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // --- (setup) the predecessor asks a question (via the REAL MCP tool handler) while still 'pending' ---
  const routerPre = new OrchestrationMcpRouter(db, {});
  const askResult = JSON.parse((await routerPre.buildServer(oldMgrId, "manager")._registeredTools["question_ask"]
    .handler({ title: "Bucket A or B?", body: "predecessor asked this before being stopped", options: ["A", "B"], recommendation: "A" })).content[0].text);
  const qid = askResult.questionId;
  check("(setup) the question was asked scoped to the PREDECESSOR's session id", db.getQuestion(qid).sessionId === oldMgrId);

  // --- (1) the predecessor is manually stopped — exited, NOT recycled ---
  db.setProcessState(oldMgrId, "exited");
  check("(1) the predecessor is now exited", db.getSession(oldMgrId).processState === "exited");

  // --- (2) a FRESH successor spawns on the SAME agent — recycledFrom:null, gen 0 (NOT a recycle) ---
  db.insertSession({
    id: freshMgrId, projectId: projId, agentId, engineSessionId: "eng-fresh", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", recycledFrom: null, gen: 0,
  });
  check("(2) the fresh successor is a genuinely NEW lineage (recycledFrom:null)", db.getSession(freshMgrId).recycledFrom == null);
  check("(2) the question row was NEVER reparented — still stranded on the dead predecessor's id", db.getQuestion(qid).sessionId === oldMgrId);

  // --- (3) the human answers it via the REAL REST route ---
  const enqueued = [];
  const stubPty = {
    enqueueStdin: (sessionId, text, source, onDeliver, route, kind) => { enqueued.push({ sessionId, text, source, kind }); return { delivered: true }; },
  };
  const stub = {};
  const app = await buildServer({
    db, pty: stubPty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    const answered = await app.inject({ method: "POST", url: `/api/questions/${qid}/answer`, payload: { chosenOption: "A", note: "go with A" } });
    check("(3) the REST answer succeeds", answered.statusCode === 200);
    check("(3) it's now 'answered', still on the dead predecessor's session_id", db.getQuestion(qid).state === "answered" && db.getQuestion(qid).sessionId === oldMgrId);
    // THE FIX (third of three decision-delivery paths): the IMMEDIATE answer-route push-nudge is now
    // AGENT-LINEAGE-AWARE too — it must reach the live FRESH successor, not the dead predecessor's id
    // (updated.sessionId), even though the question row itself was never reparented.
    check("(3) the immediate push-nudge was routed to the LIVE fresh successor, not the dead predecessor",
      enqueued.length === 1 && enqueued[0].sessionId === freshMgrId);
    check("(3) the nudge never targeted the dead predecessor's session id", enqueued.every((e) => e.sessionId !== oldMgrId));
  } finally {
    await app.close();
  }

  // --- (4) THE FIX: the fresh successor's question_pull sees + consumes the predecessor's decision ---
  const purgeCalls = [];
  const routerPost = new OrchestrationMcpRouter(db, { purgeAnsweredQuestionNudges(sessionId, ids) { purgeCalls.push({ sessionId, ids }); } });
  const freshServer = routerPost.buildServer(freshMgrId, "manager");
  const pulled = JSON.parse((await freshServer._registeredTools["question_pull"].handler({})).content[0].text);
  check("(4) the FRESH (non-recycle) successor's question_pull sees the predecessor's answered decision", pulled.questions.length === 1 && pulled.questions[0].questionId === qid);
  check("(4) it carries the human's real answer", pulled.questions[0].chosenOption === "A" && pulled.questions[0].note === "go with A");
  check("(4) it's now 'consumed' (pull is atomic consume)", db.getQuestion(qid).state === "consumed");
  check("(4) the purge call for the consumed batch used the FRESH successor's own session id", purgeCalls.length === 1 && purgeCalls[0].sessionId === freshMgrId);

  // --- (5) cross-project isolation: a DIFFERENT project's manager (different agent) never sees it ---
  // Ask + answer a second question via the predecessor (already exited, but the DB row can still be
  // written directly to simulate "answered, never pulled").
  const q2 = "qfs-q2";
  db.insertQuestion({
    id: q2, sessionId: oldMgrId, projectId: projId, title: "Second decision", body: "b",
    options: null, recommendation: null, state: "answered", chosenOption: null, note: "proceed",
    createdAt: now, answeredAt: now, consumedAt: null,
  });
  const otherServer = routerPost.buildServer(otherMgrId, "manager");
  const otherPulled = JSON.parse((await otherServer._registeredTools["question_pull"].handler({})).content[0].text);
  check("(5) a DIFFERENT project's manager (different agent) does NOT see the other project's decision", otherPulled.questions.length === 0);
  check("(5) the cross-project question is untouched (still 'answered', not consumed by the wrong project)", db.getQuestion(q2).state === "answered");

  // --- (6) the answered-stuck watchdog nudges the LIVE fresh successor, never the dead predecessor ---
  const alive = new Set([freshMgrId, otherMgrId]); // the predecessor's pty is gone
  const watcherEnqueued = [];
  const watcherPty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, source, onDeliver, route, kind) => { watcherEnqueued.push({ id, text, kind }); return { delivered: true }; },
  };
  const control = new OrchestrationControl();
  const watcher = new IdleWatcher({ db, pty: watcherPty, control, recycleRatio: 0, notifyIdleWorker: () => {}, isWorkerStranded: () => true });
  const stuckAnsweredAt = new Date(Date.now() - 30 * 60_000).toISOString(); // 30m ago > 15m threshold

  // q2 (above) was inserted with answeredAt = now — too recent to be "stuck" at the watchdog's 15m
  // threshold. Insert a THIRD question, answered 30 minutes ago, to actually exercise the stuck path.
  const q3 = "qfs-q3";
  db.insertQuestion({
    id: q3, sessionId: oldMgrId, projectId: projId, title: "Third decision (stuck)", body: "b",
    options: null, recommendation: null, state: "answered", chosenOption: null, note: "go",
    createdAt: stuckAnsweredAt, answeredAt: stuckAnsweredAt, consumedAt: null,
  });
  watcher.tick(new Date());
  const hits = watcherEnqueued.filter((x) => x.id === freshMgrId);
  check("(6) the answered-stuck watchdog nudges the LIVE FRESH successor's session id", hits.length === 1);
  check("(6) the nudge names the stuck question's title", hits[0]?.text.includes("Third decision (stuck)"));
  check("(6) the watchdog never targets the dead predecessor's session id", !watcherEnqueued.some((x) => x.id === oldMgrId));
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fresh (non-recycle) successor manager on the SAME agent now sees + consumes its predecessor's answered decision-inbox questions via all three delivery paths (the answer route's immediate push-nudge, question_pull, and the answered-stuck watchdog — all agent-lineage-scoped, not the exact dead session id), a different project's manager never sees it (cross-project isolation holds under agent-scoping), and none of the three paths ever targets the dead predecessor's session id."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
