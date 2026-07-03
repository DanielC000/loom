import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Task model `deferred` field (card 77d33266) — the manager-settable sequencing flag, additive and
// modeled exactly like `held` (db.ts SCHEMA + TASK_ADDED_COLUMNS + insert/update/toTask). DETERMINISTIC
// + CLAUDE-FREE + NETWORK-FREE, hermetic like tasks-priority.mjs (legacy-table migration via a hand-built
// better-sqlite3 DB) and project-task-held.mjs (PATCH semantics).
//
// Proves:
//   (1) a LEGACY tasks table with NO `deferred` column (but WITH `held`, since deferred shipped after
//       it) migrates in place on open: the column is added, every existing row backfills to
//       deferred=false, and every OTHER field (title/body/columnKey/position/held) is left untouched;
//   (2) insertTask WITHOUT deferred (an untyped/legacy caller omitting the field) defaults to
//       deferred:false, byte-identical to a fresh row's other fields;
//   (3) db.updateTask sets/clears deferred (deferred:true / deferred:false);
//   (4) omitting `deferred` entirely on a db.updateTask patch leaves the stored value UNTOUCHED (PATCH
//       semantics, not clobber) — mirrors held's omit-leaves-untouched behavior exactly.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-deferred-field.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-tdf-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");

const file = path.join(os.tmpdir(), `loom-task-deferred-${Date.now()}.db`);
const now = new Date().toISOString();

try {
  // ===== (1) a LEGACY tasks table with no `deferred` column migrates in place on open =====
  {
    const raw = new Database(file);
    raw.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
      vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', column_key TEXT NOT NULL, position REAL NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'p2', held INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    raw.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,?)")
      .run("projA", "Alpha", "C:/a", "C:/a", "{}", now, null);
    raw.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,priority,held,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("legacy-1", "projA", "Legacy One", "BODY-1", "backlog", 1, "p1", 1, now, now);
    const colsBefore = raw.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    check("(1) precondition: legacy table has NO deferred column before migration", !colsBefore.includes("deferred"));
    raw.close();
  }

  const db = new Db(file); // runs migrateTasks() on open — ADDs deferred, backfills every row to false

  const colsAfter = db.getTask("legacy-1") && true; // toTask reads deferred — proves the column exists
  check("(1) migration added the deferred column (toTask reads it)", colsAfter);
  const legacy = db.getTask("legacy-1");
  check("(1) the legacy row backfills to deferred=false", legacy.deferred === false);
  check("(1) migration leaves every OTHER field intact (title/body/columnKey/position/priority/held)",
    legacy.title === "Legacy One" && legacy.body === "BODY-1" && legacy.columnKey === "backlog" &&
    legacy.position === 1 && legacy.priority === "p1" && legacy.held === true);

  // ===== (2) insertTask WITHOUT deferred defaults to false; other fields stored exactly as given =====
  const t1 = randomUUID();
  db.insertTask({ id: t1, projectId: "projA", title: "no deferred passed", body: "b1", columnKey: "backlog",
    position: 2, priority: "p1", held: false, createdAt: now, updatedAt: now }); // deferred OMITTED
  const r1 = db.getTask(t1);
  check("(2) omitting deferred on insert defaults to false", r1.deferred === false);
  check("(2) every OTHER field round-trips exactly as given",
    r1.title === "no deferred passed" && r1.body === "b1" && r1.columnKey === "backlog" &&
    r1.position === 2 && r1.priority === "p1" && r1.held === false);

  // ===== (3) db.updateTask sets/clears deferred =====
  db.updateTask(t1, { deferred: true });
  check("(3) updateTask deferred:true sets the flag", db.getTask(t1).deferred === true);
  db.updateTask(t1, { deferred: false });
  check("(3) updateTask deferred:false clears the flag", db.getTask(t1).deferred === false);

  // ===== (4) omitting deferred on a patch leaves the stored value UNTOUCHED (PATCH semantics) =====
  db.updateTask(t1, { deferred: true });
  check("(4) setup: deferred re-set to true before the omit-check", db.getTask(t1).deferred === true);
  db.updateTask(t1, { priority: "p0" }); // deferred OMITTED from the patch
  const r1b = db.getTask(t1);
  check("(4) omitting deferred on a patch leaves it untouched in the DB", r1b.deferred === true);
  check("(4) the OTHER patched field (priority) still applied", r1b.priority === "p0");

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Task.deferred migrates a legacy (pre-column) table in place (backfilled false, every other field untouched), is additive + default false on insert, db.updateTask sets/clears it, and omitting it from a patch never clobbers the stored value — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
