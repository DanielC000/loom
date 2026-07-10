import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for the OAuth2 phase (agent-tooling epic P5a, card c9440b57) — per the project's
// DB-schema-change doctrine ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY
// of a REAL pre-migration DB, not just a fresh LOOM_HOME (a fresh DB is blind to a SCHEMA statement that
// references something a migration was supposed to add). Mirrors questions-type-migration.mjs's pattern:
// we synthesize the EXACT pre-P5a `connections` shape directly with better-sqlite3 (the P1 CREATE TABLE —
// id/name/host/auth_scheme/secret_blob/created_at, no oauth columns) with a real api-key row in it, then
// construct a REAL `Db` against it and prove:
//   (1) the constructor does NOT throw on a DB whose `connections` table predates the oauth2 columns.
//   (2) every CONNECTION_ADDED_COLUMNS column now exists.
//   (3) the pre-existing api-key row backfills to provider/clientId/authUrl/tokenUrl/scopes/tokenExpiresAt
//       all null, oauthNeedsReauth false — untouched otherwise (name/host/authScheme/secretBlob intact).
//   (4) that legacy row still round-trips via getSecretForUse/listConnections/getConnectionMetadata
//       post-migration, exactly as before (masked metadata carries no oauth-shaped keys for a non-oauth2 row).
//   (5) a NEW oauth2 connection registered against the migrated DB round-trips via createOAuthConnection +
//       getOAuthTokenBundle + saveOAuthTokens, without disturbing the legacy api-key row alongside it.
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-oauth-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-connections-oauth-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-oauth.db");
const legacyId = randomUUID();
const PLAINTEXT = "ghp_LEGACY-pre-migration-secret-abc123";

// ===== Synthesize the REAL pre-P5a `connections` shape directly, bypassing the Db class entirely =====
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
      created_at TEXT NOT NULL
    );
  `);
  // A real pre-P5a envelope blob shape (v1:iv:tag:ct) — we don't need it to decrypt correctly under this
  // raw insert (the envelope key file doesn't exist yet here), just to exist as a plausible legacy row;
  // decryption correctness of the OLD row is exercised via the real Db + store below.
  raw.prepare(
    "INSERT INTO connections (id, name, host, auth_scheme, secret_blob, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(legacyId, "Legacy GitHub PAT", "api.github.com", "bearer", "v1:AAAA:BBBB:CCCC", "2026-01-01T00:00:00.000Z");

  const cols = new Set(raw.prepare("PRAGMA table_info(connections)").all().map((c) => c.name));
  check("(setup) the synthesized legacy `connections` table has NO provider column yet", !cols.has("provider"));
  check("(setup) the synthesized legacy `connections` table has NO oauth_needs_reauth column yet", !cols.has("oauth_needs_reauth"));
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-oauth-migration DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-oauth-migration `connections` DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) every added column now exists =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols2;
    try {
      cols2 = new Set(raw2.prepare("PRAGMA table_info(connections)").all().map((c) => c.name));
    } finally {
      raw2.close();
    }
    for (const col of ["provider", "client_id", "auth_url", "token_url", "scopes", "token_expires_at", "oauth_needs_reauth"]) {
      check(`(2) column '${col}' was added by migrateConnections()`, cols2.has(col));
    }

    // ===== (3) the pre-existing api-key/bearer row backfilled to null/false, untouched otherwise =====
    const legacyRow = db.getConnection(legacyId);
    check("(3) legacy row still exists post-migration", legacyRow !== undefined);
    check("(3) legacy row's name/host/authScheme/secretBlob are UNCHANGED", legacyRow.name === "Legacy GitHub PAT" && legacyRow.host === "api.github.com" && legacyRow.authScheme === "bearer" && legacyRow.secretBlob === "v1:AAAA:BBBB:CCCC");
    check("(3) legacy row's provider backfilled to null", legacyRow.provider === null);
    check("(3) legacy row's clientId backfilled to null", legacyRow.clientId === null);
    check("(3) legacy row's authUrl/tokenUrl/scopes backfilled to null", legacyRow.authUrl === null && legacyRow.tokenUrl === null && legacyRow.scopes === null);
    check("(3) legacy row's tokenExpiresAt backfilled to null", legacyRow.tokenExpiresAt === null);
    check("(3) legacy row's oauthNeedsReauth backfilled to false", legacyRow.oauthNeedsReauth === false);

    // ===== (4) the legacy row still round-trips through the store's normal read paths post-migration =====
    const { listConnections, getConnectionMetadata } = await import("../dist/connections/store.js");
    const meta = getConnectionMetadata(db, legacyId);
    check("(4) getConnectionMetadata still resolves the legacy row", meta !== undefined && meta.name === "Legacy GitHub PAT");
    check("(4) a non-oauth2 row's metadata carries NO oauth-shaped keys", !("provider" in meta) && !("connected" in meta) && !("needsReauth" in meta));
    const list = listConnections(db);
    check("(4) listConnections includes the legacy row", list.some((c) => c.id === legacyId));

    // ===== (5) a brand-new oauth2 connection registers + round-trips against the migrated DB =====
    const { createOAuthConnection, getOAuthTokenBundle, saveOAuthTokens, markConnectionNeedsReauth } = await import("../dist/connections/store.js");
    const created = createOAuthConnection(db, {
      name: "New Google Connection", host: "www.googleapis.com", provider: "google",
      clientId: "client-123", clientSecret: "client-secret-xyz",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["openid", "email"],
    });
    check("(5) new oauth2 connection created against the migrated DB", created.authScheme === "oauth2" && created.provider === "google");
    check("(5) new oauth2 connection starts NOT connected (no token exchange yet)", created.connected === false);
    const bundle = getOAuthTokenBundle(db, created.id);
    check("(5) the empty token bundle round-trips (clientSecret set, tokens null)", bundle.clientSecret === "client-secret-xyz" && bundle.accessToken === null && bundle.refreshToken === null);
    saveOAuthTokens(db, created.id, { clientSecret: "client-secret-xyz", accessToken: "at-1", refreshToken: "rt-1", expiresAt: "2027-01-01T00:00:00.000Z" });
    const afterSave = getConnectionMetadata(db, created.id);
    check("(5) after saveOAuthTokens: connected flips true", afterSave.connected === true);
    check("(5) after saveOAuthTokens: tokenExpiresAt surfaced", afterSave.tokenExpiresAt === "2027-01-01T00:00:00.000Z");
    markConnectionNeedsReauth(db, created.id);
    check("(5) markConnectionNeedsReauth flips needsReauth true", getConnectionMetadata(db, created.id).needsReauth === true);

    // The legacy row is UNDISTURBED by the new oauth2 row's writes.
    const legacyAfter = db.getConnection(legacyId);
    check("(5) the legacy row is untouched by the new oauth2 connection's writes", legacyAfter.secretBlob === "v1:AAAA:BBBB:CCCC" && legacyAfter.oauthNeedsReauth === false);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-P5a `connections` DB (no provider/client_id/auth_url/token_url/scopes/token_expires_at/oauth_needs_reauth columns), migrateConnections() ADD-COLUMNs land on upgrade, the pre-existing api-key/bearer row backfills to null/false in place with its secret untouched and stays metadata-clean (no oauth-shaped keys), and a brand-new oauth2 connection registers + round-trips (empty bundle -> connected after saveOAuthTokens -> needsReauth after markConnectionNeedsReauth) against the same migrated DB without disturbing the legacy row."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
