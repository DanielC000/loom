import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fix for the noisy multi-answer batch on the decision inbox (card bbc46336 follow-up).
//
// The bug: POST /api/questions/:id/answer enqueues ONE push-nudge per answered question, but
// question_pull is a BATCH consume — it atomically returns+consumes EVERY answered question for the
// session in one shot. So a batch of N answers queues N nudges; the FIRST drains -> question_pull
// consumes ALL N -> the remaining (N-1) nudges still drain as their own turns, each triggering a
// question_pull that returns [] (a wasted empty-pull turn).
//
// The fix: `question_pull` now purges any OTHER still-queued nudge tagged (QueuedMessage.questionId) to
// a question THIS pull just consumed, via the new PtyHost.purgeQueuedByQuestionIds -> the
// SessionService.purgeAnsweredQuestionNudges wrapper.
//
// HERMETIC — a REAL PtyHost (fake pty backend, mirrors pty-queue-mutations.mjs) driving a REAL Db +
// SessionService + OrchestrationMcpRouter (mirrors question-inbox.mjs / question-recycle-survival.mjs).
// No real claude, no network, no live daemon.
//
//   (U) UNIT   — PtyHost.purgeQueuedByQuestionIds: selective removal, FIFO preserved, unrelated entries
//                untouched, unknown/empty ids a safe no-op.
//   (B) BATCH  — 3 answer-nudges tagged to 3 questions, an UNRELATED queued direction message alongside
//                them, then the REAL question_pull tool handler consumes all 3 -> all 3 tagged nudges are
//                gone from the queue, the unrelated message survives untouched.
//   (S) SINGLE — one decision answered alone: its nudge still delivers normally (not suppressed), and a
//                subsequent question_pull doesn't disturb an already-empty queue.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-answer-nudge-purge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()) — set BEFORE
// importing host.js, since paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-q-nudge-purge-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

const dbFile = path.join(tmpHome, "qnp.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "qnp-proj", agentId = "qnp-agent";
db.insertProject({ id: projId, name: "QNP", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "", position: 0 });

function insertManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
}
function insertAnsweredQuestion(id, sessionId, title) {
  db.insertQuestion({
    id, sessionId, projectId: projId, title, body: "b", options: null, recommendation: null,
    state: "answered", chosenOption: null, note: "go ahead", createdAt: now, answeredAt: now, consumedAt: null,
  });
}

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" }); // mark ready (startupModeCycles:0 -> synchronous)
}

const sessions = new SessionService(db, host, new OrchestrationControl());
const router = new OrchestrationMcpRouter(db, sessions);

