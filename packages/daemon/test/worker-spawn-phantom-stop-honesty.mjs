import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Phantom-session + lying worker_stop (card dde0ce24 — reported live by the Codescape peer manager).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-live-task-guard.mjs: a REAL Db +
// SessionService driven against a REAL PtyHost whose createPty() seam is forced to throw — a genuine
// process-creation failure (the known real-world trigger is an oversized Windows command line, "error
// code: 206", carded separately as bc91e86c), not a stub at the wrong layer. Forcing the failure AT the
// createPty boundary (rather than stubbing spawnWorker/pty.spawn higher up) exercises the REAL record-
// lifecycle code this bug lives in: PtyHost.spawn() calls createPty() synchronously, BEFORE it ever
// registers a Live entry — so a throw here reproduces exactly "no Live entry was ever created" (the same
// shape the real Windows CreateProcess failure produces), while still running every other real code path
// (createWorktree, insertSession, setProcessState, the pty.isAlive/pty.stop machinery).
//
// The two chained defects (both fixed here):
//   (1) spawnWorker flips the DB row to processState:'live' BEFORE wiring the pty (so a fast async exit's
//       onExit always wins the race) — but a SYNCHRONOUS createPty throw happens before onExit could ever
//       fire (no process was ever created), so nothing ever reconciled the row: a phantom stuck 'live'
//       forever with engineSessionId:null, holding liveSessionIdForTask's per-task mutex.
//   (2) worker_stop unconditionally called pty.stop() (which silently no-ops on a session with no Live
//       entry) and reported {stopped:true} regardless — a false success a manager cannot route around.
//
// Proves:
//   (A) a genuine createPty failure leaves NO live phantom — the row is reconciled to 'exited', the
//       per-task mutex is released, and a subsequent re-spawn on the same task is ADMITTED;
//   (B) worker_stop is honest for ANY live-but-dead row (not just one caused by (A)'s exact code path —
//       e.g. one that predates this fix): it returns {stopped:false, reason:...}, NEVER {stopped:true},
//       when there is no live pty — and as a side effect reconciles the row + releases the mutex, so a
//       re-spawn is admitted right after;
//   (C) worker_recycle still works as the escape hatch on a phantom that has a REAL provisioned worktree —
//       and genuinely REUSES it (an uncommitted marker file placed in the worktree SURVIVES the recycle,
//       proving no re-provisioning / no `reset --hard` ran against it).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-phantom-stop-honesty.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const rejects = async (label, fn, needle) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && (!needle || String(threw.message).includes(needle));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wsph-${Date.now()}-${process.pid}`);
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

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wsph-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-phantom-stop-honesty test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const taskA = randomUUID(); // (A) real createPty failure never leaves a phantom
const taskB = randomUUID(); // (B) worker_stop honesty, general case (a synthetic already-in-the-wild phantom)
const taskC = randomUUID(); // (C) worker_recycle escape hatch on a phantom with a real worktree
for (const id of [taskA, taskB, taskC]) {
  db.insertTask({ id, projectId: "pP", title: `t-${id}`, body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
}

// The REAL PtyHost, driven by a REAL Db and REAL createWorktree — only createPty (the ONE seam that
// actually shells out to node-pty / the OS) is forced to fail, on command, to simulate the genuine
// Windows CreateProcess failure this bug is about. Every other PtyHost code path (spawn()'s Live-entry
// bookkeeping, isAlive(), stop()) runs FOR REAL.
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.failNext = false; }
  createPty(opts) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("spawn claude EINVAL (simulated CreateProcess failure — error code: 206)");
    }
    return super.createPty(opts);
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const worktrees = [];
try {
  // ===================== (A) a genuine createPty failure leaves NO live phantom =====================
  host.failNext = true;
  await rejects("(A) a genuine createPty failure propagates out of worker_spawn",
    () => svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO" }), "error code: 206");

  const rowsA = db.listWorktreeSessionsForTask(taskA);
  check("(A) exactly one session row was left behind (the worktree/session were created before the pty failure)", rowsA.length === 1);
  const rowA = rowsA[0];
  worktrees.push(rowA.worktreePath);
  check("(A) the phantom row is RECONCILED to 'exited', not stuck 'live'", rowA.processState === "exited");
  check("(A) the phantom row never got an engine", rowA.engineSessionId === null);
  check("(A) the per-task mutex is released — liveSessionIdForTask sees no live holder", db.liveSessionIdForTask(taskA) === undefined);

  const w2A = await svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w2A.worktreePath);
  check("(A) a re-spawn on the same task is ADMITTED right after (no residual mutex hold)",
    w2A.role === "worker" && w2A.taskId === taskA && w2A.id !== rowA.id && db.getSession(w2A.id).processState === "live");

  // ===================== (B) worker_stop is honest for ANY live-but-dead row =====================
  // A synthetic phantom independent of (A)'s exact code path — e.g. one that predates this fix, or
  // arises from some other cause — to prove the general invariant, not just this one trigger.
  const phantomB = {
    id: randomUUID(), projectId: "pP", agentId: "agentDev", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: "mgr1", taskId: taskB, worktreePath: repo, branch: "loom/wsph-b",
  };
  db.insertSession(phantomB);
  check("(B) the phantom holds the per-task mutex", db.liveSessionIdForTask(taskB) === phantomB.id);
  await rejects("(B) worker_spawn on the held task is rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO" }), "already has a live worker");

  const stopResB = svc.stopWorker("mgr1", phantomB.id, "hard");
  check("(B) worker_stop reports {stopped:false} — NEVER a lying {stopped:true} — when there's no live pty",
    stopResB.stopped === false && typeof stopResB.reason === "string" && stopResB.reason.length > 0);
  check("(B) the phantom row is now reconciled to 'exited'", db.getSession(phantomB.id).processState === "exited");
  check("(B) the mutex is released as a side effect of the honest stop", db.liveSessionIdForTask(taskB) === undefined);

  const w2B = await svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w2B.worktreePath);
  check("(B) a re-spawn on the task is admitted right after worker_stop's honest report",
    w2B.role === "worker" && w2B.taskId === taskB);

  // ===================== (C) worker_recycle still works as the escape hatch on a phantom =====================
  host.failNext = true;
  await rejects("(C) a genuine createPty failure on taskC",
    () => svc.spawnWorker("mgr1", { taskId: taskC, agentId: "agentDev", kickoffPrompt: "GO" }), "error code: 206");
  const rowsC = db.listWorktreeSessionsForTask(taskC);
  const rowC = rowsC[0];
  worktrees.push(rowC.worktreePath);
  check("(C) the phantom on taskC has a REAL provisioned worktree on disk", fs.existsSync(rowC.worktreePath));

  // An uncommitted marker: if recycleWorker mistakenly re-provisioned (createWorktree's REUSE path
  // recuts the branch via `reset --hard mainSha` — see worker-spawn-live-task-guard.mjs) instead of
  // reusing the worktree in place, this file would be destroyed.
  const marker = path.join(rowC.worktreePath, "UNCOMMITTED-MARKER.txt");
  fs.writeFileSync(marker, "must survive worker_recycle — no re-provisioning\n");

  const fresh = await svc.recycleWorker("mgr1", rowC.id, "handoff: predecessor never got an engine; continue the same work");
  check("(C) worker_recycle succeeds on a phantom with no engine", fresh.role === "worker" && fresh.id !== rowC.id);
  check("(C) the successor REUSES the exact same worktree path (no re-provisioning)", fresh.worktreePath === rowC.worktreePath);
  check("(C) the successor keeps the same branch", fresh.branch === rowC.branch);
  check("(C) the uncommitted marker SURVIVES the recycle (proves reuse, not re-provisioning)",
    fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("must survive"));
  check("(C) db.hasSuccessor records the recycle lineage", db.hasSuccessor(rowC.id) === true);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a genuine createPty failure no longer leaves a phantom 'live' session holding the per-task mutex; worker_stop never reports {stopped:true} without an actual live pty to stop, and honestly reconciling releases the mutex; worker_recycle still works as the escape hatch and genuinely reuses the provisioned worktree — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
