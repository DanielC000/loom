import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f1969787 (Code Review of 2fd55955, landed as 82b68e28): recycleManager's ownership-transfer steps
// (reparentLiveWorkers/Wakes/Questions/EventTriggerTargets/PollJobTargets/WebhookTargets/
// PendingOwnerMessage/capQueue.reparent, plus the pending-queue carry) run AFTER the successor is already
// live. Before this card, ANY of them throwing aborted recycleManager entirely: the successor stayed
// live, the predecessor was never stopped (settleRecycleHandoff is only reached on the success path), and
// the caller saw a bare thrown error with no structured signal about what transferred.
//
// Proves:
//   (A) a step that fails ONCE then succeeds is retried transparently — attemptManagerOwnershipTransfer
//       reports zero failedSteps and the real reparent count.
//   (B) a step STILL failing after the one retry does NOT throw recycleManager, does NOT retire the
//       predecessor (no pty.stop, no settleRecycleHandoff), halts with a recycle_ownership_transfer_failed
//       event naming the exact failed step + stranded wake id, recycle_complete.detail.failedSteps is set,
//       and BOTH managers are durably nudged. A step that DID succeed (workers) is NOT reported stranded.
//   (C) the predecessor stays genuinely functional post-halt: still processState:'live', hasSuccessor still
//       true (the successor genuinely exists), its own recycle-settle-pending marker cleared (never stuck).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// low-level pty (createPty()/stop() seam — mirrors recycle-successor-determinism.mjs's proven harness).
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-manager-ownership-transfer-halt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rmoth-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-rmoth-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-manager-ownership-transfer-halt test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rmoth@loom -c user.name=rmoth");

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends createSeamHost(PtyHost) {
  stoppedIds = new Set();
  stop(id, mode) { this.stoppedIds.add(id); return super.stop(id, mode); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pRMOTH", name: "RMOTH", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgrRMOTH", projectId: "pRMOTH", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });

