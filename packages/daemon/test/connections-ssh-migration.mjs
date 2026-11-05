import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for the SSH connection type (design record a3d5c7f4, card f9972a3d). No real
// pre-ssh-phase backup exists to copy from ([[verify-schema-change-against-upgraded-db]]'s preferred
// path), so this synthesizes the exact pre-ssh-phase `connections` shape directly with better-sqlite3,
// then constructs a REAL `Db` against it and proves:
//   (1) the constructor does NOT throw on a DB whose `connections` table predates the ssh_* columns.
//   (2) every ssh_* column CONNECTION_ADDED_COLUMNS names now exists.
//   (3) the pre-existing api-key row backfills its ssh_* fields to a harmless default (null/'[]') and is
//       otherwise byte-identical (name/host/authScheme/secretBlob/projectId untouched) — and its masked
//       metadata carries NO ssh-shaped keys (same posture as connections-oauth-migration.mjs's own
//       "no oauth-shaped keys on a non-oauth2 row" check, mirrored for ssh).
//   (4) that legacy row still round-trips via getSecretForUse/listConnections/getConnectionMetadata
//       post-migration, exactly as before.
//   (5) a NEW ssh connection registers against the migrated DB and round-trips (create -> decrypt ->
//       update config), without disturbing the legacy row alongside it.
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-ssh-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-connections-ssh-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-ssh.db");
const legacyId = randomUUID();
const PLAINTEXT = "ghp_LEGACY-pre-ssh-migration-secret-xyz789";
const SSH_ADDED_COLUMNS = ["ssh_port", "ssh_user", "ssh_host_key_fingerprint", "ssh_read_only", "ssh_command_allowlist", "ssh_risky_patterns"];

