import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 60b26261: worker_report_get had no dedup against the queued `[loom:worker-report]` inbox entry.
// A manager reads a report via worker_report_get (straight from durable event storage), fully acts on it —
// and the queued copy of that SAME report STILL drains later as a wasted turn.
//
// The fix: `workerReport` (sessions/service.ts) now tags each queued `[loom:worker-report]` nudge with the
// SAME id it just minted for that report's own `worker_report` orchestration event (`reportEventId` — see
// QueuedMessage.reportEventId, pty/host.ts). `worker_report_get` (mcp/orchestration.ts) then purges any
// still-queued nudge carrying that exact id via the new `PtyHost.purgeQueuedByReportEventIds` ->
// `SessionService.purgeQueuedWorkerReportNudge` wrapper — mirroring the SAME selective-splice mechanics
// question-answer-nudge-purge.mjs already proved for the decision-inbox's `purgeQueuedByQuestionIds`.
//
// Keyed on the report's OWN event id, deliberately NEVER on the worker id: a worker can file `progress`
// then `done`, and purging by worker id would silently drop an UNREAD earlier report the manager hasn't
// seen yet — this is the multi-report case (M) below, the whole point of this card (DoD-5).
//
// HERMETIC — a REAL PtyHost (fake pty backend, mirrors question-answer-nudge-purge.mjs / pty-queue-
// mutations.mjs) driving a REAL Db + SessionService + OrchestrationMcpRouter. No real claude, no network,
// no live daemon.
//
//   (U) UNIT     — PtyHost.purgeQueuedByReportEventIds: selective removal, FIFO preserved, unrelated
//                  entries untouched, unknown/empty ids a safe no-op, dead session a safe no-op.
//   (M) MULTI    — the case a single-report test cannot see (DoD-5): a worker files `progress` then `done`
//                  while its manager stays busy — TWO queued nudges, two distinct reportEventIds. Reading
//                  the LATEST report (the default) purges ONLY that report's nudge; the UNREAD earlier
//                  report's nudge MUST SURVIVE. Reading the earlier report explicitly then purges IT too.
//                  An UNRELATED queued manager-direction message survives every purge, untouched.
//   (D) DURABLE  — a purged entry resolves its durable session_message_queued record honestly (never reads
//                  as undelivered/lost afterward) — DoD-3.
//   (I) IDEMPOTENT — re-reading an already-purged report is a safe no-op (nothing left to purge, no throw).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-report-nudge-purge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()) — set BEFORE
// importing host.js, since paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-wr-nudge-purge-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

