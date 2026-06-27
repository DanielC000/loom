import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card af902717 — a manager-spawned worker must receive its agent BASE BRIEF (agent.startupPrompt)
// composed ahead of the dynamic part, on BOTH paths (spawn kickoff + recycle handoff). Before this,
// `composeWorkerStartupPrompt` didn't exist and workers only ever got the dynamic text — so the
// Dev/Bugfix/Web-Designer briefs ("Step 0: run `/worker`", "CLAUDE.md is law") were dead config.
//
// DETERMINISTIC + CLAUDE-FREE, hermetic like manager-context-block.mjs: isolated LOOM_HOME, a REAL Db +
// SessionService driven against a FAKE pty injected via PtyHost's createPty() seam — no real claude, no
// daemon, no network. A real temp git repo backs the project so spawnWorker/recycleWorker's worktree git
// is real. The fake pty fires its onExit on kill() so recycleWorker's hard-stop wait resolves instantly.
//
// Proves the DoD:
//   (1) pure composeWorkerStartupPrompt: brief leads, dynamic follows; empty/whitespace/undefined ⇒ dynamic-only.
//   (2) SPAWN: a brief-bearing worker's opts.startupPrompt = brief THEN kickoff; an empty-brief worker = kickoff alone.
//   (3) RECYCLE: a brief-bearing worker's successor opts.startupPrompt = brief THEN handoff; empty-brief = handoff alone.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-prompt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-wprompt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { composeWorkerStartupPrompt } = await import("../dist/sessions/worker-prompt.js");
const { removeWorktree } = await import("../dist/git/worktrees.js");

