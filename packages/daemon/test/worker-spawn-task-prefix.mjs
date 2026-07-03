import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn taskId-by-PREFIX resolution (card 3e9e1d9f).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-agent-name.mjs: isolated LOOM_HOME +
// a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty (PtyHost createPty() seam). A real
// temp git repo backs spawnWorker's createWorktree; the only thing faked is the claude pty.
//
// The UX gap: Loom DISPLAYS the 8-char id-prefix everywhere as the paste-able id, but worker_spawn's taskId
// was EXACT-lookup only — an agentId prefix already resolved (worker-spawn-agent-name.mjs), so a manager
// pasting the SAME kind of short id for a taskId got "does not resolve" while the full 36-char UUID worked.
//
// Proves:
//   (1) an unambiguous 8-char taskId PREFIX resolves and spawns a worker bound to the right task;
//   (2) an AMBIGUOUS prefix (two tasks sharing an 8-char prefix) is REJECTED naming BOTH candidate ids, and
//       spawns NOTHING (no worker session, no worktree);
//   (3) a full taskId still resolves (regression — the historical contract is preserved).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-task-prefix.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const rejects = async (label, fn, ...needles) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && needles.every((n) => String(threw.message).includes(n));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wstp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wstp-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-task-prefix test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// Raise the concurrency cap so all SUCCESS spawns in this test can be live at once — orthogonal to what
// this test exercises (taskId resolution).
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 10 } }, createdAt: now, archivedAt: null });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 0, profileId: "profDev" });

db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentDev", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// A REAL, non-terminal task whose id we'll only ever pass by its 8-char PREFIX (case 1).
const tUnique = randomUUID();
db.insertTask({ id: tUnique, projectId: "pP", title: "unique task", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// Two tasks engineered to share the SAME 8-char prefix (case 2 — ambiguity). Force an 8-hex-char shared
// prefix onto two otherwise-random UUIDs so this is deterministic, not a random collision.
const sharedPrefix = "abcdef12";
const tDupA = `${sharedPrefix}-${randomUUID().slice(9)}`;
const tDupB = `${sharedPrefix}-${randomUUID().slice(9)}`;
db.insertTask({ id: tDupA, projectId: "pP", title: "dup A", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: tDupB, projectId: "pP", title: "dup B", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });

// A third REAL task for the full-id regression check (case 3).
const tFull = randomUUID();
db.insertTask({ id: tFull, projectId: "pP", title: "full-id task", body: "", columnKey: "backlog", position: 4, priority: "p2", createdAt: now, updatedAt: now });

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

const worktrees = [];
try {
  // ===================== (1) an unambiguous 8-char taskId PREFIX resolves + spawns =====================
  const prefixRef = tUnique.slice(0, 8);
  const wPrefix = await svc.spawnWorker("mgr1", { taskId: prefixRef, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wPrefix.worktreePath);
  check("(1) 8-char taskId prefix resolves and spawns a worker on the right task", wPrefix.taskId === tUnique);
  check("(1) the task moved to in_progress", db.getTask(tUnique).columnKey === "in_progress");

  // ===================== (2) an AMBIGUOUS prefix is rejected, naming BOTH candidates, spawns nothing =====================
  await rejects("(2) ambiguous taskId prefix rejected, naming both candidate ids",
    () => svc.spawnWorker("mgr1", { taskId: sharedPrefix, agentId: "agentDev", kickoffPrompt: "GO" }),
    "ambiguous", "id-prefix", tDupA, tDupB);
  check("(2) neither ambiguous-prefix task moved off backlog (nothing spawned)",
    db.getTask(tDupA).columnKey === "backlog" && db.getTask(tDupB).columnKey === "backlog");

  // ===================== (3) a full taskId still resolves (regression) =====================
  const wFull = await svc.spawnWorker("mgr1", { taskId: tFull, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wFull.worktreePath);
  check("(3) a full taskId still resolves (historical contract preserved)", wFull.taskId === tFull);
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
  ? "\n✅ ALL PASS — worker_spawn resolves a taskId by an unambiguous 8-char id-prefix, rejects an ambiguous prefix naming both candidates and spawning nothing, and still accepts a full taskId — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
