import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_recycle PHANTOM-LIVE row on a pre-pty synchronous throw (card 6ca4155f, following fa1b77c1).
//
// The bug: recycleWorker (sessions/service.ts) inserts a fresh successor row and flips it to
// processState:"live" (setProcessState) BEFORE the pty is started. Several synchronous statements run
// between that flip and pty.spawn — buildWorkerRepoContext (already guarded by its OWN try/catch),
// stampProjectMemoryDigest, fireCodescapeRegisterWorktree — none of them wrapped by the method's own
// try/finally in a way that reconciles the row. The method's enclosing try (~10691) has only a `finally`
// (unsuppressCapQueueDrain + a cap-queue drain kick) — no catch. If any of the unguarded pre-pty
// statements throws, the fresh successor row is stranded "live" with no process behind it: a
// PHANTOM-LIVE worker that occupies the manager's concurrency cap AND holds liveSessionIdForTask's
// per-task mutex until a human notices and worker_stops it by hand.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty()/stop() seam, mirroring recycle-successor-determinism.mjs's proven recycleWorker
// harness) and a real temp git repo + worktree. The throw is forced by monkeypatching
// SessionService.prototype.stampProjectMemoryDigest — the SAME pre-pty statement + technique
// worker-spawn-prespawn-throw-marks-exited.mjs already uses for spawnWorker's identical shape.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-recycle-prespawn-throw-marks-exited.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wrpt-${Date.now()}-${process.pid}`);
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

// --- a real temp git repo + worktree so recycleWorker's fresh row reuses a real worktreePath ---
const repo = path.join(os.tmpdir(), `loom-wrpt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-recycle-prespawn-throw-marks-exited test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=wr@loom -c user.name=wr");

const CAP = 2;
const now = new Date().toISOString();
const db = new Db();

// Mirrors recycle-successor-determinism.mjs's proven recycleWorker harness: isAlive() reflects stop()
// immediately, so recycleWorker's synchronous "wait until the old pty is actually gone" poll returns on
// its first check instead of spinning its ~5s budget.
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
db.insertSession({ id: oldWorkerId, projectId: "pR", agentId: "agentDev", engineSessionId: null, title: null,
  cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "worker", parentSessionId: "mgr1", taskId: taskA, worktreePath, branch });

// --- force a synchronous throw in a pre-pty step: stampProjectMemoryDigest runs AFTER the fresh row is
// flipped 'live' and BEFORE pty.spawn (see the card's traced statement list). ---
const INJECTED_MESSAGE = "injected pre-spawn throw (worker-recycle-prespawn-throw-marks-exited test)";
const originalStamp = SessionService.prototype.stampProjectMemoryDigest;
SessionService.prototype.stampProjectMemoryDigest = function () {
  throw new Error(INJECTED_MESSAGE);
};

const worktrees = [[repo, worktreePath]];
try {
  let recycleError;
  try {
    await svc.recycleWorker("mgr1", oldWorkerId, "handoff — forcing a pre-spawn throw");
  } catch (e) {
    recycleError = e;
  }

  check("(setup precondition) the injected pre-spawn throw actually propagated out of recycleWorker",
    !!recycleError && String(recycleError.message).includes(INJECTED_MESSAGE));

  // The fresh successor row exists (insertSession ran before the throw) — find it via listWorkers
  // rather than trusting a returned Session (recycleWorker rejected, so it never returned one) or
  // db.getSuccessor (card 4be56c33: reconcileFailedSpawn now NULLS the failed row's own recycled_from,
  // so a post-failure getSuccessor(oldWorkerId) no longer finds it — that's the fix under test, not a
  // regression; listWorkers is unaffected since it keys off parent_session_id, not recycled_from).
  const successor = db.listWorkers("mgr1").find((w) => w.id !== oldWorkerId);
  check("(setup precondition) a fresh successor row was created for the old worker despite the throw", !!successor);

  check("successor row ends processState:'exited', NOT stranded 'live', after a pre-spawn throw",
    successor?.processState === "exited");
  check("successor row's lastError carries the injected throw's own message (the catch's second effect)",
    typeof successor?.lastError === "string" && successor.lastError.includes(INJECTED_MESSAGE));
  check("successor row's own recycledFrom is NULLED by the catch (card 4be56c33's fix's third effect)",
    successor?.recycledFrom === null);
  check("the OLD worker is no longer hasSuccessor()-superseded once its failed successor is unlinked",
    db.hasSuccessor(oldWorkerId) === false);

  // Mirror what a real onExit would have done to the OLD worker's row (recycleWorker only hard-stops the
  // pty; SeamHost's fake pty never fires a real onExit) — isolates this assertion to the successor's own
  // phantom-live defect rather than conflating it with the predecessor's teardown.
  db.setProcessState(oldWorkerId, "exited");
  const capacity = svc.getWorkerCapacity("mgr1");
  check("manager capacity shows NO live worker after the pre-spawn throw (old stopped, successor reconciled)",
    capacity.live === 0);
  check("manager capacity is fully free again (cap - live - inFlight == cap)", capacity.free === CAP);
} finally {
  SessionService.prototype.stampProjectMemoryDigest = originalStamp;
  for (const [r, wt] of worktrees) { if (wt) { try { await removeWorktree(r, wt); } catch { /* best-effort */ } } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a synchronous throw in a pre-pty step (stampProjectMemoryDigest) during recycleWorker, after the fresh successor row goes live, leaves it 'exited', not phantom-live, and frees the manager's cap slot."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