// --- a real temp git repo so worktree git (real) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wprompt-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-prompt test\n");
execSync(`git init -q && git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pW", name: "WProj", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pW", name: "Orchestrator", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pW", name: "Dev", startupPrompt: "DEV_BRIEF", position: 1, profileId: null });
db.insertAgent({ id: "agentQA", projectId: "pW", name: "QA", startupPrompt: "", position: 2, profileId: null }); // empty brief (like the shipped QA agent)
db.insertSession({
  id: "mgr1", projectId: "pW", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
const taskA = "11111111-1111-1111-8111-111111111111";
const taskB = "22222222-2222-2222-8222-222222222222";
db.insertTask({ id: taskA, projectId: "pW", title: "A", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
db.insertTask({ id: taskB, projectId: "pW", title: "B", body: "", columnKey: "todo", position: 2, createdAt: now, updatedAt: now });

// --- fake pty: captures every SpawnOpts, and fires onExit on kill() so recycleWorker's hard-stop wait resolves fast ---
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    let exitCb = null;
    return {
      pid: 4242, write() {}, resize() {},
      onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) exitCb({ exitCode: 0 }); },
    };
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
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);
const order = (s, a, b) => s.includes(a) && s.includes(b) && s.indexOf(a) < s.indexOf(b);

const worktrees = [];
try {
  // ===================== (1) pure composeWorkerStartupPrompt =====================
  const composed = composeWorkerStartupPrompt("BRIEF", "DYNAMIC");
  check("(1) pure: brief leads, dynamic follows", order(composed, "BRIEF", "DYNAMIC"));
  check("(1) pure: undefined brief ⇒ dynamic-only", composeWorkerStartupPrompt(undefined, "DYNAMIC") === "DYNAMIC");
  check("(1) pure: whitespace brief ⇒ dynamic-only (trimmed away)", composeWorkerStartupPrompt("   \n  ", "DYNAMIC") === "DYNAMIC");
  check("(1) pure: empty brief ⇒ dynamic-only", composeWorkerStartupPrompt("", "DYNAMIC") === "DYNAMIC");
  // 2-arg form (no cwd) stays byte-identical — backward-compat for the pure callers/tests.
  check("(1) pure: 2-arg form (no cwd) is byte-unchanged — no location block", composeWorkerStartupPrompt("BRIEF", "DYNAMIC") === "BRIEF\n\n---\n\nDYNAMIC");
  // 3-arg form prepends the worktree location block ahead of the brief, naming the cwd as the edit dir.
  const composedCwd = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path");
  check("(1) pure: cwd ⇒ worktree block leads, then brief, then dynamic", order(composedCwd, "/wt/path", "BRIEF") && order(composedCwd, "BRIEF", "DYNAMIC"));
  check("(1) pure: cwd ⇒ block names the worktree as the edit dir", composedCwd.includes("make ALL edits here") && composedCwd.includes("`/wt/path`"));
  // Block is present even with an EMPTY brief (the QA startupPrompt:"" case) — block then dynamic.
  const composedEmptyCwd = composeWorkerStartupPrompt("", "DYNAMIC", "/wt/path");
  check("(1) pure: empty brief + cwd ⇒ block still present, leads the dynamic part", composedEmptyCwd.includes("`/wt/path`") && order(composedEmptyCwd, "/wt/path", "DYNAMIC"));

  // ===================== (2) SPAWN composes the worktree block + brief ahead of the kickoff =====================
  const wA = await svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "KICKOFF_A" });
  worktrees.push(wA.worktreePath);
  const oWA = optsFor(wA.id);
  check("(2) spawn (brief): startupPrompt carries the agent brief THEN the kickoff", order(oWA?.startupPrompt ?? "", "DEV_BRIEF", "KICKOFF_A"));
  check("(2) spawn (brief): startupPrompt names the worktree cwd as the edit dir, ahead of the brief", (oWA?.startupPrompt ?? "").includes(wA.worktreePath) && (oWA?.startupPrompt ?? "").includes("make ALL edits here") && order(oWA?.startupPrompt ?? "", wA.worktreePath, "DEV_BRIEF"));

  const wQ = await svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentQA", kickoffPrompt: "KICKOFF_B" });
  worktrees.push(wQ.worktreePath);
  const oWQ = optsFor(wQ.id);
  check("(2) spawn (empty brief): startupPrompt is the worktree block THEN the kickoff (block present even with empty brief)", (oWQ?.startupPrompt ?? "").includes(wQ.worktreePath) && (oWQ?.startupPrompt ?? "").includes("KICKOFF_B") && order(oWQ?.startupPrompt ?? "", wQ.worktreePath, "KICKOFF_B"));

  // ===================== (3) RECYCLE composes the worktree block + brief ahead of the handoff =====================
  const rA = await svc.recycleWorker("mgr1", wA.id, "HANDOFF_A");
  const oRA = optsFor(rA.id);
  check("(3) recycle (brief): successor startupPrompt carries the agent brief THEN the handoff", order(oRA?.startupPrompt ?? "", "DEV_BRIEF", "HANDOFF_A"));
  check("(3) recycle (brief): the handoff frame is preserved after the brief", (oRA?.startupPrompt ?? "").includes("[loom:handoff]"));
  check("(3) recycle (brief): successor startupPrompt names the SAME worktree cwd as the edit dir, ahead of the brief", (oRA?.startupPrompt ?? "").includes(rA.worktreePath) && (oRA?.startupPrompt ?? "").includes("make ALL edits here") && order(oRA?.startupPrompt ?? "", rA.worktreePath, "DEV_BRIEF"));

  const rQ = await svc.recycleWorker("mgr1", wQ.id, "HANDOFF_B");
  const oRQ = optsFor(rQ.id);
  check("(3) recycle (empty brief): successor startupPrompt is the worktree block THEN the handoff (block present, no brief prefix)", (oRQ?.startupPrompt ?? "").includes(rQ.worktreePath) && (oRQ?.startupPrompt ?? "").includes("[loom:handoff]") && (oRQ?.startupPrompt ?? "").includes("HANDOFF_B") && order(oRQ?.startupPrompt ?? "", rQ.worktreePath, "[loom:handoff]"));
} finally {
  for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — workers receive their agent base brief composed ahead of the dynamic part on BOTH spawn and recycle; an empty brief degrades to the dynamic part alone — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