const dbFile = path.join(tmpHome, "wrnp.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "wrnp-proj", agentId = "wrnp-agent";
db.insertProject({ id: projId, name: "WRNP", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "", position: 0 });

function insertSession(id, opts) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, ...opts,
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
  // ============================ (U) UNIT: purgeQueuedByReportEventIds on the raw PtyHost ============================
  {
    const SID = "u-sess";
    spawnReady(SID);
    const primer = host.enqueueStdin(SID, "PRIMER"); // idle -> submits now, arms busy=true so the rest QUEUE
    check("(U) setup: primer delivered + armed busy", primer.delivered === true);
    host.enqueueStdin(SID, "report-A", "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { reportEventId: "ra" });
    host.enqueueStdin(SID, "direction-1", "system", undefined, undefined, "agent"); // no reportEventId -> untagged
    host.enqueueStdin(SID, "report-B", "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { reportEventId: "rb" });
    host.enqueueStdin(SID, "report-C", "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { reportEventId: "rc" });
    check("(U) setup: queue is [report-A,direction-1,report-B,report-C]", JSON.stringify(host.getPending(SID)) === JSON.stringify(["report-A", "direction-1", "report-B", "report-C"]));

    const removed = host.purgeQueuedByReportEventIds(SID, ["ra", "rc"]);
    check("(U) purge returns the 2 matching removed entries, in FIFO order", removed.length === 2 && removed[0].text === "report-A" && removed[1].text === "report-C");
    check("(U) purge removed report-A and report-C, left direction-1 and report-B in FIFO order", JSON.stringify(host.getPending(SID)) === JSON.stringify(["direction-1", "report-B"]));

    const emptyIds = host.purgeQueuedByReportEventIds(SID, []);
    check("(U) purge with an EMPTY id list is a no-op", emptyIds.length === 0 && JSON.stringify(host.getPending(SID)) === JSON.stringify(["direction-1", "report-B"]));

    const unknownId = host.purgeQueuedByReportEventIds(SID, ["already-drained-or-unknown"]);
    check("(U) purge with an unknown/already-drained reportEventId is a safe no-op", unknownId.length === 0 && JSON.stringify(host.getPending(SID)) === JSON.stringify(["direction-1", "report-B"]));

    const deadSession = host.purgeQueuedByReportEventIds("no-such-session", ["rb"]);
    check("(U) purge on a dead/unknown session returns [] rather than throwing", deadSession.length === 0);

    // Clean up the remainder so it can't leak into another section's queue depth.
    host.purgeQueuedByReportEventIds(SID, ["rb"]);
  }

  // ============================ (M)/(D)/(I): the real workerReport() -> worker_report_get path ============================
  {
    const mgrId = "m-mgr", wkrId = "m-wkr", taskId = "m-task";
    insertSession(mgrId, { role: "manager" });
    insertSession(wkrId, { role: "worker", parentSessionId: mgrId, taskId });
    spawnReady(mgrId);
    spawnReady(wkrId);
    const mgrServer = router.buildServer(mgrId, "manager");

    const primer = host.enqueueStdin(mgrId, "PRIMER"); // idle -> delivers now, arms busy so the rest hold
    check("(M) setup: primer delivered + armed busy", primer.delivered === true);

    // An UNRELATED queued manager-direction message, no reportEventId — must survive every purge below.
    host.enqueueStdin(mgrId, "[loom:from-manager] unrelated direction, must survive", "system", undefined, undefined, "agent");

    // Worker files an EARLIER report (progress) while the manager is still busy — queues, tagged with its
    // own reportEventId. Then a LATER report (done) — also queues, tagged with a DIFFERENT reportEventId.
    const r1 = await sessions.workerReport(wkrId, { status: "progress", summary: "checkpoint-marker-ONE" });
    check("(M) report 1 (progress) HELD, not delivered now ('queued')", r1.deliveryStatus === "queued");
    const r2 = await sessions.workerReport(wkrId, { status: "done", summary: "final-marker-TWO", noChanges: true });
    check("(M) report 2 (done) HELD, not delivered now ('queued')", r2.deliveryStatus === "queued");

    const report1Event = db.listEventsForWorker(wkrId).filter((e) => e.kind === "worker_report").find((e) => e.detail?.summary === "checkpoint-marker-ONE");
    const report2Event = db.listEventsForWorker(wkrId).filter((e) => e.kind === "worker_report").find((e) => e.detail?.summary === "final-marker-TWO");
    check("(M) setup: two distinct worker_report events recorded", !!report1Event && !!report2Event && report1Event.id !== report2Event.id);
    check("(M) setup: 3 entries queued (1 unrelated direction + 2 report nudges)", host.getPendingEntries(mgrId).length === 3);

    const undelivBefore = db.listUndeliveredQueuedMessages();
    check("(D) setup: both reports have a durable session_message_queued record before any read",
      undelivBefore.some((e) => e.detail?.text?.includes("checkpoint-marker-ONE")) && undelivBefore.some((e) => e.detail?.text?.includes("final-marker-TWO")));

    // Read the LATEST report (default, no eventId) -> report 2 ("done").
    const latest = JSON.parse((await mgrServer._registeredTools["worker_report_get"].handler({ workerSessionId: wkrId })).content[0].text);
    check("(M) worker_report_get default returns report 2 (the latest)", latest.eventId === report2Event.id && latest.summary === "final-marker-TWO");

    const afterLatestRead = host.getPending(mgrId);
    check("(M) DoD-5: report 2's queued nudge is now purged", !afterLatestRead.some((t) => t.includes("final-marker-TWO")));
    check("(M) DoD-5: report 1's (UNREAD) queued nudge SURVIVES — never purged by worker id, only by the exact eventId read", afterLatestRead.some((t) => t.includes("checkpoint-marker-ONE")));
    check("(M) the UNRELATED manager-direction entry survived, untouched", afterLatestRead.some((t) => t.includes("unrelated direction, must survive")));
    check("(M) exactly 2 entries remain (unrelated direction + report 1's still-unread nudge)", host.getPendingEntries(mgrId).length === 2);

    const undelivAfterLatest = db.listUndeliveredQueuedMessages();
    check("(D) report 2's durable record is resolved (no longer undelivered) — never reads as lost", !undelivAfterLatest.some((e) => e.detail?.text?.includes("final-marker-TWO")));
    check("(D) report 1's durable record is STILL genuinely undelivered (nobody read it yet)", undelivAfterLatest.some((e) => e.detail?.text?.includes("checkpoint-marker-ONE")));

    // Now explicitly read the EARLIER report (report 1) by its eventId.
    const earlier = JSON.parse((await mgrServer._registeredTools["worker_report_get"].handler({ workerSessionId: wkrId, eventId: report1Event.id })).content[0].text);
    check("(M) worker_report_get(eventId) returns report 1", earlier.eventId === report1Event.id && earlier.summary === "checkpoint-marker-ONE");

    const afterEarlierRead = host.getPending(mgrId);
    check("(M) report 1's queued nudge is now ALSO purged", !afterEarlierRead.some((t) => t.includes("checkpoint-marker-ONE")));
    check("(M) the UNRELATED manager-direction entry STILL survives, untouched", afterEarlierRead.length === 1 && afterEarlierRead[0].includes("unrelated direction, must survive"));

    const undelivAfterBoth = db.listUndeliveredQueuedMessages();
    check("(D) report 1's durable record is now ALSO resolved", !undelivAfterBoth.some((e) => e.detail?.text?.includes("checkpoint-marker-ONE")));

    // (I) IDEMPOTENT: re-reading either report again finds nothing left in the queue to purge — no throw.
    const rereadLatest = JSON.parse((await mgrServer._registeredTools["worker_report_get"].handler({ workerSessionId: wkrId })).content[0].text);
    check("(I) re-reading the latest report again is a safe no-op (still returns it correctly)", rereadLatest.eventId === report2Event.id);
    check("(I) the queue is untouched by the repeat read (unrelated direction still the only entry)", host.getPendingEntries(mgrId).length === 1);
  }

  // ============================ (R) Card d09d58e7 — THE SPECIMEN: reportEventId survives a manager ==========
  // ============================ recycle's carryPendingToSuccessor re-mint, and the purge still fires =========
  //
  // This is the ACTUAL mechanism behind the card's live specimen (owner-reported manager `0aed0bb3`,
  // recycled_from `2f5038fc`) — NOT handleGiveUpExhausted (see the card's own corrected root-cause note):
  // recycleManager calls pty.flushPending + reads db.listUnresolvedQueuedMessagesForWorker directly and
  // hands both to carryPendingToSuccessor, which SUPERSEDES the predecessor's durable record and RE-MINTS
  // it onto the successor via enqueueDurableMessage — never touching the give-up machinery at all. Before
  // this card's fix, that re-mint call (service.ts's carryPendingToSuccessor) omitted reportEventId, so a
  // still-queued `[loom:worker-report]` nudge landed on the successor UNTAGGED and worker_report_get could
  // never again purge it — exactly the wasted-turn symptom (card 60b26261's dedup silently not firing).
  {
    const mgrId = "r-mgr", wkrId = "r-wkr", taskId = "r-task";
    insertSession(mgrId, { role: "manager" });
    insertSession(wkrId, { role: "worker", parentSessionId: mgrId, taskId });
    spawnReady(mgrId);
    spawnReady(wkrId);

    const primer = host.enqueueStdin(mgrId, "PRIMER"); // idle -> delivers now, arms busy so the report holds
    check("(R) setup: primer delivered + armed busy", primer.delivered === true);

    // Worker files `done` while the manager is BUSY (the card's exact specimen shape) -> queues, tagged.
    const r = await sessions.workerReport(wkrId, { status: "done", summary: "RECYCLE-SURVIVOR-REPORT", noChanges: true });
    check("(R) setup: report HELD, not delivered now ('queued')", r.deliveryStatus === "queued");
    const reportEvent = db.listEventsForWorker(wkrId).filter((e) => e.kind === "worker_report").find((e) => e.detail?.summary === "RECYCLE-SURVIVOR-REPORT");
    check("(R) setup: worker_report event recorded", !!reportEvent);
    check("(R) setup: the queued nudge sits on the PREDECESSOR manager before recycle", host.getPending(mgrId).some((t) => t.includes("RECYCLE-SURVIVOR-REPORT")));

    // Recycle the manager — carryPendingToSuccessor supersedes the predecessor's durable record and
    // re-mints it onto the successor.
    const fresh = await sessions.recycleManager(mgrId, "successor: drain the queue");
    check("(R) recycle reparented the worker onto the successor", db.getSession(wkrId)?.parentSessionId === fresh.id);

    const supersededMarker = db.listEventsForWorker(mgrId).filter((e) => e.kind === "session_message_delivered" && e.detail?.reason === "superseded");
    check("(R) the predecessor's durable record was superseded", supersededMarker.length >= 1);

    const remintedRec = db.listUndeliveredQueuedMessages().find((e) => e.workerSessionId === fresh.id && e.detail?.text?.includes("RECYCLE-SURVIVOR-REPORT"));
    check("(R) THE FIX: the re-minted durable record on the SUCCESSOR still carries the ORIGINAL reportEventId", remintedRec?.detail?.reportEventId === reportEvent.id);
    check("(R) THE FIX: the re-minted nudge is queued on the SUCCESSOR's own live FIFO, still carrying the text", host.getPending(fresh.id).some((t) => t.includes("RECYCLE-SURVIVOR-REPORT")));

    // Now the successor's own worker_report_get reads the SAME report straight from durable storage —
    // DoD-4/DoD-5: this MUST purge the re-minted queued copy still sitting on the successor.
    const freshServer = router.buildServer(fresh.id, "manager");
    const read = JSON.parse((await freshServer._registeredTools["worker_report_get"].handler({ workerSessionId: wkrId })).content[0].text);
    check("(R) worker_report_get on the successor returns the SAME report", read.eventId === reportEvent.id && read.summary === "RECYCLE-SURVIVOR-REPORT");

    const afterRead = host.getPending(fresh.id);
    check("(R) THE FIX (DoD-4): the re-minted nudge is now PURGED from the successor's queue — no wasted turn", !afterRead.some((t) => t.includes("RECYCLE-SURVIVOR-REPORT")));
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PtyHost.purgeQueuedByReportEventIds selectively drops queued entries by reportEventId (FIFO preserved, unrelated entries untouched, unknown/empty ids and a dead session a safe no-op); the real worker_report_get tool handler now purges the queued nudge for the EXACT report it just read (never by worker id — an unread earlier report's nudge survives), resolves each purged entry's durable record honestly, repeat reads are idempotent, and (card d09d58e7) a reportEventId-tagged nudge survives a manager recycle's carryPendingToSuccessor re-mint intact, so worker_report_get still purges it on the successor."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
