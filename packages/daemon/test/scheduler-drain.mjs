// Scheduler real-claude board-drain (PR #19b). Proves the self-starting queue end-to-end with NO
// human relay: a due schedule → the daemon's Scheduler boots a REAL manager (interactive pty) →
// the manager reads the board and spawns a worker for a seeded todo task. Stops at "worker spawned
// for the task" (full merge is orchestration-e2e's job). Timing-sensitive → run 2×.
//
// RUN against a fresh isolated LOOM_HOME daemon with the scheduler ENABLED + a SHORT tick:
//   1) LOOM_HOME=<temp> LOOM_SCHEDULER_ENABLED=1 LOOM_SCHEDULER_INTERVAL_MS=2000 node dist/index.js
//   2) LOOM_HOME=<temp> node test/scheduler-drain.mjs        (SAME LOOM_HOME)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
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
const now = new Date().toISOString();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- a real git repo + seeds. The agent's startupPrompt is the manager kickoff (drain the board). ---
const sfx = Date.now();
const projId = `sd-proj-${sfx}`, agentId = `sd-agent-${sfx}`, taskId = `sd-task-${sfx}`, scheduleId = `sd-sched-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-sd-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# scheduler-drain test\n");
execSync(`git init -q && git add . && git -c user.email=sd@loom -c user.name=sd commit -q -m init`, { cwd: repo });

const managerKickoff =
  "You are an autonomous manager. Do exactly this, then stop: call the tasks_list tool to read the board; " +
  "for EVERY task whose columnKey is \"todo\", call the worker_spawn tool with that task's id and " +
  "kickoffPrompt \"Create a file named done.txt containing the word done, then stop.\". Do nothing else.";

// Seed AFTER the daemon is up (so the Scheduler's boot-time recompute already ran over an empty
// table and won't push our past-dated schedule forward). next_fire_at in the PAST = due now; the
// running Scheduler's next tick fires it. cron "0 0 1 1 *" → post-fire next is months away (one fire).
{
  const db = new Database(DB_FILE);
  db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(projId, "SchedDrain", repo, repo, "{}", now);
  db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)")
    .run(agentId, projId, "drain", managerKickoff);
  db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','todo',?,?,?)")
    .run(taskId, projId, "make-done-file", 1, now, now);
  db.prepare("INSERT INTO schedules (id,agent_id,cron,enabled,next_fire_at,last_fired_at,created_at) VALUES (?,?,?,1,?,NULL,?)")
    .run(scheduleId, agentId, "0 0 1 1 *", new Date(Date.now() - 60_000).toISOString(), now);
  db.close();
}

// Trust entries the spawns will add (manager cwd = repo; worker cwd = its worktree) — clean only ours.
const worktreeExpected = path.join(LOOM, "worktrees", projId, taskId.slice(0, 8));
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = (p) => path.resolve(p).replace(/\\/g, "/");
const hadTrust = (p) => { try { return trustKey(p) in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; } };
const repoHadTrust = hadTrust(repo), wtHadTrust = hadTrust(worktreeExpected);

function scheduleFiredEvent() {
  const db = new Database(DB_FILE, { readonly: true });
  const row = db.prepare("SELECT * FROM orchestration_events WHERE kind = 'schedule_fired'").get();
  db.close();
  return row;
}

let mgr = null, worker = null, taskCol = null;
try {
  // Unattended: just wait for the daemon's Scheduler to boot a manager that drains the board.
  for (let i = 0; i < 180 && !worker; i++) {
    await sleep(1000);
    const ss = await get("/api/sessions");
    mgr = ss.find((s) => s.role === "manager" && s.agentId === agentId) ?? mgr;
    worker = ss.find((s) => s.role === "worker" && s.taskId === taskId);
    taskCol = (await get(`/api/projects/${projId}/board`)).tasks.find((t) => t.id === taskId)?.columnKey;
  }

  const fired = scheduleFiredEvent();
  check("scheduler fired the schedule unattended (schedule_fired event)", !!fired && JSON.parse(fired.detail_json ?? "{}").scheduleId === scheduleId);
  check("a manager session booted (role=manager in the scheduled agent)", !!mgr);
  check("the booted manager IS the schedule_fired event's manager", !!fired && !!mgr && fired.manager_session_id === mgr.id);
  check("the manager spawned a worker for the seeded task (parent=manager, taskId)", !!worker && !!mgr && worker.parentSessionId === mgr.id && worker.taskId === taskId);
  check("the task left 'todo' (the manager drained the board)", !!taskCol && taskCol !== "todo");
} finally {
  for (const id of [worker?.id, mgr?.id]) { try { if (id) await post(`/api/sessions/${id}/stop`, { mode: "hard" }); } catch { /* ignore */ } }
  await sleep(1500);
  try { await removeWorktree(repo, worker?.worktreePath ?? worktreeExpected); } catch { /* ignore */ }
  try {
    const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
    let mutated = false;
    for (const [p, had] of [[repo, repoHadTrust], [worker?.worktreePath ?? worktreeExpected, wtHadTrust]]) {
      const k = trustKey(p);
      if (!had && cfg.projects && k in cfg.projects) { delete cfg.projects[k]; mutated = true; }
    }
    if (mutated) writeJsonAtomic(realClaudeJson, cfg);
  } catch { /* nothing to clean */ }
  try {
    const db = new Database(DB_FILE);
    if (mgr?.id) db.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(mgr.id, mgr.id);
    db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(mgr?.id ?? "");
    db.prepare("DELETE FROM schedules WHERE id = ?").run(scheduleId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projId);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projId);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a due schedule booted a real manager unattended that drained the board (spawned a worker for the seeded task)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
