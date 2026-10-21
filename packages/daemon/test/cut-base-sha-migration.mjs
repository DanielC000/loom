import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 — schema-upgrade guard for the new `cut_base_sha` column (mirrors
// halted-recycle-pending-schema-migration.mjs's discipline: a `SESSION_ADDED_COLUMNS` migration is
// exactly the class that shipped a real P0 boot crash before (project memory
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
//   (2) `cut_base_sha` exists again post-reopen (checked via PRAGMA table_info), and a pre-existing row
//       survives intact with the new column backfilled to NULL — both at the raw-column level AND via
//       `Session.cutBaseSha` (this column DOES have a live projection, unlike halted_recycle_pending_for).
//   (3) a legacy row with NO recorded cut base reads `cutBaseSha: null` through `getSession` — the exact
//       shape the fork-point ancestry check (checkCutBaseAncestry) grandfathers as `unknown:true`.
//   (4) a FRESH insert on the migrated DB can set and read back a real cutBaseSha value.
//   (5) migration is idempotent on a THIRD open (checked via PRAGMA table_info again — exactly one
//       occurrence of the column, not zero or duplicated).
//   (6) statement-scoped (never line-scoped): no CREATE INDEX/TRIGGER/VIEW statement anywhere in db.ts's
//       own SCHEMA text references the new column.
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cbsm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

const legacyId = "legacy-cbsm";
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
  check("(setup) the real schema DOES have the column before we strip it", realSql.includes("cut_base_sha"));
  // Strip ONLY the one column-definition line — never a comment line that merely mentions the column.
  legacySql = realSql.replace(/[^\n]*cut_base_sha[^\n]*\n/, "");
  check("(setup) the strip actually removed something", legacySql.length < realSql.length);
  check("(setup) the stripped SQL no longer mentions the column at all", !legacySql.includes("cut_base_sha"));
  check("(setup) sanity: required (notnull, no-default) columns were found", requiredCols.length > 0);
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(refFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===== Build a GENUINELY BLANK DB holding ONLY the stripped (legacy-shaped) sessions table, plus the
// projects/agents tables its own FK references require to even prepare an INSERT =====
const dbFile = path.join(tmpHome, "cbsm.db");
{
  const raw = new Database(dbFile);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`${projectsSql};\n${agentsSql};\n${legacySql}`);
  const tableCount = raw.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  check("(precondition) the blank DB holds ONLY the sessions/projects/agents tables before migration", tableCount === 3);
  const colsBefore = new Set(raw.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name));
  check("(precondition) legacy DB has NONE of cut_base_sha", !colsBefore.has("cut_base_sha"));
  // review_base_sha IS present in the legacy shape (it predates cut_base_sha) — sanity that the strip
  // was surgical and didn't collaterally remove its own sibling nullable-sha column.
  check("(precondition) legacy DB still has review_base_sha (an unrelated, older sibling column)", colsBefore.has("review_base_sha"));

  // The real `Db` class opens with `foreign_keys = ON`, so a LATER insertSession() call (step 4, through
  // the real Db) needs the project_id/agent_id it names to actually exist — insert minimal real rows,
  // generically, from each table's own required (notnull, no-default) columns (never hand-typed).
  const fillRequired = (tableName, id) => {
    const reqCols = raw.prepare(`PRAGMA table_info(${tableName})`).all()
      .filter((c) => c.notnull === 1 && c.dflt_value === null && c.name !== "id").map((c) => c.name);
    const vals = reqCols.map((c) => (/_at$/.test(c) ? now : `cbsm-${c}`));
    raw.prepare(`INSERT INTO ${tableName} (id, ${reqCols.join(",")}) VALUES (?, ${reqCols.map(() => "?").join(",")})`).run(id, ...vals);
  };
  fillRequired("projects", "cbsm");
  fillRequired("agents", "cbsm");

  const cols = [...requiredCols, "role", "branch", "worktree_path"];
  const placeholders = cols.map(() => "?").join(",");
  const valuesFor = (id) => cols.map((c) => {
    if (c === "project_id" || c === "agent_id" || c === "cwd") return "cbsm";
    if (c === "created_at" || c === "last_activity") return now;
    if (c === "role") return "worker";
    if (c === "branch") return "loom/cbsm-task";
    if (c === "worktree_path") return "/host/cbsm-worktree";
    return id; // falls back to the id itself for any other required column this schema might add later
  });
  raw.prepare(`INSERT INTO sessions (id, ${cols.join(",")}) VALUES (?, ${placeholders})`)
    .run(legacyId, ...valuesFor(legacyId));
  check("(precondition) the legacy row landed in the legacy table",
    raw.prepare("SELECT count(*) AS c FROM sessions").get().c === 1);
  raw.close();
}

// ===== Reopen with THIS branch's real Db — must migrate without throwing =====
{
  let db;
  let threw = null;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(1) opening a pre-migration DB does NOT throw", threw === null);

  // n1: assert the COLUMN directly (PRAGMA table_info), independent of the Session projection below.
  const raw = new Database(dbFile, { readonly: true });
  const colsAfter = raw.prepare("PRAGMA table_info(sessions)").all();
  check("(2) cut_base_sha exists again post-migration", colsAfter.some((c) => c.name === "cut_base_sha"));
  raw.close();

  // The pre-existing legacy row survived migration intact.
  const legacy = db.getSession(legacyId);
  check("(2) the legacy row survived migration intact", legacy?.id === legacyId);
  check("(2) the legacy row's branch (already-migrated column) is untouched", legacy?.branch === "loom/cbsm-task");

  // ===== (3) a legacy row with no recorded cut base reads cutBaseSha: null — the exact shape
  // checkCutBaseAncestry grandfathers (unknown:true, never refused). =====
  check("(3) the legacy row backfills cutBaseSha to null (grandfathered, never enforced)", legacy?.cutBaseSha === null);

  // ===== (4) a fresh insert on the migrated DB can set and read back a real cutBaseSha =====
  const freshId = "fresh-cbsm";
  db.insertSession({
    id: freshId, projectId: legacy.projectId, agentId: legacy.agentId, engineSessionId: null, title: null, cwd: "/host/fresh-cbsm-worktree",
    processState: "starting", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", branch: "loom/fresh-cbsm-task", worktreePath: "/host/fresh-cbsm-worktree",
    cutBaseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  const fresh = db.getSession(freshId);
  check("(4) a fresh insert's cutBaseSha round-trips through getSession", fresh?.cutBaseSha === "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

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
  const occurrences = raw.prepare("PRAGMA table_info(sessions)").all().filter((c) => c.name === "cut_base_sha").length;
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
  const offenders = ddlStatements.filter((s) => s.includes("cut_base_sha"));
  check("(6) NO CREATE INDEX/TRIGGER/VIEW statement references cut_base_sha", offenders.length === 0);
}

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — cut_base_sha migrates additively onto a genuinely blank, pre-card-0eaaa693 sessions table (existing rows backfill to cutBaseSha: null, a fresh insert round-trips a real value, re-open is idempotent), and no base-schema index/trigger/view statement references it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
