import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 54434e27 — schema-upgrade guard for the new `halted_recycle_pending_for` column (mirrors
// db-legacy-boot.mjs / idle-watch-foundation.mjs's own (B2): a `SESSION_ADDED_COLUMNS` migration is
// exactly the class that shipped a real P0 boot crash before (project memory
// `verify-schema-change-against-upgraded-db`), because it was only ever tested against a FRESH DB —
// `CREATE TABLE IF NOT EXISTS` no-ops on a table that already exists in its OLD shape, so a SCHEMA-level
// statement referencing a migration-only column blows up with `SqliteError: no such column: ...` on any
// real, already-upgraded install.
//
// Code Review `9fe8f672` m4: builds the legacy fixture from a genuinely BLANK database holding ONLY a
// hand-derived `sessions` table — its CREATE TABLE SQL read straight off a reference DB's own
// `sqlite_master` (never hand-typed, so it can't drift from the real schema) with just the one new
// column's definition line stripped out. Opening THIS with the real `Db` class is what actually exercises
// `exec(SCHEMA)` running its full CREATE TABLE statement against an EXISTING, column-less table (the
// `IF NOT EXISTS` no-op) — the prior draft of this test instead surgically `ALTER TABLE ... DROP COLUMN`ed
// a fully-built DB, which is faithful for the migration step itself but one layer further from "this is
// what a genuinely pre-card install's `sessions` table looked like" than the Lead judged trustworthy.
//
// Proves:
//   (1) the constructor does NOT throw opening a DB that predates this column.
//   (2) `halted_recycle_pending_for` exists again post-reopen (checked via PRAGMA table_info — NOT via a
//       `Session` projection, which never exposes this internal-only column at all), and a pre-existing
//       predecessor/successor pair's rows survive intact with the new column backfilled to NULL.
//   (3) `listHaltedRecyclePending()` returns nothing for them (NULL, not a stray "pending" row).
//   (4) `runBootRecoveryPrefix` does not throw against the just-migrated DB; the new marker/reparent
//       methods round-trip cleanly afterward.
//   (5) migration is idempotent on a THIRD open (checked via PRAGMA table_info again — exactly one
//       occurrence of the column, not zero or duplicated).
//   (6) statement-scoped (never line-scoped): no CREATE INDEX/TRIGGER/VIEW statement anywhere in db.ts's
//       own SCHEMA text references the new column — a base-schema index/constraint/trigger/view on a
//       migration-only column is exactly the shape that crashes pre-migration.
//
// Run: 1) build (turbo builds shared first), 2) node test/halted-recycle-pending-schema-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-hrpsm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { runBootRecoveryPrefix } = await import("../dist/sessions/boot-backstop.js");

const predecessorId = "pred-hrpsm";
const successorId = "succ-hrpsm";
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
  // `sessions.project_id`/`agent_id` carry inline `REFERENCES projects(id)`/`REFERENCES agents(id)` —
  // SQLite resolves those targets at DML-PREPARE time regardless of the (default-off) foreign_keys
  // pragma, so a blank DB holding ONLY the stripped sessions table fails to even prepare an INSERT into
  // it ("no such table: main.agents"). Pull their real CREATE TABLE SQL too (unmodified — not under test).
  projectsSql = refRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get().sql;
  agentsSql = refRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get().sql;
  requiredCols = refRaw.prepare("PRAGMA table_info(sessions)").all()
    .filter((c) => c.notnull === 1 && c.dflt_value === null).map((c) => c.name);
  refRaw.close();
  check("(setup) the real schema DOES have the column before we strip it", realSql.includes("halted_recycle_pending_for"));
  // Strip ONLY the one column-definition line — never a comment line that merely mentions the column
  // (this card's own comment above that column deliberately never spells its name, so this is unambiguous).
  legacySql = realSql.replace(/[^\n]*halted_recycle_pending_for[^\n]*\n/, "");
  check("(setup) the strip actually removed something", legacySql.length < realSql.length);
  check("(setup) the stripped SQL no longer mentions the column at all", !legacySql.includes("halted_recycle_pending_for"));
  check("(setup) sanity: required (notnull, no-default) columns were found", requiredCols.length > 0);
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(refFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===== Build a GENUINELY BLANK DB holding ONLY the stripped (legacy-shaped) sessions table, plus the
// projects/agents tables its own FK references require to even prepare an INSERT =====
const dbFile = path.join(tmpHome, "hrpsm.db");
{
  const raw = new Database(dbFile);
  // This build's SQLite defaults `foreign_keys` ON — we're not testing projects/agents row integrity
  // here, only that sessions' own FK-referenced tables exist so an INSERT can even be PREPARED.
  raw.pragma("foreign_keys = OFF");
  raw.exec(`${projectsSql};\n${agentsSql};\n${legacySql}`);
  const tableCount = raw.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  check("(precondition) the blank DB holds ONLY the sessions/projects/agents tables before migration", tableCount === 3);
  const colsBefore = new Set(raw.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name));
  check("(precondition) legacy DB has NONE of halted_recycle_pending_for", !colsBefore.has("halted_recycle_pending_for"));

  // Insert the predecessor/successor pair directly, using only the columns the REAL schema actually
  // requires (derived above, never hand-typed) — `role`/`recycled_from` are nullable extras.
  const cols = [...requiredCols, "role"];
  const placeholders = cols.map(() => "?").join(",");
  const valuesFor = (id, extra) => cols.map((c) => {
    if (c === "project_id" || c === "agent_id" || c === "cwd") return "hrpsm";
    if (c === "created_at" || c === "last_activity") return now;
    if (c === "role") return "manager";
    return id; // falls back to the id itself for any other required column this schema might add later
  });
  raw.prepare(`INSERT INTO sessions (id, ${cols.join(",")}) VALUES (?, ${placeholders})`)
    .run(predecessorId, ...valuesFor(predecessorId));
  raw.prepare(`INSERT INTO sessions (id, ${cols.join(",")}, recycled_from) VALUES (?, ${placeholders}, ?)`)
    .run(successorId, ...valuesFor(successorId), predecessorId);
  check("(precondition) the predecessor/successor pair landed in the legacy table",
    raw.prepare("SELECT count(*) AS c FROM sessions").get().c === 2);
  raw.close();
}

// ===== Reopen with THIS branch's real Db — must migrate without throwing =====
{
  let db;
  let threw = null;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(1) opening a pre-migration DB does NOT throw", threw === null);

  // n1: assert the COLUMN directly (PRAGMA table_info), never a Session-projection proxy — this column is
  // deliberately never exposed on `Session`/`toSession`, so `getSession(...)?.id` would pass even if the
  // column migration silently failed.
  const raw = new Database(dbFile, { readonly: true });
  const colsAfter = raw.prepare("PRAGMA table_info(sessions)").all();
  check("(2) halted_recycle_pending_for exists again post-migration", colsAfter.some((c) => c.name === "halted_recycle_pending_for"));
  raw.close();

  // The pre-existing predecessor/successor pair survived intact.
  check("(2) the predecessor row survived migration intact", db.getSession(predecessorId)?.id === predecessorId);
  check("(2) the successor row survived migration intact, still linked", db.getSession(successorId)?.recycledFrom === predecessorId);

  // Old rows backfill to NULL — not a stray "pending" row for either.
  check("(3) listHaltedRecyclePending() is empty for the migrated-in predecessor/successor pair",
    !db.listHaltedRecyclePending().some((r) => r.predecessorId === predecessorId || r.predecessorId === successorId));

  // The real boot prefix must run cleanly against the just-migrated DB.
  let prefixThrew = null;
  try { runBootRecoveryPrefix(db); } catch (e) { prefixThrew = e; }
  check("(4) runBootRecoveryPrefix does not throw against the migrated DB", prefixThrew === null);

  // The new marker/reparent methods are usable post-migration.
  db.reparentHaltedRecycleLineage(successorId, predecessorId);
  check("(4b) reparentHaltedRecycleLineage + the marker round-trip on the migrated DB",
    db.listHaltedRecyclePending().some((r) => r.predecessorId === predecessorId && r.freshId === successorId));
  db.clearHaltedRecyclePending(predecessorId);
  check("(4c) clearHaltedRecyclePending clears it again", !db.listHaltedRecyclePending().some((r) => r.predecessorId === predecessorId));

  db.close();
}

// ===== Idempotency: a THIRD open must not throw and must not duplicate the column =====
{
  let threw = null;
  let db;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(5) a further re-open is idempotent — does not throw", threw === null);
  db.close();

  // n1: again, assert the COLUMN directly, and that it appears EXACTLY ONCE (never duplicated by a
  // mis-guarded ALTER TABLE ADD COLUMN re-running on an already-migrated table).
  const raw = new Database(dbFile, { readonly: true });
  const occurrences = raw.prepare("PRAGMA table_info(sessions)").all().filter((c) => c.name === "halted_recycle_pending_for").length;
  check("(5) the column is still there, EXACTLY once (not duplicated by a repeated migration)", occurrences === 1);
  raw.close();
}

// ===== m4: statement-scoped static guard — no CREATE INDEX/TRIGGER/VIEW references the new column =====
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

  // Statement-scoped, not line-scoped: split the WHOLE schema on `;` so a CREATE INDEX/TRIGGER/VIEW that
  // happens to span multiple lines (or has the column name on a different line than the CREATE keyword,
  // within the SAME statement) is still caught as one unit.
  const statements = schemaText.split(";");
  const ddlKindRe = /CREATE\s+(UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\b/i;
  const ddlStatements = statements.filter((s) => ddlKindRe.test(s));
  check("(6) negative control: the statement scan itself finds real CREATE INDEX/TRIGGER/VIEW statements", ddlStatements.length > 0);
  const offenders = ddlStatements.filter((s) => s.includes("halted_recycle_pending_for"));
  check("(6) NO CREATE INDEX/TRIGGER/VIEW statement references halted_recycle_pending_for", offenders.length === 0);
}

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — halted_recycle_pending_for migrates additively onto a genuinely blank, pre-card-54434e27 sessions table (existing rows backfill to NULL, the real boot prefix runs clean, re-open is idempotent), and no base-schema index/trigger/view statement references it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
