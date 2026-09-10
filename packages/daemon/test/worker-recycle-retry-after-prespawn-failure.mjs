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

  const deadSuccessor = db.listWorkers("mgr1").find((w) => w.id !== oldWorkerId);
  check("(setup precondition) attempt 1 minted a fresh (now-dead) successor row", !!deadSuccessor);
  check("(setup precondition) that successor ends 'exited', not phantom-live", deadSuccessor?.processState === "exited");

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
