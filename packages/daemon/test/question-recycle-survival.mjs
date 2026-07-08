import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CR MAJOR 2 regression (card 8701bdbb, decision inbox): a question must survive a MANAGER RECYCLE.
// question_pull is scoped by EXACT session_id, but recycleManager mints the successor a NEW session id
// — without reparenting `questions` (as it already does for workers/wakes/messages — the SAME
// recycle-changes-session-id class card 93609ef3 fixed for worker reads), a question asked by the
// predecessor would be stranded: unreachable from the successor's own session id, and its push-nudge
// would target the retired predecessor's dead pty.
//
// HERMETIC, claude-free (mirrors recycle-pending-carry.mjs's PtyStub — no real claude, no live daemon):
//   (1) manager asks a question (still 'pending') → recycleManager → db.reparentQuestions moved it onto
//       the successor's session_id.
//   (2) the human answers it via the REAL REST route (POST /api/questions/:id/answer, buildServer +
//       app.inject) AFTER the recycle — the push-nudge must reach the SUCCESSOR's pty, not the retired
//       predecessor's.
//   (3) the successor's question_pull (the REAL MCP tool handler) returns the now-answered question.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-recycle-survival.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { buildServer } from "../dist/gateway/server.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-q-recycle-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// A contract-faithful PtyStub (mirrors recycle-pending-carry.mjs): spawn/stop/isAlive are enough for
// recycleManager's own teardown/wiring; enqueueStdin records calls so we can assert WHICH session id a
// later nudge targets.
class PtyStub {
  constructor() { this.live = new Set(); this.spawned = []; this.stopped = []; this.enqueued = []; }
  spawn(opts) { this.spawned.push(opts); this.live.add(opts.sessionId); }
  stop(id) { this.stopped.push(id); this.live.delete(id); }
  isAlive(id) { return this.live.has(id); }
  flushPending() { return []; } // nothing queued in this scenario
  getPending() { return []; }
  enqueueStdin(sessionId, text, source, onDeliver, route, kind) {
    this.enqueued.push({ sessionId, text, source, route, kind });
    return { delivered: true };
  }
}

const dbFile = path.join(tmpHome, "qr.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "qr-proj", agentId = "qr-agent", oldMgrId = "qr-mgr-old";

try {
  db.insertProject({ id: projId, name: "QR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: oldMgrId, projectId: projId, agentId, engineSessionId: "eng-old", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // --- (setup) the predecessor asks a question (via the REAL MCP tool handler) while still 'pending' ---
  const routerPre = new OrchestrationMcpRouter(db, {});
  const askResult = JSON.parse((await routerPre.buildServer(oldMgrId, "manager")._registeredTools["question_ask"]
    .handler({ title: "Ship the migration?", body: "gate is green", options: ["yes", "no"], recommendation: "yes" })).content[0].text);
  const qid = askResult.questionId;
  check("(setup) the question was asked scoped to the PREDECESSOR's session id", db.getQuestion(qid).sessionId === oldMgrId);
  check("(setup) it's still 'pending' (not yet answered)", db.getQuestion(qid).state === "pending");

  // --- (1) recycle the manager: the question must move onto the successor's session id ---
  const pty = new PtyStub();
  pty.live.add(oldMgrId);
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const fresh = await sessions.recycleManager(oldMgrId, "successor: 1 pending decision-inbox question outstanding");

  check("(1) recycleManager minted a NEW session id (not the predecessor's)", fresh.id !== oldMgrId);
  check("(1) the question's session_id was REPARENTED onto the successor", db.getQuestion(qid).sessionId === fresh.id);
  check("(1) the question is UNREACHABLE at the predecessor's old id (moved, not copied)", db.listQuestionsForSession(oldMgrId).length === 0);
  check("(1) it's still 'pending' post-recycle (the recycle itself doesn't answer anything)", db.getQuestion(qid).state === "pending");

  // --- (2) the human answers it via the REAL REST route, AFTER the recycle — the nudge must reach the
  // SUCCESSOR, never the retired predecessor's dead pty ---
  const stub = {};
  const app = await buildServer({
    db, pty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    const answered = await app.inject({ method: "POST", url: `/api/questions/${qid}/answer`, payload: { chosenOption: "yes", note: "ship it" } });
    check("(2) the REST answer succeeds post-recycle", answered.statusCode === 200);
    check("(2) the push-nudge targets the SUCCESSOR's session id", pty.enqueued.length === 1 && pty.enqueued[0].sessionId === fresh.id);
    check("(2) the nudge did NOT target the retired predecessor", pty.enqueued.every((e) => e.sessionId !== oldMgrId));
  } finally {
    await app.close();
  }

  // --- (3) the successor's question_pull (the REAL tool handler) sees the now-answered question ---
  const routerPost = new OrchestrationMcpRouter(db, { purgeAnsweredQuestionNudges() {} }); // question_pull's post-consume purge call needs this stubbed
  const successorServer = routerPost.buildServer(fresh.id, "manager");
  const pulled = JSON.parse((await successorServer._registeredTools["question_pull"].handler({})).content[0].text);
  check("(3) the SUCCESSOR's question_pull returns the reparented, now-answered question", pulled.questions.length === 1 && pulled.questions[0].questionId === qid);
  check("(3) it carries the human's real answer", pulled.questions[0].chosenOption === "yes" && pulled.questions[0].note === "ship it");
  check("(3) it's now 'consumed' (pull is atomic consume)", db.getQuestion(qid).state === "consumed");

  // Sanity: the OLD (retired) manager's session can never pull it — it has no orchestration surface use
  // here, but prove the row itself is simply gone from that scope (no stale pull possible even in
  // principle) by re-checking listQuestionsForSession(oldMgrId) is still empty post-consume.
  check("(sanity) the retired predecessor's question list stays empty throughout", db.listQuestionsForSession(oldMgrId).length === 0);
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manager's decision-inbox question survives recycle: reparentQuestions moves the row onto the successor's session id (never left stranded on the retired predecessor), the human's post-recycle REST answer pushes its nudge to the SUCCESSOR (not the dead predecessor pty), and the successor's question_pull sees + consumes the answer."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
