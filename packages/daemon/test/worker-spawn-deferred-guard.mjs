import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn DEFERRED guard (card 77d33266 — manager-settable `deferred`, orthogonal to the owner's
// `held` brake). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-held-guard.mjs:
// a REAL Db + SessionService driven against a FAKE pty (createPty() seam), a real temp git repo behind
// createWorktree.
//
// The model: `deferred` is the MANAGER's own sequencing/dependency-gating marker — it must NEVER block
// worker_spawn (only `held`, the owner's SOLE brake, does). The two flags are orthogonal: either can be
// set independently of the other.
//
// Proves:
//   (1) a spawn onto a deferred-but-not-held card SUCCEEDS (deferred is not a brake);
//   (2) a spawn onto a held-but-not-deferred card is STILL REJECTED ("HELD") — held keeps blocking;
//   (3) a spawn onto a card that is BOTH held AND deferred is REJECTED ("HELD") — held wins regardless
//       of deferred, proving the two flags are checked independently (deferred never masks held).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-deferred-guard.mjs
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
const tmpHome = path.join(os.tmpdir(), `loom-wsdg-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-wsdg-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-deferred-guard test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const taskDeferredOnly = randomUUID(), taskHeldOnly = randomUUID(), taskHeldAndDeferred = randomUUID();
// (1) deferred=true, held=false — must SPAWN (deferred is not a brake).
db.insertTask({ id: taskDeferredOnly, projectId: "pP", title: "deferred-only", body: "", columnKey: "backlog", position: 1, priority: "p2", deferred: true, createdAt: now, updatedAt: now });
// (2) held=true, deferred=false — must still be REJECTED.
db.insertTask({ id: taskHeldOnly, projectId: "pP", title: "held-only", body: "", columnKey: "backlog", position: 2, priority: "p2", held: true, createdAt: now, updatedAt: now });
// (3) BOTH held=true and deferred=true — held must still win (rejected).
db.insertTask({ id: taskHeldAndDeferred, projectId: "pP", title: "held-and-deferred", body: "", columnKey: "backlog", position: 3, priority: "p2", held: true, deferred: true, createdAt: now, updatedAt: now });

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
  // ===================== (1) a spawn onto a deferred-only card SUCCEEDS =====================
  const w = await svc.spawnWorker("mgr1", { taskId: taskDeferredOnly, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(w.worktreePath);
  check("(1) a spawn onto a deferred (not held) card succeeds — deferred is not a brake",
    w.role === "worker" && w.taskId === taskDeferredOnly);

  // ===================== (2) a spawn onto a held-only card is STILL REJECTED =====================
  await rejects("(2) a spawn onto a held (not deferred) card is still rejected",
    () => svc.spawnWorker("mgr1", { taskId: taskHeldOnly, agentId: "agentDev", kickoffPrompt: "GO" }), "HELD");
  check("(2) no worktree/worker side effect from the rejected spawn",
    db.listWorkers("mgr1").filter((w2) => w2.taskId === taskHeldOnly).length === 0);

  // ===================== (3) held wins even when deferred is ALSO set =====================
  await rejects("(3) a card that is BOTH held and deferred is rejected — held wins regardless of deferred",
    () => svc.spawnWorker("mgr1", { taskId: taskHeldAndDeferred, agentId: "agentDev", kickoffPrompt: "GO" }), "HELD");
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
  ? "\n✅ ALL PASS — worker_spawn never refuses onto a deferred (not held) card, held STILL refuses regardless of deferred, and held wins even when both flags are set on the same card — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
