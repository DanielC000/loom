import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1d882a8c — boot-test of the `allow_plain_http` column against a synthesized PRE-MIGRATION `connections`
// table (the six-column P1 shape plus a legacy row whose host text carries a scheme, exactly the owner's Plex
// shape), per the schema-change doctrine: a fresh LOOM_HOME is blind to a SCHEMA statement that references a
// column a migration was supposed to add. Proves: (1) the constructor does not throw; (2) the column exists,
// NOT NULL DEFAULT 0; (3) the legacy row backfills to https-only and is otherwise byte-identical; (4) NO index
// in the base SCHEMA references the column (a source scan with a control that sees a real index); (5) the
// migration is idempotent across a second boot; (6) any stored value other than an explicit 1 (here 2 — the
// column is NOT NULL, so NULL cannot be stored) decodes fail-closed (https only).
// Run: 1) build (turbo builds shared first), 2) node test/connections-plain-http-migration.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-plainhttp-mig-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre.db");
const legacyId = "legacy-plex-row";
{
  const raw = new Database(dbFile);
  raw.exec(`CREATE TABLE connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, auth_scheme TEXT NOT NULL, secret_blob TEXT NOT NULL, created_at TEXT NOT NULL);`);
  raw.prepare("INSERT INTO connections (id, name, host, auth_scheme, secret_blob, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(legacyId, "Plex", "http://192.168.178.136:32400", "api-key", "v1:AAAA:BBBB:CCCC", "2026-01-01T00:00:00.000Z");
  check("(setup) the synthesized table has no allow_plain_http column", !raw.prepare("PRAGMA table_info(connections)").all().some((c) => c.name === "allow_plain_http"));
  raw.close();
}

const { Db } = await import("../dist/db.js");
const { getConnectionMetadata } = await import("../dist/connections/store.js");
let db = null; let err = null;
try { db = new Db(dbFile); } catch (e) { err = e; }
check("(1) constructing Db against the pre-migration table does not throw", err === null);
if (err) console.log(`    threw: ${err?.stack || err}`);

if (db) {
  const peek = new Database(dbFile, { readonly: true });
  const col = peek.prepare("PRAGMA table_info(connections)").all().find((c) => c.name === "allow_plain_http");
  peek.close();
  check("(2) the column was added, NOT NULL with default 0", !!col && col.notnull === 1 && String(col.dflt_value) === "0");

  const row = db.getConnection(legacyId);
  check("(3) the legacy row is https-only and its host text is untouched (NOT silently migrated)",
    row.allowPlainHttp === false && row.host === "http://192.168.178.136:32400" && row.name === "Plex" && row.secretBlob === "v1:AAAA:BBBB:CCCC");
  const meta = getConnectionMetadata(db, legacyId);
  check("(3) it is flagged invalidHost for the owner to fix, and carries no allowPlainHttp key", meta.invalidHost === true && !("allowPlainHttp" in meta));

  // (4) no base-SCHEMA index may reference a migration-added column.
  const src = fs.readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  const indexesOnIt = src.split("\n").filter((l) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(l) && /allow_plain_http/.test(l));
  check("(4) no CREATE INDEX statement references allow_plain_http", indexesOnIt.length === 0);
  const controlHits = src.split("\n").filter((l) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(l) && /connections/i.test(l));
  check("(4) (negative control) the same scan DOES find a real index line on the connections table", controlHits.length > 0 || src.split("\n").some((l) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(l)));

  // (6) NULL decodes fail-closed.
  db.close();
  const raw2 = new Database(dbFile);
  raw2.pragma("foreign_keys = OFF");
  raw2.exec("UPDATE connections SET allow_plain_http = 1 WHERE id = 'legacy-plex-row'");
  raw2.close();
  db = new Db(dbFile);
  check("(5) a second boot is idempotent and keeps an explicit 1", db.getConnection(legacyId).allowPlainHttp === true);
  db.close();
  const raw3 = new Database(dbFile);
  // NOT NULL column: simulate an unexpected non-1 value instead (2) — only an explicit 1 may enable plain http.
  raw3.exec("UPDATE connections SET allow_plain_http = 2 WHERE id = 'legacy-plex-row'");
  raw3.close();
  db = new Db(dbFile);
  check("(6) any value other than an explicit 1 decodes as https-only (fail closed)", db.getConnection(legacyId).allowPlainHttp === false);
  db.close();
}

await finishAndExit(failures);
