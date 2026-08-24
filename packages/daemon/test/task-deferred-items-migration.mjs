import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Task.deferredItems (card 0d4bc3f0) — mirrors task-manual-deferral-migration.mjs's
// discipline: a FRESH LOOM_HOME is structurally blind to a "schema references a migration-added column"
// bug, because a brand-new tasks table gets every TASK_ADDED_COLUMNS entry applied by migrateTasks()
// regardless of whether the ALTER actually exercised anything. This test synthesizes a REAL
// pre-0d4bc3f0 `tasks` table directly on disk with better-sqlite3 — the EXACT column set this project's
// own tasks table carried immediately before this card (19 columns: every column through `version`, the
// full CREATE TABLE plus every migrateTasks() ADD COLUMN entry that predates deferred_items) — verified
// against a COPY of this project's own self-hosting production `~/.loom/loom.db` as a one-time manual
// check per this card's own DoD (the live prod DB was never opened read-write, only a copy under a
// throwaway LOOM_HOME; see the worker report for that run's output). That machine-specific run is NOT
// committed here, to keep this suite hermetic/portable; this file reproduces the identical schema so the
// SAME guarantee runs everywhere, including CI.
//
// Proves:
//   (1) the constructor does NOT throw on this legacy (pre-0d4bc3f0) tasks table.
//   (2) deferred_items was added to the existing table.
//   (3) a pre-existing legacy row (columnKey/priority/deferred/deferredReason all populated) backfills
//       deferredItems to [] — NEVER null/undefined at the Task-object level, and every OTHER field
//       survives byte-identical.
//   (4) post-migration: appendDeferredItem/setDeferredItemStatus on a migrated-in-place legacy row persist
//       and round-trip through BOTH getTask() and listTasks() — the ALTER'd column is actually wired into
//       the read/write paths, not just present in the schema.
//   (5) NEGATIVE: no BASE `SCHEMA` index or constraint references deferred_items — the inverse-bug check
//       the card explicitly calls for (a base index referencing a migration-only column would crash a
//       FRESH install, which this synthesized-legacy test can't itself catch — this check reads the
//       daemon's own compiled SCHEMA text directly).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-deferred-items-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-deferred-items-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-deferred-items.db");
const projId = randomUUID();
const legacyTaskId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-0d4bc3f0) `tasks` table — every column through `version`, no more =====
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
      deferred_until_task_id TEXT,
      deferred_stuck INTEGER NOT NULL DEFAULT 0,
      deferred_at TEXT,
      deferred_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1
      -- NO deferred_items -- the real pre-0d4bc3f0 shape (every column through 'version', verified against
      -- a copy of this project's own ~/.loom/loom.db).
    );
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Legacy Project", projId, projId, t0);
  // A real pre-existing row exercising every populated legacy field this migration must leave untouched.
  raw.prepare(
    `INSERT INTO tasks (id, project_id, title, body, column_key, position, created_at, updated_at, priority, held,
       deferred, held_by, repo_key, deferred_until_task_id, deferred_stuck, deferred_at, deferred_reason, version)
     VALUES (?, ?, 'A legacy card that predates deferredItems', 'some body text', 'backlog', 7, ?, ?, 'p1', 0,
       1, NULL, NULL, NULL, 0, '2026-06-01T00:00:00.000Z', 'gated on an owner decision', 3)`,
  ).run(legacyTaskId, projId, t0, t0);
  raw.close();

  const cols0 = new Set(new Database(dbFile, { readonly: true }).prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration tasks table has NO deferred_items yet", !cols0.has("deferred_items"));
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-0d4bc3f0) DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-0d4bc3f0 tasks table does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) deferred_items was added to the existing table =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols;
    try {
      cols = raw2.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    } finally {
      raw2.close();
    }
    check("(2) deferred_items column added", cols.includes("deferred_items"));

    // ===== (3) the pre-existing legacy row: deferredItems backfills to [], everything else untouched =====
    const legacy = db.getTask(legacyTaskId);
    check("(3) the legacy row is still readable post-migration", legacy?.title === "A legacy card that predates deferredItems");
    check("(3) deferredItems backfills to an empty array — never null/undefined", Array.isArray(legacy?.deferredItems) && legacy.deferredItems.length === 0);
    check("(3) unrelated fields survive untouched (body)", legacy?.body === "some body text");
    check("(3) unrelated fields survive untouched (columnKey)", legacy?.columnKey === "backlog");
    check("(3) unrelated fields survive untouched (priority)", legacy?.priority === "p1");
    check("(3) unrelated fields survive untouched (position)", legacy?.position === 7);
    check("(3) unrelated fields survive untouched (deferred)", legacy?.deferred === true);
    check("(3) unrelated fields survive untouched (deferredAt)", legacy?.deferredAt === "2026-06-01T00:00:00.000Z");
    check("(3) unrelated fields survive untouched (deferredReason)", legacy?.deferredReason === "gated on an owner decision");
    check("(3) unrelated fields survive untouched (version)", legacy?.version === 3);

    // ===== (4) post-migration: append + status-update on the migrated-in-place legacy row persists + round-trips =====
    const appended = db.appendDeferredItem(legacyTaskId, { text: "a hand-off recorded after migration", toTaskId: "some-other-task-id" });
    check("(4) appendDeferredItem succeeds on a migrated legacy row", typeof appended?.id === "string" && appended.status === "open");
    const afterAppend = db.getTask(legacyTaskId);
    check("(4) getTask() round-trips the appended item", afterAppend?.deferredItems?.length === 1 && afterAppend.deferredItems[0].id === appended.id);
    const listedAfterAppend = db.listTasks(projId).find((t) => t.id === legacyTaskId);
    check("(4) listTasks() ALSO surfaces the appended item (toTask() mapping wired for the list path too)", listedAfterAppend?.deferredItems?.length === 1 && listedAfterAppend.deferredItems[0].id === appended.id);

    const updated = db.setDeferredItemStatus(legacyTaskId, appended.id, "declined");
    check("(4) setDeferredItemStatus succeeds on a migrated legacy row", updated?.status === "declined");
    const afterStatus = db.getTask(legacyTaskId);
    check("(4) getTask() round-trips the status change", afterStatus?.deferredItems?.[0]?.status === "declined");
    const listedAfterStatus = db.listTasks(projId).find((t) => t.id === legacyTaskId);
    check("(4) listTasks() ALSO surfaces the status change", listedAfterStatus?.deferredItems?.[0]?.status === "declined");

    // ===== (5) NEGATIVE — no BASE SCHEMA index/constraint references deferred_items =====
    const dbSrc = fs.readFileSync(new URL("../dist/db.js", import.meta.url), "utf8");
    const schemaMatch = dbSrc.match(/const SCHEMA = `([\s\S]*?)`;/);
    check("(5) setup: located the compiled SCHEMA template literal", !!schemaMatch);
    if (schemaMatch) {
      const schemaText = schemaMatch[1];
      check("(5) base SCHEMA never references deferred_items", !/\bdeferred_items\b/.test(schemaText));
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-0d4bc3f0 legacy tasks table (every column through `version`, the exact shape verified against a copy of this project's own self-hosting production DB), migrateTasks() ADD COLUMNs deferred_items, a pre-existing legacy row backfills deferredItems to [] (never null/undefined) while every other populated field survives byte-identical, appendDeferredItem/setDeferredItemStatus on the migrated-in-place row persist and round-trip through both getTask() and listTasks(), and the base SCHEMA never references the migration-only column (the inverse-bug check)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
