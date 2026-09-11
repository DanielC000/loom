import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// RETRY a recycle after a PRE-SPAWN failure (card 4be56c33, Code Reviewer finding on card 6ca4155f's
// branch) — hasSuccessor(sessionId) (db.ts) is `SELECT 1 FROM sessions WHERE recycled_from = ?`, with no
// regard for whether that successor ever actually went live. Once card 6ca4155f made reconcileFailedSpawn
// honestly mark a failed pre-spawn successor 'exited' (instead of leaving it phantom-'live'), the
// predecessor was STILL left permanently `hasSuccessor()===true` forever — because the fresh (now-dead)
// row's own `recycled_from` column was never cleared. Two concrete consequences:
//   (a) a RETRIED recycleWorker/recycleManager/recyclePlatformLead on the same predecessor is refused
//       "...its successor is live" — provably false once the successor is honestly 'exited'.
//   (b) crash-recovery (recordUnexpectedExit / isCrashRecoveryEligible / the watcher tick) skips the
//       predecessor forever, believing a live successor "owns" it — so a still-alive-but-now-orphaned
//       predecessor manager/Lead that later crashes is never auto-recovered.
//
// Fix: reconcileFailedSpawn (sessions/service.ts) now also NULLS the failed row's own recycled_from —
// the only 3 call sites that ever set recycledFrom (recycleWorker/recycleManager/recyclePlatformLead) all
// route their pre-spawn failure through this ONE shared helper, so this single change point covers all
// three without touching hasSuccessor's read side (and therefore without touching the SUCCESS path at
// all — no new race window on a genuine recycle).
//
// Proves, for the WORKER path (recycleWorker):
//   (1) RETRY: a recycle that fails pre-spawn, followed by a SECOND recycleWorker call on the SAME
//       predecessor, is REFUSED before the fix ("...its successor is live") and SUCCEEDS after — this
//       file's own RED/GREEN split (see below) demonstrates both states against a REAL revert of the fix,
//       not an argument.
//   (2) CRASH-RECOVERY (finding b): recordUnexpectedExit(db, predecessorId, false) — the exact guard
//       crash-recovery-watcher.ts's onExit hook calls — returns false (wrongly skipped) before the fix and
//       true (correctly eligible) after, for the SAME predecessor, once its dead successor is unlinked.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty()/stop() seam, mirroring worker-recycle-prespawn-throw-marks-exited.mjs's proven
// recycleWorker harness) and a real temp git repo + worktree.
//
// RED/GREEN: `node test/worker-recycle-retry-after-prespawn-failure.mjs` is GREEN against this tranche's
// fixed sessions/service.ts. To see it RED against the pre-fix code, temporarily revert this exact hunk
// (reconcileFailedSpawn's `this.db.setOrchestration(sessionId, { recycledFrom: null });` line) via
// `git diff -- packages/daemon/src/sessions/service.ts > <scratch>.patch` + `git checkout HEAD --
// packages/daemon/src/sessions/service.ts` (worker doctrine's own revert-to-prove-RED recipe), rebuild,
// re-run this file, then `git apply <scratch>.patch` to restore.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-recycle-retry-after-prespawn-failure.mjs
//
// EXTENDED by card 08320d02 (Code Review pass 1+2 on 4be56c33) with more assertions against the SAME
// attempt-1 failure, proving: (1) the dead successor is ARCHIVED — off `db.listWorkers`/`listAllSessions`
// (the live rail) — listChildSessions, which includes archived rows, is used to find the row for these
// assertions instead of listWorkers. (card 08320d02 left a SEPARATE gap alone here: MCP `worker_list`'s
// own dangling-worker pool (getDanglingWorkers) used to still surface this exact never-started successor
// as processState:"dangling" — fixed by card dc1604c7, which excludes an archived worker candidate that
// has a `recycle_failed` event recorded under its own id (this file's own assertion (2) below proves that
// event is appended for exactly this shape); see worker-list-dangling.mjs's own scenario (I) for that
// coverage, not this file.); (2) a
// `recycle_failed` event records {recycledFrom, failedSuccessorId, cancelledWakes, error}, with the right
// workerSessionId/taskId; (3) a wake pending on the predecessor BEFORE the recycle attempt is CANCELLED
// (counted, not silently dropped), not left to auto-resume the hard-killed worker once hasSuccessor(old)
// flips false — with a negative control proving the cancel is scoped to the predecessor's OWN wakes, not
// every wake in the table. RED/GREEN for each: revert 08320d02's own hunks in recycleWorker's catch (the
// archiveSession/appendEvent/cancelWakesForSession calls) via the same worker-doctrine revert recipe
// above, rebuild, re-run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wrra-${Date.now()}-${process.pid}`);
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
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");
const { recordUnexpectedExit } = await import("../dist/orchestration/crash-recovery-watcher.js");

