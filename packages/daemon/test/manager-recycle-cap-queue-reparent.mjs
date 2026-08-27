import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// card daf7dfa1 regression: a cap-queued worker_spawn intent must survive a MANAGER RECYCLE.
//
// THE GAP THIS CLOSES: recycleManager already reparents live workers (reparentLiveWorkers), scheduled
// wakes (reparentWakes), and decision-inbox questions (reparentQuestions) onto the successor's NEW
// session id — but, before this fix, it never touched the in-memory CapQueueRegistry. A cap-queued entry
// recorded under the predecessor's session id was silently ORPHANED: every one of the predecessor's live
// workers gets reparented onto the successor, so ALL of their future onExit-driven drains call
// maybeDrainCapQueue(successorId) — never maybeDrainCapQueue(oldManagerId) again. The entry just sits
// under the dead predecessor id until its 30-min TTL reaps it, and even that TTL-reap notice is sent to a
// session that no longer exists (enqueueDurableMessage to an archived predecessor). Same defect CLASS as
// card 8701bdbb (questions) and card 93609ef3 (worker reads) — "recycle mints a new session id" strands
// anything keyed to the old one that isn't explicitly carried forward.
//
// HERMETIC (real Db + SessionService + a real temp git repo behind createWorktree, fake pty — mirrors
// worker-spawn-cap-queue.mjs's SeamHost):
//   (1) a worker fills the cap (cap=1) under the OLD manager id; a second spawn is cap-queued behind it.
//   (2) recycleManager(oldMgrId) — the queued entry must be VISIBLE under the successor's NEW id and GONE
//       from the predecessor's (moved, not copied/duplicated).
//   (3) freeing the reparented worker's slot (its own onExit now correctly attributes to the SUCCESSOR,
//       since reparentLiveWorkers already moved it) auto-fires the migrated entry into a REAL live worker
//       parented to the SUCCESSOR — proving it's not just visible, it can actually still drain.
//
// Run: 1) build (turbo builds shared first), 2) node test/manager-recycle-cap-queue-reparent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mrcq-${Date.now()}-${process.pid}-${randomUUID()}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

// Dynamic imports, AFTER LOOM_HOME is set — paths.ts reads LOOM_HOME at import time (mirrors
// worker-spawn-cap-queue.mjs's own ordering).
const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const GIT_ID = "-c user.email=mrcq@loom -c user.name=mrcq";
function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mrcq\n");
  execSync(`git init -q && git config user.email mrcq@loom && git config user.name mrcq && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

class SeamHost extends PtyHost {
  createPty() {
    let exitCb = null;
    return {
      pid: 4242, write() {}, onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) setTimeout(() => exitCb({ exitCode: 0 }), 0); },
      resize() {},
    };
  }
}
let lastDrainPromise = Promise.resolve();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    const exited = db.getSession(id);
    lastDrainPromise = (exited && exited.role === "worker" && exited.parentSessionId)
      ? svc.maybeDrainCapQueue(exited.parentSessionId)
      : Promise.resolve();
  },
};
const host = new SeamHost(events);
const control = new OrchestrationControl();
const db = new Db();
const svc = new SessionService(db, host, control);

const repo = path.join(os.tmpdir(), `loom-mrcq-repo-${Date.now()}-${process.pid}-${randomUUID()}`);
initRepo(repo);
const worktrees = [];
try {
  const now = new Date().toISOString();
  db.insertProject({ id: "pMRCQ", name: "MRCQ", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrMRCQ", projectId: "pMRCQ", name: "MgrMRCQ", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: "agentDevMRCQ", projectId: "pMRCQ", name: "DevMRCQ", startupPrompt: "DEV", position: 1, profileId: null });
  const oldMgrId = "mgrMRCQ-old";
  db.insertSession({ id: oldMgrId, projectId: "pMRCQ", agentId: "agentMgrMRCQ", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const taskA = randomUUID();
  const taskB = randomUUID();
  db.insertTask({ id: taskA, projectId: "pMRCQ", title: "task A", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  db.insertTask({ id: taskB, projectId: "pMRCQ", title: "task B", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });

  // ===================== (1) fill the cap under the OLD manager, queue a second spawn behind it =====================
  const spawnA = await svc.spawnWorker(oldMgrId, { taskId: taskA, agentId: "agentDevMRCQ", kickoffPrompt: "GO A" });
  check("(1 setup) taskA fills the cap (cap=1) under the OLD manager id", !!spawnA.id && spawnA.parentSessionId === oldMgrId);
  worktrees.push(spawnA.worktreePath);

  let rejB;
  try {
    await svc.spawnWorker(oldMgrId, { taskId: taskB, agentId: "agentDevMRCQ", kickoffPrompt: "GO B, will be cap-queued" });
    check("(1 setup) taskB spawn was unexpectedly NOT cap-rejected", false);
  } catch (e) {
    rejB = e;
  }
  check("(1 setup) taskB is cap-rejected + queued under the OLD manager id", !!rejB?.capQueued && rejB.capQueued.taskId === taskB);
  check("(1 setup) the entry is visible via listCapQueuedSpawns(oldMgrId)",
    svc.listCapQueuedSpawns(oldMgrId).some((e) => e.opId === rejB.capQueued.opId));

  // ===================== (2) recycle the manager — the entry must MOVE onto the successor, not be lost =====================
  const fresh = await svc.recycleManager(oldMgrId, "successor: 1 cap-queued spawn outstanding behind taskA");
  check("(2) recycleManager minted a NEW session id", fresh.id !== oldMgrId);
  check("(2) the cap-queued entry is now visible under the SUCCESSOR's id", svc.listCapQueuedSpawns(fresh.id).some((e) => e.opId === rejB.capQueued.opId));
  check("(2) the entry is GONE from the predecessor's id (moved, not duplicated)", svc.listCapQueuedSpawns(oldMgrId).length === 0);
  check("(2) taskA's worker was ALSO reparented onto the successor (reparentLiveWorkers, unchanged)",
    db.getSession(spawnA.id)?.parentSessionId === fresh.id);

  // ===================== (3) freeing the reparented worker's slot auto-fires the migrated entry — for real =====================
  events.onExit(spawnA.id, 0, { intended: true }); // its own parentSessionId is now fresh.id — see (2) above
  await lastDrainPromise;
  const workersUnderSuccessor = db.listWorkers(fresh.id);
  const liveB = workersUnderSuccessor.find((w) => w.taskId === taskB && w.processState === "live");
  check("(3) the migrated entry auto-fired into a REAL live worker, parented to the SUCCESSOR", !!liveB);
  if (liveB) worktrees.push(liveB.worktreePath);
  check("(3) no cap-queued placeholder remains anywhere (successor or predecessor)",
    svc.listCapQueuedSpawns(fresh.id).length === 0 && svc.listCapQueuedSpawns(oldMgrId).length === 0);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a cap-queued worker_spawn intent survives a manager recycle: CapQueueRegistry.reparent moves it onto the successor's session id (never stranded on the retired predecessor), and it still auto-fires into a real worker once a slot frees post-recycle."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
