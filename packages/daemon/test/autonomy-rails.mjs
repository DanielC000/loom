// Orchestration safety-rails test (PR #17a): the pause/kill switch + maxConcurrentWorkers cap that
// bound the loop before it can run unattended. Three scenarios against ONE isolated daemon:
//   • PAUSE  — deterministic, NO claude: pause (global) → worker_spawn refused → resume → status clear.
//   • CAP    — deterministic, NO claude: 2 LIVE workers + cap=2 → worker_spawn refused before any spawn.
//   • KILL   — ONE real worker: spawn → /kill hard-stops it (→ exited) + latches the global pause.
// SURGICAL (unique ids, no DELETE-all) + self-cleaning. PAUSE/CAP never reach createWorktree (the
// gate throws first), so only KILL touches disk/claude (real repo + worktree + a ~/.claude.json
// trust entry, cleaned in teardown — orch-spawn's pattern).
//
// RUN against an ISOLATED LOOM_HOME daemon (KILL spawns real claude + a real worktree):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/autonomy-rails.mjs        (SAME LOOM_HOME)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { removeWorktree } from "../dist/git/worktrees.js";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv({ port: true }); // prod-guard: abort unless LOOM_HOME=<temp> + LOOM_PORT != 4317
const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (res) => JSON.parse(res.content[0].text);
const now = new Date().toISOString();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function connect(sessionId) {
  const client = new Client({ name: "autonomy-rails-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/${sessionId}`)));
  return client;
}

// --- unique ids per scenario ---
const sfx = Date.now();
const P = { proj: `ar-pause-proj-${sfx}`, agent: `ar-pause-agent-${sfx}`, task: `ar-pause-task-${sfx}`, mgr: `ar-pause-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-ar-pause-${sfx}`) };
const C = { proj: `ar-cap-proj-${sfx}`, agent: `ar-cap-agent-${sfx}`, task: `ar-cap-task-${sfx}`, mgr: `ar-cap-mgr-${sfx}`, w1: `ar-cap-w1-${sfx}`, w2: `ar-cap-w2-${sfx}`, repo: path.join(os.tmpdir(), `loom-ar-cap-${sfx}`) };
const K = { proj: `ar-kill-proj-${sfx}`, agent: `ar-kill-agent-${sfx}`, task: `ar-kill-task-${sfx}`, mgr: `ar-kill-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-ar-kill-${sfx}`) };

// KILL needs a real git repo (it reaches createWorktree); PAUSE/CAP only need the project row.
fs.mkdirSync(K.repo, { recursive: true });
fs.writeFileSync(path.join(K.repo, "README.md"), "# autonomy-rails kill\n");
execSync(`git init -q && git add . && git -c user.email=ar@loom -c user.name=ar commit -q -m init`, { cwd: K.repo });

// --- seed the daemon's (isolated) DB directly ---
{
  const d = new Database(DB_FILE);
  const seedProject = (id, repo, config) =>
    d.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)").run(id, "AR", repo, repo, config, now);
  const seedAgent = (id, proj) =>
    d.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run(id, proj, "t", "");
  const seedTask = (id, proj) =>
    d.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','todo',?,?,?)").run(id, proj, "T", 1, now, now);
  const seedManager = (id, proj, agent, repo) =>
    d.prepare(`INSERT INTO sessions (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role)
      VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'manager')`).run(id, proj, agent, repo, now, now);
  const seedLiveWorker = (id, proj, agent, mgr, repo) =>
    d.prepare(`INSERT INTO sessions (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role,parent_session_id,task_id,worktree_path,branch)
      VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'worker',?,NULL,?,?)`).run(id, proj, agent, repo, now, now, mgr, repo, "loom/seeded");

  // PAUSE: default project config (cap=3); one manager.
  seedProject(P.proj, P.repo, "{}");
  seedAgent(P.agent, P.proj); seedTask(P.task, P.proj); seedManager(P.mgr, P.proj, P.agent, P.repo);
  // CAP: project config caps at 2; manager + exactly 2 LIVE workers under it → at the cap.
  seedProject(C.proj, C.repo, JSON.stringify({ orchestration: { maxConcurrentWorkers: 2 } }));
  seedAgent(C.agent, C.proj); seedTask(C.task, C.proj); seedManager(C.mgr, C.proj, C.agent, C.repo);
  seedLiveWorker(C.w1, C.proj, C.agent, C.mgr, C.repo); seedLiveWorker(C.w2, C.proj, C.agent, C.mgr, C.repo);
  // KILL: default config; one manager; spawns a real worker live.
  seedProject(K.proj, K.repo, "{}");
  seedAgent(K.agent, K.proj); seedTask(K.task, K.proj); seedManager(K.mgr, K.proj, K.agent, K.repo);
  d.close();
}

