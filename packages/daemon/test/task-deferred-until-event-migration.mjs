import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Task.deferredUntilEvent (card 74716cfb) — mirrors
// task-deferred-items-migration.mjs's discipline exactly: a FRESH LOOM_HOME is structurally blind to a
// "schema references a migration-added column" bug, because a brand-new tasks table gets every
// TASK_ADDED_COLUMNS entry applied by migrateTasks() regardless of whether the ALTER actually exercised
// anything. This test synthesizes a REAL pre-74716cfb `tasks` table directly on disk with better-sqlite3
// — the exact column set immediately before this card (every column through `deferred_items`, i.e. the
// shape task-deferred-items-migration.mjs's own legacy fixture plus that one card's own new column).
//
// Proves:
//   (1) the constructor does NOT throw on this legacy (pre-74716cfb) tasks table.
//   (2) deferred_until_event was added to the existing table.
//   (3) a pre-existing legacy row (columnKey/priority/deferred/deferredReason/deferredItems all
//       populated) backfills deferredUntilEvent to null — never throws — and every OTHER field survives
//       byte-identical.
//   (4) post-migration: db.updateTask({deferredUntilEvent}) on the migrated-in-place legacy row persists
//       and round-trips through BOTH getTask() and listTasks() — the ALTER'd column is actually wired
//       into the read/write paths, not just present in the schema. A field-only patch that never mentions
//       deferredUntilEvent leaves an already-set value untouched (mirrors deferredUntilTaskId's own
//       unconditional-re-serialize contract). Clearing to null round-trips too.
//   (5) a corrupted/malformed blob in the column degrades to null on read rather than throwing.
//   (6) NEGATIVE: no BASE `SCHEMA` index or constraint references deferred_until_event — the inverse-bug
//       check the card explicitly calls for (a base index referencing a migration-only column would crash
//       a FRESH install, which this synthesized-legacy test can't itself catch — this check reads the
//       daemon's own compiled SCHEMA text directly).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-deferred-until-event-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-deferred-until-event-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-deferred-until-event.db");
const projId = randomUUID();
const legacyTaskId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-74716cfb) `tasks` table — every column through `deferred_items` =====
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
      deferred_items TEXT,
      version INTEGER NOT NULL DEFAULT 1
      -- NO deferred_until_event -- the real pre-74716cfb shape.
    );
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Legacy Project", projId, projId, t0);
  // A real pre-existing row exercising every populated legacy field this migration must leave untouched.
  raw.prepare(
    `INSERT INTO tasks (id, project_id, title, body, column_key, position, created_at, updated_at, priority, held,
       deferred, held_by, repo_key, deferred_until_task_id, deferred_stuck, deferred_at, deferred_reason, deferred_items, version)
     VALUES (?, ?, 'A legacy card that predates deferredUntilEvent', 'some body text', 'backlog', 7, ?, ?, 'p1', 0,
       1, NULL, NULL, NULL, 0, '2026-06-01T00:00:00.000Z', 'gated on an owner decision', '[]', 3)`,
  ).run(legacyTaskId, projId, t0, t0);
  raw.close();

  const cols0 = new Set(new Database(dbFile, { readonly: true }).prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration tasks table has NO deferred_until_event yet", !cols0.has("deferred_until_event"));
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-74716cfb) DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-74716cfb tasks table does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) deferred_until_event was added to the existing table =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols;
    try {
      cols = raw2.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    } finally {
      raw2.close();
    }
    check("(2) deferred_until_event column added", cols.includes("deferred_until_event"));

    // ===== (3) the pre-existing legacy row: deferredUntilEvent backfills to null, everything else untouched =====
    const legacy = db.getTask(legacyTaskId);
    check("(3) the legacy row is still readable post-migration", legacy?.title === "A legacy card that predates deferredUntilEvent");
    check("(3) deferredUntilEvent backfills to null", legacy?.deferredUntilEvent === null);
    check("(3) unrelated fields survive untouched (body)", legacy?.body === "some body text");
    check("(3) unrelated fields survive untouched (columnKey)", legacy?.columnKey === "backlog");
    check("(3) unrelated fields survive untouched (priority)", legacy?.priority === "p1");
    check("(3) unrelated fields survive untouched (deferred)", legacy?.deferred === true);
    check("(3) unrelated fields survive untouched (deferredReason)", legacy?.deferredReason === "gated on an owner decision");
    check("(3) unrelated fields survive untouched (deferredItems)", Array.isArray(legacy?.deferredItems) && legacy.deferredItems.length === 0);
    check("(3) unrelated fields survive untouched (version)", legacy?.version === 3);

    // ===== (4) post-migration write + round-trip, incl. field-only-patch-preserves-value + clear-to-null =====
    db.updateTask(legacyTaskId, { deferredUntilEvent: { kind: "gate-fail-naming", key: "some-test-file.mjs" } });
    const afterSet = db.getTask(legacyTaskId);
    check("(4) getTask() round-trips a freshly-set deferredUntilEvent", afterSet?.deferredUntilEvent?.kind === "gate-fail-naming" && afterSet?.deferredUntilEvent?.key === "some-test-file.mjs");
    const listedAfterSet = db.listTasks(projId).find((t) => t.id === legacyTaskId);
    check("(4) listTasks() ALSO surfaces the set value (toTask() mapping wired for the list path too)", listedAfterSet?.deferredUntilEvent?.kind === "gate-fail-naming" && listedAfterSet?.deferredUntilEvent?.key === "some-test-file.mjs");

    // A field-only patch that never mentions deferredUntilEvent must carry the CURRENT value forward
    // unconditionally (mirrors deferredUntilTaskId's own unconditional-re-serialize contract) — never
    // silently drop it just because this particular write didn't touch it.
    db.updateTask(legacyTaskId, { priority: "p0" });
    const afterUnrelatedPatch = db.getTask(legacyTaskId);
    check("(4) an unrelated field-only patch leaves deferredUntilEvent untouched", afterUnrelatedPatch?.deferredUntilEvent?.kind === "gate-fail-naming" && afterUnrelatedPatch?.deferredUntilEvent?.key === "some-test-file.mjs");
    check("(4) ...and DID apply the unrelated field", afterUnrelatedPatch?.priority === "p0");

    db.updateTask(legacyTaskId, { deferredUntilEvent: null });
    const afterClear = db.getTask(legacyTaskId);
    check("(4) explicit null clears it back to null", afterClear?.deferredUntilEvent === null);

    // ===== (5) a corrupted blob degrades to null on read, never throws =====
    const raw3 = new Database(dbFile);
    raw3.prepare("UPDATE tasks SET deferred_until_event = ? WHERE id = ?").run("{not valid json", legacyTaskId);
    raw3.close();
    let readErr = null;
    let corrupted;
    try { corrupted = db.getTask(legacyTaskId); } catch (err) { readErr = err; }
    check("(5) a corrupted deferred_until_event blob does not throw on read", readErr === null);
    check("(5) ...and degrades to null rather than surfacing a half-shaped object", corrupted?.deferredUntilEvent === null);

    // ===== (6) NEGATIVE — no BASE SCHEMA index/constraint references deferred_until_event =====
    const dbSrc = fs.readFileSync(new URL("../dist/db.js", import.meta.url), "utf8");
    const schemaMatch = dbSrc.match(/const SCHEMA = `([\s\S]*?)`;/);
    check("(6) setup: located the compiled SCHEMA template literal", !!schemaMatch);
    if (schemaMatch) {
      const schemaText = schemaMatch[1];
      check("(6) base SCHEMA never references deferred_until_event", !/\bdeferred_until_event\b/.test(schemaText));
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-74716cfb legacy tasks table, migrateTasks() ADD COLUMNs deferred_until_event, a pre-existing legacy row backfills deferredUntilEvent to null (never throws) while every other populated field survives byte-identical, a set/clear round-trips through both getTask() and listTasks() and survives an unrelated field-only patch, a corrupted blob degrades to null rather than throwing, and the base SCHEMA never references the migration-only column (the inverse-bug check)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
