import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for project_memory (card 2fd9abf9) — mirrors db-legacy-boot.mjs's discipline: a
// fresh LOOM_HOME is BLIND to "schema references a migration-added column/table" bugs, because
// `CREATE TABLE IF NOT EXISTS` brings in every column/table at once on a brand-new file. This test
// instead synthesizes a REAL pre-project_memory ("legacy") DB directly on disk with better-sqlite3 (the
// exact shape any real Loom install has TODAY, before this feature: projects/agents/sessions exist, but
// NO project_memory table, NO project_memory_fts virtual table, NO sync triggers at all), then constructs
// a real `Db` against it and proves:
//   (1) the constructor does NOT throw on a legacy (pre-project_memory) DB.
//   (2) project_memory + project_memory_fts + all three sync triggers exist post-construct.
//   (3) the full write → FTS5-search → upsert → evict → forget round-trip actually WORKS against this
//       upgraded-in-place DB (not just "the table exists" — the FTS5 triggers must be wired correctly).
//   (4) pre-existing projects/agents/sessions rows in the legacy DB are completely untouched (additive
//       migration never mutates unrelated data).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pm-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-project-memory.db");

const projId = randomUUID();
const agentId = randomUUID();
const sessId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-2fd9abf9) DB shape directly, bypassing the Db class entirely =====
{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      archived_at TEXT,
      reserved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      startup_prompt TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      profile_id TEXT,
      endpoint INTEGER NOT NULL DEFAULT 0,
      io_schema TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      engine_session_id TEXT,
      title TEXT,
      cwd TEXT NOT NULL,
      process_state TEXT NOT NULL DEFAULT 'none',
      resumability TEXT NOT NULL DEFAULT 'unknown',
      busy INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error TEXT,
      role TEXT
    );
    -- NO project_memory table, NO project_memory_fts virtual table, NO triggers — the true pre-2fd9abf9
    -- shape every existing Loom install has today.
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position, profile_id, endpoint, io_schema) VALUES (?, ?, 'Dev', '', 0, NULL, 0, NULL)")
    .run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, NULL, NULL, ?, 'exited', 'unknown', 0, ?, ?, NULL, 'worker')",
  ).run(sessId, projId, agentId, projId, t0, t0);

  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-project_memory) DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-project_memory DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    const raw2 = new Database(dbFile, { readonly: true });
    try {
      // ===== (2) project_memory + project_memory_fts + all 3 sync triggers exist post-construct =====
      const table = raw2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_memory'").get();
      check("(2) project_memory table was created", table !== undefined);
      const ftsTable = raw2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_memory_fts'").get();
      check("(2) project_memory_fts virtual table was created (FTS5 compiled into better-sqlite3)", ftsTable !== undefined);
      const triggers = raw2.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'project_memory_%'").all().map((r) => r.name);
      check("(2) all three sync triggers exist (ai/ad/au)",
        ["project_memory_ai", "project_memory_ad", "project_memory_au"].every((n) => triggers.includes(n)));

      // ===== (4) pre-existing rows are completely untouched =====
      const legacyProject = raw2.prepare("SELECT * FROM projects WHERE id = ?").get(projId);
      check("(4) the legacy project row is untouched", legacyProject?.name === "Legacy Project");
      const legacySession = raw2.prepare("SELECT * FROM sessions WHERE id = ?").get(sessId);
      check("(4) the legacy session row is untouched", legacySession?.role === "worker");
    } finally {
      raw2.close();
    }

    // ===== (3) the full write → search → upsert → evict → forget round-trip WORKS against the
    // upgraded-in-place DB (proves the FTS5 triggers are wired correctly, not just "the table exists") =====
    const w1 = db.upsertProjectMemory(projId, { key: "post-migration-note", text: "a note written after the migration ran, on an upgraded DB" }, 500);
    check("(3) a write against the upgraded DB succeeds", !!w1.id);
    const w2 = db.upsertProjectMemory(projId, { key: "post-migration-note", text: "UPDATED after migration" }, 500);
    check("(3) upsert-by-key still works post-migration (same row, new text)", w2.id === w1.id && w2.text === "UPDATED after migration");
    const hits = db.searchProjectMemory(projId, "note written after the migration", 10);
    check("(3) FTS5 search finds it post-migration (the triggers actually synced the index)",
      hits.some((r) => r.key === "post-migration-note"));
    const deleted = db.deleteProjectMemory(projId, "post-migration-note");
    check("(3) memory_forget works post-migration", deleted === true);
    check("(3) the FTS index no longer matches after delete (delete trigger fired)",
      db.searchProjectMemory(projId, "note written after the migration", 10).length === 0);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

