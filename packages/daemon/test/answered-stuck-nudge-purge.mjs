import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fix for the LAGGING answered-stuck re-nudge (follow-up to card bbc46336 / 47793b5).
//
// The bug: the gateway's answer-route push-nudge is tagged with `questionId` (QueuedMessage.questionId)
// so a later `question_pull` can purge it via PtyHost.purgeQueuedByQuestionIds if it's still queued when
// the question is consumed (card bbc46336). But IdleWatcher.tickAnsweredStuckQuestions' OWN re-nudge
// (the "[loom:answered-stuck] … call question_pull" watchdog message) called `enqueueStdin` WITHOUT that
// tag — so a watchdog nudge still sitting in a busy manager's queue when it finally calls question_pull
// survived the purge untouched, and later drained as a STALE "pull it" nudge for a question the manager
// had already consumed ("already pulled that, the nudge is lagging").
//
// The fix: idle-watcher.ts now passes `q.id` as the trailing `questionId` tag on its own enqueueStdin
// call, so it rides the SAME purge path the answer-route nudge already uses — no new purge mechanism,
// no duplicated logic.
//
// HERMETIC — a REAL PtyHost (fake pty backend, mirrors question-answer-nudge-purge.mjs) driving a REAL
// Db + SessionService + OrchestrationMcpRouter + IdleWatcher. No real claude, no network, no live daemon.
//
//   (1) a stuck answered question, manager BUSY (nudge queues, tagged with questionId) -> question_pull
//       purges that exact still-queued watchdog nudge; nothing stale is left to drain later.
//   (2) an UNRELATED queued direction message (no questionId) survives the same purge untouched.
//
// Run: 1) build (turbo builds shared first), 2) node test/answered-stuck-nudge-purge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-answered-stuck-purge-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { IdleWatcher } = await import("../dist/orchestration/idle-watcher.js");

function makeFakePty() {
  const writes = [];
  return { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

const dbFile = path.join(tmpHome, "asnp.db");
const db = new Db(dbFile);
const now = new Date();
const nowIso = now.toISOString();
const projId = "asnp-proj", agentId = "asnp-agent";
db.insertProject({ id: projId, name: "ASNP", repoPath: projId, vaultPath: projId, config: {}, createdAt: nowIso, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "", position: 0 });

function insertManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: nowIso, lastActivity: nowIso,
    lastError: null, role: "manager",
  });
}
const minutesAgo = (m) => new Date(now.getTime() - m * 60_000).toISOString();
function insertAnsweredQuestion(id, sessionId, title, answeredMinutesAgo) {
  db.insertQuestion({
    id, sessionId, projectId: projId, title, body: "b", options: null, recommendation: null,
    state: "answered", chosenOption: null, note: "go ahead", createdAt: minutesAgo(answeredMinutesAgo + 5),
    answeredAt: minutesAgo(answeredMinutesAgo), consumedAt: null,
  });
}

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

const control = new OrchestrationControl();
const sessions = new SessionService(db, host, control);
const router = new OrchestrationMcpRouter(db, sessions);
const watcher = new IdleWatcher({
  db, pty: host, control, recycleRatio: 0,
  notifyIdleWorker: () => {},
  isWorkerStranded: () => true,
});

try {
  const mgrId = "asnp-mgr";
  insertManager(mgrId);
  spawnReady(mgrId);
  const mgrServer = router.buildServer(mgrId, "manager");

  const primer = host.enqueueStdin(mgrId, "PRIMER"); // idle -> delivers now, arms busy so the rest hold
  check("(setup) primer delivered + armed busy", primer.delivered === true);

  host.enqueueStdin(mgrId, "[loom:from-manager] unrelated direction, must survive", "system", undefined, undefined, "agent");

  insertAnsweredQuestion("asnp-q1", mgrId, "ship it?", 30); // 30m > 15m stuck threshold
  watcher.tick(now);

  // getPendingEntries strips kind/questionId (UI-facing shape) — identify the watchdog entry by its
  // known text shape instead (mirrors how the gateway push-nudge's own text is asserted elsewhere).
  const afterTick = host.getPendingEntries(mgrId);
  check("(1) setup: 2 entries queued (1 unrelated direction + 1 watchdog nudge)", afterTick.length === 2);
  const watchdogEntry = afterTick.find((e) => /question_pull/.test(e.text) && e.text.includes("ship it?"));
  check("(1) the watchdog's own re-nudge is queued, naming the question and question_pull", watchdogEntry !== undefined);

  const pulled = JSON.parse((await mgrServer._registeredTools["question_pull"].handler({})).content[0].text);
  check("(1) question_pull consumes the stuck question", pulled.questions.length === 1 && pulled.questions[0].questionId === "asnp-q1");
  check("(1) the question row is now 'consumed'", db.getQuestion("asnp-q1")?.state === "consumed");

  // If the watchdog nudge had NOT been tagged with the question id (the pre-fix bug), this purge would
  // find nothing to remove and the stale nudge would still be here, primed to drain as a LAGGING
  // "pull it" message for a question the manager just consumed.
  const afterPull = host.getPendingEntries(mgrId);
  check("(1) the now-stale watchdog nudge was purged — NOT left to drain later as a stale re-nudge",
    !afterPull.some((e) => /question_pull/.test(e.text) && e.text.includes("ship it?")));
  check("(2) the unrelated direction message survived the purge untouched",
    afterPull.length === 1 && afterPull[0].text === "[loom:from-manager] unrelated direction, must survive");
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the answered-stuck watchdog's own re-nudge is now tagged with the question id, so a question_pull that consumes the question purges the watchdog's still-queued nudge too (no more lagging 'already pulled that' stale nudges), while an unrelated queued direction message survives untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
