// worker_report loop test (PR #14c). The FULL 2-level live chain with REAL claude (chosen over
// the seeded-worker fallback because it's the only shape that exercises the host.ts worker-side
// orchestration injection AND closes the worker→manager loop end-to-end):
//   live manager --worker_spawn--> real worker --worker_report(done)--> task→review + framed
//   notification --busy-gated enqueue--> manager's queue --> manager reacts (tasks_create).
//
// RUN against an ISOLATED LOOM_HOME daemon (real claude + real worktrees):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/worker-report.mjs        (SAME LOOM_HOME)
// Surgical (unique ids) + self-cleaning.
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
const post = async (u, b) => (await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();
const postRaw = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- temp git repo + project/task/agent via REST ---
const sfx = Date.now();
const repo = path.join(os.tmpdir(), `loom-wr-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-report test\n");
execSync(`git init -q && git add . && git -c user.email=wr@loom -c user.name=wr commit -q -m "init"`, { cwd: repo });

const P = await post("/api/projects", { name: `WorkerReport-${sfx}`, repoPath: repo, vaultPath: repo });
const task = await post(`/api/projects/${P.id}/tasks`, { title: "WR-TASK", columnKey: "todo" });
const startupPrompt =
  `You are a Loom orchestration manager. First, call the worker_spawn tool with taskId='${task.id}' and ` +
  `kickoffPrompt='Call the worker_report tool with status set to done and summary set to WORKER-DONE, then stop. Use no other tools.' ` +
  `After worker_spawn returns, stop. Then, whenever you later receive a message that begins with [loom:worker-report], ` +
  `call the tasks_create tool to create a task titled MANAGER-GOT-REPORT, then stop. Do not ask questions.`;
const agent = await post(`/api/projects/${P.id}/agents`, { name: "manage", startupPrompt });

const worktreePathExpected = path.join(LOOM, "worktrees", P.id, task.id.slice(0, 8));
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKeys = [repo, worktreePathExpected].map((p) => path.resolve(p).replace(/\\/g, "/"));
const projectsNow = () => { try { return JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}; } catch { return {}; } };
const hadBefore = trustKeys.map((k) => k in projectsNow());

let manager = null, worker = null;
try {
  manager = await post(`/api/agents/${agent.id}/sessions`, { role: "manager" });
  check("manager session live with role=manager", manager.processState === "live" && manager.role === "manager");

  // The live manager spawns a real worker; the worker calls worker_report(done); that moves the
  // task → review, records the event, and notifies the manager → manager creates MANAGER-GOT-REPORT.
  let taskInReview = false, reportEvent = false, managerActed = false;
  for (let i = 0; i < 150 && !(taskInReview && reportEvent && managerActed); i++) {
    await sleep(1000);
    if (!worker) worker = (await get("/api/sessions")).find((s) => s.role === "worker" && s.parentSessionId === manager.id);
    const board = await get(`/api/projects/${P.id}/board`);
    taskInReview = board.tasks.find((t) => t.id === task.id)?.columnKey === "review";
    managerActed = board.tasks.some((t) => t.title === "MANAGER-GOT-REPORT");
    try {
      const db = new Database(DB_FILE, { readonly: true });
      reportEvent = db.prepare("SELECT COUNT(*) c FROM orchestration_events WHERE kind='worker_report' AND manager_session_id=?").get(manager.id).c > 0;
      db.close();
    } catch { /* db busy */ }
  }

  check("live manager spawned a real worker (parent=manager, role=worker)", !!worker);
  check("worker_report(done) moved the task → review (real worker had + called worker_report)", taskInReview);
  check("a worker_report orchestration_event was recorded", reportEvent);
  check("manager received the framed notification and created MANAGER-GOT-REPORT (loop closed)", managerActed);
} finally {
  for (const id of [worker?.id, manager?.id]) {
    try { if (id) await postRaw(`/api/sessions/${id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  }
  await sleep(1500);
  try { await removeWorktree(repo, worker?.worktreePath ?? worktreePathExpected); } catch { /* ignore */ }
  try {
    const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
    let changed = false;
    trustKeys.forEach((k, i) => { if (!hadBefore[i] && cfg.projects && k in cfg.projects) { delete cfg.projects[k]; changed = true; } });
    if (changed) writeJsonAtomic(realClaudeJson, cfg);
  } catch { /* nothing to clean */ }
  try {
    const db = new Database(DB_FILE);
    db.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(manager.id, manager.id);
    db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(manager.id);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(P.id);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(P.id);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_report moved the task, recorded the event, and the notification closed the loop to the manager."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
