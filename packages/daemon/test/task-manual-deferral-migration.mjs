import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Task.deferredAt/deferredReason (card c90e9525) — mirrors
// task-merged-fields-migration.mjs / task-version-migration.mjs's discipline: a FRESH LOOM_HOME is
// structurally blind to a "schema references a migration-added column" bug, because a brand-new tasks
// table gets every TASK_ADDED_COLUMNS entry applied by migrateTasks() regardless of whether the ALTER
// actually exercised anything. This test synthesizes a REAL pre-c90e9525 `tasks` table directly on disk
// with better-sqlite3 — NOT a guess: this is the EXACT column set (18 columns, in this order) read live
// off this project's own self-hosting production `~/.loom/loom.db` on 2026-08-04 (a copy of the live DB
// was migrated and spot-checked separately as a one-time manual verification per this card's own DoD;
// see the worker report for that run's output — 3714 real tasks / 112 real deferred=1 rows, clean boot,
// zero mismatches. That machine-specific run is NOT committed here, to keep this suite hermetic/portable;
// this file reproduces the identical schema so the SAME guarantee runs everywhere, including CI).
//
// Proves:
//   (1) the constructor does NOT throw on this legacy (pre-c90e9525) tasks table.
//   (2) deferred_at + deferred_reason were added to the existing table (plus deferred_stuck/version —
//       this snapshot also predates 93669813/d0978321, so all four land in the same migration pass,
//       exactly as the real production DB's own migration run did).
//   (3) a pre-existing LEGACY task row that IS deferred:true (the real, load-bearing case — a manual
//       deferral written before this card ever existed) backfills deferredAt/deferredReason to NULL —
//       NEVER an invented reason or a fabricated backdate (card DoD-4) — while every OTHER field
//       (title/columnKey/priority/held/deferredUntilTaskId) survives byte-identical.
//   (4) a pre-existing NON-deferred legacy row is unaffected (both fields null, nothing else moved).
//   (5) post-migration, adding a reason to the migrated-in-place legacy row via updateTask persists and
//       round-trips through BOTH getTask() and listTasks() — the ALTER'd columns are actually wired into
//       the read/write paths, not just present in the schema.
//   (6) NEGATIVE: no BASE `SCHEMA` index or constraint references deferred_at/deferred_reason — the
//       inverse-bug check the card explicitly calls for (a base index referencing a migration-only
//       column would crash a FRESH install, which this synthesized-legacy test can't itself catch — this
//       check reads the daemon's own compiled SCHEMA text directly).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-manual-deferral-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-manual-defer-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-manual-deferral.db");
const projId = randomUUID();
const deferredTaskId = randomUUID();
const plainTaskId = randomUUID();
const blockerTaskId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-c90e9525) `tasks` table — the REAL production shape, verified live =====
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'p2',
      held INTEGER NOT NULL DEFAULT 0,
      deferred INTEGER NOT NULL DEFAULT 0,
      held_by TEXT,
      repo_key TEXT,
      merged_sha TEXT,
      merged_repo_key TEXT,
      merged_date TEXT,
      merged_verification TEXT,
      deferred_until_task_id TEXT
      -- NO deferred_stuck, NO version, NO deferred_at, NO deferred_reason — the real pre-c90e9525 shape,
      -- verified live against this project's own ~/.loom/loom.db on 2026-08-04.
    );
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Legacy Project", projId, projId, t0);
  // A real pre-existing MANUAL deferral, written before this card ever existed — the exact
  // byte-identical-to-forgotten shape the card's own defect describes: deferred=1, no reason, no date.
  raw.prepare(
    "INSERT INTO tasks (id, project_id, title, body, column_key, position, created_at, updated_at, priority, held, deferred, held_by, repo_key, deferred_until_task_id) VALUES (?, ?, 'A legitimately owner-gated epic, parked long ago', '', 'backlog', 3, ?, ?, 'p1', 0, 1, NULL, NULL, NULL)",
  ).run(deferredTaskId, projId, t0, t0);
  // A pre-existing NON-deferred row — proves the migration doesn't touch what it shouldn't.
  raw.prepare(
    "INSERT INTO tasks (id, project_id, title, body, column_key, position, created_at, updated_at, priority, held, deferred, held_by, repo_key, deferred_until_task_id) VALUES (?, ?, 'Ordinary card', '', 'todo', 1, ?, ?, 'p2', 0, 0, NULL, NULL, NULL)",
  ).run(plainTaskId, projId, t0, t0);
  raw.prepare(
    "INSERT INTO tasks (id, project_id, title, body, column_key, position, created_at, updated_at, priority, held, deferred, held_by, repo_key, deferred_until_task_id) VALUES (?, ?, 'Blocker card', '', 'done', 2, ?, ?, 'p2', 0, 0, NULL, NULL, NULL)",
  ).run(blockerTaskId, projId, t0, t0);
  raw.close();

  const cols0 = new Set(new Database(dbFile, { readonly: true }).prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration tasks table has NO deferred_at/deferred_reason yet",
    !cols0.has("deferred_at") && !cols0.has("deferred_reason"));
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-c90e9525) DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-c90e9525 tasks table does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) deferred_at + deferred_reason were added to the existing table =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols;
    try {
      cols = raw2.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    } finally {
      raw2.close();
    }
    check("(2) deferred_at column added", cols.includes("deferred_at"));
    check("(2) deferred_reason column added", cols.includes("deferred_reason"));
    check("(2) deferred_stuck ALSO added (same migration pass, this snapshot predates it too)", cols.includes("deferred_stuck"));
    check("(2) version ALSO added (same migration pass)", cols.includes("version"));

    // ===== (3) the pre-existing DEFERRED legacy row: backfills to NULL, never invents a reason =====
    const legacyDeferred = db.getTask(deferredTaskId);
    check("(3) the legacy deferred row is still readable post-migration", legacyDeferred?.title === "A legitimately owner-gated epic, parked long ago");
    check("(3) deferred stays true (untouched by the migration)", legacyDeferred?.deferred === true);
    check("(3) deferredAt backfills to null — NEVER a fabricated 'just now' timestamp", legacyDeferred?.deferredAt === null);
    check("(3) deferredReason backfills to null — NEVER an invented reason", legacyDeferred?.deferredReason === null);
    check("(3) unrelated fields survive untouched (columnKey)", legacyDeferred?.columnKey === "backlog");
    check("(3) unrelated fields survive untouched (priority)", legacyDeferred?.priority === "p1");
    check("(3) unrelated fields survive untouched (position)", legacyDeferred?.position === 3);
    check("(3) unrelated fields survive untouched (deferredUntilTaskId stays null — a manual deferral)", legacyDeferred?.deferredUntilTaskId === null);

    // ===== (4) a pre-existing NON-deferred legacy row is unaffected =====
    const legacyPlain = db.getTask(plainTaskId);
    check("(4) a non-deferred legacy row: deferred stays false", legacyPlain?.deferred === false);
    check("(4) a non-deferred legacy row: deferredAt/deferredReason both null (nothing to backfill FROM)", legacyPlain?.deferredAt === null && legacyPlain?.deferredReason === null);
    check("(4) a non-deferred legacy row: title untouched", legacyPlain?.title === "Ordinary card");

    // ===== (5) post-migration: adding a reason to the migrated-in-place legacy row persists + round-trips =====
    const { updateProjectTask } = await import("../dist/mcp/tasks.js");
    const backfillResult = await updateProjectTask(db, projId, deferredTaskId, { deferredReason: "confirmed with the owner: still gated on the Q3 infra migration" });
    check("(5) backfilling a reason onto the migrated legacy row succeeds", !("error" in backfillResult));
    check("(5) deferredAt is now stamped (first real provenance, never a backdate)", typeof backfillResult.deferredAt === "string");
    const rawAfterBackfill = db.getTask(deferredTaskId);
    check("(5) getTask() round-trips the persisted reason", rawAfterBackfill?.deferredReason === "confirmed with the owner: still gated on the Q3 infra migration");
    const listed = db.listTasks(projId).find((t) => t.id === deferredTaskId);
    check("(5) listTasks() ALSO surfaces the persisted reason (toTask() mapping wired for the list path too)", listed?.deferredReason === "confirmed with the owner: still gated on the Q3 infra migration");
    check("(5) listTasks() surfaces the stamped deferredAt too", listed?.deferredAt === rawAfterBackfill.deferredAt);

    // ===== (6) NEGATIVE — no BASE SCHEMA index/constraint references deferred_at/deferred_reason =====
    // (the inverse bug: a base-schema reference to a migration-only column crashes a FRESH install, which
    // a synthesized-legacy-table test structurally cannot exercise — read the daemon's own SCHEMA source.)
    const dbSrc = fs.readFileSync(new URL("../dist/db.js", import.meta.url), "utf8");
    const schemaMatch = dbSrc.match(/const SCHEMA = `([\s\S]*?)`;/);
    check("(6) setup: located the compiled SCHEMA template literal", !!schemaMatch);
    if (schemaMatch) {
      const schemaText = schemaMatch[1];
      // Word-boundary match: the SCHEMA legitimately contains `schedules.last_deferred_at`/
      // `last_deferred_reason` (an unrelated, pre-existing BASE column — see db.ts's own SCHEDULE_ADDED_
      // COLUMNS doc) which a bare substring test would false-positive on, since "last_deferred_at"
      // CONTAINS "deferred_at". `\b` finds no boundary between "last_" and "deferred_at" (both are \w
      // characters), so it correctly distinguishes the TASKS table's `deferred_at` (this card's own
      // migration-only column, which must be ABSENT from base SCHEMA) from the unrelated schedules column.
      check("(6) base SCHEMA never references (the tasks table's) deferred_at", !/\bdeferred_at\b/.test(schemaText));
      check("(6) base SCHEMA never references (the tasks table's) deferred_reason", !/\bdeferred_reason\b/.test(schemaText));
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-c90e9525 legacy tasks table (the EXACT shape verified live against this project's own self-hosting production DB), migrateTasks() ADD COLUMNs deferred_at/deferred_reason (alongside deferred_stuck/version, which this snapshot also predates), a pre-existing MANUAL deferral backfills both new fields to null — never an invented reason or a fabricated backdate — while every other field survives untouched, a non-deferred legacy row is unaffected, a post-migration reason-backfill persists and round-trips through both getTask() and listTasks(), and the base SCHEMA never references either migration-only column (the inverse-bug check)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
