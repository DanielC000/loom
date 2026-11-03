import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card dfef375f round 3 item 1 — schema-upgrade guard for the new `rate_limit_bailed_at` column (mirrors
// halted-recycle-pending-schema-migration.mjs / db-legacy-boot.mjs's own (B2): a `SESSION_ADDED_COLUMNS`
// migration is exactly the class that shipped a real P0 boot crash before (project memory
// `verify-schema-change-against-upgraded-db`), because it was only ever tested against a FRESH DB —
// `CREATE TABLE IF NOT EXISTS` no-ops on a table that already exists in its OLD shape, so a SCHEMA-level
// statement referencing a migration-only column blows up with `SqliteError: no such column: ...` on any
// real, already-upgraded install.
//
// Builds the legacy fixture from a genuinely BLANK database holding ONLY a hand-derived `sessions` table
// — its CREATE TABLE SQL read straight off a reference DB's own `sqlite_master` (never hand-typed, so it
// can't drift from the real schema) with just the one new column's definition line stripped out. Opening
// THIS with the real `Db` class is what actually exercises `exec(SCHEMA)` running its full CREATE TABLE
// statement against an EXISTING, column-less table (the `IF NOT EXISTS` no-op).
//
// Proves:
//   (1) the constructor does NOT throw opening a DB that predates this column.
//   (2) `rate_limit_bailed_at` exists again post-reopen (checked via PRAGMA table_info — NOT via a
//       `Session` projection alone, though toSession is also checked below), and a pre-existing live
//       session row survives intact with the new column backfilled to NULL.
//   (3) `listRateLimited()` does NOT return it (NULL, not a stray "rate-limited" row) — the migrated-in
//       legacy row never ran through the new bail path and must not look parked.
//   (4) the new setter/getter round-trip cleanly post-migration (bail stamp, then human clear), and
//       `listRateLimited()` now picks the row up by the BAILED half of its widened OR, never the park half.
//   (5) migration is idempotent on a THIRD open (checked via PRAGMA table_info again — exactly one
//       occurrence of the column, not zero or duplicated).
//   (6) statement-scoped (never line-scoped): no CREATE INDEX/TRIGGER/VIEW statement anywhere in db.ts's
//       own SCHEMA text references the new column — a base-schema index/constraint/trigger/view on a
//       migration-only column is exactly the shape that crashes pre-migration.
//
// Run: 1) build (turbo builds shared first), 2) node test/rate-limit-bailed-at-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rlbam-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

const sid = "sess-rlbam";
const now = new Date().toISOString();

// ===== Derive the REAL sessions/projects/agents CREATE TABLE SQL + sessions' required columns, all from
// a reference DB (never hand-typed) =====
const refFile = path.join(tmpHome, "ref.db");
let legacySql, projectsSql, agentsSql;
let requiredCols;
{
  const refDb = new Db(refFile);
  refDb.close();
  const refRaw = new Database(refFile, { readonly: true });
  const realSql = refRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql;
  projectsSql = refRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get().sql;
  agentsSql = refRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get().sql;
  requiredCols = refRaw.prepare("PRAGMA table_info(sessions)").all()
    .filter((c) => c.notnull === 1 && c.dflt_value === null).map((c) => c.name);
  refRaw.close();
  check("(setup) the real schema DOES have the column before we strip it", realSql.includes("rate_limit_bailed_at"));
  legacySql = realSql.replace(/[^\n]*rate_limit_bailed_at[^\n]*\n/, "");
  check("(setup) the strip actually removed something", legacySql.length < realSql.length);
  check("(setup) the stripped SQL no longer mentions the column at all", !legacySql.includes("rate_limit_bailed_at"));
  check("(setup) sanity: required (notnull, no-default) columns were found", requiredCols.length > 0);
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(refFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===== Build a GENUINELY BLANK DB holding ONLY the stripped (legacy-shaped) sessions table, plus the
// projects/agents tables its own FK references require to even prepare an INSERT =====
const dbFile = path.join(tmpHome, "rlbam.db");
{
  const raw = new Database(dbFile);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`${projectsSql};\n${agentsSql};\n${legacySql}`);
  const tableCount = raw.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  check("(precondition) the blank DB holds ONLY the sessions/projects/agents tables before migration", tableCount === 3);
  const colsBefore = new Set(raw.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name));
  check("(precondition) legacy DB has NONE of rate_limit_bailed_at", !colsBefore.has("rate_limit_bailed_at"));

  const cols = [...requiredCols, "role"];
  const placeholders = cols.map(() => "?").join(",");
  const valuesFor = (id) => cols.map((c) => {
    if (c === "project_id" || c === "agent_id" || c === "cwd") return "rlbam";
    if (c === "created_at" || c === "last_activity") return now;
    if (c === "role") return "manager";
    if (c === "process_state") return "live";
    return id; // falls back to the id itself for any other required column this schema might add later
  });
  raw.prepare(`INSERT INTO sessions (id, ${cols.join(",")}) VALUES (?, ${placeholders})`).run(sid, ...valuesFor(sid));
  check("(precondition) the live session row landed in the legacy table",
    raw.prepare("SELECT count(*) AS c FROM sessions").get().c === 1);
  raw.close();
}

// ===== Reopen with THIS branch's real Db — must migrate without throwing =====
{
  let db;
  let threw = null;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(1) opening a pre-migration DB does NOT throw", threw === null);

  const raw = new Database(dbFile, { readonly: true });
  const colsAfter = raw.prepare("PRAGMA table_info(sessions)").all();
  check("(2) rate_limit_bailed_at exists again post-migration", colsAfter.some((c) => c.name === "rate_limit_bailed_at"));
  raw.close();

  const migrated = db.getSession(sid);
  check("(2) the pre-existing row survived migration intact", migrated?.id === sid);
  check("(2) the new column backfills to NULL on `toSession` too", migrated?.rateLimitBailedAt === null);

  // Old rows backfill to NULL on BOTH halves of the widened OR — not a stray "rate-limited" row.
  check("(3) listRateLimited() is empty for the migrated-in row (neither park nor bail is set)",
    !db.listRateLimited().some((r) => r.id === sid));

  // The new setter round-trips cleanly post-migration.
  const bailedAt = new Date().toISOString();
  db.setRateLimitBailedAt(sid, bailedAt);
  check("(4) setRateLimitBailedAt round-trips on the migrated DB", db.getSession(sid)?.rateLimitBailedAt === bailedAt);
  check("(4) listRateLimited() now picks the row up via the BAILED half of the widened OR (rateLimitedUntil stays null)",
    db.listRateLimited().some((r) => r.id === sid) && db.getSession(sid)?.rateLimitedUntil === null);
  db.setRateLimitBailedAt(sid, null); // the human-clear half
  check("(4) setRateLimitBailedAt(null) clears it again, and listRateLimited() drops the row",
    db.getSession(sid)?.rateLimitBailedAt === null && !db.listRateLimited().some((r) => r.id === sid));

  db.close();
}

// ===== Idempotency: a THIRD open must not throw and must not duplicate the column =====
{
  let threw = null;
  let db;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(5) a further re-open is idempotent — does not throw", threw === null);
  db.close();

  const raw = new Database(dbFile, { readonly: true });
  const occurrences = raw.prepare("PRAGMA table_info(sessions)").all().filter((c) => c.name === "rate_limit_bailed_at").length;
  check("(5) the column is still there, EXACTLY once (not duplicated by a repeated migration)", occurrences === 1);
  raw.close();
}

// ===== statement-scoped static guard — no CREATE INDEX/TRIGGER/VIEW references the new column =====
{
  const dbTsPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src", "db.ts");
  const dbTsSource = fs.readFileSync(dbTsPath, "utf8");
  const startMarker = "const SCHEMA = `";
  const startIdx = dbTsSource.indexOf(startMarker);
  check("(6) sanity: the SCHEMA template literal's own start marker was found", startIdx !== -1);
  const schemaStart = startIdx + startMarker.length;
  const schemaEnd = dbTsSource.indexOf("`;", schemaStart);
  check("(6) sanity: the SCHEMA template literal's own closing marker was found", schemaEnd !== -1);
  const schemaText = dbTsSource.slice(schemaStart, schemaEnd);

  const statements = schemaText.split(";");
  const ddlKindRe = /CREATE\s+(UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\b/i;
  const ddlStatements = statements.filter((s) => ddlKindRe.test(s));
  check("(6) negative control: the statement scan itself finds real CREATE INDEX/TRIGGER/VIEW statements", ddlStatements.length > 0);
  const offenders = ddlStatements.filter((s) => s.includes("rate_limit_bailed_at"));
  check("(6) NO CREATE INDEX/TRIGGER/VIEW statement references rate_limit_bailed_at", offenders.length === 0);
}

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — rate_limit_bailed_at migrates additively onto a genuinely blank, pre-card-dfef375f-round-3 sessions table (existing rows backfill to NULL, the setter/listRateLimited round-trip cleanly, re-open is idempotent), and no base-schema index/trigger/view statement references it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
