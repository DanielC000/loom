// Busy-gated messaging test (PR #14b). Live daemon + REAL worker claude; an MCP client plays
// the manager. Proves: worker_message submits immediately when the worker is idle, QUEUES the
// next while it's mid-turn (busy-gated), and the queued one is drained + run on the next Stop
// (strict serialization). Surgical (unique ids) + self-cleaning.
//
// RUN against an ISOLATED LOOM_HOME daemon (spawns real claude + creates real worktrees):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/messaging.mjs        (SAME LOOM_HOME)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { removeWorktree } from "../dist/git/worktrees.js";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";

const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (res) => JSON.parse(res.content[0].text);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- unique ids + a real temp git repo ---
const sfx = Date.now();
const projId = `msg-proj-${sfx}`, topicId = `msg-topic-${sfx}`, taskId = `msg-task-${sfx}`, mgrId = `msg-mgr-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-msg-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# messaging test\n");
execSync(`git init -q && git add . && git -c user.email=msg@loom -c user.name=msg commit -q -m "init"`, { cwd: repo });
const now = new Date().toISOString();

// --- seed the daemon's (isolated) DB directly: project, topic, task(todo), manager session ---
{
  const db = new Database(DB_FILE);
  db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(projId, "Messaging", repo, repo, "{}", now);
  db.prepare("INSERT INTO topics (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)")
    .run(topicId, projId, "work", "");
  db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','todo',?,?,?)")
    .run(taskId, projId, "SEED-TASK", 1, now, now);
  db.prepare(`INSERT INTO sessions (id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role)
    VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'manager')`).run(mgrId, projId, topicId, repo, now, now);
  db.close();
}

const worktreePathExpected = path.join(LOOM, "worktrees", projId, taskId.slice(0, 8));
const trustKey = path.resolve(worktreePathExpected).replace(/\\/g, "/");
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();

async function connect(sessionId) {
  const client = new Client({ name: "messaging-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/${sessionId}`)));
  return client;
}
const boardTitles = async () => (await get(`/api/projects/${projId}/board`)).tasks.map((t) => t.title);

let spawned = null;
try {
  const M = await connect(mgrId);
  spawned = parse(await M.callTool({
    name: "worker_spawn",
    arguments: { taskId, kickoffPrompt: "Respond with exactly the word READY and nothing else, then stop. Use no tools." },
  }));
  check("worker spawned", !!spawned.workerSessionId && fs.existsSync(spawned.worktreePath));

  // Wait until the worker is IDLE (engine id captured AND its kickoff turn ended) — only then
  // does a message submit immediately rather than queue.
  let idle = false;
  for (let i = 0; i < 90 && !idle; i++) {
    await sleep(1000);
    const s = (await get("/api/sessions")).find((x) => x.id === spawned.workerSessionId);
    idle = !!(s?.engineSessionId && s.busy === false);
  }
  check("worker reached idle before messaging", idle);

  // Two messages back-to-back. m1 submits now (and arms busy); m2 arrives mid-turn → queued.
  const m1 = parse(await M.callTool({ name: "worker_message", arguments: { workerSessionId: spawned.workerSessionId, text: "Use the tasks_create tool to create a task titled MSG-ONE, then stop. Use no other tools." } }));
  const m2 = parse(await M.callTool({ name: "worker_message", arguments: { workerSessionId: spawned.workerSessionId, text: "Use the tasks_create tool to create a task titled MSG-TWO, then stop. Use no other tools." } }));
  check("m1 delivered immediately (worker was idle)", m1.delivered === true);
  check("m2 queued behind the running turn (busy-gated, position 1)", m2.delivered === false && m2.position === 1);

  // Both tasks must eventually exist — MSG-TWO only after MSG-ONE's Stop drained the queue.
  let one = false, two = false;
  for (let i = 0; i < 150 && !(one && two); i++) {
    await sleep(1000);
    const titles = await boardTitles();
    one = titles.includes("MSG-ONE");
    two = titles.includes("MSG-TWO");
  }
  check("MSG-ONE created (m1 delivered + ran)", one);
  check("MSG-TWO created (m2 drained on Stop + ran → serialization)", two);

  await M.close();
} finally {
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
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projId); // seed + MSG-ONE/MSG-TWO
    db.prepare("DELETE FROM topics WHERE id = ?").run(topicId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projId);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_message is busy-gated: m1 ran, m2 queued then drained on Stop (serialized)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
