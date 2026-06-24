import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn taskId-validation gate (PL Auditor finding #1, P1 — prevents silent work loss).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-agent-gate.mjs: isolated
// LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty (createPty() seam).
// A real temp git repo backs spawnWorker's createWorktree; the only thing faked is the claude pty.
//
// The bug: worker_spawn validated agentId ("does not resolve to an existing agent") but NOT taskId. A
// manager once passed a TRUNCATED taskId with a trailing space + a placeholder kickoff → the spawn
// SUCCEEDED, binding a live worker to a bogus task string (a zombie) while the real task stayed in
// backlog. The fix mirrors the agentId existence guard for taskId, BEFORE any worktree/session side
// effect, so a bad id creates NOTHING.
//
// Proves the DoD points:
//   (1) a truncated taskId WITH a trailing space is REJECTED (the exact repro) — no worktree/session;
//   (2) a malformed/unknown taskId is REJECTED;
//   (3) an empty / whitespace-only taskId is REJECTED;
//   (4) a taskId that exists but belongs to ANOTHER project is REJECTED (project-scoped);
//   (5) a terminal (done-lane) taskId is REJECTED — pick a non-terminal task;
//   (6) a VALID non-terminal taskId still SPAWNS (binds the worker, moves the card, creates the worktree).
//   + after every rejection: NO worktree dir was allocated AND NO worker session row was created.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-task-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// assert that an async call rejects, and that its message includes `needle`.
const rejects = async (label, fn, needle) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && (!needle || String(threw.message).includes(needle));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wstg-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-wstg-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-task-gate test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// Two projects on default config (kanbanColumns: backlog…done; terminal role → "done").
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "pOther", name: "Other", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A plain (profile-less) worker agent in pP — role resolves null ⇒ allowed as a worker.
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
// Tasks: a real non-terminal (backlog) one, a terminal (done) one in pP, and one in the OTHER project.
const taskGood = randomUUID(), taskDone = randomUUID(), taskOther = randomUUID();
db.insertTask({ id: taskGood, projectId: "pP", title: "real", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskDone, projectId: "pP", title: "done", body: "", columnKey: "done", position: 2, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskOther, projectId: "pOther", title: "elsewhere", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// "no worktree allocated" = the project's worktree dir was never created (createWorktree mkdirs it).
const ptWorktreeDir = path.join(tmpHome, "worktrees", "pP");
const noSideEffects = () => !fs.existsSync(ptWorktreeDir) && db.listWorkers("mgr1").length === 0;

const worktrees = [];
try {
  // ===================== rejections — a bad id must create NOTHING =====================
  // (1) the EXACT repro: a truncated UUID with a trailing space. Trim leaves it truncated ⇒ won't resolve.
  await rejects("(1) truncated taskId with a trailing space is rejected",
    () => svc.spawnWorker("mgr1", { taskId: `${taskGood.slice(0, 20)} `, agentId: "agentDev", kickoffPrompt: "GO" }), "does not resolve");
  // (2) a malformed / unknown id (well-formed-looking but no such task).
  await rejects("(2) malformed/unknown taskId is rejected",
    () => svc.spawnWorker("mgr1", { taskId: randomUUID(), agentId: "agentDev", kickoffPrompt: "GO" }), "does not resolve");
  // (3) empty / whitespace-only.
  await rejects("(3) whitespace-only taskId is rejected",
    () => svc.spawnWorker("mgr1", { taskId: "   ", agentId: "agentDev", kickoffPrompt: "GO" }), "not a valid task id");
  await rejects("(3') empty taskId is rejected",
    () => svc.spawnWorker("mgr1", { taskId: "", agentId: "agentDev", kickoffPrompt: "GO" }), "not a valid task id");
  // (4) a real task, but in ANOTHER project (project-scoped existence — mirrors agentId's project scoping).
  await rejects("(4) a taskId from another project is rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskOther, agentId: "agentDev", kickoffPrompt: "GO" }), "does not resolve");
  // (5) a terminal (done-lane) task — pick a non-terminal one.
  await rejects("(5) a terminal/done taskId is rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskDone, agentId: "agentDev", kickoffPrompt: "GO" }), "terminal");

  // After every rejection: NO worktree dir was allocated AND NO worker session row was created.
  check("(side-effects) no worktree dir allocated + no worker session created by any rejected spawn", noSideEffects());
  // The rejected ids never moved a card: the done task is still in `done`, the other-project task untouched.
  check("(side-effects) terminal task stayed in its done lane (a rejected spawn never moved it)",
    db.getTask(taskDone).columnKey === "done");

  // ===================== (6) a VALID non-terminal taskId still SPAWNS =====================
  const w = await svc.spawnWorker("mgr1", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w.worktreePath);
  check("(6) valid non-terminal taskId spawns a worker (role=worker, bound to the task)",
    w.role === "worker" && w.taskId === taskGood && w.agentId === "agentDev");
  check("(6) the worktree was created on disk for the valid spawn", !!w.worktreePath && fs.existsSync(w.worktreePath));
  check("(6) the worker row persists with the validated taskId", db.getSession(w.id).taskId === taskGood);
  check("(6) the card moved OUT of backlog into the active lane (default config ⇒ in_progress)",
    db.getTask(taskGood).columnKey === "in_progress");

  // A trailing-space on an OTHERWISE-VALID id is NORMALIZED by trim and accepted (robustness, not rejection):
  // the worktree is deterministic per task, so this re-uses taskGood's worktree (idempotent re-spawn path).
  const w2 = await svc.spawnWorker("mgr1", { taskId: `  ${taskGood}  `, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w2.worktreePath);
  check("(trim) surrounding whitespace on a valid id is trimmed and accepted (binds the real task)",
    w2.role === "worker" && w2.taskId === taskGood);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_spawn validates taskId BEFORE any side effect: a truncated/trailing-space/empty/wrong-project/terminal id is rejected with the agentId-style error and creates NO worktree or session, while a valid non-terminal id still spawns — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
