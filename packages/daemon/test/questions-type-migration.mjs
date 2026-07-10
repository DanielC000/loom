import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for the Requests-object generalization (card 695ebab0) — per the project's
// DB-schema-change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY
// of a REAL pre-migration DB, not just a fresh LOOM_HOME (a fresh DB is blind to a SCHEMA statement that
// references something a migration was supposed to add). Unlike `questions-legacy-boot.mjs` (which
// covers the ORIGINAL brand-new-table migration, card 8701bdbb), THIS test covers the ADD-COLUMN
// migration this card introduces: a pre-695ebab0 DB already HAS `questions`, but lacks type/task_id/
// permission_*/credential_env_var/secret_blob. We synthesize that exact pre-migration shape directly with
// better-sqlite3 (real projects/agents/sessions rows + real pending/answered/consumed `questions` rows —
// the shape every installed daemon actually has today), then construct a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a DB whose `questions` table predates the type/task_id/
//       permission_*/credential_env_var/secret_blob columns.
//   (2) every QUESTION_ADDED_COLUMNS column now exists.
//   (3) every pre-existing row backfilled to type='decision' (NOT NULL, no dangling legacy value).
//   (4) a pre-existing 'answered' row still pulls correctly via pullAnsweredQuestionsForAgent as
//       type:"decision", carrying the SAME chosenOption/note it had before the migration ran.
//   (5) a pre-existing 'pending' row can still be answered (answerQuestion) and pulled post-migration.
//   (6) a NEW type:"credential" ask against the migrated DB round-trips via answerCredentialQuestion
//       without disturbing the legacy decision rows alongside it.
//
// Run: 1) build (turbo builds shared first), 2) node test/questions-type-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-questions-type-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-type.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize a REAL pre-695ebab0 `questions` shape directly, bypassing the Db class entirely =====
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
    -- The pre-695ebab0 shape (card 8701bdbb, as landed by bdfdeb0) — no type/task_id/permission_*/
    -- credential_env_var/secret_blob columns anywhere.
    CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      options_json TEXT,
      recommendation TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      chosen_option TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      consumed_at TEXT
    );
    CREATE INDEX idx_questions_session ON questions(session_id, state);
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Manager', '', 0)")
    .run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(mgrId, projId, agentId, `eng-${mgrId}`, projId, t0, t0);

  // A real ANSWERED (unpulled) legacy question — the exact "questions table has real rows" scenario the
  // project's migration doctrine calls out.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'answered', ?, ?, ?, ?, NULL)`,
  ).run("legacy-answered", mgrId, projId, "Ship the migration?", "gate is green", JSON.stringify(["yes", "no"]), "yes", "yes", "go", t0, t0);
  // A real PENDING legacy question.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, NULL, ?, NULL, NULL)`,
  ).run("legacy-pending", mgrId, projId, "Any blockers?", "pure blocker, no options", t0);

  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized legacy `questions` table has NO type column yet", !cols.has("type"));
  check("(setup) the synthesized legacy `questions` table has NO secret_blob column yet", !cols.has("secret_blob"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-type-migration DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-type-migration `questions` DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) every added column now exists =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols2;
    try {
      cols2 = new Set(raw2.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
    } finally {
      raw2.close();
    }
    for (const col of ["type", "task_id", "permission_action", "permission_scope", "permission_expires_at", "credential_env_var", "secret_blob"]) {
      check(`(2) column '${col}' was added by migrateQuestions()`, cols2.has(col));
    }

    // ===== (3) every pre-existing row backfilled to type='decision' =====
    const answeredLegacy = db.getQuestion("legacy-answered");
    const pendingLegacy = db.getQuestion("legacy-pending");
    check("(3) the pre-existing 'answered' row backfilled to type:'decision'", answeredLegacy?.type === "decision");
    check("(3) the pre-existing 'pending' row backfilled to type:'decision'", pendingLegacy?.type === "decision");
    check("(3) the backfilled row's new nullable columns stay null (task_id)", answeredLegacy?.taskId === null);
    check("(3) the backfilled row's new nullable columns stay null (credentialEnvVar)", answeredLegacy?.credentialEnvVar === null);

    // ===== (4) the pre-existing 'answered' row still pulls correctly, unchanged, as type:"decision" =====
    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const pulledLegacy = pulled.find((q) => q.id === "legacy-answered");
    check("(4) the legacy answered question is included in the pull", pulledLegacy !== undefined);
    check("(4) it pulls as type:'decision'", pulledLegacy?.type === "decision");
    check("(4) its chosenOption survived the migration untouched", pulledLegacy?.chosenOption === "yes");
    check("(4) its note survived the migration untouched", pulledLegacy?.note === "go");
    check("(4) it's now 'consumed' post-pull", db.getQuestion("legacy-answered")?.state === "consumed");

    // ===== (5) the pre-existing 'pending' row can still be answered + pulled post-migration =====
    const answered = db.answerQuestion("legacy-pending", { chosenOption: null, note: "no blockers", answeredAt: new Date().toISOString() });
    check("(5) the legacy pending row can still be answered post-migration", answered?.state === "answered");
    const pulled2 = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    check("(5) it pulls too, still type:'decision'", pulled2.length === 1 && pulled2[0].id === "legacy-pending" && pulled2[0].type === "decision");

    // ===== (6) a brand-new type:"credential" ask round-trips against the migrated DB =====
    const credId = "new-credential";
    db.insertQuestion({
      id: credId, sessionId: mgrId, projectId: projId, type: "credential",
      title: "Need the Stripe key", body: "for the billing integration",
      options: null, recommendation: null, taskId: null,
      permissionAction: null, permissionScope: null, permissionExpiresAt: null,
      credentialEnvVar: "STRIPE_API_KEY",
      state: "pending", chosenOption: null, note: null,
      createdAt: t0, answeredAt: null, consumedAt: null,
    });
    const credAnswered = db.answerCredentialQuestion(credId, { secretBlob: "v1:aa:bb:cc", answeredAt: new Date().toISOString() });
    check("(6) a new credential ask answers via answerCredentialQuestion on the migrated DB", credAnswered?.state === "answered");
    const pulled3 = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    check("(6) the new credential question pulls too, as type:'credential'", pulled3.length === 1 && pulled3[0].id === credId && pulled3[0].type === "credential");
    check("(6) the pulled credential question never carries secret_blob (not a field on Question at all)", !("secretBlob" in pulled3[0]) && !("secret_blob" in pulled3[0]));
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-695ebab0 `questions` DB (no type/task_id/permission_*/credential_env_var/secret_blob columns), migrateQuestions() ADD-COLUMNs land on upgrade, every pre-existing row backfills to type='decision' in place with its answer untouched, a legacy pending row can still be answered+pulled post-migration, and a brand-new credential ask round-trips cleanly against the same migrated DB."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
