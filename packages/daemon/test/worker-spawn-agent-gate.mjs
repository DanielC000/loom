import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn agent-binding gate (bugfix 0b6e3a76). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like profile-spawn.mjs / browser-testing-spawn.mjs: isolated LOOM_HOME + a sandboxed HOME,
// a REAL Db + SessionService driven against a FAKE pty (PtyHost createPty() seam). A real temp git repo
// backs spawnWorker's createWorktree; the only thing faked is the claude pty.
//
// The bug: spawnWorker did `agentId: opts.agentId ?? manager.agentId` — an omitted agentId silently
// bound the worker to the MANAGER's own agent (wrong association + inherited the manager agent's
// browserTesting). The fix kills the fallback and gates the nominated agent's profile role.
//
// Proves the four DoD points:
//   (a) a worker-agent spawn SUCCEEDS, binds to the nominated agent (NOT the manager's), role=worker;
//   (b) a manager-role-profile agent spawn is REJECTED with a clear message (platform-role too);
//   (c) an ABSENT agentId is REJECTED (no silent self-bind to the manager's agent);
//   (d) browserTesting resolves from the NOMINATED worker agent (QA profile ⇒ true; Dev/plain ⇒ false),
//       and is NOT inherited from the manager's (browser-capable) agent.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-agent-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// assert that an async call rejects, and that its message includes `needle`.
const rejects = async (label, fn, needle) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && (!needle || String(threw.message).includes(needle));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

// --- Hermetic LOOM_HOME + a sandboxed HOME (so any transcript check never touches the real ~/.claude).
// Set BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-wsag-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-wsag-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-agent-gate test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// Profiles: a manager rig, a platform rig, a browser-capable QA worker rig, a plain worker rig.
db.insertProfile({ id: "profMgr", name: "Orchestrator", role: "manager", description: "mgr rig", allowDelta: [], skills: null, model: null, icon: "🧭", browserTesting: true });
db.insertProfile({ id: "profPlat", name: "Platform", role: "platform", description: "plat rig", allowDelta: [], skills: null, model: null, icon: "🛠" });
db.insertProfile({ id: "profQA", name: "QA Tester", role: "worker", description: "qa rig", allowDelta: [], skills: null, model: null, icon: "🧪", browserTesting: true });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
// Agents: the manager runs on a manager-PROFILE agent that ALSO opts into browserTesting (the worst case
// the bug produced — a worker silently inheriting the manager agent's browser). Plus worker agents.
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Orchestrator", startupPrompt: "MGR_PROMPT", position: 0, profileId: "profMgr" });
db.insertAgent({ id: "agentPlat", projectId: "pP", name: "Platform", startupPrompt: "PLAT_PROMPT", position: 1, profileId: "profPlat" });
db.insertAgent({ id: "agentQA", projectId: "pP", name: "QA", startupPrompt: "QA_PROMPT", position: 2, profileId: "profQA" });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 3, profileId: "profDev" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 4, profileId: null });
// The live manager session is BOUND to the manager-profile agent (the real-world setup that triggered
// the bug: an Orchestrator-agent manager spawning workers).
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

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
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

const worktrees = [];
try {
  // ===================== (c) ABSENT agentId is REJECTED (no silent self-bind) =====================
  await rejects("(c) absent agentId rejected (no silent self-bind to the manager's agent)",
    () => svc.spawnWorker("mgr1", { taskId: "tC", kickoffPrompt: "GO" }), "explicit worker agentId");
  // a non-existent agentId is rejected too (not silently swallowed).
  await rejects("(c') unknown agentId rejected",
    () => svc.spawnWorker("mgr1", { taskId: "tC2", agentId: "nope", kickoffPrompt: "GO" }), "does not resolve");

  // ===================== (b) manager / platform-role agent spawn is REJECTED =====================
  await rejects("(b) spawning under a manager-role agent is rejected (names the agent + role)",
    () => svc.spawnWorker("mgr1", { taskId: "tB", agentId: "agentMgr", kickoffPrompt: "GO" }), "Orchestrator");
  await rejects("(b') spawning under a platform-role agent is rejected",
    () => svc.spawnWorker("mgr1", { taskId: "tB2", agentId: "agentPlat", kickoffPrompt: "GO" }), "platform-role");

  // ===================== (a) a worker-agent spawn SUCCEEDS, binds to the nominated agent =====================
  const wDev = await svc.spawnWorker("mgr1", { taskId: "tA", agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wDev.worktreePath);
  check("(a) Dev-agent spawn succeeds, role=worker", wDev.role === "worker");
  check("(a) worker BINDS to the nominated Dev agent (NOT the manager's agentMgr)", wDev.agentId === "agentDev");
  check("(a) DB row persists agent_id = the nominated worker agent", db.getSession(wDev.id).agentId === "agentDev");
  check("(a) DB row persists role=worker", db.getSession(wDev.id).role === "worker");

  // a profile-LESS (plain) worker agent is allowed too (role null ⇒ not manager/platform).
  const wPlain = await svc.spawnWorker("mgr1", { taskId: "tA2", agentId: "agentPlain", kickoffPrompt: "GO" });
  worktrees.push(wPlain.worktreePath);
  check("(a') plain (no-profile) worker agent spawn succeeds", wPlain.role === "worker" && wPlain.agentId === "agentPlain");

  // ===================== (d) browserTesting resolves from the NOMINATED worker agent =====================
  // The manager agent (agentMgr) HAS browserTesting=true; the bug would have leaked it onto every worker.
  // Now: a Dev/plain worker agent ⇒ false; the QA worker agent ⇒ true — strictly from the nominated agent.
  check("(d) Dev-agent worker does NOT inherit the manager agent's browserTesting (false)",
    optsFor(wDev.id)?.browserTesting === false && db.getSession(wDev.id).browserTesting === false);
  check("(d) plain-agent worker browserTesting=false", db.getSession(wPlain.id).browserTesting === false);
  const wQA = await svc.spawnWorker("mgr1", { taskId: "tD", agentId: "agentQA", kickoffPrompt: "GO" });
  worktrees.push(wQA.worktreePath);
  check("(d) QA-agent worker resolves browserTesting=true from its OWN profile",
    optsFor(wQA.id)?.browserTesting === true && db.getSession(wQA.id).browserTesting === true);
  check("(d) QA worker binds to the QA agent, role still worker (browser is orthogonal)",
    wQA.agentId === "agentQA" && optsFor(wQA.id)?.role === "worker");
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
  ? "\n✅ ALL PASS — worker_spawn requires an explicit worker agentId (no silent ?? manager.agentId self-bind), rejects manager/platform-role agents, binds the worker to the nominated agent, and resolves browserTesting from THAT agent (never inherited from the manager's) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
