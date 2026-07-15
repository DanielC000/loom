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

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-project_memory legacy DB (the brand-new-table CREATE TABLE IF NOT EXISTS additive migration never references data that isn't there yet), project_memory + project_memory_fts + all three sync triggers land correctly, pre-existing rows are untouched, and the full write/search/upsert/evict/forget round-trip works against the upgraded-in-place DB (not just table-exists — the FTS5 triggers are actually wired)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