try {
  // ============================ (U) UNIT: purgeQueuedByQuestionIds on the raw PtyHost ============================
  {
    const SID = "u-sess";
    spawnReady(SID);
    const primer = host.enqueueStdin(SID, "PRIMER"); // idle -> submits now, arms busy=true so the rest QUEUE
    check("(U) setup: primer delivered + armed busy", primer.delivered === true);
    host.enqueueStdin(SID, "nudge-A", "human", undefined, undefined, "agent", "qa");
    host.enqueueStdin(SID, "direction-1", "system", undefined, undefined, "agent"); // no questionId -> untagged
    host.enqueueStdin(SID, "nudge-B", "human", undefined, undefined, "agent", "qb");
    host.enqueueStdin(SID, "nudge-C", "human", undefined, undefined, "agent", "qc");
    check("(U) setup: queue is [nudge-A,direction-1,nudge-B,nudge-C]", JSON.stringify(host.getPending(SID)) === JSON.stringify(["nudge-A", "direction-1", "nudge-B", "nudge-C"]));

    const removed = host.purgeQueuedByQuestionIds(SID, ["qa", "qc"]);
    check("(U) purge returns the 2 matching removed entries, in FIFO order", removed.length === 2 && removed[0].text === "nudge-A" && removed[1].text === "nudge-C");
    check("(U) purge removed nudge-A and nudge-C, left direction-1 and nudge-B in FIFO order", JSON.stringify(host.getPending(SID)) === JSON.stringify(["direction-1", "nudge-B"]));

    const emptyIds = host.purgeQueuedByQuestionIds(SID, []);
    check("(U) purge with an EMPTY id list is a no-op", emptyIds.length === 0 && JSON.stringify(host.getPending(SID)) === JSON.stringify(["direction-1", "nudge-B"]));

    const unknownId = host.purgeQueuedByQuestionIds(SID, ["already-drained-or-unknown"]);
    check("(U) purge with an unknown/already-drained questionId is a safe no-op", unknownId.length === 0 && JSON.stringify(host.getPending(SID)) === JSON.stringify(["direction-1", "nudge-B"]));

    const deadSession = host.purgeQueuedByQuestionIds("no-such-session", ["qb"]);
    check("(U) purge on a dead/unknown session returns [] rather than throwing", deadSession.length === 0);

    // Clean up the remainder so it can't leak into the queue depth of another section.
    host.purgeQueuedByQuestionIds(SID, ["qb"]);
  }

  // ============================ (B) BATCH: the real question_pull path purges the stale trailing nudges ============================
  {
    const mgrId = "b-mgr";
    insertManager(mgrId);
    spawnReady(mgrId);
    const mgrServer = router.buildServer(mgrId, "manager");

    const primer = host.enqueueStdin(mgrId, "PRIMER"); // idle -> delivers now, arms busy so the rest hold
    check("(B) setup: primer delivered + armed busy", primer.delivered === true);

    insertAnsweredQuestion("b-q1", mgrId, "Ship v2?");
    insertAnsweredQuestion("b-q2", mgrId, "Roll back?");
    insertAnsweredQuestion("b-q3", mgrId, "Notify on-call?");

    // Three answer-nudges tagged to the three questions, PLUS an unrelated queued manager-direction
    // message with no questionId — all held because the session is busy (the primer armed it).
    host.enqueueStdin(mgrId, 'Your question "Ship v2?" was answered — pull it (question_pull)…', "human", undefined, undefined, "agent", "b-q1");
    host.enqueueStdin(mgrId, "[loom:from-manager] unrelated direction, must survive", "system", undefined, undefined, "agent");
    host.enqueueStdin(mgrId, 'Your question "Roll back?" was answered — pull it (question_pull)…', "human", undefined, undefined, "agent", "b-q2");
    host.enqueueStdin(mgrId, 'Your question "Notify on-call?" was answered — pull it (question_pull)…', "human", undefined, undefined, "agent", "b-q3");
    check("(B) setup: 4 entries queued (3 tagged nudges + 1 unrelated direction)", host.getPendingEntries(mgrId).length === 4);

    const pulled = JSON.parse((await mgrServer._registeredTools["question_pull"].handler({})).content[0].text);
    check("(B) question_pull returns all 3 answered questions", pulled.questions.length === 3);
    check("(B) the ids match all 3 asked questions", ["b-q1", "b-q2", "b-q3"].every((id) => pulled.questions.some((q) => q.questionId === id)));
    check("(B) all 3 rows are now 'consumed'", ["b-q1", "b-q2", "b-q3"].every((id) => db.getQuestion(id).state === "consumed"));

    const remaining = host.getPendingEntries(mgrId);
    check("(B) the 3 now-stale tagged nudges were purged from the queue", remaining.length === 1);
    check("(B) the UNRELATED manager-direction entry survived, untouched", remaining[0]?.text === "[loom:from-manager] unrelated direction, must survive");

    const pullAgain = JSON.parse((await mgrServer._registeredTools["question_pull"].handler({})).content[0].text);
    check("(B) a repeat pull is empty (nothing left to consume)", pullAgain.questions.length === 0);
  }

  // ============================ (S) SINGLE: a lone decision's nudge still delivers, unsuppressed ============================
  {
    const mgrId = "s-mgr";
    insertManager(mgrId);
    spawnReady(mgrId); // idle at spawn — nothing primed busy this time

    insertAnsweredQuestion("s-q1", mgrId, "Deploy now?");
    const nudge = host.enqueueStdin(mgrId, 'Your question "Deploy now?" was answered — pull it (question_pull)…', "human", undefined, undefined, "agent", "s-q1");
    check("(S) a single answer's nudge delivers immediately (idle session) — not suppressed", nudge.delivered === true);
    check("(S) nothing is left queued (it went out as the live turn, not held)", host.getPendingEntries(mgrId).length === 0);

    const mgrServer = router.buildServer(mgrId, "manager");
    const pulled = JSON.parse((await mgrServer._registeredTools["question_pull"].handler({})).content[0].text);
    check("(S) question_pull still returns the single answered question", pulled.questions.length === 1 && pulled.questions[0].questionId === "s-q1");
    check("(S) the purge call for a single-question batch doesn't touch an already-empty queue", host.getPendingEntries(mgrId).length === 0);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PtyHost.purgeQueuedByQuestionIds selectively drops queued entries by questionId (FIFO preserved, unrelated entries untouched, unknown/empty ids a safe no-op); the real question_pull tool handler now purges every OTHER stale queued nudge for a batch of questions it just consumed (leaving unrelated queued direction alone), while a single decision answered alone still delivers its one nudge normally, unsuppressed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