// ===== SECOND scenario (card a5f98bb4): a pre-`version`-column project_memory DB — the exact shape
// every real Loom install has TODAY, after card 2fd9abf9 shipped project_memory but BEFORE this card
// added the optimistic-concurrency `version` column. Proves migrateProjectMemory() (an ADD COLUMN, not a
// CREATE TABLE) actually reaches an existing table with real rows in it, backfills version=1 in place,
// and that the version-based CAS guard works correctly against a note that predates the migration.
// A SEPARATE tmp dir — the first scenario's `finally` above already deleted `tmpHome`.
const tmpHome2 = path.join(os.tmpdir(), `loom-pm-version-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome2, { recursive: true });
const dbFile2 = path.join(tmpHome2, "legacy-pre-version-column.db");
const projId2 = randomUUID();
const noteId2 = randomUUID();
const t1 = "2026-01-01T00:00:00.000Z";

{
  const raw = new Database(dbFile2);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT, reserved INTEGER NOT NULL DEFAULT 0
    );
    -- project_memory WITHOUT the version column — the real pre-a5f98bb4 shape (mirrors db.ts SCHEMA minus
    -- the version line this card adds).
    CREATE TABLE project_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      key TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_retrieved_at TEXT,
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_id, key)
    );
    CREATE INDEX idx_project_memory_project ON project_memory(project_id, pinned, last_retrieved_at);
    CREATE VIRTUAL TABLE project_memory_fts USING fts5(title, text, content='project_memory', content_rowid='rowid');
    CREATE TRIGGER project_memory_ai AFTER INSERT ON project_memory BEGIN
      INSERT INTO project_memory_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
    END;
    CREATE TRIGGER project_memory_ad AFTER DELETE ON project_memory BEGIN
      INSERT INTO project_memory_fts(project_memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
    END;
    CREATE TRIGGER project_memory_au AFTER UPDATE OF title, text ON project_memory BEGIN
      INSERT INTO project_memory_fts(project_memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
      INSERT INTO project_memory_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
    END;
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId2, "Pre-Version Project", projId2, projId2, t1);
  // A real pre-existing note, written before version existed — this is the row the migration must reach.
  raw.prepare(
    "INSERT INTO project_memory (id, project_id, key, title, text, pinned, tags, created_at, updated_at, last_retrieved_at, retrieval_count) VALUES (?, ?, 'pre-existing-note', 'A note from before the CAS guard', 'this note predates the version column', 0, '[]', ?, ?, NULL, 0)",
  ).run(noteId2, projId2, t1, t1);
  raw.close();
}

let db2;
try {
  let ctorError2 = null;
  try {
    const { Db } = await import("../dist/db.js");
    db2 = new Db(dbFile2);
  } catch (err) {
    ctorError2 = err;
  }
  check("(v-migrate) constructing Db against a pre-version-column project_memory DB does not throw", ctorError2 === null);
  if (ctorError2) console.log(`    threw: ${ctorError2?.stack || ctorError2}`);

  if (!ctorError2) {
    const raw2 = new Database(dbFile2, { readonly: true });
    try {
      const cols = (raw2.prepare("PRAGMA table_info(project_memory)").all()).map((c) => c.name);
      check("(v-migrate) the `version` column was added to the existing table", cols.includes("version"));
    } finally {
      raw2.close();
    }

    // ===== the pre-existing row is backfilled to version=1, untouched otherwise =====
    const preExisting = db2.getProjectMemoryByKey(projId2, "pre-existing-note");
    check("(v-migrate) the pre-existing note is still readable post-migration", preExisting?.text === "this note predates the version column");
    check("(v-migrate) the pre-existing note backfills to version 1 (the same starting point a brand-new note gets)", preExisting?.version === 1);

    // ===== the version-based CAS guard works correctly against this migrated-in row =====
    const staleAttempt = db2.upsertProjectMemoryChecked(projId2, { key: "pre-existing-note", text: "a race, using the wrong version" }, 500, 999);
    check("(v-migrate) a stale baseVersion against a MIGRATED row is correctly rejected", staleAttempt.ok === false && staleAttempt.current.text === "this note predates the version column");
    const correctAttempt = db2.upsertProjectMemoryChecked(projId2, { key: "pre-existing-note", text: "the real next edit" }, 500, preExisting.version);
    check("(v-migrate) the CORRECT baseVersion (1, from the backfill) against a MIGRATED row succeeds", correctAttempt.ok === true && correctAttempt.entry.text === "the real next edit");
    check("(v-migrate) the version bumped to 2 on that first post-migration update", correctAttempt.entry.version === 2);
  }
} finally {
  try { db2?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome2, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-project_memory legacy DB (the brand-new-table CREATE TABLE IF NOT EXISTS additive migration never references data that isn't there yet), project_memory + project_memory_fts + all three sync triggers land correctly, pre-existing rows are untouched, and the full write/search/upsert/evict/forget round-trip works against the upgraded-in-place DB (not just table-exists — the FTS5 triggers are actually wired). Also: Db boots clean against a real pre-`version`-column project_memory DB (card a5f98bb4), migrateProjectMemory() ADD COLUMNs `version` and backfills every pre-existing row to 1 in place, and the version-based optimistic-concurrency guard (stale-rejected, correct-accepted, version bumps by exactly 1) works correctly against a note that predates the migration — not just against brand-new rows."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
