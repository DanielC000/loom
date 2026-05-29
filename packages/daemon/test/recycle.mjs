// worker_recycle test (PR #15). Live daemon + REAL worker claude; an MCP client plays the
// manager. Proves the context-recycle handoff: a worker is closed and a FRESH worker spawns in
// the SAME retained worktree (code state kept), seeded with the manager's handoff (intent kept),
// continuing the same task/branch at gen+1. Surgical (unique ids) + self-cleaning.
//
// RUN against an ISOLATED LOOM_HOME daemon (real claude + real worktrees):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/recycle.mjs        (SAME LOOM_HOME)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { removeWorktree } from "../dist/git/worktrees.js";
import { readTranscript } from "../dist/sessions/transcript.js";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";

const BASE = "http://127.0.0.1:4317";
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (res) => JSON.parse(res.content[0].text);
const findSession = async (id) => (await get("/api/sessions")).find((s) => s.id === id);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = Date.now();
const projId = `rc-proj-${sfx}`, topicId = `rc-topic-${sfx}`, taskId = `rc-task-${sfx}`, mgrId = `rc-mgr-${sfx}`;
const marker = `HANDOFF-MARKER-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-rc-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle test\n");
execSync(`git init -q && git add . && git -c user.email=rc@loom -c user.name=rc commit -q -m "init"`, { cwd: repo });
const now = new Date().toISOString();

{
  const db = new Database(DB_FILE);
  db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(projId, "Recycle", repo, repo, "{}", now);
  db.prepare("INSERT INTO topics (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run(topicId, projId, "work", "");
  db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','todo',?,?,?)")
    .run(taskId, projId, "RC-TASK", 1, now, now);
  db.prepare(`INSERT INTO sessions (id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role)
    VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'manager')`).run(mgrId, projId, topicId, repo, now, now);
  db.close();
}

// Post-#30 the worktree key is a hash of the task id (not slice(0,8)), so the path can't be
// precomputed — the trust-entry cleanup derives its key from the REAL `spawned.worktreePath` in
// `finally`. The worktree is always freshly created by this test, so we only ever delete what we added.
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKeyOf = (p) => path.resolve(p).replace(/\\/g, "/");

async function connect(sessionId) {
  const client = new Client({ name: "recycle-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/${sessionId}`)));
  return client;
}

let spawned = null, recycled = null;
try {
  const M = await connect(mgrId);
  spawned = parse(await M.callTool({ name: "worker_spawn", arguments: { taskId, kickoffPrompt: "Respond with exactly the word READY and nothing else, then stop. Use no tools." } }));
  check("worker spawned", !!spawned.workerSessionId && fs.existsSync(spawned.worktreePath));

  // Wait until the old worker is idle (engine id + busy false), then recycle it.
  let idle = false;
  for (let i = 0; i < 90 && !idle; i++) { await sleep(1000); const s = await findSession(spawned.workerSessionId); idle = !!(s?.engineSessionId && s.busy === false); }
  check("old worker reached idle before recycle", idle);

  recycled = parse(await M.callTool({ name: "worker_recycle", arguments: { workerSessionId: spawned.workerSessionId, handoffSummary: `${marker}: continue building the widget; decided X; next do Y.` } }));
  check("worker_recycle returns a NEW worker id, gen 1, recycledFrom = old",
    recycled.newWorkerSessionId && recycled.newWorkerSessionId !== spawned.workerSessionId && recycled.gen === 1 && recycled.recycledFrom === spawned.workerSessionId);

  const fresh = await findSession(recycled.newWorkerSessionId);
  check("new worker: role=worker, parent=manager, gen=1, recycledFrom=old",
    fresh && fresh.role === "worker" && fresh.parentSessionId === mgrId && fresh.gen === 1 && fresh.recycledFrom === spawned.workerSessionId);
  check("new worker REUSES the same worktree + branch + task (code state kept)",
    fresh && fresh.worktreePath === spawned.worktreePath && fresh.branch === spawned.branch && fresh.taskId === taskId);
  const old = await findSession(spawned.workerSessionId);
  check("old worker is now processState 'exited'", old?.processState === "exited");
  check("worktree still exists on disk (retained, not removed)", fs.existsSync(spawned.worktreePath));

  // Handoff seeded: the fresh worker's FIRST user turn is the framed handoff (contains the marker).
  let seeded = false;
  for (let i = 0; i < 90 && !seeded; i++) {
    await sleep(1000);
    const f = await findSession(recycled.newWorkerSessionId);
    if (f?.engineSessionId) {
      const turns = readTranscript(spawned.worktreePath, f.engineSessionId);
      const firstUser = turns.find((t) => t.role === "user");
      seeded = !!firstUser && firstUser.text.includes(marker);
    }
  }
  check("handoff seeded as the fresh worker's first user turn (contains the marker)", seeded);

  await M.close();
} finally {
  for (const id of [recycled?.newWorkerSessionId, spawned?.workerSessionId, mgrId]) {
    try { if (id) await post(`/api/sessions/${id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  }
  await sleep(1500);
  if (spawned?.worktreePath) {
    try { await removeWorktree(repo, spawned.worktreePath); } catch { /* ignore */ }
    try {
      const trustKey = trustKeyOf(spawned.worktreePath);
      const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
      if (cfg.projects && trustKey in cfg.projects) { delete cfg.projects[trustKey]; writeJsonAtomic(realClaudeJson, cfg); }
    } catch { /* nothing to clean */ }
  }
  try {
    const db = new Database(DB_FILE);
    db.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(mgrId, mgrId);
    db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(mgrId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projId);
    db.prepare("DELETE FROM topics WHERE id = ?").run(topicId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projId);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycle closes the old worker and re-seeds a fresh one in the same worktree with the handoff."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