// --- a real temp git repo + worktree so recycleWorker's fresh rows reuse a real worktreePath ---
const repo = path.join(os.tmpdir(), `loom-wrra-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-recycle-retry-after-prespawn-failure test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=wrra@loom -c user.name=wrra");

const CAP = 2;
const now = new Date().toISOString();
const db = new Db();

// Mirrors worker-recycle-prespawn-throw-marks-exited.mjs's proven recycleWorker harness: isAlive()
// reflects stop() immediately, so recycleWorker's synchronous "wait until the old pty is actually gone"
// poll returns on its first check instead of spinning its ~5s budget.
class SeamHost extends createSeamHost(PtyHost) {
  stoppedIds = new Set();
  stop(id) { this.stoppedIds.add(id); }
  isAlive(id) { return !this.stoppedIds.has(id); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pR", name: "R", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: CAP } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pR", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pR", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pR", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const taskA = "taskR1";
db.insertTask({ id: taskA, projectId: "pR", title: "task R1", body: "", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });

const { worktreePath, branch } = await createWorktree(repo, "pR", taskA);
const oldWorkerId = "oldWorkerR1";
// engineSessionId + resumability:"resumable" — mirrors a GENUINE, previously-live worker (recordUnexpectedExit
// and isCrashRecoveryEligible both gate on `engineSessionId` being captured and `resumability !== "dead"`).
db.insertSession({ id: oldWorkerId, projectId: "pR", agentId: "agentDev", engineSessionId: "eng-old-1", title: null,
  cwd: worktreePath, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "worker", parentSessionId: "mgr1", taskId: taskA, worktreePath, branch });

// --- force a synchronous throw in a pre-pty step ONLY on the FIRST recycle attempt: stampProjectMemoryDigest
// runs AFTER the fresh row is flipped 'live' and BEFORE pty.spawn (same injection site as
// worker-recycle-prespawn-throw-marks-exited.mjs). The SECOND attempt must reach a real (fake) pty.spawn. ---
const INJECTED_MESSAGE = "injected pre-spawn throw (worker-recycle-retry-after-prespawn-failure test)";
let throwOnNextRecycle = true;
const originalStamp = SessionService.prototype.stampProjectMemoryDigest;
SessionService.prototype.stampProjectMemoryDigest = function (...args) {
  if (throwOnNextRecycle) { throwOnNextRecycle = false; throw new Error(INJECTED_MESSAGE); }
  return originalStamp.apply(this, args);
};

// card 08320d02: a pending wake on the PREDECESSOR, scheduled before attempt 1 — proves the catch
// cancels it (item 3) rather than leaving it to auto-resume the hard-killed worker once its
// recycledFrom link is cleared (hasSuccessor(old) would otherwise read false, and resume()'s only
// resurrection guard IS hasSuccessor — no archivedAt gate).
db.insertWake({ id: "wakeOld1", sessionId: oldWorkerId, wakeAt: now, note: "self-note", createdAt: now });
// NEGATIVE CONTROL (Code Review finding 3b): a wake owned by the MANAGER, not the predecessor — proves
// cancelWakesForSession(oldWorkerId) is scoped to that one session's own wakes, not an indiscriminate
// wipe of the wakes table.
db.insertWake({ id: "wakeMgr1", sessionId: "mgr1", wakeAt: now, note: "manager self-note", createdAt: now });

const worktrees = [[repo, worktreePath]];
try {
  // --- ATTEMPT 1: forced pre-spawn failure ---
  let firstError;
  try {
    await svc.recycleWorker("mgr1", oldWorkerId, "handoff #1 — forcing a pre-spawn throw");
  } catch (e) {
    firstError = e;
  }
  check("(setup precondition) the injected pre-spawn throw actually propagated out of the FIRST recycleWorker call",
    !!firstError && String(firstError.message).includes(INJECTED_MESSAGE));
  check("(setup precondition) throwOnNextRecycle was consumed (the throw fired exactly once, on attempt 1)",
    throwOnNextRecycle === false);

  // listChildSessions (NOT listWorkers) — card 08320d02 now archives the failed successor, so
  // listWorkers (which filters archived_at IS NULL) no longer finds it; listChildSessions still does
  // (it's the "complete tree, including archived" read).
  const deadSuccessor = db.listChildSessions("mgr1").find((w) => w.id !== oldWorkerId);
  check("(setup precondition) attempt 1 minted a fresh (now-dead) successor row", !!deadSuccessor);
  check("(setup precondition) that successor ends 'exited', not phantom-live", deadSuccessor?.processState === "exited");

  // --- card 08320d02, item 1: the failed successor is off the LIVE RAIL — NOT off MCP worker_list
  // altogether (that tool's own dangling-worker pool still surfaces an archived-but-unmerged worker as
  // processState:"dangling"; a separate, not-yet-carded gap this card deliberately leaves alone — see
  // its own decision record). Claim only what's actually true: db.listWorkers/listAllSessions. ---
  check("(1) the failed successor is archived (archivedAt set)", !!deadSuccessor?.archivedAt);
  check("(1) db.listWorkers (the live rail) no longer shows the archived, failed successor — NOT a claim about MCP worker_list, which still surfaces it via the dangling-worker pool",
    !db.listWorkers("mgr1").some((w) => w.id === deadSuccessor?.id));

  // --- card 08320d02, item 2: a recycle_failed audit event records the attempt ---
  const failedEvents = db.listEventsForSession("mgr1").filter((e) => e.kind === "recycle_failed");
  check("(2) exactly one recycle_failed event was appended", failedEvents.length === 1);
  const failedEvent = failedEvents[0];
  const failedDetail = failedEvent?.detail ?? {};
  check("(2) recycle_failed.workerSessionId names the dead successor (mirrors recycle_complete's own convention)",
    failedEvent?.workerSessionId === deadSuccessor?.id);
  check("(2) recycle_failed.taskId names the task", failedEvent?.taskId === taskA);
  check("(2) recycle_failed.detail.recycledFrom names the predecessor",
    failedDetail.recycledFrom === oldWorkerId);
  check("(2) recycle_failed.detail.failedSuccessorId names the dead successor",
    failedDetail.failedSuccessorId === deadSuccessor?.id);
  check("(2) recycle_failed.detail.error carries the injected error message",
    typeof failedDetail.error === "string" && failedDetail.error.includes(INJECTED_MESSAGE));

  // --- card 08320d02, item 3: the hard-killed predecessor's own pending wake is cancelled (counted,
  // not silently dropped), not left to auto-resume it once hasSuccessor(old) flips false (below) ---
  check("(3) the predecessor's pending wake was cancelled (not left to auto-resume it)",
    db.listWakesForSession(oldWorkerId).length === 0);
  check("(3) recycle_failed.detail.cancelledWakes counts exactly the one predecessor wake cancelled",
    failedDetail.cancelledWakes === 1);
  check("(3, negative control) the MANAGER's own unrelated wake is UNTOUCHED — the cancel is scoped to the predecessor's own wakes, not a wipe of the whole table",
    db.listWakesForSession("mgr1").length === 1 && db.listWakesForSession("mgr1")[0].id === "wakeMgr1");

  // --- FINDING (b): crash-recovery must NOT treat the predecessor as superseded by a successor that
  // never actually ran. This is the exact guard crash-recovery-watcher.ts's onExit hook calls. ---
  const eligibleAfterFailure = recordUnexpectedExit(db, oldWorkerId, /* intended */ false);
  check("(b) recordUnexpectedExit(predecessor) is TRUE — crash-recovery is NOT permanently blinded by a successor that never went live",
    eligibleAfterFailure === true);

  // --- ATTEMPT 2: a RETRY of the SAME predecessor, now that attempt 1's dead successor should be unlinked.
  // Before the fix this throws "this worker has already been recycled — its successor is live" — provably
  // false, since that successor is honestly 'exited'. After the fix it must succeed. ---
  let secondError;
  let fresh2;
  try {
    fresh2 = await svc.recycleWorker("mgr1", oldWorkerId, "handoff #2 — the retry this card exists to unblock");
  } catch (e) {
    secondError = e;
  }
  check("(1) a SECOND recycleWorker on the SAME predecessor after a pre-spawn failure SUCCEEDS (no 'successor is live' refusal)",
    !secondError && !!fresh2);
  check("(1) the retry's fresh successor is genuinely live (a real, not phantom, recycle this time)",
    fresh2?.processState === "live");

  const liveSuccessor = db.getSuccessor(oldWorkerId);
  check("(1) getSuccessor(predecessor) now resolves to attempt 2's row, not attempt 1's dead one",
    liveSuccessor?.id === fresh2?.id);
  check("(1) hasSuccessor(predecessor) is TRUE again, pointing at the real (live) successor",
    db.hasSuccessor(oldWorkerId) === true);
} finally {
  SessionService.prototype.stampProjectMemoryDigest = originalStamp;
  for (const [r, wt] of worktrees) { if (wt) { try { await removeWorktree(r, wt); } catch { /* best-effort */ } } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a recycleWorker that fails pre-spawn no longer permanently blocks (a) a retried recycle of the same predecessor, or (b) that predecessor's crash-recovery eligibility."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
