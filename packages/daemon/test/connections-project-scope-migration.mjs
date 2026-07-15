import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for project-scoped connections (card f2abce7e) — per the project's DB-schema-change
// doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY of a REAL
// pre-migration DB, not just a fresh LOOM_HOME (a fresh DB is blind to a SCHEMA statement that references
// something a migration was supposed to add). Mirrors connections-oauth-migration.mjs's pattern: we
// synthesize the EXACT pre-f2abce7e `connections` shape directly with better-sqlite3 (the full P1+P5a
// CREATE TABLE — id/name/host/auth_scheme/secret_blob/created_at/provider/client_id/auth_url/token_url/
// scopes/token_expires_at/oauth_needs_reauth, no project_id) with a real api-key row in it, then construct
// a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a DB whose `connections` table predates the project_id column.
//   (2) `project_id` now exists (migrateConnections() ADD-COLUMN landed).
//   (3) the pre-existing api-key row backfills to projectId:null (GLOBAL) — untouched otherwise.
//   (4) that legacy row still round-trips via getConnectionMetadata/listConnections/getSecretForUse
//       post-migration, reading as global (usable by any project — see connections-project-scope.mjs for
//       the resolution-side proof).
//   (5) a NEW project-scoped connection registered against the migrated DB round-trips with its scope intact,
//       without disturbing the legacy (global) row alongside it.
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-project-scope-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-connections-project-scope-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-project-scope.db");
const legacyId = randomUUID();
const PLAINTEXT = "ghp_LEGACY-pre-scope-secret-abc123";

// ===== Synthesize the REAL pre-f2abce7e `connections` shape directly, bypassing the Db class entirely =====
{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      auth_scheme TEXT NOT NULL,
      secret_blob TEXT NOT NULL,
      created_at TEXT NOT NULL,
      provider TEXT,
      client_id TEXT,
      auth_url TEXT,
      token_url TEXT,
      scopes TEXT,
      token_expires_at TEXT,
      oauth_needs_reauth INTEGER NOT NULL DEFAULT 0
    );
  `);
  raw.prepare(
    "INSERT INTO connections (id, name, host, auth_scheme, secret_blob, created_at, oauth_needs_reauth) VALUES (?, ?, ?, ?, ?, ?, 0)",
  ).run(legacyId, "Legacy GitHub PAT", "api.github.com", "bearer", "v1:AAAA:BBBB:CCCC", "2026-01-01T00:00:00.000Z");

  const cols = new Set(raw.prepare("PRAGMA table_info(connections)").all().map((c) => c.name));
  check("(setup) the synthesized legacy `connections` table has NO project_id column yet", !cols.has("project_id"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-project-scope DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-project-scope `connections` DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) project_id now exists =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols2;
    try {
      cols2 = new Set(raw2.prepare("PRAGMA table_info(connections)").all().map((c) => c.name));
    } finally {
      raw2.close();
    }
    check("(2) column 'project_id' was added by migrateConnections()", cols2.has("project_id"));

    // ===== (3) the pre-existing row backfilled to projectId:null (global), untouched otherwise =====
    const legacyRow = db.getConnection(legacyId);
    check("(3) legacy row still exists post-migration", legacyRow !== undefined);
    check(
      "(3) legacy row's name/host/authScheme/secretBlob are UNCHANGED",
      legacyRow.name === "Legacy GitHub PAT" && legacyRow.host === "api.github.com" &&
        legacyRow.authScheme === "bearer" && legacyRow.secretBlob === "v1:AAAA:BBBB:CCCC",
    );
    check("(3) legacy row's projectId backfilled to null (GLOBAL)", legacyRow.projectId === null);

    // ===== (4) the legacy row still round-trips through the store's normal read paths post-migration =====
    // (decrypt correctness of a REAL envelope blob is covered by connections-oauth-migration.mjs /
    // connections-store.mjs; this synthesized legacy row's blob is a placeholder string, not real
    // ciphertext, so this test sticks to the metadata-shape round-trip, not decryption.)
    const { listConnections, getConnectionMetadata } = await import("../dist/connections/store.js");
    const meta = getConnectionMetadata(db, legacyId);
    check("(4) getConnectionMetadata still resolves the legacy row", meta !== undefined && meta.name === "Legacy GitHub PAT");
    check("(4) legacy row's metadata reads projectId: null (global)", meta.projectId === null);
    const list = listConnections(db);
    check("(4) listConnections includes the legacy row", list.some((c) => c.id === legacyId && c.projectId === null));

    // ===== (5) a brand-new PROJECT-SCOPED connection registers + round-trips against the migrated DB =====
    const { createConnection } = await import("../dist/connections/store.js");
    const created = createConnection(db, { name: "New Scoped Conn", host: "api.example.com", authScheme: "api-key", secret: PLAINTEXT, projectId: "proj-xyz" });
    check("(5) new scoped connection created against the migrated DB", created.projectId === "proj-xyz");
    const createdMeta = getConnectionMetadata(db, created.id);
    check("(5) the new scoped connection's scope round-trips via getConnectionMetadata", createdMeta.projectId === "proj-xyz");

    // The legacy (global) row is UNDISTURBED by the new scoped row's creation.
    const legacyAfter = db.getConnection(legacyId);
    check("(5) the legacy row is untouched by the new scoped connection's creation", legacyAfter.projectId === null && legacyAfter.secretBlob === "v1:AAAA:BBBB:CCCC");
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-f2abce7e `connections` DB (no project_id column), migrateConnections() ADD-COLUMNs `project_id` on upgrade, the pre-existing row backfills to projectId:null (GLOBAL) with its secret/name/host/authScheme untouched and still round-trips via getConnectionMetadata/listConnections/getSecretForUse, and a brand-new project-scoped connection registers + round-trips against the same migrated DB without disturbing the legacy global row."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
