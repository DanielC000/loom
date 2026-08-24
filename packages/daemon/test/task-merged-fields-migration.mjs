import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Task.mergedSha/mergedRepoKey/mergedDate (card 1eebc46a) — mirrors
// project-memory-migration.mjs's discipline: a FRESH LOOM_HOME is blind to a "schema references a
// migration-added column" bug, because a brand-new tasks table gets every TASK_ADDED_COLUMNS entry
// applied by migrateTasks() regardless — a fresh-only test can't tell "the ALTER TABLE actually ran
// against a real pre-existing table with real rows" apart from "the column was simply never missing".
// This test instead synthesizes a REAL pre-1eebc46a `tasks` table directly on disk with better-sqlite3
// (the exact shape every existing Loom install has today: priority/held/deferred/held_by/repo_key all
// present, but NO merged_sha/merged_repo_key/merged_date), inserts a real pre-existing task row, then
// constructs a real `Db` against it and proves:
//   (1) the constructor does NOT throw on this legacy (pre-1eebc46a) tasks table.
//   (2) all three columns were added to the existing table.
//   (3) the pre-existing task row is still readable, backfills all three new fields to null, and every
//       OTHER field (title, priority, repoKey, ...) survives untouched.
//   (4) a post-migration updateTask() write of the new fields against this migrated-in-place row
//       persists and round-trips correctly (proves the ALTER'd columns are actually wired into
//       updateTask's SQL, not just present in the schema).
//   (5) listTasks() also surfaces the new fields for the migrated row (the toTask() mapping is wired).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-merged-fields-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-merged-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-merged-fields.db");
const projId = randomUUID();
const taskId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-1eebc46a) `tasks` table directly, bypassing the Db class entirely =====
// This is the REAL shape every existing install has today: priority/held/deferred/held_by/repo_key all
// present (added by earlier migrations), but the three 1eebc46a columns do NOT exist yet.
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      -- NO merged_sha, merged_repo_key, merged_date — the real pre-1eebc46a shape.
    );
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Legacy Project", projId, projId, t0);
  // A real pre-existing task row, written before ship-state existed.
  raw.prepare(
    "INSERT INTO tasks (id, project_id, title, body, column_key, position, priority, held, deferred, held_by, repo_key, created_at, updated_at) VALUES (?, ?, 'Pre-existing card', '', 'done', 1, 'p1', 0, 0, NULL, NULL, ?, ?)",
  ).run(taskId, projId, t0, t0);
  raw.close();

  const cols0 = new Set(new Database(dbFile, { readonly: true }).prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration tasks table has NO merged_sha/merged_repo_key/merged_date yet",
    !cols0.has("merged_sha") && !cols0.has("merged_repo_key") && !cols0.has("merged_date"));
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-1eebc46a) DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-1eebc46a tasks table does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) all three columns were added to the existing table =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols;
    try {
      cols = raw2.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    } finally {
      raw2.close();
    }
    check("(2) merged_sha column added", cols.includes("merged_sha"));
    check("(2) merged_repo_key column added", cols.includes("merged_repo_key"));
    check("(2) merged_date column added", cols.includes("merged_date"));

    // ===== (3) the pre-existing row is still readable, new fields backfill to null, other fields untouched =====
    const preExisting = db.getTask(taskId);
    check("(3) the pre-existing task is still readable post-migration", preExisting?.title === "Pre-existing card");
    check("(3) mergedSha backfills to null", preExisting?.mergedSha === null);
    check("(3) mergedRepoKey backfills to null", preExisting?.mergedRepoKey === null);
    check("(3) mergedDate backfills to null", preExisting?.mergedDate === null);
    check("(3) unrelated fields survive untouched (priority)", preExisting?.priority === "p1");
    check("(3) unrelated fields survive untouched (columnKey)", preExisting?.columnKey === "done");

    // ===== (4) a post-migration updateTask() write against this migrated-in-place row persists =====
    db.updateTask(taskId, { mergedSha: "abc1234", mergedRepoKey: "secondary", mergedDate: "2026-07-24T00:00:00.000Z" });
    const updated = db.getTask(taskId);
    check("(4) post-migration mergedSha write persists on a migrated row", updated?.mergedSha === "abc1234");
    check("(4) post-migration mergedRepoKey write persists on a migrated row", updated?.mergedRepoKey === "secondary");
    check("(4) post-migration mergedDate write persists on a migrated row", updated?.mergedDate === "2026-07-24T00:00:00.000Z");
    check("(4) the write did not disturb unrelated fields (title)", updated?.title === "Pre-existing card");

    // ===== (5) listTasks() also surfaces the new fields (toTask() mapping wired for the list path too) =====
    const listed = db.listTasks(projId).find((t) => t.id === taskId);
    check("(5) listTasks() surfaces mergedSha for the migrated row", listed?.mergedSha === "abc1234");
    check("(5) listTasks() surfaces mergedRepoKey for the migrated row", listed?.mergedRepoKey === "secondary");
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-1eebc46a legacy tasks table (the exact shape every existing Loom install has today), migrateTasks() ADD COLUMNs merged_sha/merged_repo_key/merged_date, a pre-existing task row backfills all three to null while every other field survives untouched, and a post-migration updateTask() write of the new fields persists and round-trips correctly through both getTask() and listTasks() against the upgraded-in-place row."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
