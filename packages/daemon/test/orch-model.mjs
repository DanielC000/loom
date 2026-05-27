// Orchestration data-model test (PR #10). HERMETIC like dead-id.mjs: isolated LOOM_HOME,
// imports dist/db.js, no daemon, no real claude. Covers the additive schema + writers:
//   (migration) a pre-#10 (phase-1) DB gains the new columns and its rows round-trip;
//   (a) a plain phase-1 session inserts unchanged (orchestration fields null, gen 0);
//   (b) a manager + worker; listWorkers(manager) returns exactly the worker;
//   (c) setContextCounters writes tokens/turns + bumps ctxUpdatedAt;
//   (d) appendEvent x2 read back in chronological order (with detail round-trip).
// Run: 1) build the daemon, 2) node test/orch-model.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-orch-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
const DB_FILE = path.join(process.env.LOOM_HOME, "loom.db");
const now = new Date().toISOString();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- (migration) seed a pre-#10 DB: a phase-1 `sessions` table (post-#9, has busy, no orch cols) ---
{
  const old = new Database(DB_FILE);
  old.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, topic_id TEXT NOT NULL,
    engine_session_id TEXT, title TEXT, cwd TEXT NOT NULL,
    process_state TEXT NOT NULL DEFAULT 'none', resumability TEXT NOT NULL DEFAULT 'unknown',
    busy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity TEXT NOT NULL, last_error TEXT
  );`);
  old.prepare(`INSERT INTO sessions (id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("legacy1", "pX", "tX", "eng-legacy", null, "C:/tmp/x", "exited", "resumable", 0, now, now, null);
  old.close();
}

// Opening with the real Db must run the idempotent migration (ALTER ADD COLUMN) without wiping data.
const { Db } = await import("../dist/db.js");
const db = new Db(); // uses LOOM_HOME/loom.db

const legacy = db.getSession("legacy1");
check("migration: pre-#10 row still readable (engine id + resumability preserved)",
  legacy?.engineSessionId === "eng-legacy" && legacy?.resumability === "resumable" && legacy?.busy === false);
check("migration: pre-#10 row's new orchestration fields default null/0",
  legacy?.role === null && legacy?.parentSessionId === null && legacy?.gen === 0 &&
  legacy?.ctxInputTokens === null && legacy?.ctxUpdatedAt === null);

// (a) a plain phase-1 session literal (no orchestration fields) inserts + round-trips unchanged.
db.insertProject({ id: "pX", name: "X", repoPath: "C:/tmp/x", vaultPath: "C:/tmp/x", config: {}, createdAt: now, archivedAt: null });
db.insertTopic({ id: "tX", projectId: "pX", name: "t", startupPrompt: "", position: 0 });
db.insertSession({
  id: "plain1", projectId: "pX", topicId: "tX", engineSessionId: null, title: null,
  cwd: "C:/tmp/x", processState: "live", resumability: "unknown", busy: true,
  createdAt: now, lastActivity: now, lastError: null,
});
const plain = db.getSession("plain1");
check("(a) plain session round-trips (busy + state preserved)", plain?.busy === true && plain?.processState === "live");
check("(a) plain session's orchestration fields are null, gen 0",
  plain.role === null && plain.parentSessionId === null && plain.taskId === null &&
  plain.worktreePath === null && plain.branch === null && plain.recycledFrom === null &&
  plain.gen === 0 && plain.ctxInputTokens === null && plain.ctxTurns === null && plain.ctxUpdatedAt === null);

// (b) a manager (role set at insert) + a worker (lineage set via setOrchestration).
db.insertSession({
  id: "mgr1", projectId: "pX", topicId: "tX", engineSessionId: null, title: null,
  cwd: "C:/tmp/x", processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
db.insertSession({
  id: "wkr1", projectId: "pX", topicId: "tX", engineSessionId: null, title: null,
  cwd: "C:/tmp/x", processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null,
});
db.setOrchestration("wkr1", {
  role: "worker", parentSessionId: "mgr1", taskId: "task1",
  branch: "loom/task1", worktreePath: "C:/tmp/wt/task1",
});
check("(b) manager inserted with role=manager", db.getSession("mgr1").role === "manager");
const workers = db.listWorkers("mgr1");
check("(b) listWorkers(manager) returns exactly the worker", workers.length === 1 && workers[0].id === "wkr1");
const w = workers[0];
check("(b) worker carries parent/task/branch/worktree lineage",
  w.role === "worker" && w.parentSessionId === "mgr1" && w.taskId === "task1" &&
  w.branch === "loom/task1" && w.worktreePath === "C:/tmp/wt/task1");

// setOrchestration sets ONLY the provided fields (partial update leaves others intact).
db.setOrchestration("wkr1", { taskId: "task2" });
const w2 = db.getSession("wkr1");
check("setOrchestration partial: taskId updated, branch left unchanged",
  w2.taskId === "task2" && w2.branch === "loom/task1");

// (c) setContextCounters writes occupancy and bumps ctx_updated_at.
db.setContextCounters("wkr1", { ctxInputTokens: 12345, ctxTurns: 7 });
const w3 = db.getSession("wkr1");
check("(c) setContextCounters writes tokens + turns", w3.ctxInputTokens === 12345 && w3.ctxTurns === 7);
check("(c) setContextCounters bumps ctxUpdatedAt", typeof w3.ctxUpdatedAt === "string" && w3.ctxUpdatedAt.length > 0);

// (d) appendEvent twice — inserted later-ts FIRST to prove listEvents sorts by ts, not insertion.
db.appendEvent({ id: "ev2", ts: "2026-01-02T00:00:00.000Z", managerSessionId: "mgr1", workerSessionId: "wkr1", taskId: "task2", kind: "worker_report", detail: { ok: true, n: 2 } });
db.appendEvent({ id: "ev1", ts: "2026-01-01T00:00:00.000Z", managerSessionId: "mgr1", workerSessionId: "wkr1", taskId: "task1", kind: "spawn_worker" });
const events = db.listEvents("mgr1");
check("(d) listEvents returns both events in chronological order",
  events.length === 2 && events[0].id === "ev1" && events[1].id === "ev2");
check("(d) event detail round-trips (and absent detail is undefined)",
  events[1].kind === "worker_report" && events[1].detail?.ok === true && events[1].detail?.n === 2 &&
  events[0].kind === "spawn_worker" && events[0].detail === undefined);

db.close(); // free the WAL file handle before removing the temp dir (Windows)
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — orchestration schema migrates additively and the writers round-trip."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
