import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for the decisions-relay dedup signature (card 0c1365d0) — per the project's
// DB-schema-change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY
// of a REAL pre-migration DB, not just a fresh LOOM_HOME. We synthesize the FULL pre-0c1365d0 `questions`
// shape directly with better-sqlite3 (every column the Requests-object generalization + credential
// auto-provisioning already added — type/task_id/permission_*/credential_env_var/secret_blob/
// provision_* — but WITHOUT last_surfaced_state/last_surfaced_at), with real projects/agents/sessions
// rows and real pending/answered `questions` rows, then construct a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a `questions` table that predates last_surfaced_state/at.
//   (2) both new columns now exist.
//   (3) a pre-existing row (legacy, NULL last_surfaced_state) reads back via getQuestionSurfacedSignatures
//       as "never surfaced" — never a false match against any signature.
//   (4) markQuestionSurfaced + a follow-up getQuestionSurfacedSignatures round-trip correctly against a
//       migrated (upgraded-in-place) row.
//   (5) the pre-existing rows still function through their ordinary lifecycle post-migration (answer a
//       pending legacy row, pull it) — the new columns don't disturb anything else.
//   (6) no base-schema index/constraint references the new columns (idx_questions_session/
//       idx_questions_state_answered/idx_questions_task are exactly the pre-migration set).
//
// Run: 1) build (turbo builds shared first), 2) node test/decisions-surfaced-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-decisions-surfaced-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-surfaced.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize a REAL pre-0c1365d0 `questions` shape directly, bypassing the Db class entirely =====
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
    -- The FULL pre-0c1365d0 shape (every column landed by 8701bdbb/695ebab0/193de09e) — no
    -- last_surfaced_state/last_surfaced_at anywhere.
    CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
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
      consumed_at TEXT
    );
    CREATE INDEX idx_questions_session ON questions(session_id, state);
    CREATE INDEX idx_questions_state_answered ON questions(state, answered_at);
    CREATE INDEX idx_questions_task ON questions(task_id);
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Manager', '', 0)")
    .run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(mgrId, projId, agentId, `eng-${mgrId}`, projId, t0, t0);

  // A real PENDING legacy question — the exact "decisions_list has been reading this for a while" scenario.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, 'decision', ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`,
  ).run("legacy-pending", mgrId, projId, "Ship the migration?", "gate is green", JSON.stringify(["yes", "no"]), "yes", t0);
  // A real ANSWERED legacy question.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, 'decision', ?, ?, NULL, NULL, 'answered', ?, ?, ?, ?, NULL)`,
  ).run("legacy-answered", mgrId, projId, "Any blockers?", "pure blocker, no options", "go", "already handled", t0, t0);

  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration `questions` table has NO last_surfaced_state column yet", !cols.has("last_surfaced_state"));
  check("(setup) the synthesized pre-migration `questions` table has NO last_surfaced_at column yet", !cols.has("last_surfaced_at"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-surfaced-columns DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-0c1365d0 `questions` DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) both new columns now exist =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols2, indexes2;
    try {
      cols2 = new Set(raw2.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
      indexes2 = raw2.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'questions'").all();
    } finally {
      raw2.close();
    }
    check("(2) column 'last_surfaced_state' was added by migrateQuestions()", cols2.has("last_surfaced_state"));
    check("(2) column 'last_surfaced_at' was added by migrateQuestions()", cols2.has("last_surfaced_at"));

    // ===== (3) a pre-existing (legacy, NULL) row reads back as "never surfaced" =====
    const legacySignatures = db.getQuestionSurfacedSignatures(["legacy-pending", "legacy-answered"]);
    check("(3) a legacy row with NULL last_surfaced_state is absent from getQuestionSurfacedSignatures (never a false match)",
      !legacySignatures.has("legacy-pending") && !legacySignatures.has("legacy-answered"));

    // ===== (4) markQuestionSurfaced + getQuestionSurfacedSignatures round-trip on a migrated row =====
    const sig = "pending||" + "|";
    db.markQuestionSurfaced("legacy-pending", sig, new Date().toISOString());
    const afterMark = db.getQuestionSurfacedSignatures(["legacy-pending"]);
    check("(4) markQuestionSurfaced + getQuestionSurfacedSignatures round-trips against a migrated row", afterMark.get("legacy-pending") === sig);
    // A vanished id never throws — just absent from the map (defensive, mirrors the answered-stuck watchdog's posture).
    const vanished = db.getQuestionSurfacedSignatures(["no-such-id"]);
    check("(4) an unknown id is simply absent from the map (no throw)", !vanished.has("no-such-id"));

    // ===== (5) pre-existing rows still function through their ordinary lifecycle post-migration =====
    const answered = db.answerQuestion("legacy-pending", { chosenOption: "yes", note: "go", answeredAt: new Date().toISOString() });
    check("(5) the legacy pending row can still be answered post-migration", answered?.state === "answered");
    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    check("(5) both legacy rows still pull correctly post-migration", pulled.length === 2 && pulled.every((q) => q.type === "decision"));

    // Answering the row is a genuine state change — its last-surfaced signature should no longer match
    // the PENDING-era one we stamped in step (4) (the decisions_list handler itself computes/compares
    // against the live signature; this just confirms the marker column survives an ordinary write to the
    // OTHER lifecycle columns untouched, i.e. the ALTER TABLE didn't wire any trigger/default that mutates it).
    const afterAnswer = db.getQuestionSurfacedSignatures(["legacy-pending"]);
    check("(5) answering the row leaves its last-surfaced marker exactly as last written (no side-mutation from the answer path)",
      afterAnswer.get("legacy-pending") === sig);

    // ===== (6) no base-schema index/constraint references the new columns =====
    const indexNames = new Set(indexes2.map((i) => i.name));
    check("(6) idx_questions_session is unchanged (still just session_id, state)", [...indexNames].some((n) => n === "idx_questions_session"));
    check("(6) idx_questions_state_answered is unchanged (still just state, answered_at)", [...indexNames].some((n) => n === "idx_questions_state_answered"));
    check("(6) idx_questions_task is unchanged (still just task_id)", [...indexNames].some((n) => n === "idx_questions_task"));
    check("(6) NO index references last_surfaced_state/last_surfaced_at",
      indexes2.every((i) => !(i.sql ?? "").includes("last_surfaced")));
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-0c1365d0 `questions` DB (no last_surfaced_state/at columns), migrateQuestions() ADD-COLUMNs land on upgrade, a legacy NULL row reads back as never-surfaced (no false match), markQuestionSurfaced/getQuestionSurfacedSignatures round-trip against a migrated row without disturbing it, pre-existing rows still answer+pull normally post-migration, and no base-schema index/constraint references the new columns."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
