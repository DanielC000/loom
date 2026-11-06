import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0683ac4d — boot-test of the `api_key_header` column against a synthesized PRE-MIGRATION `connections` table
// (the six-column P1 shape), per the schema-change doctrine: a fresh LOOM_HOME is blind to a SCHEMA statement that
// references a column a migration was supposed to add. Proves: (1) the constructor does not throw; (2) the column
// exists, nullable TEXT, no default; (3) the legacy row reads back with a NULL header (so it sends X-API-Key) and is
// otherwise byte-identical; (4) NO index in the base SCHEMA references the column (a source scan with a control that
// sees a real index); (5) a second boot is idempotent and keeps a stored value.
// Run: 1) build (turbo builds shared first), 2) node test/connections-api-key-header-migration.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-akh-mig-");
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
    .run(legacyId, "Plex", "192.168.178.136:32400", "api-key", "v1:AAAA:BBBB:CCCC", "2026-01-01T00:00:00.000Z");
  check("(setup) the synthesized table has no api_key_header column", !raw.prepare("PRAGMA table_info(connections)").all().some((c) => c.name === "api_key_header"));
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
  const col = peek.prepare("PRAGMA table_info(connections)").all().find((c) => c.name === "api_key_header");
  peek.close();
  check("(2) the column was added as nullable TEXT with no default", !!col && col.type === "TEXT" && col.notnull === 0 && col.dflt_value === null);

  const row = db.getConnection(legacyId);
  check("(3) the legacy row has a NULL header and is otherwise untouched",
    row.apiKeyHeader === null && row.host === "192.168.178.136:32400" && row.name === "Plex" && row.secretBlob === "v1:AAAA:BBBB:CCCC");
  check("(3) its metadata carries no apiKeyHeader key", !("apiKeyHeader" in getConnectionMetadata(db, legacyId)));

  // (4) no base-SCHEMA index may reference a migration-added column.
  const src = fs.readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  const indexesOnIt = src.split("\n").filter((l) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(l) && /api_key_header/.test(l));
  check("(4) no CREATE INDEX statement references api_key_header", indexesOnIt.length === 0);
  check("(4) (negative control) the same scan DOES find a real index line in the schema source", src.split("\n").some((l) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(l) && /connections/i.test(l)) || src.split("\n").some((l) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(l)));
  check("(4) (negative control) the migration map DOES carry the column (the scan target exists)", /api_key_header: "TEXT"/.test(src));

  db.close();
  const raw2 = new Database(dbFile);
  raw2.exec("UPDATE connections SET api_key_header = 'X-Plex-Token' WHERE id = 'legacy-plex-row'");
  raw2.close();
  db = new Db(dbFile);
  check("(5) a second boot is idempotent and keeps a stored value", db.getConnection(legacyId).apiKeyHeader === "X-Plex-Token");
  db.close();
}

await finishAndExit(failures);