// ===== Synthesize the REAL pre-ssh-phase `connections` shape directly, bypassing the Db class entirely =====
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
      oauth_needs_reauth INTEGER NOT NULL DEFAULT 0,
      project_id TEXT
    );
  `);
  raw.prepare(
    "INSERT INTO connections (id, name, host, auth_scheme, secret_blob, created_at, oauth_needs_reauth) VALUES (?, ?, ?, ?, ?, ?, 0)",
  ).run(legacyId, "Legacy GitHub PAT", "api.github.com", "bearer", "v1:AAAA:BBBB:CCCC", "2026-01-01T00:00:00.000Z");

  const cols = new Set(raw.prepare("PRAGMA table_info(connections)").all().map((c) => c.name));
  for (const col of SSH_ADDED_COLUMNS) {
    check(`(setup) the synthesized pre-ssh 'connections' table has NO '${col}' column yet`, !cols.has(col));
  }
  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-ssh-migration DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-ssh-migration `connections` DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) every ssh_* column now exists =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols2;
    try {
      cols2 = new Set(raw2.prepare("PRAGMA table_info(connections)").all().map((c) => c.name));
    } finally {
      raw2.close();
    }
    for (const col of SSH_ADDED_COLUMNS) {
      check(`(2) column '${col}' was added by migrateConnections()`, cols2.has(col));
    }

    // ===== (3) the pre-existing api-key/bearer row backfilled to a harmless default, untouched otherwise =====
    const legacyRow = db.getConnection(legacyId);
    check("(3) legacy row still exists post-migration", legacyRow !== undefined);
    check("(3) legacy row's name/host/authScheme/secretBlob are UNCHANGED", legacyRow.name === "Legacy GitHub PAT" && legacyRow.host === "api.github.com" && legacyRow.authScheme === "bearer" && legacyRow.secretBlob === "v1:AAAA:BBBB:CCCC");
    check("(3) legacy row's sshPort/sshUser/sshHostKeyFingerprint backfilled to null", legacyRow.sshPort === null && legacyRow.sshUser === null && legacyRow.sshHostKeyFingerprint === null);
    check("(3) legacy row's sshCommandAllowlist/sshRiskyPatterns backfilled to '[]'", legacyRow.sshCommandAllowlist === "[]" && legacyRow.sshRiskyPatterns === "[]");
    // ssh_read_only has a NOT NULL DEFAULT 1 (db.ts), so the ADD COLUMN migration backfills it to 1/true —
    // checked at both the raw SQLite column (the actual migrated value) and the mapped boolean (the
    // read path `(r.ssh_read_only as number | null) !== 0` would ALSO read a stray NULL as true, so the
    // raw check is what actually proves the backfill happened rather than masking a missing default).
    const raw3 = new Database(dbFile, { readonly: true });
    let rawReadOnly;
    try {
      rawReadOnly = raw3.prepare("SELECT ssh_read_only FROM connections WHERE id = ?").get(legacyId).ssh_read_only;
    } finally {
      raw3.close();
    }
    check("(3) legacy row's RAW ssh_read_only column backfilled to 1", rawReadOnly === 1);
    check("(3) legacy row's mapped sshReadOnly backfilled to true", legacyRow.sshReadOnly === true);

    // ===== (4) the legacy row still round-trips through the store's normal read paths post-migration =====
    const { listConnections, getConnectionMetadata, getSecretForUse } = await import("../dist/connections/store.js");
    const { decryptSecret } = await import("../dist/keys/envelope.js");
    // (the legacy row's blob is a placeholder ciphertext from a different key file — just prove the shape
    // is intact, not that it decrypts to a real secret; a genuine encrypt/decrypt round trip is covered by
    // connections-ssh-store.mjs's own Part 1.)
    check("(4) legacy row's secretBlob is unchanged bytes", legacyRow.secretBlob === "v1:AAAA:BBBB:CCCC");
    const meta = getConnectionMetadata(db, legacyId);
    check("(4) getConnectionMetadata still resolves the legacy row", meta !== undefined && meta.name === "Legacy GitHub PAT");
    check("(4) a non-ssh row's metadata carries NO ssh-shaped keys", !("port" in meta) && !("user" in meta) && !("hostKeyFingerprint" in meta) && !("readOnly" in meta) && !("commandAllowlist" in meta));
    const list = listConnections(db);
    check("(4) listConnections includes the legacy row", list.some((c) => c.id === legacyId));

    // ===== (5) a brand-new ssh connection registers + round-trips against the migrated DB =====
    const { createSshConnection, getSshPrivateKeyForUse, updateSshConnectionConfig } = await import("../dist/connections/store.js");
    const sshDefault = (await import("ssh2")).default;
    const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs"); // ssh2's ed25519 generator is malformed 1/256 (card 28c304b2)
    const unenc = generateParseableEd25519(sshDefault.utils);
    const created = createSshConnection(db, {
      name: "New Homelab Host", host: "10.0.0.10", user: "loom",
      privateKey: unenc.private, hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    });
    check("(5) new ssh connection created against the migrated DB", created.authScheme === "ssh" && created.user === "loom");
    const decrypted = getSshPrivateKeyForUse(db, created.id);
    check("(5) the new connection's key round-trips (same public-key bytes)", Buffer.compare(sshDefault.utils.parseKey(decrypted).getPublicSSH(), sshDefault.utils.parseKey(unenc.private).getPublicSSH()) === 0);
    const updated = updateSshConnectionConfig(db, created.id, { readOnly: false });
    check("(5) the new connection's config updates against the migrated DB", updated.readOnly === false);

    // The legacy row is UNDISTURBED by the new ssh row's writes.
    const legacyAfter = db.getConnection(legacyId);
    check("(5) the legacy row is untouched by the new ssh connection's writes", legacyAfter.secretBlob === "v1:AAAA:BBBB:CCCC" && legacyAfter.sshPort === null);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-ssh-phase `connections` DB (no ssh_* columns), migrateConnections() ADD-COLUMNs land on upgrade, the pre-existing api-key/bearer row backfills to null/'[]' in place with its secret untouched and stays metadata-clean (no ssh-shaped keys), and a brand-new ssh connection registers + round-trips (create -> decrypt -> update config) against the same migrated DB without disturbing the legacy row."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
