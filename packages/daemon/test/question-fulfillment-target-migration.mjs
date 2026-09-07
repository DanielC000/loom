import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card 3880f783's `fulfillment_target` column — per the project's DB-schema-
// change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY of a REAL
// pre-migration `questions` shape, not just a fresh LOOM_HOME (a fresh DB is blind to a SCHEMA statement
// that references something only a migration was supposed to add — the exact bug class this project has
// already shipped once). Mirrors `question-filed-by-session-id-migration.mjs`'s precedent exactly, scoped
// to this one new column: we synthesize the FULL pre-3880f783 `questions` shape directly with
// better-sqlite3 (every column that exists today EXCEPT `fulfillment_target`), insert real pending/
// answered permission rows, then construct a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a `questions` table that predates `fulfillment_target`.
//   (2) the column now exists (migrateQuestions()'s ADD COLUMN ran).
//   (3) every pre-existing row reads fulfillmentTarget:null (no fabricated backfill) and its `fulfillment`
//       shape (via questionPullItem/questionAnswerByType) surfaces {state:"unknown", detail:null} — the
//       EXACT status-quo behavior that row has always had, never a false "not_yet_done".
//   (4) a pre-existing row's OTHER fields (state, chosenOption, decidedScope) are untouched by the migration.
//   (5) a BRAND-NEW permission ask against the migrated DB can declare a fulfillmentTarget, and it round-
//       trips through computeFulfillment exactly as it does on a fresh install.
//   (6) INVERSE CHECK: no index/constraint in the base schema references `fulfillment_target` — the
//       synthesized pre-migration table (with no such column at all) boots, migrates, and serves every
//       existing questions index (idx_questions_session, idx_questions_state_answered) without error.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-fulfillment-target-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-q-fulfillment-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-fulfillment.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the FULL pre-3880f783 `questions` shape directly, bypassing the Db class entirely —
// every column that exists TODAY except `fulfillment_target` =====
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
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, description TEXT NOT NULL DEFAULT '',
      allow_delta TEXT NOT NULL DEFAULT '[]', skills TEXT, model TEXT, icon TEXT,
      browser_testing INTEGER NOT NULL DEFAULT 0, document_conversion INTEGER NOT NULL DEFAULT 0,
      vault_write INTEGER NOT NULL DEFAULT 0, restricted_tools INTEGER NOT NULL DEFAULT 0,
      no_commit INTEGER NOT NULL DEFAULT 0, connections TEXT NOT NULL DEFAULT '[]',
      capabilities TEXT NOT NULL DEFAULT '[]', harness TEXT
    );
    -- The pre-3880f783 shape — every column questions has TODAY except fulfillment_target.
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
      escalated_at TEXT,
      acknowledged_until TEXT
    );
    CREATE INDEX idx_questions_session ON questions(session_id, state);
    CREATE INDEX idx_questions_state_answered ON questions(state, answered_at);
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Manager', '', 0)")
    .run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(mgrId, projId, agentId, `eng-${mgrId}`, projId, t0, t0);
  // A real profile a post-migration ask can declare a fulfillmentTarget against (below).
  raw.prepare(
    "INSERT INTO profiles (id, name, role, description, allow_delta, skills, model, icon) VALUES ('legacy-prof', 'LegacyProf', 'worker', '', '[]', NULL, NULL, NULL)",
  ).run();

  // A real ANSWERED legacy permission question — asked and answered before fulfillmentTarget existed;
  // no target was ever declared (the column didn't exist), so this row must read "unknown" forever, not
  // a false "not_yet_done".
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, permission_action, decided_scope, decided_expires_at, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, 'permission', ?, ?, ?, 'standing', NULL, 'answered', 'authorize', NULL, ?, ?, NULL)`,
  ).run("legacy-permission-answered", mgrId, projId, "Restart the worker?", "legacy answer path", "restart worker", t0, t0);
  // A real PENDING legacy permission question.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, permission_action, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, 'permission', ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`,
  ).run("legacy-permission-pending", mgrId, projId, "Force-push main?", "recovering a bad merge", "force-push origin/main", t0);

  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration `questions` table has NO fulfillment_target column yet", !cols.has("fulfillment_target"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-fulfillment_target DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-fulfillment_target `questions` DB does not throw", ctorError === null);
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
    check("(2) column 'fulfillment_target' was added by migrateQuestions()", cols2.has("fulfillment_target"));

    // ===== (3) every pre-existing row reads fulfillmentTarget:null and fulfillment:{state:"unknown"} =====
    const { questionPullItem, questionAnswerByType } = await import("../dist/mcp/questionTool.js");
    const answeredLegacy = db.getQuestion("legacy-permission-answered");
    const pendingLegacy = db.getQuestion("legacy-permission-pending");
    check("(3) an answered legacy permission row reads fulfillmentTarget:null (never a fabricated target)", answeredLegacy?.fulfillmentTarget === null);
    check("(3) a pending legacy permission row ALSO reads fulfillmentTarget:null", pendingLegacy?.fulfillmentTarget === null);
    const answeredShape = questionAnswerByType(answeredLegacy, db);
    const pendingShape = questionAnswerByType(pendingLegacy, db);
    check("(3) the answered legacy row's fulfillment reads {state:\"unknown\", detail:null} — status quo, never a false not_yet_done", answeredShape.fulfillment?.state === "unknown" && answeredShape.fulfillment?.detail === null);
    check("(3) the pending legacy row's fulfillment ALSO reads {state:\"unknown\", detail:null}", pendingShape.fulfillment?.state === "unknown" && pendingShape.fulfillment?.detail === null);

    // ===== (4) the pre-existing rows' other fields are untouched by this migration =====
    check("(4) the answered legacy row's decidedScope survived untouched", answeredLegacy?.decidedScope === "standing");
    check("(4) the answered legacy row's chosenOption survived untouched", answeredLegacy?.chosenOption === "authorize");
    check("(4) the pending legacy row's state is still 'pending'", pendingLegacy?.state === "pending");
    check("(4) the pending legacy row's permissionAction survived untouched", pendingLegacy?.permissionAction === "force-push origin/main");

    // ===== (5) a BRAND-NEW permission ask against the migrated DB can declare a fulfillmentTarget, and it
    // round-trips through computeFulfillment exactly as it does on a fresh install =====
    const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
    const built = buildQuestionAsk(
      { type: "permission", title: "Post-migration fulfillment ask", body: "on the upgraded DB", action: "set harness", fulfillmentTarget: { profileId: "legacy-prof", key: "harness" } },
      { sessionId: mgrId, projectId: projId, db, role: "manager" },
    );
    check("(5) a post-migration ask accepts a fulfillmentTarget", "question" in built && built.question.fulfillmentTarget?.key === "harness");
    db.insertQuestion(built.question);
    db.answerQuestion(built.question.id, { chosenOption: "authorize", note: null, answeredAt: new Date().toISOString() });
    const postMigrationItem = questionPullItem(db.getQuestion(built.question.id), db);
    check("(5) the post-migration ask's declared target reads not_yet_done (profile's harness is unset)", postMigrationItem.fulfillment?.state === "not_yet_done");
    db.updateProfile("legacy-prof", { harness: "codex" });
    const postMigrationFulfilled = questionPullItem(db.getQuestion(built.question.id), db);
    check("(5) the SAME post-migration row flips to fulfilled once the live profile value matches", postMigrationFulfilled.fulfillment?.state === "fulfilled");

    // ===== (6) INVERSE CHECK: every pre-existing index still resolves fine post-migration (nothing in the
    // base schema referenced fulfillment_target before it existed, and the new column carries no index of
    // its own — this just confirms the migrated table's existing indexes are intact and queryable) =====
    let indexError = null;
    try {
      db.getQuestion("legacy-permission-pending"); // exercises idx_questions_session (session_id, state)
      db.listOpenQuestions(true); // exercises idx_questions_state_answered (state, answered_at)
    } catch (err) {
      indexError = err;
    }
    check("(6) pre-existing questions indexes still resolve post-migration, no error", indexError === null);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-3880f783 `questions` DB (no fulfillment_target column), migrateQuestions() ADD-COLUMNs it on upgrade, every pre-existing permission row (answered and pending alike) reads fulfillmentTarget:null and fulfillment:{state:\"unknown\",detail:null} rather than a fabricated target or a false not_yet_done, other fields are untouched, a brand-new post-migration ask can declare + observe a fulfillmentTarget exactly like a fresh install, and the table's pre-existing indexes remain queryable."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
