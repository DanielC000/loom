import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fb5e39c3 — a THIRD variant of the e79e2956/8457d0ed failure ("a farewell was delivered to a
// session that had since been replaced by its successor"), but a DIFFERENT mechanism: those four sites
// SCAN candidates by role and pick one (excluded via `!hasSuccessor`); here the caller of
// `deliverSessionMessage` (messageSessionAsPlatform / messageSessionAsCompanion) already names the
// target `sessionId` explicitly, so there is nothing to select between.
//
// The producers (Code Review finding, card fb5e39c3 — corrected from an earlier, wrong draft of this
// comment): `recycleManager` never touches the predecessor's processState at all (it stays "live" until
// the pty is eventually torn down). `recycleWorker` hard-stops the predecessor, but its processState
// flips to "exited" only via the ASYNC onExit callback, decoupled from the synchronous
// insertRecycleSuccessor + setProcessState("live") that follows — recycleWorker is the HIGHEST-VOLUME
// producer of this race. `recyclePlatformLead` is NOT a producer at all: it sets the predecessor's
// processState to "exited" SYNCHRONOUSLY, before the successor row is even inserted. In a producing path,
// `session.processState === "live"` can read true for a session `hasSuccessor()` already reports as
// superseded — a window that is ORDINARILY seconds but can run indefinitely if the successor never
// settles. This test constructs that race directly via db.insertSession (recycledFrom), rather than
// running a real recycle, to isolate the delivery-path behavior from the recycle machinery itself.
//
// Proves the DoD:
//   (1) an addressed session that is still `live` but already has a recycle successor is NOT delivered
//       into (nothing enqueued to its pty), NOT silently redirected to the successor (nothing enqueued
//       there either), and NOT boarded (no durable card filed) — deliveryStatus is "dropped" and
//       `replacedBy` names the successor. True for BOTH callers (messageSessionAsPlatform and
//       messageSessionAsCompanion, which share deliverSessionMessage), each with its own audit-event check.
//   (2) an ordinary LIVE target with NO successor still delivers normally (regression).
//   (3) the pre-existing NOT-LIVE-target-with-live-successor routing (@decision 5519559c) is UNCHANGED —
//       it still auto-routes to the successor (deliveryStatus reflects the successor's own delivery,
//       routedTo names it) — this fix must not reshape that branch's existing contract.
//   (4) `replacedBy` may itself name a DEAD successor (recycle's NEVER-RESURRECT guard can leave a
//       confirmed-dead successor's recycled_from link intact) — re-addressing it then falls through to
//       the ordinary NOT-LIVE/boarding path, at the cost of one extra hop.
//   (5) BLOCKING fix (Code Review finding): messageSessionAsPlatform's retry-dedupe cache
//       (platformMessageDedupe) must NOT cache a "dropped" result — a retry of the SAME (sessionId, text)
//       after the predecessor actually closes must re-evaluate and route to the successor via the
//       NOT-LIVE branch, never replay a stale cached "dropped".
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService driven against a FAKE pty
// (createSeamHost, enqueueStdin spied), mirroring platform-messaging.mjs's proven harness.
// Run: 1) build (turbo builds shared first), 2) node test/session-message-live-successor-disclosure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-smlsd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "P", name: "Ordinary", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentWork", projectId: "P", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });

const seedSession = (id, extra = {}) => db.insertSession({
  id, projectId: "P", agentId: "agentWork", engineSessionId: null, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: null, parentSessionId: null, ...extra,
});

// Fake pty: spy enqueueStdin so we can assert whether a delivery attempt was actually made.
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.enqueued = []; }
  enqueueStdin(id, text) { this.enqueued.push({ id, text }); return { delivered: true }; }
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
  // ============ (1) live-but-superseded predecessor: disclose, do not deliver, do not redirect ============
  seedSession("PRED"); // still `live` — settleRecycleHandoff hasn't closed it yet
  seedSession("SUCC", { recycledFrom: "PRED" }); // recycle successor, already `live`
  check("(pre) PRED reads processState live", db.getSession("PRED").processState === "live");
  check("(pre) hasSuccessor(PRED) is already true (the exact race window)", db.hasSuccessor("PRED") === true);

  const tasksBeforePlatform = db.listTasks("P").length;
  const beforePlatform = host.enqueued.length;
  const platformResult = svc.messageSessionAsPlatform("PRED", "a farewell for the predecessor", "SENDER");
  check("(1a platform) deliveryStatus is 'dropped' for a live-but-superseded target",
    platformResult.deliveryStatus === "dropped");
  check("(1a platform) replacedBy names the successor",
    platformResult.replacedBy === "SUCC");
  check("(1a platform) NOTHING was enqueued to PRED's pty (not delivered into the dying predecessor)",
    !host.enqueued.slice(beforePlatform).some((e) => e.id === "PRED"));
  check("(1a platform) NOTHING was enqueued to SUCC's pty either (disclosure, not silent redirect)",
    !host.enqueued.slice(beforePlatform).some((e) => e.id === "SUCC"));
  check("(1a platform) enqueue count is unchanged entirely (no delivery attempt at all)",
    host.enqueued.length === beforePlatform);
  check("(1a platform) taskId is undefined — no fallback to boarding",
    platformResult.taskId === undefined);
  check("(1a platform) NOTHING was boarded (no durable card filed on the project's board)",
    db.listTasks("P").length === tasksBeforePlatform);
  check("(1a platform) a session_message audit event was recorded for PRED with detail.replacedBy",
    db.listEventsForWorker("PRED").some((e) => e.kind === "session_message" && e.detail?.replacedBy === "SUCC"));

  seedSession("PRED2");
  seedSession("SUCC2", { recycledFrom: "PRED2" });
  const tasksBeforeCompanion = db.listTasks("P").length;
  const beforeCompanion = host.enqueued.length;
  const companionResult = svc.messageSessionAsCompanion("PRED2", "owner asked to check in", "OWNER-SESSION");
  check("(1b companion) deliveryStatus is 'dropped' for a live-but-superseded target (shared delivery path)",
    companionResult.deliveryStatus === "dropped");
  check("(1b companion) replacedBy names the successor",
    companionResult.replacedBy === "SUCC2");
  check("(1b companion) NOTHING was enqueued for either PRED2 or SUCC2",
    host.enqueued.length === beforeCompanion);
  check("(1b companion) NOTHING was boarded either",
    db.listTasks("P").length === tasksBeforeCompanion);
  check("(1b companion) a session_message audit event was recorded for PRED2 with detail.replacedBy",
    db.listEventsForWorker("PRED2").some((e) => e.kind === "session_message" && e.detail?.replacedBy === "SUCC2"));

  // ============ (4) replacedBy may itself name a DEAD successor — re-addressing it falls through ============
  seedSession("PRED3");
  seedSession("DEADSUCC3", { recycledFrom: "PRED3", processState: "exited" }); // confirmed-dead successor
  const deadSuccResult = svc.messageSessionAsPlatform("PRED3", "a farewell into a dead-successor lineage", "SENDER4");
  check("(4) a live-but-superseded target whose successor is itself DEAD still discloses (not delivered)",
    deadSuccResult.deliveryStatus === "dropped" && deadSuccResult.replacedBy === "DEADSUCC3");
  const followUp = svc.messageSessionAsPlatform("DEADSUCC3", "re-addressed to the dead successor", "SENDER4");
  check("(4) re-addressing the dead successor falls through to the ordinary NOT-LIVE/boarding path",
    followUp.deliveryStatus === "boarded" && !!followUp.taskId);

  // ============ (2) regression: an ordinary LIVE target with NO successor still delivers normally ============
  seedSession("TARGET");
  const beforeOrdinary = host.enqueued.length;
  const ordinary = svc.messageSessionAsPlatform("TARGET", "stand by", "SENDER2");
  check("(2) an ordinary live target (no successor) still delivers live",
    ordinary.deliveryStatus === "delivered-live" && ordinary.replacedBy === undefined);
  check("(2) the message WAS enqueued to TARGET",
    host.enqueued.slice(beforeOrdinary).some((e) => e.id === "TARGET" && e.text.includes("stand by")));

  // ============ (3) regression: NOT-LIVE-with-live-successor (@decision 5519559c) is UNCHANGED ============
  seedSession("DEADPRED", { processState: "exited" });
  seedSession("DEADSUCC", { recycledFrom: "DEADPRED" });
  const beforeNotLive = host.enqueued.length;
  const notLiveRouted = svc.messageSessionAsPlatform("DEADPRED", "still routes forward", "SENDER3");
  check("(3) a NOT-LIVE target with a live successor still auto-routes (deliveryStatus delivered-live, routedTo)",
    notLiveRouted.deliveryStatus === "delivered-live" && notLiveRouted.routedTo === "DEADSUCC" && notLiveRouted.replacedBy === undefined);
  check("(3) the message WAS enqueued to the successor DEADSUCC (5519559c's own contract, untouched)",
    host.enqueued.slice(beforeNotLive).some((e) => e.id === "DEADSUCC" && e.text.includes("still routes forward")));

  // ============ (5) BLOCKING FIX: a "dropped" result must NOT be cached by messageSessionAsPlatform's ============
  // ============ retry-dedupe — a later retry of the SAME (sessionId,text), after the predecessor actually ============
  // ============ closes, must re-evaluate and route to the successor, never replay a stale cached "dropped" ============
  seedSession("PRED5");
  seedSession("SUCC5", { recycledFrom: "PRED5" });
  const sameText = "a directive worth retrying";
  const firstAttempt = svc.messageSessionAsPlatform("PRED5", sameText, "SENDER5");
  check("(5) the FIRST attempt (predecessor still live-but-superseded) discloses: dropped, replacedBy SUCC5",
    firstAttempt.deliveryStatus === "dropped" && firstAttempt.replacedBy === "SUCC5" && !firstAttempt.duplicate);
  // settleRecycleHandoff has now closed the predecessor for real.
  db.setProcessState("PRED5", "exited");
  const beforeRetry = host.enqueued.length;
  const retryAttempt = svc.messageSessionAsPlatform("PRED5", sameText, "SENDER5");
  check("(5) a RETRY of the SAME (sessionId,text) after the predecessor closes is NOT a replayed cache hit",
    retryAttempt.duplicate !== true);
  check("(5) the retry instead re-evaluates and auto-routes to the successor (5519559c's NOT-LIVE branch)",
    retryAttempt.deliveryStatus === "delivered-live" && retryAttempt.routedTo === "SUCC5");
  check("(5) the retry's message WAS actually enqueued to SUCC5 (the caller's directive is not silently lost)",
    host.enqueued.slice(beforeRetry).some((e) => e.id === "SUCC5" && e.text.includes(sameText)));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an addressed session_message/session-control target that is still `live` but already has a recycle successor (the settleRecycleHandoff async-close window) is neither delivered into, silently redirected, nor boarded: deliveryStatus is 'dropped' and `replacedBy` names the successor (even a dead one, which falls through to the ordinary NOT-LIVE/boarding path on re-address), for both messageSessionAsPlatform and messageSessionAsCompanion, each auditing the outcome. An ordinary live target with no successor, and the pre-existing NOT-LIVE-with-live-successor auto-route (@decision 5519559c), are both unchanged. And messageSessionAsPlatform's retry-dedupe never caches a 'dropped' result, so a retry after the predecessor actually closes correctly re-evaluates and routes to the successor instead of replaying a stale non-delivery."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
