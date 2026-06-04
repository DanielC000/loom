import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Task priority (P0–P3) test. HERMETIC like tasks-filter.mjs: no daemon, no real claude — drives the
// built business logic (dist/) against a throwaway SQLite Db. Asserts:
//   (1) the guarded one-shot migration ADDs `priority` to a LEGACY tasks table (no priority column)
//       and backfills every existing row to 'p2' WITHOUT disturbing its other fields;
//   (2) createProjectTask defaults to 'p2' and honors an explicit priority;
//   (3) updateProjectTask round-trips a priority patch (and tasks_list summary carries it);
//   (4) the tasks_update/create/list `priority` zod enum accepts p0–p3 and REJECTS any other string;
//   (5) listProjectTasks minPriority returns only tasks at or above that level.
// Run: 1) build daemon, 2) node test/tasks-priority.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Db } from "../dist/db.js";
import { listProjectTasks, getProjectTask, createProjectTask, updateProjectTask } from "../dist/mcp/tasks.js";
import { prioritySchema } from "../dist/mcp/server.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-tasks-priority-${Date.now()}.db`);
const now = new Date().toISOString();

try {
  // (1) MIGRATION: build a LEGACY DB by hand — a `tasks` table with NO priority column — and seed two
  // rows the old way, then let `new Db(file)` run migrateTasks() and confirm the in-place backfill.
  {
    const raw = new Database(file);
    raw.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
      vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', column_key TEXT NOT NULL, position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    raw.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,?)")
      .run("projA", "Alpha", "C:/a", "C:/a", "{}", now, null);
    raw.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("legacy-1", "projA", "Legacy One", "BODY-1", "backlog", 1, now, now);
    raw.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("legacy-2", "projA", "Legacy Two", "BODY-2", "review", 2, now, now);
    const colsBefore = raw.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    check("legacy table has NO priority column before migration", !colsBefore.includes("priority"));
    raw.close();
  }

  const db = new Db(file); // runs migrateTasks() on open

  const colsAfter = db.getTask("legacy-1") && true; // toTask reads priority — proves column exists
  check("migration added the priority column (toTask reads it)", colsAfter);
  const l1 = db.getTask("legacy-1");
  const l2 = db.getTask("legacy-2");
  check("legacy rows backfill to 'p2'", l1.priority === "p2" && l2.priority === "p2");
  check("migration leaves other fields intact (title/body/columnKey/position)",
    l1.title === "Legacy One" && l1.body === "BODY-1" && l1.columnKey === "backlog" && l1.position === 1 &&
    l2.columnKey === "review" && l2.body === "BODY-2");

  // (2) createProjectTask: default p2 + explicit priority honored.
  const created = createProjectTask(db, "projA", { title: "New default" });
  check("createProjectTask defaults to p2", created.priority === "p2");
  const createdP0 = createProjectTask(db, "projA", { title: "New crit", priority: "p0" });
  check("createProjectTask honors explicit priority", createdP0.priority === "p0");

  // (3) updateProjectTask round-trips a priority patch; tasks_list summary carries priority.
  const upd = updateProjectTask(db, "projA", "legacy-1", { priority: "p1" });
  check("updateProjectTask returns the patched priority", upd.priority === "p1");
  check("updateProjectTask persists priority", db.getTask("legacy-1").priority === "p1");
  const summary = listProjectTasks(db, "projA");
  check("tasks_list summary rows carry priority", summary.every((t) => typeof t.priority === "string"));
  check("tasks_list reflects the updated priority", summary.find((t) => t.id === "legacy-1")?.priority === "p1");

  // (4) zod enum validation — accept p0–p3, reject anything else (this is the tasks_update guard).
  check("prioritySchema accepts p0..p3", ["p0", "p1", "p2", "p3"].every((p) => prioritySchema.safeParse(p).success));
  check("prioritySchema rejects unknown 'p4'", !prioritySchema.safeParse("p4").success);
  check("prioritySchema rejects 'high'", !prioritySchema.safeParse("high").success);
  check("prioritySchema rejects a number", !prioritySchema.safeParse(0).success);

  // (5) minPriority filter: only tasks at or above the level. State now: legacy-1=p1, legacy-2=p2,
  // "New default"=p2, "New crit"=p0. minPriority:p1 → keep p0 + p1, drop p2.
  const high = listProjectTasks(db, "projA", { minPriority: "p1" }).map((t) => t.priority).sort();
  check("minPriority:p1 keeps only p0+p1 (drops p2)", high.length === 2 && high.every((p) => p === "p0" || p === "p1"));
  check("minPriority:p0 keeps only the p0 card", listProjectTasks(db, "projA", { minPriority: "p0" }).every((t) => t.priority === "p0"));

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — priority migrates+backfills legacy rows to p2 in place, create defaults p2 / honors explicit, update round-trips, tasks_list carries it, the zod enum rejects non-p0–p3, and minPriority filters."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
