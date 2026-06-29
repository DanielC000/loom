import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Sibling-session retirement sweep (incident 35fc823f — the "zombie" end of the 2-workers-on-one-branch
// incident). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, in-process like merge-confirm-idempotent.mjs /
// worker-spawn-toctou-race.mjs: a REAL Db + SessionService driven against a stub pty, with a real temp git
// repo behind createWorktree/mergeBranch for the merge path.
//
// THE BUG: confirmWorkerMerge hard-stopped ONLY the one passed worker, then finalizeMerge DELETED the
// worktree — and recycleWorker hard-stopped ONLY the one worker, then REUSED the worktree. Neither
// reconciled OTHER live sessions bound to the same task/worktree, so a stray sibling (the pre-fix
// 2-workers-on-one-branch state) was left running in a now-DELETED / repurposed cwd: a zombie. The
// spawn-race that CREATED a 2nd session is fixed upstream (the atomic per-taskId claim); this is the
// defensive retirement guard at the OTHER end.
//
// THE FIX: a new db helper listLiveSessionsForTask(taskId) + a SessionService sweep
// retireSiblingSessionsForTask(taskId, keepSessionId) called BEFORE the worktree is removed/reused on BOTH
// paths — confirmWorkerMerge (via finalizeMerge, covering ALREADY_MERGED + Green once) and recycleWorker.
// It graceful-stops + DB-retires every live session on the task OTHER than the one being merged/recycled.
//
// Proves:
//   (M) MERGE: a task with TWO live sessions on one worktree → confirmWorkerMerge merges, removes the
//       worktree, and BOTH sessions end 'exited' — NO session is left live bound to the removed cwd.
//   (R) RECYCLE: a task with TWO live sessions on one worktree → recycleWorker retires the old worker AND
//       the sibling, leaving EXACTLY ONE live session for the task: the fresh successor (no zombie).
// Run: 1) build (turbo builds shared first), 2) node test/sibling-session-sweep.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-sss-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=sss@loom -c user.name=sss";
const now = new Date().toISOString();

const db = new Db();
// A stub pty that MODELS node-pty's onExit: a Loom stop() leads (via the real onExit handler) to the
// session row going 'exited' + busy cleared. So both the primary's hard-stop and the sweep's graceful-stop
// land their targets 'exited' here — exactly as a real daemon would. flushPending/spawn/enqueueStdin are
// the no-op seams recycleWorker touches.
const pty = {
  stop(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  isAlive() { return false; },
  enqueueStdin() {},
  flushPending() { return []; },
  spawn() {},
};
const svc = new SessionService(db, pty, new OrchestrationControl());

const worktrees = [];
const repos = [];
try {
  // ============================ (M) MERGE PATH ============================
  {
    const repo = path.join(os.tmpdir(), `loom-sss-merge-repo-${Date.now()}`);
    repos.push(repo);
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# sibling-sweep merge test\n");
    execSync(`git init -q && git config user.email sss@loom && git config user.name sss && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    const projId = `sss-m-proj`, agentId = `sss-m-agent`, taskId = randomUUID();
    const mgrId = `sss-m-mgr`, workerId = `sss-m-wkr`, siblingId = `sss-m-sib`;
    db.insertProject({ id: projId, name: "SSS-M", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0, profileId: null });
    db.insertTask({ id: taskId, projectId: projId, title: "feat(daemon): sibling-sweep merge", body: "", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // A real +1-ahead worker branch with a genuine diff so confirmWorkerMerge takes the Green merge path.
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "the work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat work"`, { cwd: worktreePath });

    // TWO live sessions bound to the SAME task/worktree/branch — the pre-fix 2-workers-on-one-branch state.
    const seedWorker = (id) => db.insertSession({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    seedWorker(workerId);
    seedWorker(siblingId);
    check("(M-pre) TWO live sessions are bound to the one task/worktree", db.countLiveSessionsForTask(taskId) === 2);

    const res = await svc.confirmWorkerMerge(mgrId, workerId);
    check("(M) confirm merged the +1 branch", res.merged === true && res.emptyKind === undefined);
    check("(M) the shared worktree was removed", !fs.existsSync(worktreePath));
    check("(M) the merged worker is now 'exited'", db.getSession(workerId).processState === "exited");
    check("(M) the SIBLING was swept to 'exited' (no zombie in the deleted cwd)", db.getSession(siblingId).processState === "exited");
    check("(M) NO live session remains bound to the task", db.countLiveSessionsForTask(taskId) === 0 && db.listLiveSessionsForTask(taskId).length === 0);
  }

  // ============================ (R) RECYCLE PATH ============================
  {
    // recycleWorker does no git itself (it REUSES the worktree), so a plain temp dir as the cwd suffices.
    const wt = path.join(os.tmpdir(), `loom-sss-recycle-wt-${Date.now()}`);
    fs.mkdirSync(wt, { recursive: true });
    const repo = path.join(os.tmpdir(), `loom-sss-recycle-repo-${Date.now()}`);
    repos.push(repo); worktrees.push(wt);
    fs.mkdirSync(repo, { recursive: true });

    const projId = `sss-r-proj`, agentId = `sss-r-agent`, taskId = randomUUID();
    const mgrId = `sss-r-mgr`, oldWorkerId = `sss-r-old`, siblingId = `sss-r-sib`;
    db.insertProject({ id: projId, name: "SSS-R", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0, profileId: null });
    db.insertTask({ id: taskId, projectId: projId, title: "chore(daemon): sibling-sweep recycle", body: "", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const seedWorker = (id) => db.insertSession({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: wt, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt, branch: "loom/sss-r" });
    seedWorker(oldWorkerId);
    seedWorker(siblingId);
    check("(R-pre) TWO live sessions are bound to the one task/worktree", db.countLiveSessionsForTask(taskId) === 2);

    const fresh = await svc.recycleWorker(mgrId, oldWorkerId, "continue the task; decided X; next do Y.");
    check("(R) recycle returns a fresh live successor (recycledFrom the old worker, same worktree)",
      !!fresh && fresh.processState === "live" && fresh.recycledFrom === oldWorkerId && fresh.worktreePath === wt && fresh.taskId === taskId);
    check("(R) the old (recycled) worker is now 'exited'", db.getSession(oldWorkerId).processState === "exited");
    check("(R) the SIBLING was swept to 'exited' (no zombie on the reused worktree)", db.getSession(siblingId).processState === "exited");
    const live = db.listLiveSessionsForTask(taskId);
    check("(R) EXACTLY ONE live session remains for the task — the fresh successor (no concurrent sibling)",
      live.length === 1 && live[0].id === fresh.id);
  }
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const r of repos) for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(r, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  for (const p of [...worktrees, ...repos, tmpHome]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMerge and recycleWorker both sweep sibling sessions: no live session is ever left bound to a removed/reused worktree (incident 35fc823f), claude-free + network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
