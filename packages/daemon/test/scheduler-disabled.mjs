// Scheduler opt-in gate (PR #19b). With schedulerEnabled false (the default) the daemon must NOT
// start the Scheduler, so a DUE schedule never fires. Deterministic, NO claude. Run against a
// fresh daemon started WITHOUT LOOM_SCHEDULER_ENABLED (so index.ts skips scheduler.start()).
// schedulerEnabled is boot-time-gated and daemon-GLOBAL (PlatformConfigOverride.schedulerEnabled,
// resolved via resolveConfig(undefined, platformOverride) at boot — see index.ts:676-677), not a
// per-project setting; this script exercises the false (default) side only — the true side needs a
// daemon started against a DB with a stored platform override, which platform-config.mjs covers at
// the resolveConfig/schema level (no daemon spawn needed for that).
//
//   1) LOOM_HOME=<temp> node dist/index.js              (no LOOM_SCHEDULER_ENABLED)
//   2) LOOM_HOME=<temp> node test/scheduler-disabled.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv({ port: true }); // prod-guard: abort unless LOOM_HOME=<temp> + LOOM_PORT != 4317
const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date().toISOString();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = Date.now();
const projId = `sx-proj-${sfx}`, agentId = `sx-agent-${sfx}`, taskId = `sx-task-${sfx}`, scheduleId = `sx-sched-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-sx-${sfx}`); // never used (nothing spawns), but kept for tidy teardown
const past = new Date(Date.now() - 60_000).toISOString();

{
  const db = new Database(DB_FILE);
  db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(projId, "SchedOff", repo, repo, "{}", now);
  db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run(agentId, projId, "t", "noop");
  db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','todo',?,?,?)")
    .run(taskId, projId, "T", 1, now, now);
  db.prepare("INSERT INTO schedules (id,agent_id,cron,enabled,next_fire_at,last_fired_at,created_at) VALUES (?,?,?,1,?,NULL,?)")
    .run(scheduleId, agentId, "*/5 * * * *", past, now);
  db.close();
}

try {
  // Wait well past several would-be ticks. A running Scheduler would have fired by now.
  await sleep(6000);

  const ss = await get("/api/sessions");
  check("disabled: NO manager session booted in the agent", !ss.some((s) => s.role === "manager" && s.agentId === agentId));

  const db = new Database(DB_FILE, { readonly: true });
  const firedCount = db.prepare("SELECT COUNT(*) c FROM orchestration_events WHERE kind = 'schedule_fired'").get().c;
  const after = db.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId);
  db.close();
  check("disabled: NO schedule_fired event", firedCount === 0);
  check("disabled: schedule next_fire_at untouched (still past — never fired, never recomputed)", after.next_fire_at === past && after.last_fired_at === null);

  const taskCol = (await get(`/api/projects/${projId}/board`)).tasks.find((t) => t.id === taskId)?.columnKey;
  check("disabled: the task is still 'todo'", taskCol === "todo");
} finally {
  try {
    const db = new Database(DB_FILE);
    db.prepare("DELETE FROM schedules WHERE id = ?").run(scheduleId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projId);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projId);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — schedulerEnabled=false (default): the daemon never starts the Scheduler; a due schedule does not fire."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
