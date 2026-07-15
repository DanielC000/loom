import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for credential auto-provisioning v1 (card 193de09e) — per the project's DB-schema-
// change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY of a REAL
// pre-migration DB, not just a fresh LOOM_HOME. The pre-migration shape here is the POST-695ebab0 shape
// (already has type/task_id/permission_*/credential_env_var/secret_blob — see
// questions-type-migration.mjs for THAT migration) but predates provision_target/provision_connection_id/
// provision_binding_state.
//
// Proves:
//   (1) the constructor does NOT throw on a DB whose `questions` table predates the 3 provisioning columns.
//   (2) all 3 QUESTION_ADDED_COLUMNS provisioning columns now exist.
//   (3) a pre-existing row (any type) backfills with provisionTarget:null, provisionConnectionId:null,
//       provisionBindingState:"none" — no base-schema query/index assumes these are non-null.
//   (4) a pre-existing 'answered' credential row (from before this card, so secret_blob is non-null and
//       provisioning columns are absent) still pulls correctly post-migration, unchanged.
//   (5) a NEW provisioning credential ask round-trips against the migrated DB via answerCredentialQuestion's
//       new `provision` patch, backfilling provision_connection_id/provision_binding_state correctly
//       alongside legacy rows.
//
// Run: 1) build (turbo builds shared first), 2) node test/credential-provisioning-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-credential-provisioning-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-provisioning.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize a REAL post-695ebab0 / pre-193de09e `questions` shape directly =====
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
    -- The post-695ebab0 / pre-193de09e shape — has type/task_id/permission_*/credential_env_var/
    -- secret_blob, but NO provision_target/provision_connection_id/provision_binding_state.
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
      state TEXT NOT NULL DEFAULT 'pending',
      chosen_option TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      consumed_at TEXT
    );
    CREATE INDEX idx_questions_session ON questions(session_id, state);
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

  // A real pre-193de09e ANSWERED credential row — non-null secret_blob, no provisioning columns at all.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, credential_env_var, secret_blob, state, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, 'credential', ?, ?, ?, ?, 'answered', ?, ?, NULL)`,
  ).run("legacy-credential", mgrId, projId, "Need the DB password", "for the migration", "DB_PASSWORD", "v1:aa:bb:cc", t0, t0);
  // A real legacy PENDING decision row too, to prove the base migration keeps working alongside this one.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, options_json, state, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, 'decision', ?, ?, ?, 'pending', ?, NULL, NULL)`,
  ).run("legacy-decision", mgrId, projId, "Ship it?", "gate green", JSON.stringify(["yes", "no"]), t0);

  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized pre-193de09e `questions` table has NO provision_target column yet", !cols.has("provision_target"));
  check("(setup) the synthesized pre-193de09e `questions` table has NO provision_connection_id column yet", !cols.has("provision_connection_id"));
  check("(setup) the synthesized pre-193de09e `questions` table has NO provision_binding_state column yet", !cols.has("provision_binding_state"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-provisioning-migration DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-193de09e `questions` DB does not throw", ctorError === null);
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
    for (const col of ["provision_target", "provision_connection_id", "provision_binding_state"]) {
      check(`(2) column '${col}' was added by migrateQuestions()`, cols2.has(col));
    }

    // ===== (3) every pre-existing row backfills to the non-provisioning defaults, no base query breaks =====
    const legacyCred = db.getQuestion("legacy-credential");
    const legacyDecision = db.getQuestion("legacy-decision");
    check("(3) a legacy credential row backfills provisionTarget:null", legacyCred?.provisionTarget === null);
    check("(3) a legacy credential row backfills provisionConnectionId:null", legacyCred?.provisionConnectionId === null);
    check("(3) a legacy credential row backfills provisionBindingState:'none' (not null, matching the TS type)", legacyCred?.provisionBindingState === "none");
    check("(3) a legacy decision row backfills the same defaults", legacyDecision?.provisionTarget === null && legacyDecision?.provisionBindingState === "none");
    check("(3) the legacy credential row's OWN pre-existing fields survived untouched", legacyCred?.credentialEnvVar === "DB_PASSWORD" && legacyCred?.state === "answered");

    // ===== (4) the pre-existing 'answered' credential row still pulls correctly, unchanged =====
    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const pulledLegacy = pulled.find((q) => q.id === "legacy-credential");
    check("(4) the legacy answered credential question is included in the pull", pulledLegacy !== undefined);
    check("(4) it still pulls as type:'credential'", pulledLegacy?.type === "credential");
    check("(4) its provisioning fields stay at the non-provisioning defaults", pulledLegacy?.provisionTarget === null && pulledLegacy?.provisionBindingState === "none");
    check("(4) it's now 'consumed' post-pull", db.getQuestion("legacy-credential")?.state === "consumed");
    // The base decision row is untouched by this migration too (still pending, still answerable).
    const decisionAnswered = db.answerQuestion("legacy-decision", { chosenOption: "yes", note: null, answeredAt: new Date().toISOString() });
    check("(4) the legacy decision row can still be answered post-migration", decisionAnswered?.state === "answered");

    // ===== (5) a NEW provisioning credential ask round-trips against the migrated DB =====
    const { encryptSecret } = await import("../dist/keys/envelope.js");
    const credId = "new-provisioning-credential";
    db.insertQuestion({
      id: credId, sessionId: mgrId, projectId: projId, type: "credential",
      title: "Need the Stripe key", body: "for billing",
      options: null, recommendation: null, taskId: null,
      permissionAction: null, permissionScope: null, permissionExpiresAt: null,
      credentialEnvVar: null,
      provisionTarget: { connection: { name: "Stripe Prod", host: "api.stripe.com" }, binding: { profileId: "prof-1" } },
      provisionConnectionId: null, provisionBindingState: "none",
      state: "pending", chosenOption: null, note: null,
      createdAt: t0, answeredAt: null, consumedAt: null,
    });
    const inserted = db.getQuestion(credId);
    check("(5) the new provisioning ask's provisionTarget round-trips through insertQuestion/toQuestion on the migrated DB", inserted?.provisionTarget?.connection.name === "Stripe Prod");

    const connId = "conn-migrated";
    const answered = db.answerCredentialQuestion(credId, {
      secretBlob: null, answeredAt: new Date().toISOString(), provision: { connectionId: connId, bindingState: "pending" },
    });
    check("(5) answerCredentialQuestion's new `provision` patch writes cleanly on the migrated DB", answered?.state === "answered");
    check("(5) provisionConnectionId persisted", answered?.provisionConnectionId === connId);
    check("(5) provisionBindingState persisted as 'pending'", answered?.provisionBindingState === "pending");

    const pulled2 = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const pulledNew = pulled2.find((q) => q.id === credId);
    check("(5) the new provisioning question pulls too, carrying the provisioning result", pulledNew?.provisionConnectionId === connId && pulledNew?.provisionBindingState === "pending");
    check("(5) it never carries a secret field", !("secretBlob" in pulledNew) && !("secret_blob" in pulledNew));
    // Alongside a legacy non-provisioning row in the SAME migrated DB — the per-agent pull above swept it
    // up too (it was answered-but-unpulled since step (4)), so it's now 'consumed'; the point is its OWN
    // fields (provisioning defaults included) are undisturbed by the new provisioning row's insert/answer.
    const legacyStillFine = db.getQuestion("legacy-decision");
    check("(5) the legacy decision row's provisioning defaults are undisturbed by the new provisioning row's insert/answer", legacyStillFine?.state === "consumed" && legacyStillFine?.provisionBindingState === "none" && legacyStillFine?.provisionTarget === null);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-193de09e `questions` DB (post-695ebab0 shape, no provision_target/provision_connection_id/provision_binding_state columns), migrateQuestions() ADD-COLUMNs land on upgrade, every pre-existing row (credential or otherwise) backfills to the non-provisioning defaults (provisionTarget:null, provisionConnectionId:null, provisionBindingState:'none') in place with its own fields untouched and still pullable/answerable, and a BRAND-NEW provisioning credential ask round-trips cleanly (insert -> answerCredentialQuestion's new `provision` patch -> pull) against the same migrated DB without disturbing legacy rows alongside it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
