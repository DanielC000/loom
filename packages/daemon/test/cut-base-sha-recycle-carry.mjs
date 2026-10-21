import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 — Session.cutBaseSha must survive recycle and resume UNCHANGED, carried forward exactly
// like reviewBaseSha ("SAME worktree => SAME fork point"). A dropped carry silently turns a recycled
// worker into a grandfathered cutBaseUnknown one for the REST of its lineage, disabling the fork-point
// ancestry check for every future landing of that task without anyone noticing.
//
// REAL Db + SessionService driven against a FAKE pty (createPty/stop seam), mirroring
// recycle-successor-determinism.mjs's proven recycleWorker harness (real temp git repo + a real
// worktree). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE.
//
// Proves:
//   (1) recycleWorker's successor row carries the SAME cutBaseSha as its predecessor.
//   (2) RED WITHOUT THE FIX: monkey-patching Db.insertSession to strip cutBaseSha (simulating the carry
//       line being removed from recycleWorker) makes assertion (1) fail — proving this check can
//       actually catch the regression it exists to catch, not just pass vacuously.
//   (3) resume()'s already-live short-circuit returns the SAME row, cutBaseSha included, unchanged —
//       the only path through resume() a worker role can hermetically reach without a real engine
//       transcript on disk; resume() has no write path touching this column at all (verified by reading
//       the real method: it only calls db.setResumability/setProcessState, never insertSession).
//   (4) a null cutBaseSha (a legacy worker) ALSO carries forward as null, not coerced to anything else.
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-recycle-carry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-cbsrc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=cbsrc@loom -c user.name=cbsrc";
const now = new Date().toISOString();

