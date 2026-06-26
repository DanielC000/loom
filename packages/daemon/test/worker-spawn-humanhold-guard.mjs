import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn human-hold guard (P1 OWNER-BRAKE — close a bypassed safe-path asymmetry).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-task-gate.mjs: a REAL Db +
// SessionService driven against a FAKE pty (createPty() seam), a real temp git repo behind createWorktree.
//
// The bug: doctrine + owner memory treat the `blocked` column (role `humanHold`) as the owner's SOLE brake —
// never dispatch onto it. But spawnWorker resolved only the terminal column; `humanHold` was consulted for
// convergence (hasPendingBoardWork), never on DISPATCH. Nothing structurally refused dispatching a worker
// onto a human-held card. The fix: a one-line sibling of the terminal rail — reject a spawn onto the
// humanHold lane BEFORE any worktree/pty side effect.
//
// Proves:
//   (1) a spawn onto a card in the human-hold lane (default `blocked`) is REJECTED ("human-hold lane");
//   (2) the rejection has NO side effect — no worktree dir, no worker session;
//   (3) a spawn onto a NON-held card (backlog) still SUCCEEDS;
//   (4) a board with NO humanHold lane never false-rejects (the guard is a no-op when the role is absent).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-humanhold-guard.mjs
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
const tmpHome = path.join(os.tmpdir(), `loom-wshhg-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-wshhg-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-humanhold-guard test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// pP: default config (humanHold role → the `blocked` column).
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// pNoHold: a custom board with NO humanHold lane — the guard must NOT false-reject here.
db.insertProject({ id: "pNoHold", name: "NoHold", repoPath: repo, vaultPath: repo, createdAt: now, archivedAt: null,
  config: { kanbanColumns: [{ key: "todo", label: "Todo", role: "defaultLanding" }, { key: "done", label: "Done", role: "terminal" }] } });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertAgent({ id: "agentMgr2", projectId: "pNoHold", name: "Mgr2", startupPrompt: "MGR2", position: 0, profileId: null });
db.insertAgent({ id: "agentDev2", projectId: "pNoHold", name: "Dev2", startupPrompt: "DEV2", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertSession({ id: "mgr2", projectId: "pNoHold", agentId: "agentMgr2", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskHeld = randomUUID(), taskOpen = randomUUID(), taskNoHold = randomUUID();
db.insertTask({ id: taskHeld, projectId: "pP", title: "held", body: "", columnKey: "blocked", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskOpen, projectId: "pP", title: "open", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskNoHold, projectId: "pNoHold", title: "open", body: "", columnKey: "todo", position: 1, priority: "p2", createdAt: now, updatedAt: now });

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

const ptWorktreeDir = path.join(tmpHome, "worktrees", "pP");
const worktrees = [];
try {
  // ===================== (1) a spawn onto a human-held card is REJECTED =====================
  await rejects("(1) a spawn onto a card in the human-hold lane (blocked) is rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskHeld, agentId: "agentDev", kickoffPrompt: "GO" }), "human-hold lane");

  // ===================== (2) the rejection had NO side effect =====================
  check("(2) no worktree dir allocated + no worker session created by the rejected spawn",
    !fs.existsSync(ptWorktreeDir) && db.listWorkers("mgr1").length === 0);
  check("(2) the held card stayed on its blocked lane (a rejected spawn never moved it)",
    db.getTask(taskHeld).columnKey === "blocked");

  // ===================== (3) a spawn onto a NON-held card still works =====================
  const w = await svc.spawnWorker("mgr1", { taskId: taskOpen, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w.worktreePath);
  check("(3) a spawn onto a backlog (non-held) card still succeeds", w.role === "worker" && w.taskId === taskOpen);

  // ===================== (4) a board with NO humanHold lane never false-rejects =====================
  const w2 = await svc.spawnWorker("mgr2", { taskId: taskNoHold, agentId: "agentDev2", kickoffPrompt: "GO" });
  worktrees.push(w2.worktreePath);
  check("(4) a board with no humanHold lane spawns normally (guard is a no-op when the role is absent)",
    w2.role === "worker" && w2.taskId === taskNoHold);
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
  ? "\n✅ ALL PASS — worker_spawn refuses to dispatch onto the human-hold lane BEFORE any side effect (the owner's brake is now structural), still spawns onto open cards, and never false-rejects a board with no humanHold lane — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
