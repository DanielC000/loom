import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card f44cc187's `delivered_credentials.undeliverable_notified_at` column — per
// the project's DB-schema-change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run
// against a COPY of a REAL pre-migration DB, not just a fresh LOOM_HOME (a fresh file brings in every
// column at once via CREATE TABLE and is blind to an upgrade-path bug in a migration-added column). The
// pre-migration shape here is the REAL post-af08f7e8 shape (delivered_credentials already exists, with
// id/project_id/credential_env_var/secret_blob/source_question_id/delivered_at/revoked_at/revoked_by/
// revoked_reason) but predates `undeliverable_notified_at` entirely — the shape every existing Loom
// install has today, before this card.
//
// Proves:
//   (1) the constructor does NOT throw on a DB whose delivered_credentials table has no
//       undeliverable_notified_at column at all.
//   (2) the column now exists on the upgraded table, with no new index/constraint (a plain ADD COLUMN).
//   (3) a pre-existing LIVE row backfills with undeliverable_notified_at NULL (byte-identical read
//       behavior for every row that predates this card).
//   (4) markCredentialUndeliverableNotified works against the migrated row: true the first call, false
//       the second (the once-per-row dedupe gate functions on a backfilled column exactly like a
//       fresh-install one).
//   (5) idempotent: a second Db construction against the same file does not reset or duplicate the mark.
//
// Run: 1) build (turbo builds shared first), 2) node test/delivered-credentials-undeliverable-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-delivered-credentials-undeliverable-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-f44cc187.db");

const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const rowId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-02T00:00:00.000Z";

// ===== Synthesize the REAL post-af08f7e8 / pre-f44cc187 `delivered_credentials` shape directly, bypassing
// Db — NO undeliverable_notified_at column, the true shape every existing install has today. =====
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
    -- The real post-af08f7e8 / pre-f44cc187 shape: every af08f7e8 column, but NO
    -- undeliverable_notified_at — the true shape every existing Loom install has today, before this card.
    CREATE TABLE delivered_credentials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      credential_env_var TEXT NOT NULL,
      secret_blob TEXT NOT NULL,
      source_question_id TEXT,
      delivered_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT,
      revoked_reason TEXT
    );
    CREATE INDEX idx_delivered_credentials_project ON delivered_credentials(project_id, revoked_at);
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Manager', '', 0)")
    .run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(mgrId, projId, agentId, `eng-${mgrId}`, projId, t0, t0);

  // A real pre-f44cc187 LIVE, delivering credential row — must survive the upgrade untouched apart from
  // gaining the new column.
  raw.prepare(
    `INSERT INTO delivered_credentials (id, project_id, credential_env_var, secret_blob, source_question_id, delivered_at, revoked_at, revoked_by, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(rowId, projId, "DB_PASSWORD", "v1:aa:bb:cc", "legacy-question", t1);

  const columns0 = raw.prepare("PRAGMA table_info(delivered_credentials)").all().map((c) => c.name);
  check("(setup) the synthesized pre-f44cc187 delivered_credentials table has NO undeliverable_notified_at column yet", !columns0.includes("undeliverable_notified_at"));
  raw.close();
}

let db;
let Db;
try {
  // ===== (1) the constructor must NOT throw on this pre-f44cc187 DB =====
  let ctorError = null;
  try {
    ({ Db } = await import("../dist/db.js"));
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-f44cc187 DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) the column now exists, with no new index/constraint (a plain ADD COLUMN) =====
    const raw2 = new Database(dbFile, { readonly: true });
    let columns;
    let indexes;
    try {
      columns = raw2.prepare("PRAGMA table_info(delivered_credentials)").all().map((c) => c.name);
      indexes = raw2.prepare("PRAGMA index_list(delivered_credentials)").all();
    } finally {
      raw2.close();
    }
    check("(2) undeliverable_notified_at column exists on the upgraded delivered_credentials table", columns.includes("undeliverable_notified_at"));
    check("(2) no index on delivered_credentials references undeliverable_notified_at (plain ADD COLUMN, no constraint added)",
      indexes.every((ix) => !/undeliverable_notified_at/.test(ix.name)));

    // ===== (3) the legacy row backfills with undeliverable_notified_at NULL, and reads deliverable:true
    // (DB_PASSWORD is a well-formed, non-reserved name) with every other column untouched =====
    const legacy = db.getDeliveredCredential(rowId);
    check("(3) the legacy row's undeliverable_notified_at is NULL post-migration", db.db.prepare("SELECT undeliverable_notified_at FROM delivered_credentials WHERE id = ?").get(rowId).undeliverable_notified_at === null);
    check("(3) the legacy row's credentialEnvVar is untouched", legacy?.credentialEnvVar === "DB_PASSWORD");
    check("(3) the legacy row reads deliverable:true (well-formed name, unaffected by this migration)", legacy?.deliverable === true);
    check("(3) the legacy row reads effective:true (live, sole winner, deliverable)", legacy?.effective === true);
    check("(3) the legacy row's secretBlob round-trips byte-for-byte", db.listCredentialSessionEnvSources(projId).find((s) => s.credentialEnvVar === "DB_PASSWORD")?.secretBlob === "v1:aa:bb:cc");

    // ===== (4) markCredentialUndeliverableNotified works against the migrated row: true the first call,
    // false the second — the once-per-row dedupe gate functions on a backfilled (NULL) column exactly
    // like it would on a fresh-install row =====
    check("(4) markCredentialUndeliverableNotified returns true the first time against the migrated row", db.markCredentialUndeliverableNotified(rowId) === true);
    check("(4) the column is now set (non-null) after marking", db.db.prepare("SELECT undeliverable_notified_at FROM delivered_credentials WHERE id = ?").get(rowId).undeliverable_notified_at !== null);
    check("(4) markCredentialUndeliverableNotified returns false the second time for the SAME migrated row", db.markCredentialUndeliverableNotified(rowId) === false);

    db.close();

    // ===== (5) idempotent: a second Db construction against the same file neither resets nor duplicates
    // the mark, and does not disturb the row =====
    const db2 = new Db(dbFile);
    try {
      const again = db2.getDeliveredCredential(rowId);
      check("(5) a second Db construction over an already-migrated file does not duplicate the row", db2.listDeliveredCredentials(projId).length === 1);
      check("(5) the mark set in (4) survives a fresh boot (not reset by re-running the migration)", db2.db.prepare("SELECT undeliverable_notified_at FROM delivered_credentials WHERE id = ?").get(rowId).undeliverable_notified_at !== null);
      check("(5) the row's other columns are still untouched after a fresh boot", again?.credentialEnvVar === "DB_PASSWORD" && again?.revokedAt === null);
    } finally {
      db2.close();
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-f44cc187 delivered_credentials table (post-af08f7e8 shape, no undeliverable_notified_at column), the column lands via the idempotent ADD COLUMN migration with no new index/constraint, a legacy row backfills with the column NULL (deliverable:true, effective:true, every other column untouched), markCredentialUndeliverableNotified's once-per-row dedupe gate works correctly against the migrated/backfilled column, and re-opening an already-migrated file is a clean no-op that preserves the mark."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