// KILL's worktree path is deterministic; record whether the real ~/.claude.json already trusts it.
const killWorktreeExpected = path.join(LOOM, "worktrees", K.proj, K.task.slice(0, 8));
const trustKey = path.resolve(killWorktreeExpected).replace(/\\/g, "/");
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();

let spawned = null;
try {
  // === PAUSE (deterministic) — pause refuses worker_spawn; resume lifts it ===
  await post("/api/orchestration/pause", {}); // scope defaults to "global"
  const MP = await connect(P.mgr);
  const pRes = parse(await MP.callTool({ name: "worker_spawn", arguments: { taskId: P.task, kickoffPrompt: "noop — must be refused before any spawn" } }));
  check("PAUSE: worker_spawn refused while paused — ok({error}) ~ /paus/i", typeof pRes.error === "string" && /paus/i.test(pRes.error));
  await MP.close();
  await post("/api/orchestration/resume", {}); // scope defaults to "global"
  const status1 = await get("/api/orchestration/status");
  check("PAUSE: resume cleared the gate (GET /status → no paused scopes)", Array.isArray(status1.pausedScopes) && status1.pausedScopes.length === 0);

  // === CAP (deterministic) — at the cap, worker_spawn is refused before any real spawn ===
  const MC = await connect(C.mgr);
  const cRes = parse(await MC.callTool({ name: "worker_spawn", arguments: { taskId: C.task, kickoffPrompt: "noop — must be refused at the cap" } }));
  check("CAP: worker_spawn refused at cap — ok({error}) ~ /cap|concurren/i", typeof cRes.error === "string" && /cap|concurren/i.test(cRes.error));
  check("CAP: refusal mentions the cap value (2)", /\b2\b/.test(cRes.error ?? ""));
  await MC.close();

  // === KILL (one real worker) — spawn → /kill hard-stops it and latches the global pause ===
  const MK = await connect(K.mgr);
  spawned = parse(await MK.callTool({
    name: "worker_spawn",
    arguments: { taskId: K.task, kickoffPrompt: "Respond with exactly the word READY and nothing else, then stop. Use no tools." },
  }));
  check("KILL: real worker spawned (under cap, not paused)", !!spawned.workerSessionId && !!spawned.worktreePath);
  let w = null;
  for (let i = 0; i < 20 && !(w && w.processState === "live"); i++) {
    await sleep(400);
    w = (await get("/api/sessions")).find((s) => s.id === spawned.workerSessionId);
  }
  check("KILL: worker reached processState 'live'", !!w && w.processState === "live");

  // /kill hard-stops every live worker (the real one + the CAP phantom rows, which have no pty so
  // their stop is a no-op) → the count may exceed 1; the DoD is "stopped >= 1".
  const killRes = await (await post("/api/orchestration/kill")).json();
  check("KILL: POST /kill → { stopped } >= 1", typeof killRes.stopped === "number" && killRes.stopped >= 1);

  let exited = false;
  for (let i = 0; i < 30 && !exited; i++) {
    await sleep(1000);
    exited = (await get("/api/sessions")).find((s) => s.id === spawned.workerSessionId)?.processState === "exited";
  }
  check("KILL: the real worker reached processState 'exited'", exited);

  const status2 = await get("/api/orchestration/status");
  check("KILL: global pause latched after kill (GET /status includes 'global')", status2.pausedScopes.includes("global"));
  await MK.close();
} finally {
  // Surgical teardown.
  try { if (spawned?.workerSessionId) await post(`/api/sessions/${spawned.workerSessionId}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  await sleep(1500);
  try { await removeWorktree(K.repo, spawned?.worktreePath ?? killWorktreeExpected); } catch { /* ignore */ }
  if (!realHadKeyBefore) {
    try {
      const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
      if (cfg.projects && trustKey in cfg.projects) { delete cfg.projects[trustKey]; writeJsonAtomic(realClaudeJson, cfg); }
    } catch { /* nothing to clean */ }
  }
  try {
    const d = new Database(DB_FILE);
    for (const mgr of [P.mgr, C.mgr, K.mgr]) {
      d.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(mgr, mgr);
      d.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(mgr);
    }
    for (const proj of [P.proj, C.proj, K.proj]) {
      d.prepare("DELETE FROM tasks WHERE project_id = ?").run(proj);
      d.prepare("DELETE FROM agents WHERE project_id = ?").run(proj);
      d.prepare("DELETE FROM projects WHERE id = ?").run(proj);
    }
    d.close();
  } catch { /* ignore */ }
  for (const r of [P.repo, C.repo, K.repo]) fs.rmSync(r, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — safety rails: pause refuses spawn (resume lifts it), the cap refuses at the limit, /kill hard-stops live workers + latches the global pause."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
