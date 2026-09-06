import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card 889ae619 (iii-a)'s `acknowledged_until` column — per the project's
// DB-schema-change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY
// of a REAL pre-migration `questions` shape, not just a fresh LOOM_HOME (a fresh DB is blind to a SCHEMA
// statement that references something only a migration was supposed to add). Mirrors
// question-filed-by-session-id-migration.mjs's precedent, scoped to this one new column: we synthesize
// the FULL pre-889ae619 `questions` shape directly with better-sqlite3 (every column that exists today
// EXCEPT `acknowledged_until`), insert a real STALE pending row (escalated_at set — the exact state this
// snooze exists to suppress), then construct a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a `questions` table that predates `acknowledged_until`.
//   (2) the column now exists (migrateQuestions()'s ADD COLUMN ran).
//   (3) the pre-existing stale row reads acknowledgedUntil:null (never snoozed) — its OTHER fields
//       (state, escalatedAt, chosenOption) are untouched by the migration.
//   (4) `acknowledgeQuestion` works against the migrated DB: it stamps a future ISO instant, reads back
//       via getQuestion/getQuestionInboxItem, and un-snoozes cleanly back to null.
//   (5) the base (unmigrated) schema's own indexes never reference `acknowledged_until` — the inverse
//       check this doctrine also asks for (no base-schema index/constraint may reference a
//       migration-added column, mirroring escalated_at's own idx_questions_pending_unescalated caveat).
//
// Run: 1) build (turbo builds shared first), 2) node test/question-acknowledged-until-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-q-ackuntil-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-ackuntil.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";
const staleId = "legacy-stale-pending";

// ===== Synthesize the FULL pre-889ae619 `questions` shape directly, bypassing the Db class entirely —
// every column that exists TODAY except `acknowledged_until` =====
{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      agent_id TEXT NOT NULL REFERENCES agents(id), engine_session_id TEXT, title TEXT, cwd TEXT NOT NULL,
      process_state TEXT NOT NULL DEFAULT 'none', resumability TEXT NOT NULL DEFAULT 'unknown',
      busy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity TEXT NOT NULL,
      last_error TEXT, role TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', column_key TEXT NOT NULL, position REAL NOT NULL DEFAULT 0
    );
    -- The pre-889ae619 shape — every column questions has TODAY except acknowledged_until.
    CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      filed_by_session_id TEXT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL DEFAULT 'decision',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      options_json TEXT,
      recommendation TEXT,
      task_id TEXT,
      permission_action TEXT,
      permission_scope TEXT,
      permission_expires_at TEXT,
      decided_scope TEXT,
      decided_expires_at TEXT,
      credential_env_var TEXT,
      secret_blob TEXT,
      provision_target TEXT,
      provision_connection_id TEXT,
      provision_binding_state TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      chosen_option TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      consumed_at TEXT,
      last_surfaced_state TEXT,
      last_surfaced_at TEXT,
      cancelled_reason TEXT,
      cancelled_by TEXT,
      cancelled_at TEXT,
      escalated_at TEXT
    );
    CREATE INDEX idx_questions_session ON questions(session_id, state);
    CREATE INDEX idx_questions_state_answered ON questions(state, answered_at);
    CREATE INDEX idx_questions_task ON questions(task_id);
    CREATE INDEX idx_questions_pending_unescalated ON questions(created_at) WHERE state = 'pending' AND escalated_at IS NULL;
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Manager', '', 0)")
    .run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(mgrId, projId, agentId, `eng-${mgrId}`, projId, t0, t0);

  // A real, already-STALE (escalated) pending question — exactly the row this snooze exists to suppress.
  raw.prepare(
    `INSERT INTO questions (id, session_id, filed_by_session_id, project_id, type, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at, escalated_at)
     VALUES (?, ?, ?, ?, 'decision', ?, ?, NULL, NULL, 'pending', NULL, NULL, ?, NULL, NULL, ?)`,
  ).run(staleId, mgrId, mgrId, projId, "Any blockers?", "pure blocker, no options", t0, "2026-01-02T00:00:00.000Z");

  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration `questions` table has NO acknowledged_until column yet", !cols.has("acknowledged_until"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-acknowledged_until DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-acknowledged_until `questions` DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) the column now exists =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols2;
    try {
      cols2 = new Set(raw2.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
    } finally {
      raw2.close();
    }
    check("(2) column 'acknowledged_until' was added by migrateQuestions()", cols2.has("acknowledged_until"));

    // ===== (3) the pre-existing stale row reads acknowledgedUntil:null; other fields untouched =====
    const staleLegacy = db.getQuestion(staleId);
    check("(3) a never-snoozed legacy row reads acknowledgedUntil:null", staleLegacy?.acknowledgedUntil === null);
    check("(3) the legacy row's escalatedAt survived untouched", staleLegacy?.escalatedAt === "2026-01-02T00:00:00.000Z");
    check("(3) the legacy row's state is still 'pending'", staleLegacy?.state === "pending");
    check("(3) the legacy row's body survived untouched", staleLegacy?.body === "pure blocker, no options");

    // ===== (4) acknowledgeQuestion works against the migrated DB: stamp, read back, un-snooze =====
    const future = "2099-01-01T00:00:00.000Z";
    const acked = db.acknowledgeQuestion(staleId, future);
    check("(4) acknowledgeQuestion returns the updated row with the new acknowledgedUntil", acked?.acknowledgedUntil === future);
    check("(4) acknowledgeQuestion did NOT touch state (still 'pending', still answerable)", acked?.state === "pending");
    const rereadViaGetQuestion = db.getQuestion(staleId);
    check("(4) the snooze persisted — a fresh getQuestion also sees it", rereadViaGetQuestion?.acknowledgedUntil === future);
    const inboxItem = db.getQuestionInboxItem(staleId);
    check("(4) getQuestionInboxItem (the web-facing enriched read) also carries the snooze", inboxItem?.acknowledgedUntil === future);
    const unsnoozed = db.acknowledgeQuestion(staleId, null);
    check("(4) passing null un-snoozes cleanly back to null", unsnoozed?.acknowledgedUntil === null);
    check("(4) acknowledgeQuestion on an unknown id returns undefined (no row to update)", db.acknowledgeQuestion("does-not-exist", future) === undefined);

    // ===== (5) inverse check: the BASE (unmigrated) schema's own indexes never reference the new column —
    // acknowledged_until has no index of its own today, so a naive "does any index mention it" grep must
    // return zero; POSITIVE-CONTROLLED against escalated_at's own real index so a broken pattern can't
    // masquerade as a true absence. =====
    const idxSql = raw2Reopen(dbFile);
    const mentionsAcknowledgedUntil = idxSql.some((sql) => sql && sql.includes("acknowledged_until"));
    const mentionsEscalatedAt = idxSql.some((sql) => sql && sql.includes("escalated_at"));
    check("(5) POSITIVE CONTROL: escalated_at's own index IS found by this same scan (pattern works)", mentionsEscalatedAt);
    check("(5) no index/constraint on the migrated DB references acknowledged_until (nothing to migrate-order against)", !mentionsAcknowledgedUntil);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

function raw2Reopen(file) {
  const raw = new Database(file, { readonly: true });
  try {
    return raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'questions'").all().map((r) => r.sql);
  } finally {
    raw.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-889ae619 `questions` DB (no acknowledged_until column), migrateQuestions() ADD-COLUMNs it on upgrade, the pre-existing stale row reads acknowledgedUntil:null with every other field untouched, acknowledgeQuestion stamps/reads/clears it correctly post-migration, and no index references the new column."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
