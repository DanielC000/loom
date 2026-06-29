import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn TOCTOU double-create race (P1 DATA-LOSS — close the confirmed concurrent/retried-spawn window).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-live-task-guard.mjs: a REAL Db +
// SessionService driven against a FAKE pty (createPty() seam), a real temp git repo behind createWorktree.
//
// The bug: spawnWorker's ONLY second-worker guard was liveSessionIdForTask(taskId) — a single NON-atomic
// SELECT taken synchronously BEFORE the first `await createWorktree`; the new session row is inserted only
// AFTER that await. So two CONCURRENT or RETRIED worker_spawn calls for one taskId both observe
// liveHolder=null across the await window, both createWorktree (the worktree path is DETERMINISTIC per task
// and createWorktree REUSES the dir), and both insert+spawn → TWO live workers sharing ONE branch/worktree
// (silent work-loss). The fix: an in-memory per-taskId claim (inFlightSpawnTaskIds), test-and-set
// SYNCHRONOUSLY at the top of the side-effect window (no await between .has() and .add()) and claimed BEFORE
// createWorktree, so the loser is rejected before it can create an orphan worktree/branch; released in a
// finally once the row is live or on failure.
//
// Why this is DETERMINISTIC (no sleeps / no luck): calling an async fn runs its synchronous prefix
// immediately, up to the first await. So `spawnWorker(...)` (call #1) runs liveHolder-check → claim.add →
// then yields at `await createWorktree`, returning a pending promise. Call #2's synchronous prefix then runs
// with the claim already SET (call #1 hasn't inserted yet, so liveHolder is still null) and is rejected. The
// race window is reproduced exactly by firing both calls without awaiting between them.
//
// Proves:
//   (1) two OVERLAPPING spawns on one taskId → exactly ONE fulfils, ONE is rejected ("spawn in flight");
//   (2) exactly ONE live worker + ONE session row exists for the task (no double-create);
//   (3) the loser left NO orphan — only one worktree/branch was ever created (it rejected before createWorktree);
//   (4) the claim is RELEASED afterward — the normal single-spawn path on another task still works.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-toctou-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wstr-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-wstr-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-toctou-race test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const task = randomUUID();
db.insertTask({ id: task, projectId: "pP", title: "real", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
const taskB = randomUUID();
db.insertTask({ id: taskB, projectId: "pP", title: "second", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });

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
  // ===================== (1) TWO OVERLAPPING spawns on the SAME task — fire both, then settle =====================
  // No await between the two calls: each runs its synchronous prefix immediately, so call #1 claims the task
  // and yields at `await createWorktree` while call #2's prefix sees the claim and is rejected. This is BOTH
  // the concurrent case AND the retry case (a slow first spawn the caller fires again before it returns).
  const p1 = svc.spawnWorker("mgr1", { taskId: task, agentId: "agentDev", kickoffPrompt: "GO" });
  const p2 = svc.spawnWorker("mgr1", { taskId: task, agentId: "agentDev", kickoffPrompt: "GO" });
  const [r1, r2] = await Promise.allSettled([p1, p2]);

  const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
  const rejected = [r1, r2].filter((r) => r.status === "rejected");
  check("(1) exactly ONE overlapping spawn fulfils, ONE is rejected",
    fulfilled.length === 1 && rejected.length === 1);
  check("(1) the loser's rejection names the in-flight claim",
    rejected.length === 1 && /spawn in flight/.test(String(rejected[0].reason?.message)));

  const winner = fulfilled[0]?.value;
  if (winner?.worktreePath) worktrees.push(winner.worktreePath);
  check("(1) the winner is a real live worker bound to the task",
    !!winner && winner.role === "worker" && winner.taskId === task && db.getSession(winner.id).processState === "live");

  // ===================== (2) exactly ONE live worker + ONE session row for the task (no double-create) =====================
  const liveForTask = db.listLiveWorkers().filter((w) => w.taskId === task);
  check("(2) exactly ONE live worker holds the task", liveForTask.length === 1 && liveForTask[0].id === winner.id);
  const rowsForTask = db.listAllSessions().filter((s) => s.taskId === task);
  check("(2) exactly ONE session row was created for the task (no second insert)", rowsForTask.length === 1);
  check("(2) liveSessionIdForTask resolves to the single winner", db.liveSessionIdForTask(task) === winner.id);

  // ===================== (3) the loser left NO orphan worktree/branch =====================
  // The worktree dir is deterministic per task; exactly one was created (the winner's). The loser rejected
  // BEFORE createWorktree, so there is no second/divergent worktree or branch lingering.
  check("(3) the winner's worktree exists on disk", !!winner && fs.existsSync(winner.worktreePath));
  // Only the winner's worktree branch (`loom/<key>`) should exist; taskB isn't spawned until step (4).
  const branches = execSync("git branch --list", { cwd: repo, encoding: "utf8" })
    .split("\n").map((l) => l.replace(/^[*+]?\s*/, "").trim()).filter(Boolean);
  const loomBranches = branches.filter((b) => b.startsWith("loom/"));
  check("(3) exactly ONE worktree branch exists — the winner's (loser created none)",
    loomBranches.length === 1 && !!winner && loomBranches[0] === winner.branch);

  // ===================== (4) the claim was RELEASED — the normal single-spawn path still works =====================
  const wB = await svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wB.worktreePath);
  check("(4) a normal spawn on a different task succeeds after the race (claim released, path unchanged)",
    wB.role === "worker" && wB.taskId === taskB && db.getSession(wB.id).processState === "live");
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
  ? "\n✅ ALL PASS — two overlapping worker_spawn calls for one task produce exactly ONE live worker + ONE worktree/branch; the loser is rejected cleanly with no orphan, and the per-taskId claim is released so the normal path still works — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
