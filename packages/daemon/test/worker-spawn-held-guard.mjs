import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn HELD guard (Board Hold Model redesign — supersedes the retired `blocked`/`humanHold`
// column-based guard, worker-spawn-humanhold-guard.mjs). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like worker-spawn-task-gate.mjs: a REAL Db + SessionService driven against a FAKE pty (createPty()
// seam), a real temp git repo behind createWorktree.
//
// The model: the per-card `held` flag is now the SOLE human brake — checked in ANY column, not by which
// lane a card sits in. spawnWorker refuses to dispatch onto a held card regardless of its columnKey.
//
// Proves:
//   (1) a spawn onto a HELD card is REJECTED ("HELD"), with NO side effect (no worktree dir, no worker
//       session), and the held card stays exactly where it was (a rejected spawn never moves it);
//   (2) a spawn onto a NON-held card still SUCCEEDS;
//   (3) held is checked in ANY column — a held card sitting in an ordinary lane (not a special "blocked"
//       column — that column/role no longer exists) is still refused;
//   (4) a board with a column literally named "blocked" (now just an ordinary lane, no special role) does
//       NOT block a spawn by itself — only the `held` flag does.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-held-guard.mjs
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
const tmpHome = path.join(os.tmpdir(), `loom-wshg-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-wshg-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-held-guard test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// pP: default config (no humanHold role/blocked column anymore — the flag is the ONLY brake).
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// pCustom: a custom board with a plain column literally KEYED "blocked" (no special role) — proves that
// key alone confers no brake; only `held` does.
db.insertProject({ id: "pCustom", name: "Custom", repoPath: repo, vaultPath: repo, createdAt: now, archivedAt: null,
  config: { kanbanColumns: [
    { key: "todo", label: "Todo", role: "defaultLanding" },
    { key: "blocked", label: "Blocked" }, // plain lane, no role — the retired brake key
    { key: "done", label: "Done", role: "terminal" },
  ] } });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertAgent({ id: "agentMgr2", projectId: "pCustom", name: "Mgr2", startupPrompt: "MGR2", position: 0, profileId: null });
db.insertAgent({ id: "agentDev2", projectId: "pCustom", name: "Dev2", startupPrompt: "DEV2", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertSession({ id: "mgr2", projectId: "pCustom", agentId: "agentMgr2", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskHeld = randomUUID(), taskOpen = randomUUID(), taskHeldInTodo = randomUUID(), taskOnBlockedKeyNotHeld = randomUUID();
// (1) held=true on an ordinary column ("backlog") — the flag is the brake, not the lane.
db.insertTask({ id: taskHeld, projectId: "pP", title: "held", body: "", columnKey: "backlog", position: 1, priority: "p2", held: true, createdAt: now, updatedAt: now });
db.insertTask({ id: taskOpen, projectId: "pP", title: "open", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
// (3) held=true sitting in the project's "todo" (workReady) lane — still refused.
db.insertTask({ id: taskHeldInTodo, projectId: "pP", title: "held-in-todo", body: "", columnKey: "todo", position: 3, priority: "p2", held: true, createdAt: now, updatedAt: now });
// (4) sitting on a column literally KEYED "blocked" but held=false — must SPAWN (key alone is no brake).
db.insertTask({ id: taskOnBlockedKeyNotHeld, projectId: "pCustom", title: "on-blocked-key-not-held", body: "", columnKey: "blocked", position: 1, priority: "p2", createdAt: now, updatedAt: now });

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
  // ===================== (1) a spawn onto a HELD card is REJECTED =====================
  await rejects("(1) a spawn onto a HELD card is rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskHeld, agentId: "agentDev", kickoffPrompt: "GO" }), "HELD");

  // ===================== (2) the rejection had NO side effect =====================
  check("(2) no worktree dir allocated + no worker session created by the rejected spawn",
    !fs.existsSync(ptWorktreeDir) && db.listWorkers("mgr1").length === 0);
  check("(2) the held card stayed in its column (a rejected spawn never moved it)",
    db.getTask(taskHeld).columnKey === "backlog");

  // ===================== (3) a spawn onto a NON-held card still works =====================
  const w = await svc.spawnWorker("mgr1", { taskId: taskOpen, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w.worktreePath);
  check("(3) a spawn onto a non-held card still succeeds", w.role === "worker" && w.taskId === taskOpen);

  // ===================== (4) held is checked in ANY column, not just a special lane =====================
  await rejects("(4) a held card sitting in the ordinary workReady lane ('todo') is STILL rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskHeldInTodo, agentId: "agentDev", kickoffPrompt: "GO" }), "HELD");

  // ===================== (5) a column literally keyed "blocked" confers NO brake by itself =====================
  const w2 = await svc.spawnWorker("mgr2", { taskId: taskOnBlockedKeyNotHeld, agentId: "agentDev2", kickoffPrompt: "GO" });
  worktrees.push(w2.worktreePath);
  check("(5) a card on a plain 'blocked'-keyed column (no role, held=false) still spawns — the flag is the brake",
    w2.role === "worker" && w2.taskId === taskOnBlockedKeyNotHeld);
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
  ? "\n✅ ALL PASS — worker_spawn refuses to dispatch onto a HELD card in ANY column BEFORE any side effect (the owner's brake is structural + lane-agnostic), still spawns onto open cards, and a plain 'blocked'-keyed column confers no brake by itself — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
