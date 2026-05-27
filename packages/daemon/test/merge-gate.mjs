// Two-step merge gate test (PR #16). REAL git, NO claude → fully deterministic. An MCP client
// plays the manager and drives worker_merge / worker_merge_confirm against a live daemon (the
// merge is pure git + db, no pty). Proves the PASS path (gate green → merged, worktree removed,
// task done) AND the fail-closed FAIL path (gate red → NOT merged, canonical repo untouched,
// worktree retained). Surgical (unique ids) + self-cleaning.
//
// RUN against an ISOLATED LOOM_HOME daemon (so WORKTREES_DIR is isolated; no claude is spawned):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/merge-gate.mjs        (SAME LOOM_HOME)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWorktree, removeWorktree } from "../dist/git/worktrees.js";

const BASE = "http://127.0.0.1:4317";
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const get = async (u) => (await fetch(BASE + u)).json();
const parse = (res) => JSON.parse(res.content[0].text);
const now = new Date().toISOString();
const GIT_ID = "-c user.email=mg@loom -c user.name=mg";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function connect(sessionId) {
  const client = new Client({ name: "merge-gate-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/${sessionId}`)));
  return client;
}
function eventExists(mgrId, kind) {
  const db = new Database(DB_FILE, { readonly: true });
  const c = db.prepare("SELECT COUNT(*) c FROM orchestration_events WHERE manager_session_id=? AND kind=?").get(mgrId, kind).c;
  db.close();
  return c > 0;
}

// Build one project: a real repo + a worker whose branch has a committed file, plus the seeded
// manager/worker rows. gateCommand is stored in the project config (cross-platform via node -e).
function makeProject(label, gateCommand) {
  const sfx = `${Date.now()}-${label}-${Math.random().toString(36).slice(2, 7)}`;
  const p = {
    projId: `mg-proj-${sfx}`, topicId: `mg-topic-${sfx}`, taskId: `mg-task-${sfx}`,
    mgrId: `mg-mgr-${sfx}`, workerId: `mg-wkr-${sfx}`,
    repo: path.join(os.tmpdir(), `loom-mg-repo-${sfx}`), gateCommand, file: `widget-${label}.txt`,
  };
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), `# merge-gate ${label}\n`);
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  return p;
}

async function seedWorker(p) {
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), `work for ${p.projId}\n`);
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  const db = new Database(DB_FILE);
  db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(p.projId, "MG", p.repo, p.repo, JSON.stringify({ orchestration: { gateCommand: p.gateCommand } }), now);
  db.prepare("INSERT INTO topics (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run(p.topicId, p.projId, "t", "");
  db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','in_progress',?,?,?)")
    .run(p.taskId, p.projId, "MG-TASK", 1, now, now);
  db.prepare(`INSERT INTO sessions (id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role)
    VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'manager')`).run(p.mgrId, p.projId, p.topicId, p.repo, now, now);
  db.prepare(`INSERT INTO sessions (id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role,parent_session_id,task_id,worktree_path,branch)
    VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL,'worker',?,?,?,?)`).run(p.workerId, p.projId, p.topicId, worktreePath, now, now, p.mgrId, p.taskId, worktreePath, branch);
  db.close();
  return { worktreePath, branch };
}

const A = makeProject("A", 'node -e "process.exit(0)"'); // gate green
const B = makeProject("B", 'node -e "process.exit(1)"'); // gate red
const a = await seedWorker(A);
const b = await seedWorker(B);

try {
  // --- PASS path: gate green → merged, worktree removed, task done ---
  const MA = await connect(A.mgrId);
  const diff = parse(await MA.callTool({ name: "worker_merge", arguments: { workerSessionId: A.workerId } }));
  check("PASS: worker_merge diff lists the committed file (no merge yet)", diff.filesChanged >= 1 && diff.patch.includes(A.file));
  check("PASS: canonical repo NOT yet changed by the review step", !fs.existsSync(path.join(A.repo, A.file)));
  const confirmA = parse(await MA.callTool({ name: "worker_merge_confirm", arguments: { workerSessionId: A.workerId } }));
  check("PASS: worker_merge_confirm → merged:true", confirmA.merged === true);
  check("PASS: file is now on the canonical repo (merged into main)", fs.existsSync(path.join(A.repo, A.file)));
  check("PASS: worktree removed after merge", !fs.existsSync(a.worktreePath));
  const boardA = await get(`/api/projects/${A.projId}/board`);
  check("PASS: task moved to done", boardA.tasks.find((t) => t.id === A.taskId)?.columnKey === "done");
  check("PASS: merge_done event recorded", eventExists(A.mgrId, "merge_done"));
  await MA.close();

  // --- FAIL path (fail-closed): gate red → NOT merged, canonical untouched, worktree retained ---
  const MB = await connect(B.mgrId);
  const confirmB = parse(await MB.callTool({ name: "worker_merge_confirm", arguments: { workerSessionId: B.workerId } }));
  check("FAIL: worker_merge_confirm → merged:false, reason ~ gate", confirmB.merged === false && /gate|build/i.test(confirmB.reason ?? ""));
  check("FAIL: canonical repo UNTOUCHED (file absent from main)", !fs.existsSync(path.join(B.repo, B.file)));
  check("FAIL: merge_rejected event recorded", eventExists(B.mgrId, "merge_rejected"));
  check("FAIL: worktree RETAINED (manager can re-task a fix)", fs.existsSync(b.worktreePath));
  await MB.close();
} finally {
  try { await removeWorktree(B.repo, b.worktreePath); } catch { /* ignore */ }
  try {
    const db = new Database(DB_FILE);
    for (const p of [A, B]) {
      db.prepare("DELETE FROM sessions WHERE id = ? OR parent_session_id = ?").run(p.mgrId, p.mgrId);
      db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ?").run(p.mgrId);
      db.prepare("DELETE FROM tasks WHERE project_id = ?").run(p.projId);
      db.prepare("DELETE FROM topics WHERE id = ?").run(p.topicId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(p.projId);
    }
    db.close();
  } catch { /* ignore */ }
  fs.rmSync(A.repo, { recursive: true, force: true });
  fs.rmSync(B.repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — two-step merge gate: green merges (worktree removed, task done); red is fail-closed (repo untouched, worktree retained)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
