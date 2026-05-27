// worker_spawn / worker_stop test (PR #13b). Live daemon + REAL claude; an MCP client plays the
// manager and drives the lifecycle tools. SURGICAL (unique ids, no DELETE-all) and self-cleaning.
//
// RUN against an ISOLATED LOOM_HOME daemon (this spawns real claude AND creates real worktrees):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/orch-spawn.mjs        (SAME LOOM_HOME — it seeds that loom.db)
//
// Note: LOOM_HOME only relocates ~/.loom (db, worktrees); claude still uses the real ~/.claude.json,
// so the spawn adds a trust entry for the WORKTREE path — removed in teardown (busy-flag's pattern).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { removeWorktree } from "../dist/git/worktrees.js";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";

const BASE = "http://127.0.0.1:4317";
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (res) => JSON.parse(res.content[0].text);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- unique ids + a real temp git repo bound to the seeded project ---
const sfx = Date.now();
const projId = `osp-proj-${sfx}`, topicId = `osp-topic-${sfx}`, taskId = `osp-task-${sfx}`, mgrId = `osp-mgr-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-osp-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# orch-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=osp@loom -c user.name=osp commit -q -m "init"`, { cwd: repo });
const now = new Date().toISOString();

// --- seed the daemon's (isolated) DB directly: project, topic, task(todo), manager session ---
{
  const db = new Database(DB_FILE);
  db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(projId, "OrchSpawn", repo, repo, "{}", now);
  db.prepare("INSERT INTO topics (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)")
    .run(topicId, projId, "work", "");
  db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','todo',?,?,?)")
    .run(taskId, projId, "WORKER-TASK", 1, now, now);
  db.prepare(`INSERT INTO sessions (id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role)
    VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'manager')`).run(mgrId, projId, topicId, repo, now, now);
  db.close();
}

// The worktree path is deterministic; record whether the real ~/.claude.json already trusts it.
const worktreePathExpected = path.join(LOOM, "worktrees", projId, taskId.slice(0, 8));
const trustKey = path.resolve(worktreePathExpected).replace(/\\/g, "/");
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();

async function connect(sessionId) {
  const client = new Client({ name: "orch-spawn-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/${sessionId}`)));
  return client;
}

let spawned = null;
try {
  const M = await connect(mgrId);

  // worker_spawn → creates worktree, spawns a real worker, moves the task.
  spawned = parse(await M.callTool({
    name: "worker_spawn",
    arguments: { taskId, kickoffPrompt: "Respond with exactly the word READY and nothing else, then stop. Use no tools." },
  }));
  check("worker_spawn returns workerSessionId + branch + worktreePath",
    !!spawned.workerSessionId && !!spawned.branch && !!spawned.worktreePath);
  check("worktree exists on disk", fs.existsSync(spawned.worktreePath));

  // GET /api/sessions shows the worker live, with role/parent/branch.
  let w = null;
  for (let i = 0; i < 20 && !(w && w.processState === "live"); i++) {
    await sleep(400);
    w = (await get("/api/sessions")).find((s) => s.id === spawned.workerSessionId);
  }
  check("worker is live with role=worker, parent=manager, branch set",
    !!w && w.processState === "live" && w.role === "worker" && w.parentSessionId === mgrId && w.branch === spawned.branch);

  // task moved to in_progress.
  const board = await get(`/api/projects/${projId}/board`);
  check("task moved to in_progress", board.tasks.find((t) => t.id === taskId)?.columnKey === "in_progress");

  // worker_list includes the worker.
  const list = parse(await M.callTool({ name: "worker_list", arguments: {} }));
  check("worker_list on the manager includes the worker", list.some((x) => x.workerSessionId === spawned.workerSessionId));

  // Confirm the worker actually came alive and ran its kickoff turn (engine id captured,
  // then busy=false on the Stop hook) — proof the spawn produced a working session.
  let idle = null;
  for (let i = 0; i < 90 && !idle; i++) {
    await sleep(1000);
    const s = (await get("/api/sessions")).find((x) => x.id === spawned.workerSessionId);
    if (s?.engineSessionId && s.busy === false) idle = s;
  }
  check("worker booted and ran its kickoff turn (engine id captured, then idle)", !!idle);

  // worker_stop with mode 'hard' (pty.kill) → DETERMINISTIC exit (~0.5s). Graceful (Ctrl-C ×2)
  // does NOT reliably exit an idle v2.1.150 worker; the graceful→bounded-wait→hard escalation
  // is tracked separately (lands before #15's recycle relies on a clean graceful close).
  const stopRes = parse(await M.callTool({ name: "worker_stop", arguments: { workerSessionId: spawned.workerSessionId, mode: "hard" } }));
  check("worker_stop returns { stopped: true }", stopRes.stopped === true);
  let exited = false;
  for (let i = 0; i < 30 && !exited; i++) {
    await sleep(1000);
    exited = (await get("/api/sessions")).find((s) => s.id === spawned.workerSessionId)?.processState === "exited";
  }
  check("worker_stop(hard) stops the worker (processState → exited)", exited);

  await M.close();
} finally {
  // Surgical teardown.
  try { if (spawned?.workerSessionId) await post(`/api/sessions/${spawned.workerSessionId}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  await sleep(1500);
  try { await removeWorktree(repo, spawned?.worktreePath ?? worktreePathExpected); } catch { /* ignore */ }
  if (!realHadKeyBefore) {
    try {
      const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
      if (cfg.projects && trustKey in cfg.projects) { delete cfg.projects[trustKey]; writeJsonAtomic(realClaudeJson, cfg); }
    } catch { /* nothing to clean */ }
  }
  try {
    const db = new Database(DB_FILE);
    db.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(mgrId, mgrId);
    db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(mgrId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    db.prepare("DELETE FROM topics WHERE id = ?").run(topicId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projId);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_spawn creates an isolated worker + moves the task; worker_stop stops it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