class SeamHost extends createSeamHost(PtyHost) {
  spawned = [];
  stoppedIds = new Set();
  createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
  stop(id, _mode) { this.stoppedIds.add(id); }
  isAlive(id) { return !this.stoppedIds.has(id); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-cbsrc-repo-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# cbsrc\n");
  execSync(`git init -q && git config user.email cbsrc@loom && git config user.name cbsrc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ==================== (1)+(2) recycleWorker carries cutBaseSha forward, RED-proofed ====================
  {
    const P = "cbsrc-proj", repo = makeRepo("worker");
    const { worktreePath, branch } = await createWorktree(repo, P, "wa");
    db.insertProject({ id: P, name: "CBSRC", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertTask({ id: "wa", projectId: P, title: "wa", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const mgrId = `${P}-mgr1`, workerAId = `${P}-wkrA`;
    const FIXED_CUT_BASE = "cafef00dcafef00dcafef00dcafef00dcafef00d";
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({
      id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "worker", parentSessionId: mgrId, taskId: "wa", worktreePath, branch,
      cutBaseSha: FIXED_CUT_BASE,
    });
    check("(1 pre) predecessor's cutBaseSha is the fixed test value", db.getSession(workerAId)?.cutBaseSha === FIXED_CUT_BASE);

    const workerB = await svc.recycleWorker(mgrId, workerAId, "handoff — cut-base carry check");
    check("(1) recycle succeeded and produced a NEW row", !!workerB && workerB.id !== workerAId);
    check("(1) the successor's cutBaseSha is the SAME as the predecessor's (carried forward, never re-derived)",
      workerB.cutBaseSha === FIXED_CUT_BASE);
    check("(1) getSession(successor) agrees with the returned row", db.getSession(workerB.id)?.cutBaseSha === FIXED_CUT_BASE);
    host.stoppedIds.add(workerAId); db.setProcessState(workerAId, "exited");

    // ===== (2) RED WITHOUT THE FIX: prove this check is load-bearing, not vacuous. Monkey-patch
    // Db.insertSession on THIS instance to strip cutBaseSha before delegating — simulating exactly what
    // removing recycleWorker's `cutBaseSha: old.cutBaseSha ?? null` carry line would produce (the
    // successor row lands with no cut base at all). =====
    const realInsertSession = db.insertSession.bind(db);
    db.insertSession = (s) => realInsertSession({ ...s, cutBaseSha: null });
    let brokenSuccessor;
    let redProofError = null;
    try {
      // Re-task: a fresh worker row on a NEW task, so this doesn't collide with workerB's own lineage.
      db.insertTask({ id: "wb", projectId: P, title: "wb", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
      const { worktreePath: wt2, branch: br2 } = await createWorktree(repo, P, "wb");
      const workerCId = `${P}-wkrC`;
      realInsertSession({ id: workerCId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: wt2, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "wb", worktreePath: wt2, branch: br2, cutBaseSha: FIXED_CUT_BASE });
      brokenSuccessor = await svc.recycleWorker(mgrId, workerCId, "handoff — simulating a dropped carry line");
    } catch (e) { redProofError = e; } finally { db.insertSession = realInsertSession; }
    check("(2) negative control setup did not itself throw", redProofError === null);
    // Read back from the DB, never the in-memory returned object: recycleWorker returns the `fresh`
    // object it itself built BEFORE handing it to insertSession, so a patch on insertSession's own write
    // never retroactively mutates that already-constructed literal — only the PERSISTED row reflects it.
    check("(2) RED WITHOUT THE FIX: the PERSISTED successor row's cutBaseSha reads null (NOT the predecessor's value) -- proves assertion (1)'s shape can actually fail, not just pass vacuously",
      !!brokenSuccessor && db.getSession(brokenSuccessor.id)?.cutBaseSha == null);
  }

  // ==================== (3) resume()'s already-live short-circuit preserves cutBaseSha ====================
  {
    const P = "cbsrc-resume", repo = makeRepo("resume");
    const { worktreePath, branch } = await createWorktree(repo, P, "ra");
    db.insertProject({ id: P, name: "CBSRC-Resume", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 0, profileId: null });
    db.insertTask({ id: "ra", projectId: P, title: "ra", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerId = `${P}-wkr`;
    const FIXED_CUT_BASE = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: "ra", worktreePath, branch, cutBaseSha: FIXED_CUT_BASE });

    check("(3 pre) host reports this session alive (host.isAlive -- resume()'s own already-live check)", host.isAlive(workerId) === true);
    const resumed = svc.resume(workerId);
    check("(3) resume() took the already-live short-circuit and returned the SAME row", resumed.id === workerId);
    check("(3) the row's cutBaseSha survived resume() unchanged", resumed.cutBaseSha === FIXED_CUT_BASE);
    check("(3) getSession agrees -- resume()'s short-circuit wrote nothing", db.getSession(workerId)?.cutBaseSha === FIXED_CUT_BASE);
  }

  // ==================== (4) a null (legacy) cutBaseSha carries forward as null, not coerced ====================
  {
    const P = "cbsrc-null", repo = makeRepo("null");
    const { worktreePath, branch } = await createWorktree(repo, P, "na");
    db.insertProject({ id: P, name: "CBSRC-Null", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertTask({ id: "na", projectId: P, title: "na", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const mgrId = `${P}-mgr1`, workerAId = `${P}-wkrA`;
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "na", worktreePath, branch });
    check("(4 pre) predecessor's cutBaseSha is null (a legacy worker)", db.getSession(workerAId)?.cutBaseSha == null);

    const workerB = await svc.recycleWorker(mgrId, workerAId, "handoff — legacy null carry");
    check("(4) the successor's cutBaseSha is ALSO null (never coerced to a stray value)", workerB.cutBaseSha == null);
  }
} finally {
  const { cleanupPathSync } = await import("./_tmp-fixture.mjs");
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycleWorker carries cutBaseSha forward unchanged (proven RED without the carry line via a monkey-patched insertSession), resume()'s already-live short-circuit returns the same row untouched, and a legacy null cutBaseSha carries forward as null, never coerced."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
