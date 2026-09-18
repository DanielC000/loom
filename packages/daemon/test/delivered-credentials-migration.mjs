import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card af08f7e8 (decouple credential delivery into its own delivered_credentials
// table) — per the project's DB-schema-change doctrine ([[verify-schema-change-against-upgraded-db]]),
// this must run against a COPY of a REAL pre-migration DB, not just a fresh LOOM_HOME. The pre-migration
// shape here is the POST-82b22817 shape (questions already has credential_env_var/secret_blob/
// provision_target/cancelled_at) but predates the delivered_credentials table entirely.
//
// The risk this proves against is a real regression, not a cosmetic gap: pre-af08f7e8,
// listCredentialSessionEnvSources read straight off `questions`. A credential answered BEFORE this
// upgrade — already live, already being injected into every spawn — must keep delivering AFTER the
// upgrade, or every project with an answered credential goes instantly, silently dark the moment this
// ships.
//
// Proves:
//   (1) the constructor does NOT throw on a DB with no delivered_credentials table at all.
//   (2) the delivered_credentials table now exists.
//   (3) a pre-existing ANSWERED credential row AND a pre-existing CONSUMED credential row both backfill
//       into delivered_credentials, unrevoked. Code Review finding: `pullAnsweredQuestionsForAgent` flips
//       answered->consumed the moment the asking agent pulls, so CONSUMED (not answered) is the dominant
//       real live state — a fixture seeding only 'answered' never proves the common case.
//   (4) listCredentialSessionEnvSources (the real production read path) returns BOTH backfilled rows on
//       the migrated DB — the credentials keep delivering, unchanged from the caller's point of view.
//   (5) a pre-existing PENDING row, a PROVISIONED row, and a CANCELLED row are all excluded from the
//       backfill (mirrors the old predicate exactly).
//   (6) idempotency: constructing Db a SECOND time against the same file does not duplicate either
//       backfilled row.
//   (7) revokeDeliveredCredential works against the migrated, backfilled row (the whole point of the card).
//   (8) Code Review finding: a revoked credential does NOT resurrect on a THIRD Db construction (a fresh
//       boot) — the backfill's idempotency check must never re-derive a row past a revoke that already
//       happened. This is the card's worst possible failure mode and (1)-(7) never separately re-boot after
//       revoking, so nothing before this step actually rules it out.
//
// Run: 1) build (turbo builds shared first), 2) node test/delivered-credentials-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-delivered-credentials-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-delivered-credentials.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-02T00:00:00.000Z";

// ===== Synthesize a REAL post-82b22817 / pre-af08f7e8 shape directly (no delivered_credentials table) =====
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
    -- The post-82b22817 / pre-af08f7e8 shape — has credential_env_var/secret_blob/provision_target/
    -- provision_connection_id/provision_binding_state/cancelled_at, but NO delivered_credentials table.
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
      consumed_at TEXT,
      cancelled_reason TEXT,
      cancelled_by TEXT,
      cancelled_at TEXT
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

  // A real pre-af08f7e8 ANSWERED, LIVE-DELIVERING credential row — this is the one that must survive.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, credential_env_var, secret_blob, provision_target, state, created_at, answered_at, consumed_at, cancelled_at)
     VALUES (?, ?, ?, 'credential', ?, ?, ?, ?, NULL, 'answered', ?, ?, NULL, NULL)`,
  ).run("legacy-live-credential", mgrId, projId, "Need the DB password", "for the migration", "DB_PASSWORD", "v1:aa:bb:cc", t0, t1);

  // Code Review finding: `pullAnsweredQuestionsForAgent` flips answered->CONSUMED the moment the asking
  // agent pulls its inbox — so CONSUMED, not answered, is the dominant real live state in production. A
  // fixture that never seeds it would leave the actual common case unproven.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, credential_env_var, secret_blob, provision_target, state, created_at, answered_at, consumed_at, cancelled_at)
     VALUES (?, ?, ?, 'credential', ?, ?, ?, ?, NULL, 'consumed', ?, ?, ?, NULL)`,
  ).run("legacy-consumed-credential", mgrId, projId, "Need the API token", "for the migration", "API_TOKEN", "v1:11:22:33", t0, t1, t1);

  // A PENDING credential — must never backfill (never answered, nothing to deliver).
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, credential_env_var, secret_blob, provision_target, state, created_at, answered_at, consumed_at, cancelled_at)
     VALUES (?, ?, ?, 'credential', ?, ?, ?, NULL, NULL, 'pending', ?, NULL, NULL, NULL)`,
  ).run("legacy-pending-credential", mgrId, projId, "Need another key", "later", "OTHER_VAR", t0);

  // A PROVISIONED credential — secret lives in a Connection instead; must never backfill.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, credential_env_var, secret_blob, provision_target, state, created_at, answered_at, consumed_at, cancelled_at)
     VALUES (?, ?, ?, 'credential', ?, ?, ?, NULL, ?, 'answered', ?, ?, NULL, NULL)`,
  ).run("legacy-provisioned-credential", mgrId, projId, "Provision Stripe", "for billing", "STRIPE_KEY", JSON.stringify({ connection: { name: "Stripe", host: "api.stripe.com" } }), t0, t1);

  // A CANCELLED credential (answered then cancelled — edge case, but the old predicate excluded it via
  // cancelled_at IS NULL) — must never backfill.
  raw.prepare(
    `INSERT INTO questions (id, session_id, project_id, type, title, body, credential_env_var, secret_blob, provision_target, state, created_at, answered_at, consumed_at, cancelled_at, cancelled_reason, cancelled_by)
     VALUES (?, ?, ?, 'credential', ?, ?, ?, ?, NULL, 'answered', ?, ?, NULL, ?, 'stale', 'human')`,
  ).run("legacy-cancelled-credential", mgrId, projId, "Need a key", "stale ask", "STALE_VAR", "v1:dd:ee:ff", t0, t1, t1);

  const tables = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
  check("(setup) the synthesized pre-af08f7e8 DB has NO delivered_credentials table yet", !tables.has("delivered_credentials"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-af08f7e8 DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-af08f7e8 DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) delivered_credentials now exists =====
    const raw2 = new Database(dbFile, { readonly: true });
    let tables2;
    try {
      tables2 = new Set(raw2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
    } finally {
      raw2.close();
    }
    check("(2) delivered_credentials was created by exec(SCHEMA)", tables2.has("delivered_credentials"));

    // ===== (3)+(5) exactly the two live-delivering rows backfill (answered AND consumed); pending/
    // provisioned/cancelled do not =====
    const delivered = db.listDeliveredCredentials(projId);
    check("(3) exactly two rows backfilled (the live-delivering credentials only)", delivered.length === 2);
    const backfilledAnswered = delivered.find((d) => d.sourceQuestionId === "legacy-live-credential");
    check("(3) the ANSWERED row's credentialEnvVar matches the legacy question", backfilledAnswered?.credentialEnvVar === "DB_PASSWORD");
    check("(3) the ANSWERED row's deliveredAt matches the legacy answeredAt", backfilledAnswered?.deliveredAt === t1);
    check("(3) the ANSWERED row is NOT revoked", backfilledAnswered?.revokedAt === null);
    const backfilledConsumed = delivered.find((d) => d.sourceQuestionId === "legacy-consumed-credential");
    check("(3) the dominant real state — CONSUMED — also backfills", backfilledConsumed !== undefined);
    check("(3) the CONSUMED row's credentialEnvVar matches its legacy question", backfilledConsumed?.credentialEnvVar === "API_TOKEN");
    check("(3) the CONSUMED row is NOT revoked", backfilledConsumed?.revokedAt === null);
    check("(5) the pending row did not backfill", !delivered.some((d) => d.sourceQuestionId === "legacy-pending-credential"));
    check("(5) the provisioned row did not backfill", !delivered.some((d) => d.sourceQuestionId === "legacy-provisioned-credential"));
    check("(5) the cancelled row did not backfill", !delivered.some((d) => d.sourceQuestionId === "legacy-cancelled-credential"));

    // ===== (4) the REAL production read path still returns BOTH backfilled rows — delivery is unbroken
    // for the answered case AND the dominant consumed case =====
    const sources = db.listCredentialSessionEnvSources(projId);
    const src = sources.find((s) => s.credentialEnvVar === "DB_PASSWORD");
    const srcConsumed = sources.find((s) => s.credentialEnvVar === "API_TOKEN");
    check("(4) listCredentialSessionEnvSources returns the migrated/backfilled ANSWERED credential", src !== undefined);
    check("(4) its ciphertext round-tripped byte-for-byte through the backfill", src?.secretBlob === "v1:aa:bb:cc");
    check("(4) listCredentialSessionEnvSources returns the migrated/backfilled CONSUMED credential", srcConsumed !== undefined);
    check("(4) its ciphertext round-tripped byte-for-byte through the backfill", srcConsumed?.secretBlob === "v1:11:22:33");
    check("(4) STRIPE_KEY (provisioned) never reaches the delivery read path", !sources.some((s) => s.credentialEnvVar === "STRIPE_KEY"));
    check("(4) OTHER_VAR (pending) never reaches the delivery read path", !sources.some((s) => s.credentialEnvVar === "OTHER_VAR"));
    check("(4) STALE_VAR (cancelled) never reaches the delivery read path", !sources.some((s) => s.credentialEnvVar === "STALE_VAR"));

    db.close();

    // ===== (6) idempotency — a second Db construction against the SAME file never duplicates either row ===
    const { Db: Db2 } = await import("../dist/db.js");
    const db2 = new Db2(dbFile);
    const deliveredAgain = db2.listDeliveredCredentials(projId);
    check("(6) a second Db construction against the same file does not duplicate either backfilled row", deliveredAgain.length === 2);

    // ===== (7) revocation works against the migrated, backfilled row (revokeDeliveredCredential now
    // returns an ARRAY — Code Review finding, the rotation blocker: revoking is by env var, not by row) ===
    const targetRow = deliveredAgain.find((d) => d.credentialEnvVar === "DB_PASSWORD");
    const revoked = db2.revokeDeliveredCredential(targetRow.id, { revokedBy: "human", revokedReason: "rotated" });
    check("(7) revokeDeliveredCredential returns exactly the one row revoked (no sibling env var for DB_PASSWORD)", revoked?.length === 1);
    check("(7) revokeDeliveredCredential succeeds against the migrated row", revoked?.[0]?.revokedAt !== null);
    const sourcesAfterRevoke = db2.listCredentialSessionEnvSources(projId);
    check("(7) the revoked, migrated credential no longer reaches the delivery read path", !sourcesAfterRevoke.some((s) => s.credentialEnvVar === "DB_PASSWORD"));
    check("(7) its unrelated sibling (API_TOKEN, different env var) is untouched by the revoke", sourcesAfterRevoke.some((s) => s.credentialEnvVar === "API_TOKEN"));
    // Never destroyed — the audit trail survives, same "retain, never destroy" posture as cancelQuestion.
    check("(7) the revoked row is still listed (retained, not deleted)", db2.listDeliveredCredentials(projId).length === 2);

    db2.close();

    // ===== (8) Code Review finding: a revoked credential must NOT resurrect on the NEXT boot. The
    // migration backfill runs on EVERY Db construction (idempotent via source_question_id presence), so a
    // revoked row's own source `questions` row is still sitting there in its original 'answered' shape —
    // nothing about it changed. Proving the revoke survives a THIRD Db construction is what actually rules
    // out "the backfill silently re-derives and un-revokes it" — the worst possible outcome for this card,
    // and the one thing (1)-(7) above do NOT separately establish (they never re-boot after revoking). =====
    const { Db: Db3 } = await import("../dist/db.js");
    const db3 = new Db3(dbFile);
    const deliveredThirdBoot = db3.listDeliveredCredentials(projId);
    check("(8) still exactly two rows after a third boot (no phantom re-backfill)", deliveredThirdBoot.length === 2);
    const revokedAfterReboot = deliveredThirdBoot.find((d) => d.credentialEnvVar === "DB_PASSWORD");
    check("(8) the revoked row is STILL revoked after a fresh boot — it did not resurrect", revokedAfterReboot?.revokedAt !== null);
    const sourcesThirdBoot = db3.listCredentialSessionEnvSources(projId);
    check("(8) DB_PASSWORD is STILL absent from the real delivery read path after a fresh boot", !sourcesThirdBoot.some((s) => s.credentialEnvVar === "DB_PASSWORD"));
    check("(8) API_TOKEN (never revoked) still delivers after a fresh boot", sourcesThirdBoot.some((s) => s.credentialEnvVar === "API_TOKEN"));

    db = db3;
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-af08f7e8 DB (post-82b22817 shape, no delivered_credentials table), the table is created by exec(SCHEMA), every live-delivering credential backfills into it in BOTH real live states (answered AND consumed — pending/provisioned/cancelled rows correctly excluded, mirroring the old predicate exactly), the migrated credentials still deliver through the real production read path (listCredentialSessionEnvSources), the backfill is idempotent across a second Db construction, revocation works cleanly against a migrated/backfilled row without deleting it or touching an unrelated env var, and — the card's worst possible failure mode — a revoked credential does NOT resurrect on a third, fresh Db construction."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
