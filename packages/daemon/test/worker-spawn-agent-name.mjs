import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn agentId-by-NAME/SLUG + nearest-match suggestion (PL Auditor finding #10, card 03615ee0).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-agent-gate.mjs: isolated LOOM_HOME +
// a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty (PtyHost createPty() seam). A real
// temp git repo backs spawnWorker's createWorktree; the only thing faked is the claude pty.
//
// The UX gap: a raw 36-char agent UUID is hand-copied into ~14 spawns/session; one-char typos only surface at
// spawn time. The fix lets worker_spawn's agentId be EITHER the id OR a stable NAME/SLUG (resolved server-side
// within the manager's project), and on a bad value appends a deterministic "did you mean '<X>'?" hint.
//
// Proves:
//   (1) a valid agent NAME resolves to the right agent and SPAWNS it (role=worker, bound to that agent);
//   (2) a SLUG (lowercased, non-alnum→hyphen) of the name resolves to the same agent;
//   (3) a real agent id still resolves (regression — the historical contract is preserved);
//   (4) an unknown agentId/name is REJECTED with "does not resolve" AND a "did you mean '<nearest>'?" hint;
//   (5) a NAME collision resolves DETERMINISTICALLY to the LOWEST-position agent (never a random pick).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-agent-name.mjs
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
const tmpHome = path.join(os.tmpdir(), `loom-wsan-${Date.now()}-${process.pid}`);
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
const repo = path.join(os.tmpdir(), `loom-wsan-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-agent-name test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// Raise the concurrency cap so all four SUCCESS spawns (name + slug + id + collision) can be live at once —
// the cap (default 3) is orthogonal to what this test exercises (agentId resolution).
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 10 } }, createdAt: now, archivedAt: null });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
// Worker agents. "QA Tester" exercises the SLUG path (qa-tester). Two agents NAMED "Dup" at different
// positions exercise the collision rule (lowest position wins). A second project's agent guards scoping.
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 0, profileId: "profDev" });
db.insertAgent({ id: "agentQA", projectId: "pP", name: "QA Tester", startupPrompt: "QA_PROMPT", position: 1, profileId: "profDev" });
db.insertAgent({ id: "agentDupLo", projectId: "pP", name: "Dup", startupPrompt: "DUP_LO_PROMPT", position: 2, profileId: "profDev" });
db.insertAgent({ id: "agentDupHi", projectId: "pP", name: "Dup", startupPrompt: "DUP_HI_PROMPT", position: 3, profileId: "profDev" });

const db2Project = "pOther";
db.insertProject({ id: db2Project, name: "Other", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentForeign", projectId: db2Project, name: "Foreigner", startupPrompt: "X", position: 0, profileId: "profDev" });

db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentDev", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// Real, non-terminal tasks for each SUCCESS case (worker_spawn validates taskId — PL finding #1).
const tName = randomUUID(), tSlug = randomUUID(), tId = randomUUID(), tDup = randomUUID();
for (const id of [tName, tSlug, tId, tDup])
  db.insertTask({ id, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

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
  // ===================== (1) a valid agent NAME resolves + spawns the right agent =====================
  const wName = await svc.spawnWorker("mgr1", { taskId: tName, agentId: "Dev", kickoffPrompt: "GO" });
  worktrees.push(wName.worktreePath);
  check("(1) name 'Dev' resolves to agentDev, role=worker", wName.agentId === "agentDev" && wName.role === "worker");
  check("(1) DB row persists agent_id = agentDev", db.getSession(wName.id).agentId === "agentDev");

  // ===================== (2) a SLUG of the name resolves to the same agent =====================
  const wSlug = await svc.spawnWorker("mgr1", { taskId: tSlug, agentId: "qa-tester", kickoffPrompt: "GO" });
  worktrees.push(wSlug.worktreePath);
  check("(2) slug 'qa-tester' resolves to agentQA ('QA Tester')", wSlug.agentId === "agentQA" && wSlug.role === "worker");

  // ===================== (3) a real agent id still resolves (regression) =====================
  const wId = await svc.spawnWorker("mgr1", { taskId: tId, agentId: "agentQA", kickoffPrompt: "GO" });
  worktrees.push(wId.worktreePath);
  check("(3) raw id 'agentQA' still resolves (historical contract preserved)", wId.agentId === "agentQA");

  // ===================== (4) unknown agentId rejected WITH a nearest-match "did you mean" hint =====================
  // 'Dveloper' is one transposition/edit from 'Dev' — the nearest agent name.
  await rejects("(4) unknown name 'Dveloper' rejected with 'does not resolve' + 'did you mean ... Dev'",
    () => svc.spawnWorker("mgr1", { taskId: randomUUID(), agentId: "Dveloper", kickoffPrompt: "GO" }),
    "does not resolve to an existing agent", "did you mean", "'Dev'");
  // a foreign-project agent name does NOT resolve here (server-side project scoping) — and still gets a hint.
  await rejects("(4') foreign-project agent name 'Foreigner' does not resolve in this project",
    () => svc.spawnWorker("mgr1", { taskId: randomUUID(), agentId: "Foreigner", kickoffPrompt: "GO" }),
    "does not resolve to an existing agent", "did you mean");

  // ===================== (5) NAME collision resolves to the LOWEST-position agent =====================
  const wDup = await svc.spawnWorker("mgr1", { taskId: tDup, agentId: "Dup", kickoffPrompt: "GO" });
  worktrees.push(wDup.worktreePath);
  check("(5) name 'Dup' (two agents) resolves to the LOWEST-position agent (agentDupLo, position 2)",
    wDup.agentId === "agentDupLo");
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
  ? "\n✅ ALL PASS — worker_spawn resolves an agentId by NAME or SLUG within the manager's project, still accepts a raw id, rejects an unknown value with a deterministic 'did you mean' nearest-match hint, and resolves a name collision to the lowest-position agent — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
