import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card cb7d6998's `filed_by_session_id` column — per the project's DB-schema-
// change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY of a REAL
// pre-migration `questions` shape, not just a fresh LOOM_HOME (a fresh DB is blind to a SCHEMA statement
// that references something only a migration was supposed to add — the exact bug class this project has
// already shipped once). Mirrors `questions-type-migration.mjs`'s precedent exactly, scoped to this one
// new column: we synthesize the FULL pre-cb7d6998 `questions` shape directly with better-sqlite3 (every
// column that exists today EXCEPT `filed_by_session_id`), insert real pending/answered rows — including
// one that has already been through a recycle (session_id pointing at a SUCCESSOR, simulating exactly
// the corrupted-provenance scenario this card fixes) — then construct a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a `questions` table that predates `filed_by_session_id`.
//   (2) the column now exists (migrateQuestions()'s ADD COLUMN ran).
//   (3) every pre-existing row reads filedBySessionId:null — NEVER a guessed/backfilled value (there is
//       no legitimate backfill for this column; a legacy row's true filer is genuinely unrecoverable).
//   (4) a pre-existing row's OTHER fields (state, chosenOption, sessionId) are untouched by the migration.
//   (5) a BRAND-NEW question asked against the migrated DB gets filedBySessionId populated correctly, and
//       it survives a recycle exactly like question-filed-by-session-id-survives-recycle.mjs proves on a
//       fresh install.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-filed-by-session-id-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-q-filedby-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-filedby.db");

const projId = randomUUID();
const agentId = randomUUID();
const oldMgrId = randomUUID();
const successorMgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the FULL pre-cb7d6998 `questions` shape directly, bypassing the Db class entirely —
// every column that exists TODAY except `filed_by_session_id` =====
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
    -- The pre-cb7d6998 shape — every column questions has TODAY except filed_by_session_id.
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
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Manager', '', 0)")
    .run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(oldMgrId, projId, agentId, `eng-${oldMgrId}`, projId, t0, t0);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(successorMgrId, projId, agentId, `eng-${successorMgrId}`, projId, t0, t0);

  // A real ANSWERED legacy question, never reparented — session_id still names its true filer.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, 'decision', ?, ?, ?, ?, 'answered', ?, ?, ?, ?, NULL)`,
  ).run("legacy-answered", oldMgrId, projId, "Ship the migration?", "gate is green", JSON.stringify(["yes", "no"]), "yes", "yes", "go", t0, t0);
  // A real PENDING question that has ALREADY been through a recycle BEFORE this migration ever ran —
  // session_id was reparented onto the successor by the pre-existing reparentQuestions, exactly the
  // corrupted-provenance state the escalation that produced this card actually found in the wild.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, options_json, recommendation, state, chosen_option, note, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, 'decision', ?, ?, NULL, NULL, 'pending', NULL, NULL, ?, NULL, NULL)`,
  ).run("legacy-reparented-pending", successorMgrId, projId, "Any blockers?", "pure blocker, no options", t0);

  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration `questions` table has NO filed_by_session_id column yet", !cols.has("filed_by_session_id"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-filed_by_session_id DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-filed_by_session_id `questions` DB does not throw", ctorError === null);
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
    check("(2) column 'filed_by_session_id' was added by migrateQuestions()", cols2.has("filed_by_session_id"));

    // ===== (3) every pre-existing row reads filedBySessionId:null — no fabricated backfill =====
    const answeredLegacy = db.getQuestion("legacy-answered");
    const reparentedLegacy = db.getQuestion("legacy-reparented-pending");
    check("(3) a never-reparented legacy row reads filedBySessionId:null (unrecoverable, not guessed)", answeredLegacy?.filedBySessionId === null);
    check("(3) an ALREADY-reparented legacy row ALSO reads filedBySessionId:null (its true filer is gone)", reparentedLegacy?.filedBySessionId === null);
    check("(3) the already-reparented row's sessionId is left exactly as it was pre-migration (the successor)", reparentedLegacy?.sessionId === successorMgrId);

    // ===== (4) the pre-existing rows' other fields are untouched by this migration =====
    check("(4) the answered legacy row's chosenOption survived untouched", answeredLegacy?.chosenOption === "yes");
    check("(4) the answered legacy row's note survived untouched", answeredLegacy?.note === "go");
    check("(4) the pending legacy row's state is still 'pending'", reparentedLegacy?.state === "pending");

    // ===== (5) a BRAND-NEW question asked against the migrated DB gets filedBySessionId populated, and
    // it survives a recycle just like on a fresh install =====
    const { SessionService } = await import("../dist/sessions/service.js");
    const { OrchestrationControl } = await import("../dist/orchestration/control.js");
    const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

    const routerPre = new OrchestrationMcpRouter(db, {});
    const askResult = JSON.parse((await routerPre.buildServer(successorMgrId, "manager")._registeredTools["question_ask"]
      .handler({ title: "Post-migration ask", body: "on the upgraded DB" })).content[0].text);
    const newQid = askResult.questionId;
    check("(5) a new post-migration ask gets filedBySessionId populated", db.getQuestion(newQid).filedBySessionId === successorMgrId);

    class PtyStub {
      constructor() { this.live = new Set(); }
      spawn(opts) { this.live.add(opts.sessionId); }
      stop(id) { this.live.delete(id); }
      isAlive(id) { return this.live.has(id); }
      flushPending() { return []; }
      getPending() { return []; }
      enqueueStdin() { return { delivered: true }; }
    }
    const pty = new PtyStub();
    pty.live.add(successorMgrId);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const secondSuccessor = await sessions.recycleManager(successorMgrId, "post-migration recycle: filedBySessionId must still survive");
    const afterRecycle = db.getQuestion(newQid);
    check("(5) post-migration: sessionId is reparented onto the new successor", afterRecycle.sessionId === secondSuccessor.id);
    check("(5) post-migration: filedBySessionId still names the ORIGINAL post-migration filer", afterRecycle.filedBySessionId === successorMgrId);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-cb7d6998 `questions` DB (no filed_by_session_id column), migrateQuestions() ADD-COLUMNs it on upgrade, every pre-existing row (including one already corrupted by a pre-migration recycle) reads filedBySessionId:null rather than a fabricated value, other fields are untouched, and a brand-new post-migration ask gets real provenance that itself survives a further recycle."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