const mkManager = (id) => db.insertSession({
  id, projectId: "pRMOTH", agentId: "agentMgrRMOTH", engineSessionId: `eng-${id}`, title: null,
  cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// ===================== (A) RETRY SUCCEEDS — a step that fails once then succeeds is retried transparently =====================
{
  const oldManagerId = "oldMgrA";
  mkManager(oldManagerId);
  db.insertSession({ id: "workerA1", projectId: "pRMOTH", agentId: "agentMgrRMOTH", engineSessionId: "eng-workerA1",
    title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now,
    lastActivity: now, lastError: null, role: "worker", parentSessionId: oldManagerId });

  let callCount = 0;
  const originalReparentWakes = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function (...args) {
    callCount++;
    if (callCount === 1) throw new Error("injected transient failure (scenario A)");
    return originalReparentWakes.apply(this, args);
  };
  try {
    const { reparentedWorkers, failedSteps } = svc.attemptManagerOwnershipTransfer(oldManagerId, "freshA-fakeid");
    check("(A) a step that fails ONCE then succeeds on retry reports ZERO failedSteps", failedSteps.length === 0);
    check("(A) the real worker reparent count is still correctly reported", reparentedWorkers === 1);
    check("(A) the flaky step was actually called twice (attempt + retry)", callCount === 2);
  } finally {
    Db.prototype.reparentWakes = originalReparentWakes;
  }
}

// ===================== (B)+(C) HALT, DON'T RETIRE — a step STILL failing after retry =====================
{
  const oldManagerId = "oldMgrB";
  mkManager(oldManagerId);
  db.insertSession({ id: "workerB1", projectId: "pRMOTH", agentId: "agentMgrRMOTH", engineSessionId: "eng-workerB1",
    title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now,
    lastActivity: now, lastError: null, role: "worker", parentSessionId: oldManagerId });
  db.insertWake({ id: "wakeB1", sessionId: oldManagerId, wakeAt: now, note: "self-note", createdAt: now });
  db.insertQuestion({ id: "questionB1", sessionId: oldManagerId, projectId: "pRMOTH", type: "decision",
    title: "q", body: "b", options: null, recommendation: null, state: "pending", chosenOption: null,
    note: null, createdAt: now, answeredAt: null, consumedAt: null });

  const originalReparentWakes = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (scenario B)"); };

  // (C)'s old "never stopped" check read `host.stoppedIds` directly — unfalsifiable here, since
  // `settleRecycleHandoff`'s own poll loop is async and waits for a SessionStart this fake pty never
  // produces, so EVEN the pre-fix buggy code (which called it unconditionally) would never actually reach
  // `pty.stop(oldId)` within this test's synchronous window either. Spy on the method itself instead —
  // this flips to `true` SYNCHRONOUSLY the instant `recycleManager` calls it, independent of anything the
  // (unresolved) promise it returns does afterward, so a removed halt guard is caught immediately.
  let settleRecycleHandoffCalled = false;
  const originalSettleRecycleHandoff = SessionService.prototype.settleRecycleHandoff;
  SessionService.prototype.settleRecycleHandoff = function (...args) {
    settleRecycleHandoffCalled = true;
    return originalSettleRecycleHandoff.apply(this, args);
  };

  let fresh, thrown;
  try {
    try {
      fresh = await svc.recycleManager(oldManagerId, "continuation — forcing a still-failing ownership step");
    } catch (e) { thrown = e; }

    check("(B) recycleManager does NOT throw even though a step is still failing after retry", !thrown && !!fresh);
    check("(B) the successor is reported live", fresh?.processState === "live");

    const oldRow = db.getSession(oldManagerId);
    check("(C) the predecessor's row is UNTOUCHED — still processState:'live'", oldRow?.processState === "live");
    check("(C) the predecessor's pty was NEVER stopped (host.stoppedIds)", !host.stoppedIds.has(oldManagerId));
    check("(C) settleRecycleHandoff was NEVER invoked — the halted predecessor is never even attempted-retired",
      settleRecycleHandoffCalled === false);
    check("(C) hasSuccessor(predecessor) is TRUE — the successor genuinely exists", db.hasSuccessor(oldManagerId) === true);
    check("(C) the predecessor's recycle-settle-pending marker is cleared (never stuck)",
      !db.listRecycleSettlePending().some((r) => r.predecessorId === oldManagerId));

    // The "workers" step DID succeed (reparentLiveWorkers is a real, unstubbed call) — prove it actually
    // transferred, and is therefore NOT reported as stranded, even though a SIBLING step failed.
    const workerRow = db.getSession("workerB1");
    check("(B) the worker reparent step succeeded independently of the failing wake step",
      workerRow?.parentSessionId === fresh?.id);

    const completeEvents = db.listEventsForSession(fresh.id).filter((e) => e.kind === "recycle_complete");
    check("(B) exactly one recycle_complete event was appended, filed under the successor", completeEvents.length === 1);
    check("(B) recycle_complete.detail.failedSteps names the still-failing step (never an ambiguous bare 0)",
      Array.isArray(completeEvents[0]?.detail?.failedSteps) && completeEvents[0].detail.failedSteps.includes("wakes"));
    check("(B) recycle_complete.detail.reparentedWorkers still reports the TRUE count (1), not stranded by the unrelated failure",
      completeEvents[0]?.detail?.reparentedWorkers === 1);

    const failedEvents = db.listEventsForSession(fresh.id).filter((e) => e.kind === "recycle_ownership_transfer_failed");
    check("(B) exactly one recycle_ownership_transfer_failed event was appended", failedEvents.length === 1);
    const failedDetail = failedEvents[0]?.detail ?? {};
    check("(B) its failedSteps names exactly the wakes step", Array.isArray(failedDetail.failedSteps) && failedDetail.failedSteps.includes("wakes"));
    check("(B) its strandedWakeIds names the real stranded wake", Array.isArray(failedDetail.strandedWakeIds) && failedDetail.strandedWakeIds.includes("wakeB1"));
    check("(B) its strandedWorkerIds is EMPTY — the workers step succeeded, nothing stranded there",
      Array.isArray(failedDetail.strandedWorkerIds) && failedDetail.strandedWorkerIds.length === 0);
    check("(B) its strandedQuestionIds is EMPTY — the questions step succeeded (only wakes was stubbed)",
      Array.isArray(failedDetail.strandedQuestionIds) && failedDetail.strandedQuestionIds.length === 0);

    // The question DID reparent correctly (only reparentWakes was stubbed) — confirm it actually moved.
    const questionRow = db.listQuestionsForSession(fresh.id).find((q) => q.id === "questionB1");
    check("(B) the question reparent step succeeded independently of the failing wake step", !!questionRow);
    // The wake, by contrast, is still stuck on the predecessor — the stub blocked its UPDATE.
    check("(B) the stranded wake is STILL on the predecessor, not silently moved or lost",
      db.listWakesForSession(oldManagerId).some((w) => w.id === "wakeB1"));

    // enqueueDurableNudge defers a manager's dispatch until this session's loom-orchestration MCP route is
    // first "seen" (df5e37e7) — the successor really was pty.spawn()'d by recycleManager above (via the
    // SeamHost fake), so it's genuinely tracked alive and legitimately waits; simulate the real gateway's
    // /mcp-orch/:sessionId hit, then let the already-queued .then(dispatch) microtask actually run. Every
    // check BELOW this wait is positive-polarity (asserts a nudge DOES exist) — every check that reads
    // state already settled synchronously inside recycleManager above runs BEFORE this wait, never after.
    host.markMcpSeen(fresh.id);
    await new Promise((r) => setTimeout(r, 0));

    const oldNudges = db.listUnresolvedQueuedMessagesForWorker(oldManagerId);
    check("(B) the predecessor received a durable [loom:recycle-ownership-transfer-failed] nudge",
      oldNudges.some((e) => typeof e.detail?.text === "string" && e.detail.text.includes("[loom:recycle-ownership-transfer-failed]")));
    const freshNudges = db.listUnresolvedQueuedMessagesForWorker(fresh.id);
    check("(B) the successor received a CORRECTING [loom:recycle-ownership-transfer-failed] nudge",
      freshNudges.some((e) => typeof e.detail?.text === "string" && e.detail.text.includes("[loom:recycle-ownership-transfer-failed]")));
    check("(B) the successor's nudge does NOT wrongly claim its predecessor's workers are reparented, since they ARE — it correctly says so",
      freshNudges.some((e) => typeof e.detail?.text === "string" && e.detail.text.includes("Worker re-parenting itself DID succeed")));
  } finally {
    Db.prototype.reparentWakes = originalReparentWakes;
    SessionService.prototype.settleRecycleHandoff = originalSettleRecycleHandoff;
  }
}

// ===================== (D) NEGATIVE CONTROL for the (C) spy — proves it CAN detect a true call =====================
// Card f1969787 Code Review: (C)'s old check read `host.stoppedIds`, which stays empty in THIS harness
// regardless of whether the halt guard exists (the fake pty never reaches ready, so even unstubbed
// `settleRecycleHandoff` never gets far enough to call `pty.stop`) — unfalsifiable. The spy above fixes
// that for the HALT scenario; this scenario proves the spy itself is a working instrument by showing it
// flip `true` on an ORDINARY, fully-successful recycle (no stubs at all) — the shape a removed halt guard
// would fall through to.
{
  const oldManagerId = "oldMgrD";
  mkManager(oldManagerId);

  let settleRecycleHandoffCalledD = false;
  const originalSettle = SessionService.prototype.settleRecycleHandoff;
  SessionService.prototype.settleRecycleHandoff = function (...args) {
    settleRecycleHandoffCalledD = true;
    return originalSettle.apply(this, args);
  };
  try {
    const freshD = await svc.recycleManager(oldManagerId, "continuation — ordinary, unstubbed recycle");
    check("(D) negative control: an ORDINARY successful recycle DOES call settleRecycleHandoff (the spy is a working instrument, not vacuously green)",
      settleRecycleHandoffCalledD === true);
    check("(D) sanity: the ordinary recycle reports no failedSteps", !db.listEventsForSession(freshD.id).some((e) => e.kind === "recycle_ownership_transfer_failed"));
  } finally {
    SessionService.prototype.settleRecycleHandoff = originalSettle;
  }
}

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — a manager recycle's ownership-transfer steps retry once; a step still failing after that retry halts (never retires the predecessor), names exactly what's stranded, and nudges both managers, while an independently-succeeding step is never wrongly reported stranded."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
