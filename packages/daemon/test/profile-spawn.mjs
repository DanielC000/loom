// Profile-driven spawn + M5 race test (Topics→Profiles P2). DETERMINISTIC + CLAUDE-FREE, hermetic
// like profiles.mjs / pty-busy-drain.mjs: isolated LOOM_HOME, a REAL Db + SessionService driven
// against a FAKE pty injected via PtyHost's createPty() seam — no real claude, no daemon, no network.
// A real temp git repo backs the project so spawnWorker's createWorktree (real `git worktree add`)
// works; the only thing faked is the claude pty.
//
// Proves the four P2 DoD points at the seam/DB level (the role→MCP-surface wiring itself is covered
// by the real-claude tests manager-live.mjs / orchestration-e2e.mjs; here we assert the role VALUE
// that host.ts maps to that surface + the persisted role that drives the server-side role-gate):
//   (a) a topic WITH a manager-role profile → startNew spawns role=manager (seam opts.role + DB row)
//       + the resolved prompt (topic's own, per resolveProfile's `??` override) + the profile's
//       allowDelta layered onto the config allow;
//   (b) a topic with NO profile → startNew spawns today's plain session (role null, today's prompt,
//       config allow unchanged — no allow delta);
//   (c) worker_spawn (spawnWorker) still produces a worker (explicit role wins; kickoff is the prompt);
//   (d) M5: a spawn that exits IMMEDIATELY (onExit fires during spawn) ends 'exited', never stuck 'live'.
//
// Run: 1) build (turbo builds shared first), 2) node test/profile-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME: host.ts opens a per-session log under LOGS_DIR (= $LOOM_HOME/logs) and
// createWorktree writes under $LOOM_HOME/worktrees. Set it BEFORE importing dist (paths.ts reads it
// at import time) and create logs/ so createWriteStream succeeds. ---
const tmpHome = path.join(os.tmpdir(), `loom-pspawn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig } = await import("@loom/shared");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-pspawn-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# profile-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=ps@loom -c user.name=ps commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const baseAllow = resolveConfig({}).permission.allow; // the config allow a profile-less spawn must keep

// --- seed the DB: project, a manager profile, two topics (one with the profile, one plain), a
// manager session + a todo task for worker_spawn ---
const db = new Db();
const PROFILE_ALLOW = "Bash(echo PROFILE_OK:*)";
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProfile({
  id: "profMgr", name: "Orchestrator", role: "manager",
  startupPrompt: "PROFILE_DEFAULT_PROMPT", allowDelta: [PROFILE_ALLOW], skills: null, model: null, icon: "🧭",
});
db.insertTopic({ id: "topicMgr", projectId: "pP", name: "Managed", startupPrompt: "TOPIC_MGR_PROMPT", position: 0, profileId: "profMgr" });
db.insertTopic({ id: "topicPlain", projectId: "pP", name: "Plain", startupPrompt: "TOPIC_PLAIN_PROMPT", position: 1, profileId: null });
// A profile-topic with NO per-topic prompt (the NOT NULL DEFAULT '' real-DB case) → falls back to
// the profile's default prompt at spawn.
db.insertTopic({ id: "topicMgrBlank", projectId: "pP", name: "ManagedBlank", startupPrompt: "", position: 2, profileId: "profMgr" });
db.insertSession({
  id: "mgr1", projectId: "pP", topicId: "topicPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
db.insertTask({ id: "taskW", projectId: "pP", title: "WORK", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });

// --- the fake pty + a PtyHost subclass that captures every SpawnOpts via the createPty() seam.
// `failFast` makes the NEXT spawn's pty fire onExit SYNCHRONOUSLY (during spawn()) — the M5 race. ---
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; this.failFast = false; }
  createPty(opts) {
    this.capture.push(opts);
    const failFast = this.failFast;
    return {
      pid: 4242,
      write() {},
      onData() { return { dispose() {} }; },
      onExit(cb) { if (failFast) cb({ exitCode: 1 }); return { dispose() {} }; },
      kill() {},
      resize() {},
    };
  }
}

// events sink wired to the DB exactly like index.ts (minus the MCP disposes): onExit OWNS live→exited.
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};

const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

let workerWorktree = null;
try {
  // ===================== (a) manager-PROFILE topic → role=manager + prompt + allowDelta =====================
  const sA = svc.startNew("topicMgr");
  const oA = optsFor(sA.id);
  check("(a) returned session.role === 'manager' (profile-conferred)", sA.role === "manager");
  check("(a) DB persists role=manager (drives the server-side role-gate)", db.getSession(sA.id).role === "manager");
  check("(a) spawn opts.role === 'manager' (the value host.ts maps to the loom-orchestration surface)", oA?.role === "manager");
  check("(a) spawn injects the resolved prompt (topic's own NON-EMPTY prompt overrides the profile's)", oA?.startupPrompt === "TOPIC_MGR_PROMPT");
  check("(a) profile allowDelta is layered onto the config allow", oA?.permission.allow.includes(PROFILE_ALLOW));
  check("(a) the base config allow is preserved alongside the delta", oA?.permission.allow.includes("mcp__loom-tasks"));
  check("(a) session is live", db.getSession(sA.id).processState === "live");

  // (a') a profile-topic with a BLANK per-topic prompt falls back to the PROFILE's default prompt
  // (empty-as-absent, profile-present) — proves the profile's prompt is reachable from the real DB,
  // where topics.startup_prompt is NOT NULL DEFAULT ''.
  const sAb = svc.startNew("topicMgrBlank");
  const oAb = optsFor(sAb.id);
  check("(a') blank profile-topic spawns role=manager", oAb?.role === "manager" && db.getSession(sAb.id).role === "manager");
  check("(a') blank profile-topic injects the PROFILE's default prompt", oAb?.startupPrompt === "PROFILE_DEFAULT_PROMPT");
  check("(a') blank profile-topic still layers the profile allowDelta", oAb?.permission.allow.includes(PROFILE_ALLOW));

  // ===================== (b) NO-profile topic → today's plain session, byte-identical =====================
  const sB = svc.startNew("topicPlain");
  const oB = optsFor(sB.id);
  check("(b) plain session has role null (no profile ⇒ today's plain session)", db.getSession(sB.id).role === null);
  check("(b) returned session.role is undefined (no role conferred)", sB.role === undefined);
  check("(b) spawn opts.role is undefined (plain MCP surface — no orchestration/platform)", oB?.role === undefined);
  check("(b) spawn injects the topic's own prompt (today's behavior)", oB?.startupPrompt === "TOPIC_PLAIN_PROMPT");
  check("(b) NO allow delta — permission.allow equals the config allow exactly",
    JSON.stringify(oB?.permission.allow) === JSON.stringify(baseAllow));
  check("(b) profile's allowDelta is NOT present on a profile-less spawn", !oB?.permission.allow.includes(PROFILE_ALLOW));
  check("(b) session is live", db.getSession(sB.id).processState === "live");

  // ===================== (c) worker_spawn still produces a worker (explicit role wins) =====================
  const w = await svc.spawnWorker("mgr1", { taskId: "taskW", kickoffPrompt: "WORKER_KICKOFF" });
  workerWorktree = w.worktreePath;
  const oW = optsFor(w.id);
  check("(c) worker_spawn returns role=worker", w.role === "worker");
  check("(c) DB persists role=worker", db.getSession(w.id).role === "worker");
  check("(c) spawn opts.role === 'worker' (explicit caller role, not the topic's profile)", oW?.role === "worker");
  check("(c) worker prompt is the manager's kickoff (NOT the topic/profile prompt)", oW?.startupPrompt === "WORKER_KICKOFF");
  check("(c) task moved to in_progress", db.getTask("taskW")?.columnKey === "in_progress");
  check("(c) worker is live", db.getSession(w.id).processState === "live");

  // ===================== (d) M5 — a spawn that exits immediately ends 'exited', never stuck 'live' =====================
  host.failFast = true; // the next spawn's pty fires onExit synchronously, during spawn()
  const sD = svc.startNew("topicPlain");
  host.failFast = false;
  check("(d) M5: a fast-failing spawn ends in 'exited' (onExit wins; not clobbered back to live)",
    db.getSession(sD.id).processState === "exited");
} finally {
  try { if (workerWorktree) { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(repo, workerWorktree); } } catch { /* best-effort */ }
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — profile-driven spawn (role+prompt+allowDelta) wires through startNew, explicit roles still win, no-profile is byte-identical, and M5 (onExit wins) holds — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
