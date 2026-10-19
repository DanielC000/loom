import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card 432765ab's `attachments_json` column — per the project's DB-schema-change
// doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY of a REAL
// pre-migration `questions` shape, not just a fresh LOOM_HOME. Mirrors
// question-acknowledged-until-migration.mjs's precedent exactly, scoped to this one new column: we
// synthesize the FULL pre-432765ab `questions` shape directly with better-sqlite3 (every column that
// exists today EXCEPT `attachments_json`), insert a real legacy row, then construct a REAL `Db` against
// it and prove:
//   (1) the constructor does NOT throw on a `questions` table that predates `attachments_json`.
//   (2) the column now exists (migrateQuestions()'s ADD COLUMN ran).
//   (3) the pre-existing legacy row reads `attachments: []` (never null — every reader iterates without a
//       null-check) — its OTHER fields are untouched by the migration.
//   (4) insertQuestion's new 2nd (attachments) param round-trips through toQuestion correctly on a FRESH
//       row against this SAME migrated DB: the public shape never carries `originalPath`/`storedFilename`
//       (mirrors `secret_blob` never reaching `Question`), and `available` is computed LIVE (true while the
//       store file exists, flips to false the instant it's deleted — consistent with the GC child card
//       6f27469b removing files out from under an unchanged row, never stored/stale).
//   (5) inverse check: the BASE (unmigrated) schema's own indexes never reference `attachments_json` — no
//       index/constraint anywhere references this column at all (deliberate — see CLAUDE.md's "no
//       base-schema index may reference a migrate-added column" rule), POSITIVE-CONTROLLED against
//       idx_questions_task's own real index so a broken scan pattern can't masquerade as a true absence.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/attachment-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-attach-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-attachments.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";
const legacyId = "legacy-no-attachments";

// ===== Synthesize the FULL pre-432765ab `questions` shape directly, bypassing the Db class entirely —
// every column that exists TODAY except `attachments_json` =====
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
    -- The pre-432765ab shape — every column questions has TODAY except attachments_json.
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
      acknowledged_until TEXT,
      read_at TEXT
    );
    CREATE INDEX idx_questions_session ON questions(session_id, state);
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

  // A real, already-ANSWERED legacy question — predates attachments entirely.
  raw.prepare(
    `INSERT INTO questions (id, session_id, filed_by_session_id, project_id, type, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, ?, 'decision', ?, ?, NULL, NULL, 'answered', 'yes', 'approved', ?, ?, NULL)`,
  ).run(legacyId, mgrId, mgrId, projId, "Ship it?", "no attachments on this one", t0, t0);

  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration `questions` table has NO attachments_json column yet", !cols.has("attachments_json"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-attachments_json DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-attachments_json `questions` DB does not throw", ctorError === null);
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
    check("(2) column 'attachments_json' was added by migrateQuestions()", cols2.has("attachments_json"));

    // ===== (3) the pre-existing legacy row reads attachments:[]; other fields untouched =====
    const legacy = db.getQuestion(legacyId);
    check("(3) a legacy row (predates the column) reads attachments: [] — never null", Array.isArray(legacy?.attachments) && legacy.attachments.length === 0);
    check("(3) the legacy row's state survived untouched", legacy?.state === "answered");
    check("(3) the legacy row's note survived untouched", legacy?.note === "approved");
    const legacyInbox = db.getQuestionInboxItem(legacyId);
    check("(3) the web-facing enriched read (getQuestionInboxItem) also carries attachments: []", Array.isArray(legacyInbox?.attachments) && legacyInbox.attachments.length === 0);

    // ===== (4) a FRESH row's attachments round-trip correctly against this SAME migrated DB, with the
    // public shape never carrying originalPath/storedFilename, and `available` computed LIVE =====
    const { questionAttachmentDir } = await import("../dist/paths.js");
    const freshId = "fresh-with-attachment";
    const storeDir = questionAttachmentDir(freshId);
    fs.mkdirSync(storeDir, { recursive: true });
    const storedFilename = "0-screenshot.png";
    fs.writeFileSync(path.join(storeDir, storedFilename), Buffer.from([1, 2, 3]));
    const stored = [{
      id: "0", label: "Screenshot", kind: "image", sizeBytes: 3,
      imageDimensions: { width: 10, height: 5 }, storedFilename,
      originalPath: "/some/worker/worktree/screenshot.png", openedAt: null,
    }];
    db.insertQuestion({
      id: freshId, sessionId: mgrId, filedBySessionId: mgrId, projectId: projId, type: "decision",
      title: "Look at this", body: "attached a screenshot",
      options: null, recommendation: null, taskId: null,
      permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
      decidedScope: null, decidedExpiresAt: null, credentialEnvVar: null, credentialByteLength: null,
      provisionTarget: null, fulfillmentTarget: null, provisionConnectionId: null, provisionBindingState: "none",
      state: "pending", chosenOption: null, note: null,
      createdAt: t0, answeredAt: null, consumedAt: null,
      cancelledReason: null, cancelledBy: null, cancelledAt: null,
      escalatedAt: null, acknowledgedUntil: null, readAt: null,
      attachments: [],
    }, stored);
    const fresh = db.getQuestion(freshId);
    check("(4) a fresh row's public attachments array has exactly one entry", fresh?.attachments.length === 1);
    const pub = fresh.attachments[0];
    check("(4) the public shape carries id/label/kind/sizeBytes/imageDimensions", pub.id === "0" && pub.label === "Screenshot" && pub.kind === "image" && pub.sizeBytes === 3 && pub.imageDimensions.width === 10);
    check("(4) the public shape NEVER carries originalPath", !("originalPath" in pub));
    check("(4) the public shape NEVER carries storedFilename", !("storedFilename" in pub));
    check("(4) available is true while the store file exists", pub.available === true);
    fs.rmSync(path.join(storeDir, storedFilename));
    const freshAfterDelete = db.getQuestion(freshId);
    check("(4) available recomputes LIVE to false the instant the store file is gone — never stale/stored", freshAfterDelete.attachments[0].available === false);

    // ===== (5) inverse check: no index/constraint anywhere references attachments_json =====
    const idxSql = raw2Reopen(dbFile);
    const mentionsAttachments = idxSql.some((sql) => sql && sql.includes("attachments_json"));
    const mentionsTaskId = idxSql.some((sql) => sql && sql.includes("task_id"));
    check("(5) POSITIVE CONTROL: idx_questions_task's own index IS found by this same scan (pattern works)", mentionsTaskId);
    check("(5) no index/constraint on the migrated DB references attachments_json (deliberately no index at all)", !mentionsAttachments);
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
  ? "\n✅ ALL PASS — Db boots clean against a real pre-432765ab `questions` DB (no attachments_json column), migrateQuestions() ADD-COLUMNs it on upgrade, a legacy row reads attachments:[], a fresh row's attachments round-trip through the public-safe shape with available computed live, and no index references the new column."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
