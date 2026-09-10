import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// recycleManager pre-spawn failure must unlink the dead successor from a STILL-LIVE, UNTOUCHED
// predecessor (card 4be56c33, second Code Review pass on commit a11525fe).
//
// This is the path the reviewer flagged as where the defect actually BITES, distinct from the worker
// case: recycleManager never touches the OLD manager's row before attempting the fresh spawn (unlike
// recycleWorker, which hard-kills its predecessor first) — the deferred hard-stop only runs 3s AFTER a
// SUCCESSFUL spawn. So on a pre-spawn failure, the old manager is genuinely still `live` and fully
// intact; the ONLY defect is the stray `recycled_from` link on its dead, never-live "successor" —
// permanently (pre-fix) hiding the old manager from a retried recycle_me AND from crash-recovery/redrive
// if it later crashes for real.
//
// Proves, for a pre-spawn throw in recycleManager:
//   (1) the OLD manager's row is completely UNTOUCHED — still processState:'live' (recycleManager never
//       flips it before a successful spawn; this fix must not change that).
//   (2) the dead successor ends 'exited' with recycledFrom NULLED (this card's fix).
//   (3) hasSuccessor(oldManager) is FALSE — no longer permanently "superseded" by a successor that never ran.
//   (4) the old manager is STILL the correct crash-recovery target: recordUnexpectedExit(db, oldManagerId,
//       false) — the exact predicate crash-recovery-watcher.ts's onExit hook evaluates — returns true,
//       simulating the old manager LATER genuinely crashing (it's still live right now; this is what would
//       happen the moment it does). Before the fix this stayed false forever.
//   (5) a RETRY of recycleManager on the same predecessor now succeeds (mirrors
//       worker-recycle-retry-after-prespawn-failure.mjs's worker-path coverage, for the manager path).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty()/stop() seam, mirroring recycle-successor-determinism.mjs's proven recycleManager
// harness — no worktree needed, a manager runs in the bare project repo).
//
// Run: 1) build (turbo builds shared first), 2) node test/manager-recycle-prespawn-throw-unlinks-predecessor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mrpu-${Date.now()}-${process.pid}`);
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
const { recordUnexpectedExit } = await import("../dist/orchestration/crash-recovery-watcher.js");

