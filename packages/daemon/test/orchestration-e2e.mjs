// Orchestration CAPSTONE e2e (PR #18a). The WHOLE spine end-to-end with an MCP-client-as-manager
// and TWO REAL parallel workers — the integration proof that #9–#17a compose as a system:
//   SETUP → PARALLEL SPAWN (2 workers, 2 isolated worktrees) → both REPORT done → MERGE one →
//   RECYCLE the other → KILL → surgical teardown.
// Live daemon + REAL claude; isolated LOOM_HOME; surgical (unique ids) + self-cleaning.
//
// RUN against a FRESH ISOLATED LOOM_HOME daemon (spawns real claude + real worktrees):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/orchestration-e2e.mjs        (SAME LOOM_HOME)
// It is the longest, most concurrent test — run it on a fresh daemon each time. The daemon
// [pty]/[hook] log is the diagnostic for any parallel-spawn race or worker-lifecycle issue.
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
const findSession = async (id) => (await get("/api/sessions")).find((s) => s.id === id);
const taskCol = async (id) => (await get(`/api/projects/${projId}/board`)).tasks.find((t) => t.id === id)?.columnKey;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- unique ids + a real temp git repo (init + commit on main; a persisted git identity so a
// worker's commit in a linked worktree has an author — worktrees share the repo's .git/config) ---
const sfx = Date.now();
const projId = `e2e-proj-${sfx}`, agentId = `e2e-agent-${sfx}`, mgrId = `e2e-mgr-${sfx}`;
// NB: worktree/branch derive from taskId.slice(0,8) (git/worktrees.ts shortId) — so the two ids
// MUST differ within their first 8 chars or both workers collide on the same branch/worktree.
const taskA = `e2eA-${sfx}`, taskB = `e2eB-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-e2e-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# orchestration-e2e\n");
execSync(`git init -q && git add . && git -c user.email=e2e@loom -c user.name=e2e commit -q -m init`, { cwd: repo });
execSync(`git config user.email e2e@loom && git config user.name e2e`, { cwd: repo }); // persisted → worktrees inherit
const now = new Date().toISOString();

// FINDING (flagged in the PR): an autonomous worker that COMMITS needs git add/commit allowlisted.
// The default allowlist (config.ts) has only git status/log/diff — read-only. So this project's
// config widens permission.allow to the defaults PLUS git add/commit. host.ts appends
// mcp__loom-orchestration on top (role-based), so worker_report still works.
const allow = [
  "mcp__loom-tasks", "Bash(obsidian:*)",
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
  "Bash(git add:*)", "Bash(git commit:*)",
];
const projectConfig = JSON.stringify({
  orchestration: { gateCommand: 'node -e "process.exit(0)"' }, // green build gate
  permission: { allow },
});

{
  const db = new Database(DB_FILE);
  db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(projId, "E2E", repo, repo, projectConfig, now);
  db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run(agentId, projId, "work", "");
  for (const [id, title] of [[taskA, "E2E-TASK-A"], [taskB, "E2E-TASK-B"]]) {
    db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','todo',?,?,?)")
      .run(id, projId, title, 1, now, now);
  }
  db.prepare(`INSERT INTO sessions (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role)
    VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'manager')`).run(mgrId, projId, agentId, repo, now, now);
  db.close();
}

// Worktree paths are deterministic → compute trust keys to clean only entries we add.
const wtA = path.join(LOOM, "worktrees", projId, taskA.slice(0, 8));
const wtB = path.join(LOOM, "worktrees", projId, taskB.slice(0, 8));
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = (p) => path.resolve(p).replace(/\\/g, "/");
const hadTrust = (p) => { try { return trustKey(p) in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; } };
const wtAHadTrust = hadTrust(wtA), wtBHadTrust = hadTrust(wtB);

const kickoff = (tag) =>
  `Create a file named done-${tag}.txt containing exactly the text done. Then commit it with git by running: git add done-${tag}.txt && git commit -m done. Then call the worker_report tool with status "done" and summary "DONE-${tag}". Use no other tools and do nothing else.`;

async function connect(sessionId) {
  const client = new Client({ name: "orchestration-e2e-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/${sessionId}`)));
  return client;
}

