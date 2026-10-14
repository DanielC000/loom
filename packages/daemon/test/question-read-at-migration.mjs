import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card 54007ab7 (Phase 2 of 59fa6403)'s `read_at` column — per the project's
// DB-schema-change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY
// of a REAL pre-migration `questions` shape, not just a fresh LOOM_HOME (a fresh DB is blind to a SCHEMA
// statement that references something only a migration was supposed to add). Mirrors
// question-acknowledged-until-migration.mjs's precedent, scoped to this one new column: we synthesize
// the FULL pre-54007ab7 `questions` shape directly with better-sqlite3 (every column that exists today
// EXCEPT `read_at`, acknowledged_until included since that migration already shipped), insert a real
// pending row (with a non-null acknowledged_until, to prove an UNRELATED migrate-added column survives
// untouched too), then construct a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a `questions` table that predates `read_at`.
//   (2) the column now exists (migrateQuestions()'s ADD COLUMN ran).
//   (3) the pre-existing legacy row reads readAt:null (never read) — its OTHER fields (state, body,
//       acknowledgedUntil) are untouched by the migration.
//   (4) `markQuestionsRead` works against the migrated DB: it stamps the row, reads back via
//       getQuestion/getQuestionInboxItem, is idempotent (a second call never re-stamps/overwrites an
//       already-read row), and a no-op on an unknown id returns an empty updated list.
//   (5) the base (unmigrated) schema's own indexes never reference `read_at` — the inverse check this
//       doctrine also asks for (no base-schema index/constraint may reference a migration-added column,
//       mirroring escalated_at's/acknowledged_until's own caveat).
//
// Run: 1) build (turbo builds shared first), 2) node test/question-read-at-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-q-readat-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-readat.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";
const legacyId = "legacy-pending-unread";

// ===== Synthesize the FULL pre-54007ab7 `questions` shape directly, bypassing the Db class entirely —
// every column that exists TODAY except `read_at` =====
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
      body TEXT NOT NULL DEFAULT '', column_key TEXT NOT NULL, position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    -- The pre-54007ab7 shape — every column questions has TODAY except read_at.
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
      fulfillment_target TEXT,
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
      escalated_at TEXT,
      acknowledged_until TEXT
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

  // A real, already-snoozed (acknowledged_until set) pending question — never read, per `read_at` NULL.
  raw.prepare(
    `INSERT INTO questions (id, session_id, filed_by_session_id, project_id, type, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at, acknowledged_until)
     VALUES (?, ?, ?, ?, 'decision', ?, ?, NULL, NULL, 'pending', NULL, NULL, ?, NULL, NULL, ?)`,
  ).run(legacyId, mgrId, mgrId, projId, "Any blockers?", "pure blocker, no options", t0, "2099-01-01T00:00:00.000Z");

  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration `questions` table has NO read_at column yet", !cols.has("read_at"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-read_at DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-read_at `questions` DB does not throw", ctorError === null);
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
    check("(2) column 'read_at' was added by migrateQuestions()", cols2.has("read_at"));

    // ===== (3) the pre-existing legacy row reads readAt:null; other fields untouched =====
    const legacy = db.getQuestion(legacyId);
    check("(3) a never-read legacy row reads readAt:null", legacy?.readAt === null);
    check("(3) the legacy row's acknowledgedUntil survived untouched (an unrelated migrate-added column)", legacy?.acknowledgedUntil === "2099-01-01T00:00:00.000Z");
    check("(3) the legacy row's state is still 'pending'", legacy?.state === "pending");
    check("(3) the legacy row's body survived untouched", legacy?.body === "pure blocker, no options");

    // ===== (4) markQuestionsRead works against the migrated DB: stamp, read back, idempotent, no-op =====
    const readAt1 = "2026-02-01T00:00:00.000Z";
    const updated1 = db.markQuestionsRead([legacyId], readAt1);
    check("(4) markQuestionsRead returns the id it actually updated", updated1.length === 1 && updated1[0] === legacyId);
    const rereadViaGetQuestion = db.getQuestion(legacyId);
    check("(4) the stamp persisted — a fresh getQuestion sees it", rereadViaGetQuestion?.readAt === readAt1);
    const inboxItem = db.getQuestionInboxItem(legacyId);
    check("(4) getQuestionInboxItem (the web-facing enriched read) also carries the stamp", inboxItem?.readAt === readAt1);
    // Idempotent: a SECOND stamp attempt with a LATER instant must never overwrite the first-read time.
    const readAt2 = "2026-03-01T00:00:00.000Z";
    const updated2 = db.markQuestionsRead([legacyId], readAt2);
    check("(4) re-marking an already-read row is a no-op (no id reported updated)", updated2.length === 0);
    const rereadAgain = db.getQuestion(legacyId);
    check("(4) read_at stays pinned to the FIRST stamp, never overwritten by a later call", rereadAgain?.readAt === readAt1);
    check("(4) markQuestionsRead on an unknown id returns an empty list (no row to update)", db.markQuestionsRead(["does-not-exist"], readAt1).length === 0);
    check("(4) markQuestionsRead on an empty id list returns an empty list, no-op", db.markQuestionsRead([], readAt1).length === 0);

    // ===== (5) inverse check: the BASE (unmigrated) schema's own indexes never reference the new column —
    // read_at has no index of its own today, so a naive "does any index mention it" grep must return
    // zero; POSITIVE-CONTROLLED against escalated_at's own real index so a broken pattern can't
    // masquerade as a true absence. =====
    const idxSql = raw2Reopen(dbFile);
    const mentionsReadAt = idxSql.some((sql) => sql && sql.includes("read_at"));
    const mentionsEscalatedAt = idxSql.some((sql) => sql && sql.includes("escalated_at"));
    check("(5) POSITIVE CONTROL: escalated_at's own index IS found by this same scan (pattern works)", mentionsEscalatedAt);
    check("(5) no index/constraint on the migrated DB references read_at (nothing to migrate-order against)", !mentionsReadAt);
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
  ? "\n✅ ALL PASS — Db boots clean against a real pre-54007ab7 `questions` DB (no read_at column), migrateQuestions() ADD-COLUMNs it on upgrade, the pre-existing legacy row reads readAt:null with every other field (incl. an unrelated migrate-added column) untouched, markQuestionsRead stamps/reads/idempotently-skips it correctly post-migration, and no index references the new column."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
