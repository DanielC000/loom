// First-live-manager test (PR #14a). A REAL manager `claude` session is given the
// loom-orchestration MCP (+ allowlist) at spawn; its startup prompt instructs it to call
// worker_spawn. We assert a worker appears UNATTENDED — proving the injection + allowlist work
// end-to-end (not just an MCP client driving the tool, as in orch-spawn.mjs).
//
// RUN against an ISOLATED LOOM_HOME daemon (spawns real claude + creates real worktrees):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/manager-live.mjs        (SAME LOOM_HOME)
//
// Surgical (unique ids, no DELETE-all) + self-cleaning. LOOM_HOME only relocates ~/.loom;
// claude still uses the real ~/.claude.json, so spawns add trust entries for the manager's repo
// path AND the worker's worktree path — both removed in teardown (busy-flag's pattern).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { removeWorktree } from "../dist/git/worktrees.js";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";

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

// --- a real temp git repo + a Loom project/task/agent via REST ---
const sfx = Date.now();
const repo = path.join(os.tmpdir(), `loom-mgr-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# manager-live test\n");
execSync(`git init -q && git add . && git -c user.email=mgr@loom -c user.name=mgr commit -q -m "init"`, { cwd: repo });

const P = await post("/api/projects", { name: `MgrLive-${sfx}`, repoPath: repo, vaultPath: repo });
const task = await post(`/api/projects/${P.id}/tasks`, { title: "MGR-TASK", columnKey: "todo" });
const startupPrompt =
  `You are a Loom orchestration manager. Call the worker_spawn tool with taskId='${task.id}' and ` +
  `kickoffPrompt='Respond with exactly the word READY and nothing else, then stop. Use no tools.' ` +
  `After worker_spawn returns, stop and do nothing else. Do not ask questions.`;
const agent = await post(`/api/projects/${P.id}/agents`, { name: "manage", startupPrompt });

// Trust bookkeeping for BOTH paths the spawns will trust (manager repo + worker worktree).
const worktreePathExpected = path.join(LOOM, "worktrees", P.id, task.id.slice(0, 8));
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKeys = [repo, worktreePathExpected].map((p) => path.resolve(p).replace(/\\/g, "/"));
const projectsNow = () => { try { return JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}; } catch { return {}; } };
const hadBefore = trustKeys.map((k) => k in projectsNow());

let manager = null, worker = null;
try {
  manager = await post(`/api/agents/${agent.id}/sessions`, { role: "manager" });
  check("manager session live with role=manager", manager.processState === "live" && manager.role === "manager");

  // The live manager should call worker_spawn from its startup turn → a worker appears. UNATTENDED.
  for (let i = 0; i < 120 && !worker; i++) {
    await sleep(1000);
    worker = (await get("/api/sessions")).find((s) => s.role === "worker" && s.parentSessionId === manager.id);
  }
  check("live manager spawned a worker UNATTENDED (role=worker, parent=manager)", !!worker);
  check("worker has its worktree on disk", !!worker?.worktreePath && fs.existsSync(worker.worktreePath));
  const board = await get(`/api/projects/${P.id}/board`);
  check("task moved to in_progress", board.tasks.find((t) => t.id === task.id)?.columnKey === "in_progress");
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
    if (manager?.id) {
      db.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(manager.id, manager.id);
      db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(manager.id);
    }
    db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(P.id);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real manager session has the orchestration MCP and spawned a worker unattended."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
