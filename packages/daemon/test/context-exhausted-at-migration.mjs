import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66ff7321 (part C of 8c7dfc65) — schema-upgrade guard for the new `context_exhausted_at` column.
// Mirrors cut-base-sha-migration.mjs's discipline exactly (project memory
// verify-schema-change-against-upgraded-db: a SESSION_ADDED_COLUMNS migration is only ever safe if
// tested against a GENUINELY pre-migration on-disk shape, never only a fresh DB — `CREATE TABLE IF NOT
// EXISTS` no-ops on a table that already exists in its OLD shape).
//
// Builds the legacy fixture from a genuinely BLANK database holding ONLY a hand-derived `sessions`
// table — its CREATE TABLE SQL read straight off a reference DB's own `sqlite_master` (never
// hand-typed, so it can't drift from the real schema) with just the one new column's definition line
// stripped out. Opening THIS with the real `Db` class is what actually exercises `exec(SCHEMA)` running
// its full CREATE TABLE statement against an EXISTING, column-less table (the `IF NOT EXISTS` no-op).
//
// Proves:
//   (1) the constructor does NOT throw opening a DB that predates this column.
//   (2) `context_exhausted_at` exists again post-reopen (PRAGMA table_info), and a pre-existing row
//       survives intact with the new column backfilled to NULL — both at the raw-column level AND via
//       `Session.contextExhaustedAt`.
//   (3) the legacy row reads `contextExhaustedAt: null` through `getSession` — the correct "never
//       exhausted" default for every row that predates this feature.
//   (4) `Db.setContextExhausted`/`clearContextExhaustedOnResume` both work correctly on the migrated DB.
//   (5) migration is idempotent on a THIRD open (PRAGMA table_info again — exactly one occurrence).
//   (6) statement-scoped (never line-scoped): no CREATE INDEX/TRIGGER/VIEW statement anywhere in db.ts's
//       own SCHEMA text references the new column (CLAUDE.md's "no base-schema index may reference a
//       migrate-added column" rule).
//
// Run: 1) build (turbo builds shared first), 2) node test/context-exhausted-at-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ceam-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

const legacyId = "legacy-ceam";
const now = new Date().toISOString();

// ===== Derive the REAL sessions/projects/agents CREATE TABLE SQL + sessions' required columns, all
// from a reference DB (never hand-typed) =====
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
  check("(setup) the real schema DOES have the column before we strip it", realSql.includes("context_exhausted_at"));
  // Strip ONLY the `, context_exhausted_at TEXT` fragment — NOT a whole line: this column is the LAST
  // one ALTER TABLE ADD COLUMN appended, so SQLite's rewritten sqlite_master.sql has no trailing `\n`
  // after it (confirmed empirically: it sits directly before the closing `)`), unlike cut_base_sha's
  // own line-oriented strip (that column isn't last). A fragment strip is correct either way.
  legacySql = realSql.replace(/,\s*context_exhausted_at\s+TEXT/, "");
  check("(setup) the strip actually removed something", legacySql.length < realSql.length);
  check("(setup) the stripped SQL no longer mentions the column at all", !legacySql.includes("context_exhausted_at"));
  check("(setup) sanity: required (notnull, no-default) columns were found", requiredCols.length > 0);
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(refFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===== Build a GENUINELY BLANK DB holding ONLY the stripped (legacy-shaped) sessions table, plus the
// projects/agents tables its own FK references require to even prepare an INSERT =====
const dbFile = path.join(tmpHome, "ceam.db");
{
  const raw = new Database(dbFile);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`${projectsSql};\n${agentsSql};\n${legacySql}`);
  const tableCount = raw.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  check("(precondition) the blank DB holds ONLY the sessions/projects/agents tables before migration", tableCount === 3);
  const colsBefore = new Set(raw.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name));
  check("(precondition) legacy DB has NONE of context_exhausted_at", !colsBefore.has("context_exhausted_at"));
  // rate_limited_until IS present (it predates context_exhausted_at) — sanity that the strip was
  // surgical and didn't collaterally remove an unrelated sibling nullable column.
  check("(precondition) legacy DB still has rate_limited_until (an unrelated, older sibling column)", colsBefore.has("rate_limited_until"));

  const fillRequired = (tableName, id) => {
    const reqCols = raw.prepare(`PRAGMA table_info(${tableName})`).all()
      .filter((c) => c.notnull === 1 && c.dflt_value === null && c.name !== "id").map((c) => c.name);
    const vals = reqCols.map((c) => (/_at$/.test(c) ? now : `ceam-${c}`));
    raw.prepare(`INSERT INTO ${tableName} (id, ${reqCols.join(",")}) VALUES (?, ${reqCols.map(() => "?").join(",")})`).run(id, ...vals);
  };
  fillRequired("projects", "ceam");
  fillRequired("agents", "ceam");

  const cols = [...requiredCols, "role", "branch", "worktree_path"];
  const placeholders = cols.map(() => "?").join(",");
  const valuesFor = (id) => cols.map((c) => {
    if (c === "project_id" || c === "agent_id" || c === "cwd") return "ceam";
    if (c === "created_at" || c === "last_activity") return now;
    if (c === "role") return "worker";
    if (c === "branch") return "loom/ceam-task";
    if (c === "worktree_path") return "/host/ceam-worktree";
    return id;
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

  const raw = new Database(dbFile, { readonly: true });
  const colsAfter = raw.prepare("PRAGMA table_info(sessions)").all();
  check("(2) context_exhausted_at exists again post-migration", colsAfter.some((c) => c.name === "context_exhausted_at"));
  raw.close();

  const legacy = db.getSession(legacyId);
  check("(2) the legacy row survived migration intact", legacy?.id === legacyId);
  check("(2) the legacy row's branch (already-migrated column) is untouched", legacy?.branch === "loom/ceam-task");

  check("(3) the legacy row backfills contextExhaustedAt to null", legacy?.contextExhaustedAt === null);

  // ===== (4) setContextExhausted/clearContextExhaustedOnResume both work on the migrated DB =====
  db.setContextExhausted(legacyId, now, "Context exhausted — migration test.");
  const exhausted = db.getSession(legacyId);
  check("(4) setContextExhausted round-trips on the migrated DB", exhausted?.contextExhaustedAt === now && /migration test/.test(exhausted?.lastError ?? ""));
  db.clearContextExhaustedOnResume(legacyId);
  const cleared = db.getSession(legacyId);
  check("(4) clearContextExhaustedOnResume round-trips on the migrated DB", cleared?.contextExhaustedAt === null && cleared?.lastError === null);

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
  const occurrences = raw.prepare("PRAGMA table_info(sessions)").all().filter((c) => c.name === "context_exhausted_at").length;
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
  const offenders = ddlStatements.filter((s) => s.includes("context_exhausted_at"));
  check("(6) NO CREATE INDEX/TRIGGER/VIEW statement references context_exhausted_at", offenders.length === 0);
}

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — context_exhausted_at migrates additively onto a genuinely blank, pre-card-66ff7321 sessions table (existing rows backfill to contextExhaustedAt: null, setContextExhausted/clearContextExhaustedOnResume both round-trip on the migrated DB, re-open is idempotent), and no base-schema index/trigger/view statement references it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