const repo = path.join(os.tmpdir(), `loom-mrpu-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# manager-recycle-prespawn-throw-unlinks-predecessor test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=mrpu@loom -c user.name=mrpu");

const now = new Date().toISOString();
const db = new Db();

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

db.insertProject({ id: "pM", name: "M", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pM", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });

const oldManagerId = "oldMgrM1";
// engineSessionId set — mirrors a GENUINELY-alive manager (recordUnexpectedExit gates on it being captured).
db.insertSession({ id: oldManagerId, projectId: "pM", agentId: "agentMgr", engineSessionId: "eng-mgr-1", title: null,
  cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// --- force a synchronous throw in a pre-pty step ONLY on the FIRST recycle attempt: stampProjectMemoryDigest
// runs AFTER the fresh row is flipped 'live' and BEFORE pty.spawn (same injection site as
// worker-recycle-retry-after-prespawn-failure.mjs). The SECOND (retry) attempt must reach a real (fake) pty.spawn. ---
const INJECTED_MESSAGE = "injected pre-spawn throw (manager-recycle-prespawn-throw-unlinks-predecessor test)";
let throwOnNextRecycle = true;
const originalStamp = SessionService.prototype.stampProjectMemoryDigest;
SessionService.prototype.stampProjectMemoryDigest = function (...args) {
  if (throwOnNextRecycle) { throwOnNextRecycle = false; throw new Error(INJECTED_MESSAGE); }
  return originalStamp.apply(this, args);
};

// card 08320d02: a pending wake on the PREDECESSOR, scheduled before the attempt — proves recycleManager's
// catch does NOT cancel it (unlike recycleWorker's — see worker-recycle-retry-after-prespawn-failure.mjs):
// the old manager's pty is never touched before a pre-spawn failure here, so it's still genuinely alive
// and its wakes must keep firing normally.
db.insertWake({ id: "wakeOldMgr1", sessionId: oldManagerId, wakeAt: now, note: "self-note", createdAt: now });

try {
  let firstError;
  try {
    await svc.recycleManager(oldManagerId, "continuation #1 — forcing a pre-spawn throw");
  } catch (e) {
    firstError = e;
  }
  check("(setup precondition) the injected pre-spawn throw actually propagated out of recycleManager",
    !!firstError && String(firstError.message).includes(INJECTED_MESSAGE));

  // (1) THE KEY DIFFERENCE FROM THE WORKER PATH: recycleManager never touches the old row before a
  // successful spawn (the hard-stop is deferred 3s, only reached on success) — so it must still be live.
  const oldRow = db.getSession(oldManagerId);
  check("(1) the OLD manager's row is completely UNTOUCHED — still processState:'live'",
    oldRow?.processState === "live");

  // (2) the dead successor: find it via listAllSessionsIncludingArchived, not getSuccessor (this fix
  // nulls recycledFrom, so a post-failure getSuccessor(oldManagerId) legitimately finds nothing) and NOT
  // listSessions (agentId) — card 08320d02 now archives this same failed row (see
  // manager-recycle-prespawn-throw-unlinks-predecessor's own sibling assertions below), and listSessions
  // filters archived_at IS NULL just like listWorkers does.
  const deadSuccessor = db.listAllSessionsIncludingArchived().find((s) => s.agentId === "agentMgr" && s.id !== oldManagerId);
  check("(2) a fresh (now-dead) successor row was minted despite the throw", !!deadSuccessor);
  check("(2) that successor ends 'exited', not phantom-live", deadSuccessor?.processState === "exited");
  check("(2) that successor's own recycledFrom is NULLED by its recycle catch (this card's fix)",
    deadSuccessor?.recycledFrom === null);

  // --- card 08320d02, item 1: the failed successor is archived off the live rail ---
  check("(2a) the failed successor is archived (archivedAt set)", !!deadSuccessor?.archivedAt);
  check("(2a) listSessions(agentMgr) no longer shows the archived, failed successor",
    !db.listSessions("agentMgr").some((s) => s.id === deadSuccessor?.id));

  // --- card 08320d02, item 2: a recycle_failed audit event, filed under the PREDECESSOR (still live) ---
  const failedEvents = db.listEventsForSession(oldManagerId).filter((e) => e.kind === "recycle_failed");
  check("(2b) exactly one recycle_failed event was appended, filed under the predecessor", failedEvents.length === 1);
  const failedDetail = failedEvents[0]?.detail ?? {};
  check("(2b) recycle_failed.detail.recycledFrom names the predecessor", failedDetail.recycledFrom === oldManagerId);
  check("(2b) recycle_failed.detail.failedSuccessorId names the dead successor",
    failedDetail.failedSuccessorId === deadSuccessor?.id);
  check("(2b) recycle_failed.detail.error carries the injected error message",
    typeof failedDetail.error === "string" && failedDetail.error.includes(INJECTED_MESSAGE));

  // --- card 08320d02, item 3 (negative): UNLIKE recycleWorker, the predecessor's own pending wake is
  // NOT cancelled here — its process never stopped, so the wake is a real, still-relevant reminder. ---
  check("(2c) the predecessor's pending wake is UNTOUCHED (recycleManager's predecessor never stopped)",
    db.listWakesForSession(oldManagerId).length === 1);

  // (3)
  check("(3) hasSuccessor(oldManager) is FALSE — no longer permanently superseded by a dead successor",
    db.hasSuccessor(oldManagerId) === false);

  // (4) the old manager is STILL the correct crash-recovery target, simulating it later genuinely crashing
  // (recordUnexpectedExit is the exact predicate crash-recovery-watcher.ts's onExit hook evaluates).
  const eligibleForCrashRecovery = recordUnexpectedExit(db, oldManagerId, /* intended */ false);
  check("(4) recordUnexpectedExit(oldManager) is TRUE — it is still a valid crash-recovery/redrive target",
    eligibleForCrashRecovery === true);

  // (5) a RETRY of the same predecessor now succeeds (mirrors the worker-path retry test).
  let secondError;
  let fresh2;
  try {
    fresh2 = await svc.recycleManager(oldManagerId, "continuation #2 — the retry this card exists to unblock");
  } catch (e) {
    secondError = e;
  }
  check("(5) a SECOND recycleManager on the SAME predecessor after a pre-spawn failure SUCCEEDS",
    !secondError && !!fresh2 && fresh2.processState === "live");
  check("(5) getSuccessor(oldManager) now resolves to the retry's row, not the dead first attempt",
    db.getSuccessor(oldManagerId)?.id === fresh2?.id);
} finally {
  SessionService.prototype.stampProjectMemoryDigest = originalStamp;
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a recycleManager pre-spawn failure leaves the OLD manager untouched (still live) and correctly unlinked from its dead successor, restoring both its retry-ability and its crash-recovery/redrive eligibility."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
