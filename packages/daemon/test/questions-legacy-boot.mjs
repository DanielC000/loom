import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for the `questions` table (card 8701bdbb, daemon core / child A) — per the
// project's DB-schema-change doctrine, this must run against a COPY of a REAL pre-migration DB, not
// just a fresh LOOM_HOME (a fresh DB is blind to a SCHEMA statement that references something a
// migration was supposed to add — see db-legacy-boot.mjs / the 2026-07-06 P0). `questions` is a
// brand-new table (no ALTER, no column added to an existing table), so `CREATE TABLE IF NOT EXISTS` in
// exec(SCHEMA) IS itself the additive migration (mirrors runs/poll_jobs/connections) — but we still
// prove it end-to-end against a hand-built pre-`questions` DB, exactly mirroring db-legacy-boot.mjs's
// method: synthesize the legacy shape directly with better-sqlite3 (real projects/agents/sessions
// rows, no `questions` table at all), then construct a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a DB that predates `questions`.
//   (2) the `questions` table + its idx_questions_session index now exist.
//   (3) a question can be inserted referencing a REAL pre-existing (legacy) session row and round-trips
//       through the full ask -> answer -> pull lifecycle against the migrated DB.
//
// Run: 1) build (turbo builds shared first), 2) node test/questions-legacy-boot.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-questions-legacy-boot-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID(); // the pre-existing manager session the legacy DB already had
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize a REAL pre-`questions` DB shape directly, bypassing the Db class entirely =====
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
      archived_at TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      startup_prompt TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0
    );
    -- The pre-questions shape: every column this feature's Db layer reads/writes on sessions already
    -- existed by then (role); no questions table anywhere in this file.
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
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Manager', '', 0)")
    .run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(mgrId, projId, agentId, `eng-${mgrId}`, projId, t0, t0);

  const tables = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
  check("(setup) the synthesized legacy DB has NO questions table yet", !tables.has("questions"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-`questions` DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-questions legacy DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    const raw2 = new Database(dbFile, { readonly: true });
    try {
      // ===== (2) the questions table + its index now exist =====
      const tables = new Set(raw2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
      check("(2) the `questions` table was created", tables.has("questions"));
      const idx = raw2.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_questions_session'",
      ).get();
      check("(2) idx_questions_session was created", idx !== undefined);
    } finally {
      raw2.close();
    }

    // ===== (3) full ask -> answer -> pull lifecycle against the migrated (legacy-turned-current) DB,
    // scoped to the REAL pre-existing session row from the legacy DB =====
    const now = new Date().toISOString();
    db.insertQuestion({
      id: "legacy-q1", sessionId: mgrId, projectId: projId, title: "Proceed with the migration?",
      body: "the legacy DB now has the table", options: ["yes", "no"], recommendation: "yes",
      state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null,
    });
    check("(3) a question inserted against the migrated DB round-trips as 'pending'", db.getQuestion("legacy-q1")?.state === "pending");

    const answered = db.answerQuestion("legacy-q1", { chosenOption: "yes", note: "go", answeredAt: now });
    check("(3) answerQuestion flips it to 'answered' on the migrated DB", answered?.state === "answered");

    const pulled = db.pullAnsweredQuestions(mgrId, now);
    check("(3) pullAnsweredQuestions returns + consumes it, scoped to the legacy session id", pulled.length === 1 && pulled[0].id === "legacy-q1" && db.getQuestion("legacy-q1").state === "consumed");
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-`questions` legacy DB (a brand-new table via CREATE TABLE IF NOT EXISTS needs no ALTER, so exec(SCHEMA) never references a column a later migrate*() would have added), the `questions` table + index land on upgrade, and the full ask -> answer -> pull lifecycle works against a real pre-existing (legacy) session row."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
