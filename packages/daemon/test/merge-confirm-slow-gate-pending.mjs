// worker_merge_confirm SLOW-GATE pending-handle + retry test (card fb8df559 Part 1, Auditor b9515beb).
// NOT HERMETIC (~20s wall-clock, needs a manually-started isolated daemon) — an MCP client plays the
// manager and drives worker_merge_confirm against a live daemon with a REAL gate that sleeps LONGER
// than SYNC_ATTACH_BUDGET_MS (12s), so the client genuinely observes the degrade-to-pending-handle path
// (not just the hermetic in-process attach() unit tests) end-to-end over the real MCP tool-call
// boundary — mirroring merge-gate.mjs's live-daemon style.
//
// Proves:
//   (1) the FIRST call blocks ~12s then returns {opId, status:"pending", workerSessionId} — NOT a client
//       timeout with no way to tell whether the gate is running.
//   (2) worker_list shows `pendingMerge` non-null for the worker while the gate is still running.
//   (3) an IMMEDIATE retry (same workerSessionId) does NOT throw "already in flight" — it attaches and
//       either stays pending or (once the gate finishes) returns the settled result.
//   (4) the gate command ran EXACTLY ONCE (a marker file) despite the retry — no double-merge.
//   (5) once settled, the branch is merged (file landed on main), worktree removed, task done.
//
// RUN against an ISOLATED LOOM_HOME daemon (so WORKTREES_DIR is isolated; no claude is spawned):
//   1) LOOM_HOME=<temp> LOOM_PORT=<non-4317> LOOM_TEST=1 node dist/index.js
//   2) LOOM_HOME=<temp> LOOM_PORT=<non-4317> node test/merge-confirm-slow-gate-pending.mjs   (SAME LOOM_HOME/PORT)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWorktree } from "../dist/git/worktrees.js";

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv({ port: true }); // prod-guard: abort unless LOOM_HOME=<temp> + LOOM_PORT != 4317
const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const GIT_ID = "-c user.email=msgp@loom -c user.name=msgp";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(sessionId) {
  const client = new Client({ name: "merge-confirm-slow-gate-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/${sessionId}`)));
  return client;
}
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (client, name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const marker = path.join(os.tmpdir(), `loom-msgp-marker-${sfx}.log`);
// A gate that sleeps 15s (> the 12s SYNC_ATTACH_BUDGET_MS) and marks each REAL invocation. The gate runs
// INSIDE the already-running daemon process, so the marker path must be a LITERAL in the command (an env
// var set on THIS script's process would not reach it) — forward-slashed + single-quoted so a Windows
// temp path (backslashes) survives both the outer `-e "..."` double-quoting and cmd.exe's own parsing.
const markerForJs = marker.replace(/\\/g, "/");
const gateCommand = `node -e "require('fs').appendFileSync('${markerForJs}', 'x'); setTimeout(()=>process.exit(0), 15000)"`;

const projId = `msgp-proj-${sfx}`, agentId = `msgp-agent-${sfx}`, taskId = `msgp-task-${sfx}`;
const mgrId = `msgp-mgr-${sfx}`, workerId = `msgp-wkr-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-msgp-repo-${sfx}`);
const file = "feat.txt";

fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# msgp\n");
execSync(`git init -q && git config user.email msgp@loom && git config user.name msgp && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
fs.writeFileSync(path.join(worktreePath, file), "work\n");
execSync(`git add . && git ${GIT_ID} commit -q -m "${file}"`, { cwd: worktreePath });

{
  const db = new Database(DB_FILE);
  db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(projId, "MSGP", repo, repo, JSON.stringify({ orchestration: { gateCommand } }), now);
  db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run(agentId, projId, "t", "");
  db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','in_progress',?,?,?)").run(taskId, projId, "MSGP-TASK", 1, now, now);
  db.prepare(`INSERT INTO sessions (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role)
    VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'manager')`).run(mgrId, projId, agentId, repo, now, now);
  db.prepare(`INSERT INTO sessions (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role,parent_session_id,task_id,worktree_path,branch)
    VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'worker',?,?,?,?)`).run(workerId, projId, agentId, worktreePath, now, now, mgrId, taskId, worktreePath, branch);
  db.close();
}

try {
  const client = await connect(mgrId);
  console.log(`(info) gate marker file: ${marker}`);

  const headBefore = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  const t0 = Date.now();
  const first = await call(client, "worker_merge_confirm", { workerSessionId: workerId });
  const elapsed1 = Date.now() - t0;
  check(`(1) the first call blocks ~12s (the sync-wait budget) before returning (elapsed=${elapsed1}ms)`, elapsed1 >= 9_000 && elapsed1 < 14_500);
  check("(1) degrades to a PENDING handle, not a client-timeout dead-end", first.status === "pending" && typeof first.opId === "string" && first.workerSessionId === workerId);

  const list = await call(client, "worker_list");
  const row = list.find((w) => w.workerSessionId === workerId);
  check("(2) worker_list shows pendingMerge non-null while the gate is still running", row && row.pendingMerge && row.pendingMerge.state === "running");

  const t1 = Date.now();
  const retry = await call(client, "worker_merge_confirm", { workerSessionId: workerId });
  const elapsed2 = Date.now() - t1;
  check("(3) an IMMEDIATE retry does NOT throw 'already in flight' — it attaches", !("error" in retry) || !/already in flight/i.test(retry.error ?? ""));
  // The gate started at t≈0 and sleeps 15s total; by t1 (~12s in) it has a few seconds left, well under
  // the retry's OWN 12s budget, so this retry call should observe the SETTLED result (not a second pending).
  check(`(3) the retry rides out the remaining time and observes the SETTLED result (elapsed=${elapsed2}ms)`, retry.merged === true);

  check("(4) the gate ran EXACTLY ONCE across the initial call + the retry (no double-merge)", fs.readFileSync(marker, "utf8") === "x");
  check("(5) file landed on the canonical repo", fs.existsSync(path.join(repo, file)));
  check("(5) exactly ONE new commit on main (one squash, not two)", execSync(`git rev-list --count ${headBefore}..HEAD`, { cwd: repo }).toString().trim() === "1");
  check("(5) worktree removed after the merge", !fs.existsSync(worktreePath));

  const listAfter = await call(client, "worker_list");
  const rowAfter = listAfter.find((w) => w.workerSessionId === workerId);
  check("(5) worker_list's pendingMerge is null AFTER settle — not stuck 'still running' (evict-on-settle)", rowAfter && rowAfter.pendingMerge === null);

  await client.close();
} finally {
  try { fs.rmSync(marker, { force: true }); } catch { /* best-effort */ }
  try {
    const db = new Database(DB_FILE);
    db.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(mgrId, mgrId);
    db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(mgrId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projId);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projId);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real multi-minute-class gate degrades worker_merge_confirm to a pending handle after the sync-wait budget, worker_list surfaces the in-flight op, an immediate retry attaches (no 'already in flight' throw) and rides out the settle, and the gate runs exactly once end-to-end over the real MCP boundary."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
