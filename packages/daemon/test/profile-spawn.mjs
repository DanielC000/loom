import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Profile-driven spawn + M5 race test (Agents→Profiles P2). DETERMINISTIC + CLAUDE-FREE, hermetic
// like profiles.mjs / pty-busy-drain.mjs: isolated LOOM_HOME, a REAL Db + SessionService driven
// against a FAKE pty injected via PtyHost's createPty() seam — no real claude, no daemon, no network.
// A real temp git repo backs the project so spawnWorker's createWorktree (real `git worktree add`)
// works; the only thing faked is the claude pty.
//
// Proves the four P2 DoD points at the seam/DB level (the role→MCP-surface wiring itself is covered
// by the real-claude tests manager-live.mjs / orchestration-e2e.mjs; here we assert the role VALUE
// that host.ts maps to that surface + the persisted role that drives the server-side role-gate):
//   (a) an agent WITH a manager-role profile → startNew spawns role=manager (seam opts.role + DB row)
//       + the agent's OWN prompt (the profile carries no prompt) + the profile's allowDelta layered
//       onto the config allow;
//   (b) an agent with NO profile → startNew spawns today's plain session (role null, today's prompt,
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

// --- seed the DB: project, a manager profile, two agents (one with the profile, one plain), a
// manager session + a todo task for worker_spawn ---
const db = new Db();
const PROFILE_ALLOW = "Bash(echo PROFILE_OK:*)";
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProfile({
  id: "profMgr", name: "Orchestrator", role: "manager",
  description: "rig blurb (UI only; never injected)", allowDelta: [PROFILE_ALLOW], skills: null, model: null, icon: "🧭",
});
// A profile that PINS a model (Phase-3 model wiring) — drives `--model` at spawn via opts.model.
const PINNED_MODEL = "claude-opus-4-8";
db.insertProfile({
  id: "profModel", name: "Modelled", role: null,
  description: "pins a model", allowDelta: [], skills: null, model: PINNED_MODEL, icon: null,
});
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Managed", startupPrompt: "AGENT_MGR_PROMPT", position: 0, profileId: "profMgr" });
db.insertAgent({ id: "agentModel", projectId: "pP", name: "Modelled", startupPrompt: "AGENT_MODEL_PROMPT", position: 3, profileId: "profModel" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "AGENT_PLAIN_PROMPT", position: 1, profileId: null });
// A profile-agent with NO per-agent prompt (the NOT NULL DEFAULT '' real-DB case) → an EMPTY injected
// prompt at spawn: the profile carries no prompt, so there is no fallback (a blank prompt = inert).
db.insertAgent({ id: "agentMgrBlank", projectId: "pP", name: "ManagedBlank", startupPrompt: "", position: 2, profileId: "profMgr" });
db.insertSession({
  id: "mgr1", projectId: "pP", agentId: "agentPlain", engineSessionId: null, title: null,
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
  // ===================== (a) manager-PROFILE agent → role=manager + prompt + allowDelta =====================
  const sA = svc.startNew("agentMgr");
  const oA = optsFor(sA.id);
  check("(a) returned session.role === 'manager' (profile-conferred)", sA.role === "manager");
  check("(a) DB persists role=manager (drives the server-side role-gate)", db.getSession(sA.id).role === "manager");
  check("(a) spawn opts.role === 'manager' (the value host.ts maps to the loom-orchestration surface)", oA?.role === "manager");
  check("(a) spawn injects the agent's OWN prompt (the profile carries no prompt)", oA?.startupPrompt === "AGENT_MGR_PROMPT");
  check("(a) profile allowDelta is layered onto the config allow", oA?.permission.allow.includes(PROFILE_ALLOW));
  check("(a) the base config allow is preserved alongside the delta", oA?.permission.allow.includes("mcp__loom-tasks"));
  check("(a) session is live", db.getSession(sA.id).processState === "live");
  // model-null profile → opts.model undefined (no --model; byte-identical). Regression-guards the default.
  check("(a) a model-NULL profile threads opts.model === undefined (no --model emitted)", oA?.model === undefined);

  // ===================== (a'') model-PINNED profile → opts.model is the pinned id (Phase-3) =====================
  const sM = svc.startNew("agentModel");
  const oM = optsFor(sM.id);
  check("(a'') model-pinned profile threads opts.model === the pinned id (drives --model at spawn)", oM?.model === PINNED_MODEL);
  check("(a'') model-pinned profile still injects the agent's OWN prompt", oM?.startupPrompt === "AGENT_MODEL_PROMPT");

  // (a') a profile-agent with a BLANK per-agent prompt injects NO prompt — the profile carries none,
  // so there is no fallback (the merge branch was removed). It still gets the profile's role + allow.
  const sAb = svc.startNew("agentMgrBlank");
  const oAb = optsFor(sAb.id);
  check("(a') blank profile-agent spawns role=manager", oAb?.role === "manager" && db.getSession(sAb.id).role === "manager");
  check("(a') blank profile-agent injects NO prompt (no fallback to the profile)", oAb?.startupPrompt === undefined);
  check("(a') blank profile-agent still layers the profile allowDelta", oAb?.permission.allow.includes(PROFILE_ALLOW));

  // ===================== (b) NO-profile agent → today's plain session, byte-identical =====================
  const sB = svc.startNew("agentPlain");
  const oB = optsFor(sB.id);
  check("(b) plain session has role null (no profile ⇒ today's plain session)", db.getSession(sB.id).role === null);
  check("(b) returned session.role is undefined (no role conferred)", sB.role === undefined);
  check("(b) spawn opts.role is undefined (plain MCP surface — no orchestration/platform)", oB?.role === undefined);
  check("(b) spawn injects the agent's own prompt (today's behavior)", oB?.startupPrompt === "AGENT_PLAIN_PROMPT");
  check("(b) NO allow delta — permission.allow equals the config allow exactly",
    JSON.stringify(oB?.permission.allow) === JSON.stringify(baseAllow));
  check("(b) profile's allowDelta is NOT present on a profile-less spawn", !oB?.permission.allow.includes(PROFILE_ALLOW));
  check("(b) NO model on a profile-less spawn — opts.model undefined (no --model, byte-identical)", oB?.model === undefined);
  check("(b) session is live", db.getSession(sB.id).processState === "live");

  // ===================== (c) worker_spawn still produces a worker (explicit role wins) =====================
  // agentId is now REQUIRED (no silent ?? manager.agentId fallback) — nominate the plain worker agent.
  const w = await svc.spawnWorker("mgr1", { taskId: "taskW", agentId: "agentPlain", kickoffPrompt: "WORKER_KICKOFF" });
  workerWorktree = w.worktreePath;
  const oW = optsFor(w.id);
  check("(c) worker_spawn returns role=worker", w.role === "worker");
  check("(c) DB persists role=worker", db.getSession(w.id).role === "worker");
  check("(c) spawn opts.role === 'worker' (explicit caller role, not the agent's profile)", oW?.role === "worker");
  check("(c) worker prompt is the manager's kickoff (NOT the agent/profile prompt)", oW?.startupPrompt === "WORKER_KICKOFF");
  check("(c) task moved to in_progress", db.getTask("taskW")?.columnKey === "in_progress");
  check("(c) worker is live", db.getSession(w.id).processState === "live");

  // ===================== (d) M5 — a spawn that exits immediately ends 'exited', never stuck 'live' =====================
  host.failFast = true; // the next spawn's pty fires onExit synchronously, during spawn()
  const sD = svc.startNew("agentPlain");
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