let spawnA = null, spawnB = null, recycled = null;
try {
  const M = await connect(mgrId);

  // === 2. PARALLEL SPAWN — fire both worker_spawn CONCURRENTLY (the parallel-spawn race test) ===
  const [rA, rB] = await Promise.all([
    M.callTool({ name: "worker_spawn", arguments: { taskId: taskA, agentId, kickoffPrompt: kickoff("A") } }),
    M.callTool({ name: "worker_spawn", arguments: { taskId: taskB, agentId, kickoffPrompt: kickoff("B") } }),
  ]);
  spawnA = parse(rA); spawnB = parse(rB);
  check(`PARALLEL: both worker_spawn succeeded (no spawn-race error) — A:${spawnA.error ?? "ok"} B:${spawnB.error ?? "ok"}`,
    !spawnA.error && !spawnB.error && !!spawnA.workerSessionId && !!spawnB.workerSessionId);
  check("PARALLEL: two DISTINCT worktrees + branches (isolation)",
    spawnA.worktreePath !== spawnB.worktreePath && spawnA.branch !== spawnB.branch);
  check("PARALLEL: both worktrees exist on disk", fs.existsSync(spawnA.worktreePath) && fs.existsSync(spawnB.worktreePath));
  const board0 = await get(`/api/projects/${projId}/board`);
  check("PARALLEL: both tasks moved to in_progress",
    board0.tasks.find((t) => t.id === taskA)?.columnKey === "in_progress" && board0.tasks.find((t) => t.id === taskB)?.columnKey === "in_progress");
  const list = parse(await M.callTool({ name: "worker_list", arguments: {} }));
  check("PARALLEL: worker_list shows exactly 2 workers", list.length === 2 &&
    list.some((w) => w.workerSessionId === spawnA.workerSessionId) && list.some((w) => w.workerSessionId === spawnB.workerSessionId));

  // === 3. REPORT — poll until BOTH tasks reach 'review' (both real workers committed + reported) ===
  let bothReview = false;
  for (let i = 0; i < 180 && !bothReview; i++) {
    await sleep(1000);
    bothReview = (await taskCol(taskA)) === "review" && (await taskCol(taskB)) === "review";
  }
  check("REPORT: both workers committed + called worker_report(done) → both tasks 'review'", bothReview);

  // === 4. MERGE ONE (taskA): review the diff, then confirm → merged, worktree gone, task done ===
  const diffA = parse(await M.callTool({ name: "worker_merge", arguments: { workerSessionId: spawnA.workerSessionId, fullDiff: true } }));
  check("MERGE: worker_merge diff lists done-A.txt (no merge yet)", diffA.filesChanged >= 1 && diffA.patch.includes("done-A.txt"));
  const confA = parse(await M.callTool({ name: "worker_merge_confirm", arguments: { workerSessionId: spawnA.workerSessionId } }));
  if (confA.merged !== true) console.log("    confA =", JSON.stringify(confA));
  check(`MERGE: worker_merge_confirm → merged:true (reason:${confA.reason ?? "-"})`, confA.merged === true);
  check("MERGE: done-A.txt is now on the canonical repo (merged to main)", fs.existsSync(path.join(repo, "done-A.txt")));
  check("MERGE: workerA's worktree was removed", !fs.existsSync(spawnA.worktreePath));
  check("MERGE: taskA moved to 'done'", (await taskCol(taskA)) === "done");

  // === 5. RECYCLE THE OTHER (taskB): fresh worker, gen+1, SAME worktree/branch/task; old exited ===
  // Sanity-check the negative case FIRST (still live → 404) so a later 200 actually proves something —
  // card b37750a4: an exited session auto-archives and leaves /api/sessions entirely, so "exited" is
  // observed via the by-id archived-sessions route below, not a re-poll of /api/sessions.
  const preRecycleCheck = await fetch(`${BASE}/api/archived-sessions/${spawnB.workerSessionId}`);
  check("archived-sessions 404s while workerB is still live", preRecycleCheck.status === 404);

  recycled = parse(await M.callTool({ name: "worker_recycle", arguments: { workerSessionId: spawnB.workerSessionId, handoffSummary: "E2E-HANDOFF: continue" } }));
  check("RECYCLE: returns a fresh worker, gen 1, recycledFrom = old B",
    !!recycled.newWorkerSessionId && recycled.newWorkerSessionId !== spawnB.workerSessionId && recycled.gen === 1 && recycled.recycledFrom === spawnB.workerSessionId);
  const fresh = await findSession(recycled.newWorkerSessionId);
  check("RECYCLE: fresh worker REUSES B's worktree + branch + task (code state kept)",
    fresh && fresh.worktreePath === spawnB.worktreePath && fresh.branch === spawnB.branch && fresh.taskId === taskB && fresh.parentSessionId === mgrId);
  let oldBArchived = null;
  for (let i = 0; i < 30 && !oldBArchived; i++) {
    await sleep(500);
    const r = await fetch(`${BASE}/api/archived-sessions/${spawnB.workerSessionId}`);
    if (r.status === 200) oldBArchived = await r.json();
  }
  // The 200 alone only proves ARCHIVED, not EXITED — assert processState explicitly.
  check("RECYCLE: old workerB is now 'exited' (archived-sessions row)", oldBArchived?.processState === "exited");

  // RECYCLE handoff CARRIES INTENT: the fresh worker's first user turn IS the framed handoff
  // (contains the summary). This guards R1 — a transcript-encoding bug once let recycle "succeed"
  // (worktree reused, gen+1) while the handoff never actually reached the new worker's first turn.
  let handoffSeeded = false;
  for (let i = 0; i < 90 && !handoffSeeded; i++) {
    await sleep(1000);
    const f = await findSession(recycled.newWorkerSessionId);
    if (f?.engineSessionId) {
      const firstUser = readTranscript(fresh.worktreePath, f.engineSessionId).find((t) => t.role === "user");
      handoffSeeded = !!firstUser && firstUser.text.includes("E2E-HANDOFF");
    }
  }
  check("RECYCLE: the handoff reached the fresh worker's first user turn (intent carried)", handoffSeeded);

  // === 6. KILL — global kill stops the live worker(s) and latches the global pause ===
  const preKillCheck = await fetch(`${BASE}/api/archived-sessions/${recycled.newWorkerSessionId}`);
  check("archived-sessions 404s while the recycled worker is still live", preKillCheck.status === 404);

  const killRes = await (await post("/api/orchestration/kill")).json();
  check("KILL: POST /kill → { stopped } >= 1", typeof killRes.stopped === "number" && killRes.stopped >= 1);
  let freshArchived = null;
  for (let i = 0; i < 30 && !freshArchived; i++) {
    await sleep(1000);
    const r = await fetch(`${BASE}/api/archived-sessions/${recycled.newWorkerSessionId}`);
    if (r.status === 200) freshArchived = await r.json();
  }
  // The 200 alone only proves ARCHIVED, not EXITED — assert processState explicitly.
  check("KILL: the live (recycled) worker reached 'exited' (archived-sessions row)", freshArchived?.processState === "exited");
  const status = await get("/api/orchestration/status");
  check("KILL: global pause latched after kill", status.pausedScopes.includes("global"));

  await M.close();
} finally {
  // === 7. SURGICAL TEARDOWN ===
  for (const id of [recycled?.newWorkerSessionId, spawnA?.workerSessionId, spawnB?.workerSessionId, mgrId]) {
    try { if (id) await post(`/api/sessions/${id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  }
  await sleep(1500);
  // workerA's worktree was removed by a successful merge; B's (reused by the recycle) remains.
  for (const wt of [spawnA?.worktreePath ?? wtA, spawnB?.worktreePath ?? wtB]) {
    try { await removeWorktree(repo, wt); } catch { /* already gone / never created */ }
  }
  // Remove only the ~/.claude.json trust entries we added (both worktrees).
  try {
    const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
    let mutated = false;
    for (const [wt, had] of [[wtA, wtAHadTrust], [wtB, wtBHadTrust]]) {
      const k = trustKey(wt);
      if (!had && cfg.projects && k in cfg.projects) { delete cfg.projects[k]; mutated = true; }
    }
    if (mutated) writeJsonAtomic(realClaudeJson, cfg);
  } catch { /* nothing to clean */ }
  try {
    const db = new Database(DB_FILE);
    db.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(mgrId, mgrId);
    db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(mgrId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projId);
    db.prepare("DELETE FROM agents WHERE project_id = ?").run(projId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projId);
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the orchestration spine composes end-to-end: 2 parallel isolated workers → both report → merge one (clean) + recycle the other (same worktree) → kill latches the global pause."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
