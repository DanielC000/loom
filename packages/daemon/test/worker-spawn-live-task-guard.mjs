import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn live-worker-on-task guard (P1 DATA-LOSS — close a bypassed safe-path asymmetry).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-task-gate.mjs: a REAL Db +
// SessionService driven against a FAKE pty (createPty() seam), a real temp git repo behind createWorktree.
//
// The bug: spawnWorker guarded the concurrency cap + terminal column but NOT "is this taskId already held by
// a LIVE worker." The worktree path is DETERMINISTIC per task and createWorktree REUSES the existing dir,
// recutting a 0-ahead branch with `reset --hard mainSha` — designed for re-spawn after a REJECTED merge (a
// DEAD worker). With a LIVE first worker mid-edit, a second spawn shared its checkout and the reset --hard
// SILENTLY DESTROYED the first's uncommitted work. The fix: reject a second LIVE worker on the task BEFORE
// any worktree/pty side effect, via a BOARD-WIDE lookup (a sibling manager's worker must be visible).
//
// Proves:
//   (1) a SECOND spawn on a task that already has a LIVE worker is REJECTED ("already has a live worker");
//   (2) the rejection has NO side effect — no new worker session, and the first worker's UNCOMMITTED work
//       in the shared worktree SURVIVES (no reset --hard ran);
//   (3) the guard is BOARD-WIDE — a DIFFERENT manager's spawn on the same task is rejected too;
//   (4) once the first worker is DEAD (processState != 'live'), a re-spawn on the task is ALLOWED again
//       (the legitimate re-spawn-after-rejected-merge path the reuse logic was built for).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-live-task-guard.mjs
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
const tmpHome = path.join(os.tmpdir(), `loom-wsltg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wsltg-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-live-task-guard test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr2", projectId: "pP", name: "Mgr2", startupPrompt: "MGR2", position: 1, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 2, profileId: null });
// TWO managers (the board-wide check needs a sibling manager). Both live.
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertSession({ id: "mgr2", projectId: "pP", agentId: "agentMgr2", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskGood = randomUUID();
db.insertTask({ id: taskGood, projectId: "pP", title: "real", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
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
  // ===================== (0) the FIRST worker spawns and goes live, mid-edit =====================
  const w1 = await svc.spawnWorker("mgr1", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w1.worktreePath);
  check("(0) first worker spawns live on the task", w1.role === "worker" && w1.taskId === taskGood && db.getSession(w1.id).processState === "live");
  // Simulate the worker mid-edit: an UNCOMMITTED file in its worktree (a reset --hard would destroy it).
  const dirty = path.join(w1.worktreePath, "UNCOMMITTED.txt");
  fs.writeFileSync(dirty, "work in progress — must survive a blocked re-spawn\n");
  const workerCountBefore = db.listLiveWorkers().length;

  // ===================== (1) a SECOND spawn on the SAME task is REJECTED =====================
  await rejects("(1) a second spawn on a task with a live worker is rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "GO" }), "already has a live worker");

  // ===================== (2) the rejection had NO side effect — work SURVIVES =====================
  check("(2) the first worker's uncommitted work SURVIVES the blocked re-spawn (no reset --hard)",
    fs.existsSync(dirty) && fs.readFileSync(dirty, "utf8").includes("must survive"));
  check("(2) no second worker session was created (still exactly one live worker on the task)",
    db.listLiveWorkers().length === workerCountBefore && db.liveSessionIdForTask(taskGood) === w1.id);

  // ===================== (3) the guard is BOARD-WIDE — a sibling manager is blocked too =====================
  await rejects("(3) a DIFFERENT manager's spawn on the same task is rejected (board-wide, not manager-scoped)",
    () => svc.spawnWorker("mgr2", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "GO" }), "already has a live worker");
  check("(3) still exactly one live worker after the sibling manager's blocked spawn", db.listLiveWorkers().length === workerCountBefore);

  // ===================== (4) once the first worker is DEAD, a re-spawn is ALLOWED =====================
  db.setProcessState(w1.id, "exited"); // the worker died / its merge was rejected — the legit re-spawn case
  check("(4) no live worker holds the task once the first is dead", db.liveSessionIdForTask(taskGood) === undefined);
  const w2 = await svc.spawnWorker("mgr1", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w2.worktreePath);
  check("(4) a re-spawn on the task is allowed once the prior worker is dead (rejected-merge re-spawn path)",
    w2.role === "worker" && w2.taskId === taskGood && w2.id !== w1.id);
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
  ? "\n✅ ALL PASS — worker_spawn rejects a SECOND live worker on a task BEFORE any worktree/pty side effect (board-wide, so a sibling manager is blocked too), so the first worker's uncommitted work can never be destroyed by the reuse path's reset --hard; once the prior worker is dead, the legit re-spawn is allowed again — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
