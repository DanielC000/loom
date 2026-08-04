import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Task.version (card d0978321) — mirrors task-merged-fields-migration.mjs's
// discipline: a FRESH LOOM_HOME is blind to a "schema references a migration-added column" bug, because
// a brand-new tasks table gets every TASK_ADDED_COLUMNS entry applied by migrateTasks() regardless — a
// fresh-only test can't tell "the ALTER TABLE actually ran against a real pre-existing table with real
// rows" apart from "the column was simply never missing". This test instead synthesizes a REAL
// pre-d0978321 `tasks` table directly on disk with better-sqlite3 — the exact shape every existing Loom
// install has today (every column through card 93669813's deferred_stuck, but NO version) — inserts a
// real pre-existing task row, then constructs a real `Db` against it and proves:
//   (1) the constructor does NOT throw on this legacy (pre-d0978321) tasks table.
//   (2) the version column was added to the existing table.
//   (3) the pre-existing task row is still readable, backfills version to 1 (the same starting point a
//       brand-new row gets), and every OTHER field (title, priority, deferred_stuck, ...) survives
//       untouched.
//   (4) a post-migration updateTask() body write against this migrated-in-place row bumps version to 2
//       (proves the ALTER'd column is actually wired into updateTask's content-bump SQL, not just
//       present in the schema) — and a field-only write does NOT bump it.
//   (5) listTasks() also surfaces version for the migrated row (the toTask() mapping is wired).
//   (6) updateTaskChecked's CAS gate works against a migrated-in-place row (a stale/omitted base is
//       rejected the same as it would be on a brand-new row).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-version-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-version-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-version.db");
const projId = randomUUID();
const taskId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-d0978321) `tasks` table directly, bypassing the Db class entirely =====
// This is the REAL shape every existing install has today: every column through deferred_stuck (card
// 93669813) present, but NO version column.
{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT, reserved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      column_key TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'p2',
      held INTEGER NOT NULL DEFAULT 0,
      deferred INTEGER NOT NULL DEFAULT 0,
      held_by TEXT,
      repo_key TEXT,
      merged_sha TEXT,
      merged_repo_key TEXT,
      merged_date TEXT,
      merged_verification TEXT,
      deferred_until_task_id TEXT,
      deferred_stuck INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      -- NO version — the real pre-d0978321 shape.
    );
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Legacy Project", projId, projId, t0);
  // A real pre-existing task row, written before the version column existed.
  raw.prepare(
    "INSERT INTO tasks (id, project_id, title, body, column_key, position, priority, held, deferred, held_by, repo_key, deferred_stuck, created_at, updated_at) " +
    "VALUES (?, ?, 'Pre-existing card', 'original pre-migration body', 'done', 1, 'p1', 0, 0, NULL, NULL, 0, ?, ?)",
  ).run(taskId, projId, t0, t0);
  raw.close();

  const cols0 = new Set(new Database(dbFile, { readonly: true }).prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration tasks table has NO version column yet", !cols0.has("version"));
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-d0978321) DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-d0978321 tasks table does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) the version column was added to the existing table =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols;
    try {
      cols = raw2.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    } finally {
      raw2.close();
    }
    check("(2) version column added", cols.includes("version"));

    // ===== (3) the pre-existing row is still readable, version backfills to 1, other fields untouched =====
    const preExisting = db.getTask(taskId);
    check("(3) the pre-existing task is still readable post-migration", preExisting?.title === "Pre-existing card");
    check("(3) version backfills to 1 (same starting point a brand-new row gets)", preExisting?.version === 1);
    check("(3) unrelated fields survive untouched (priority)", preExisting?.priority === "p1");
    check("(3) unrelated fields survive untouched (columnKey)", preExisting?.columnKey === "done");
    check("(3) unrelated fields survive untouched (body)", preExisting?.body === "original pre-migration body");

    // ===== (4) a post-migration updateTask() body write bumps version; a field-only write does not =====
    db.updateTask(taskId, { body: "post-migration edit" });
    const afterBody = db.getTask(taskId);
    check("(4) post-migration body write persists on a migrated row", afterBody?.body === "post-migration edit");
    check("(4) post-migration body write bumps version to 2", afterBody?.version === 2);
    db.updateTask(taskId, { columnKey: "review" });
    const afterField = db.getTask(taskId);
    check("(4) post-migration field-only write persists", afterField?.columnKey === "review");
    check("(4) post-migration field-only write does NOT bump version", afterField?.version === 2);

    // ===== (5) listTasks() also surfaces version (the toTask() mapping is wired for the list path too) =====
    const listed = db.listTasks(projId).find((t) => t.id === taskId);
    check("(5) listTasks() surfaces version for the migrated row", listed?.version === 2);

    // ===== (6) updateTaskChecked's CAS gate works against a migrated-in-place row =====
    const stale = db.updateTaskChecked(taskId, { body: "stale clobber" }, 1);
    check("(6) a stale baseVersion (1) against the migrated row (now at 2) is rejected", stale.ok === false);
    check("(6) the rejection returns the CURRENT migrated-row state", !stale.ok && stale.current?.body === "post-migration edit");
    const correct = db.updateTaskChecked(taskId, { body: "correctly-based edit" }, 2);
    check("(6) the CORRECT baseVersion (2) against the migrated row succeeds", correct.ok === true);
    check("(6) version advances to 3 on the migrated row", correct.ok === true && correct.task.version === 3);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-d0978321 legacy tasks table (the exact shape every existing Loom install has today), migrateTasks() ADD COLUMNs version, a pre-existing task row backfills version to 1 while every other field survives untouched, a post-migration body write bumps version (a field-only write does not), listTasks() surfaces version for the migrated row, and updateTaskChecked's CAS gate correctly rejects a stale base and accepts the current one against the migrated-in-place row."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
