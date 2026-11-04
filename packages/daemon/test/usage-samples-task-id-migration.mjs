import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 58d5a36f — schema-upgrade guard for the new `task_id` column on `session_usage_samples`.
//
// Mirrors cut-base-sha-migration.mjs's discipline (see project memory
// `verify-schema-change-against-upgraded-db`): a migration-added column must be boot-tested against a
// PRE-MIGRATION database, not just a fresh LOOM_HOME, because a fresh DB is blind to a
// SCHEMA-references-a-migration-column class of bug. The legacy fixture is built by deriving the REAL
// `session_usage_samples` CREATE TABLE SQL from a reference DB's own `sqlite_master` (never hand-typed,
// so it can't drift from the real schema) and stripping ONLY the `task_id` column-definition line — the
// same technique cut-base-sha-migration.mjs uses, which is this project's own established answer to
// "build a pre-migration DB from main's code before your change" when the column is additive and the
// rest of the table shape is unaffected. `session_usage_samples` carries no REFERENCES/FK (unlike
// `sessions`), so the legacy fixture needs no sibling projects/agents table to satisfy a foreign key.
//
// Proves:
//   (1) opening a pre-migration DB does NOT throw.
//   (2) `task_id` exists again post-migration (PRAGMA table_info), and a pre-existing legacy row
//       survives migration intact with task_id backfilled to NULL (the "historical row" shape the
//       read-side join fallback in aggregateSessionUsage relies on).
//   (3) `idx_usage_samples_task` exists post-migration (created inside the migration, never the base
//       SCHEMA).
//   (4) a FRESH insertUsageSample on the migrated DB can set and read back a real task_id value.
//   (5) migration is idempotent on a THIRD open (exactly one occurrence of the column + the index, not
//       zero or duplicated).
//   (6) statement-scoped (never line-scoped) + TABLE-scoped: no CREATE INDEX/TRIGGER/VIEW statement
//       anywhere in db.ts's own base SCHEMA text references BOTH `session_usage_samples` and `task_id`
//       together — table-scoped because "task_id" alone is a column name several OTHER, already-migrated
//       tables also carry (sessions, questions, orchestration_events, ...), so a bare string match would
//       false-positive on those unrelated, legitimate references. A synthetic positive control proves the
//       filter itself can catch a real violation shape, not just that it returns zero on real text.
//   (7) a FRESH install (new Db on a brand-new file) ALSO gets the column + index — the migration runs
//       unconditionally after exec(SCHEMA), not only when upgrading a legacy DB.
//
// Run: 1) build (turbo builds shared first), 2) node test/usage-samples-task-id-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-usidm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

const now = new Date().toISOString();

// ===== Derive the REAL session_usage_samples CREATE TABLE SQL, all from a reference DB (never hand-typed) =====
const refFile = path.join(tmpHome, "ref.db");
let legacySql, realSql;
{
  const refDb = new Db(refFile);
  refDb.close();
  const refRaw = new Database(refFile, { readonly: true });
  realSql = refRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_usage_samples'").get().sql;
  refRaw.close();
  check("(setup) the real schema DOES have the column before we strip it", realSql.includes("task_id"));
  // SQLite's ALTER TABLE ADD COLUMN rewrites sqlite_master's stored CREATE TABLE sql by inserting the new
  // column immediately before the closing paren — `...cost_usd ... ⇒ 0)\n, task_id TEXT)` — rather than
  // appending a clean trailing line, so (unlike cut-base-sha-migration.mjs's sessions fixture, where the
  // added column DOES land on its own `\n`-terminated line) the strip here targets that exact
  // `\n, task_id TEXT)` tail and restores the plain closing paren.
  // The preceding column ends in a trailing `-- ...` LINE comment (runs to end of line) — the replacement
  // must put the restored closing paren on its OWN new line, or it gets silently swallowed into that
  // comment and the statement becomes unparseable ("incomplete input").
  legacySql = realSql.replace(/\n,\s*task_id\s+TEXT\)$/, "\n)");
  check("(setup) the strip actually removed something", legacySql.length < realSql.length);
  check("(setup) the stripped SQL no longer mentions the column at all", !legacySql.includes("task_id"));
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(refFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===== Build a GENUINELY BLANK DB holding ONLY the stripped (legacy-shaped) session_usage_samples table.
// No projects/agents/sessions tables needed — this table carries no REFERENCES/FK. =====
const dbFile = path.join(tmpHome, "usidm.db");
const legacyId = "legacy-usidm";
{
  const raw = new Database(dbFile);
  raw.exec(`${legacySql};`); // sqlite_master.sql carries no trailing semicolon — exec() needs one
  const tableCount = raw.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  check("(precondition) the blank DB holds ONLY the session_usage_samples table before migration", tableCount === 1);
  const colsBefore = new Set(raw.prepare("PRAGMA table_info(session_usage_samples)").all().map((c) => c.name));
  check("(precondition) legacy DB has NONE of task_id", !colsBefore.has("task_id"));
  check("(precondition) legacy DB still has cost_usd (an unrelated, older sibling column)", colsBefore.has("cost_usd"));
  const idxBefore = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_samples_task'").get();
  check("(precondition) legacy DB has NO idx_usage_samples_task index yet", idxBefore === undefined);

  raw.prepare(
    `INSERT INTO session_usage_samples (id,session_id,project_id,agent_id,model,ts,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(legacyId, "legacy-sess", "legacy-proj", "legacy-agent", "claude-opus-4-8", now, 100, 40, 10, 5, 0.1);
  check("(precondition) the legacy row landed in the legacy table",
    raw.prepare("SELECT count(*) AS c FROM session_usage_samples").get().c === 1);
  raw.close();
}

// ===== Reopen with THIS branch's real Db — must migrate without throwing =====
{
  let db;
  let threw = null;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(1) opening a pre-migration DB does NOT throw", threw === null);

  // n1: assert the COLUMN directly (PRAGMA table_info), independent of any aggregation read.
  const raw = new Database(dbFile, { readonly: true });
  const colsAfter = raw.prepare("PRAGMA table_info(session_usage_samples)").all();
  check("(2) task_id exists again post-migration", colsAfter.some((c) => c.name === "task_id"));

  // The pre-existing legacy row survived migration intact, backfilled to task_id: NULL — the exact shape
  // aggregateSessionUsage's byTask join fallback relies on for a sample recorded before this column existed.
  const legacyRow = raw.prepare("SELECT * FROM session_usage_samples WHERE id = ?").get(legacyId);
  check("(2) the legacy row survived migration intact", legacyRow?.id === legacyId && legacyRow?.input_tokens === 100);
  check("(2) the legacy row's task_id backfills to NULL (grandfathered, read via the live-session join fallback)",
    legacyRow?.task_id === null);

  // ===== (3) idx_usage_samples_task exists, created inside the migration (never the base SCHEMA) =====
  const idxAfter = raw.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name='idx_usage_samples_task'").get();
  check("(3) idx_usage_samples_task exists post-migration, on session_usage_samples",
    idxAfter?.tbl_name === "session_usage_samples");
  raw.close();

  // ===== (4) a fresh insertUsageSample on the migrated DB can set and read back a real task_id =====
  const freshId = "fresh-usidm";
  db.insertUsageSample({
    id: freshId, sessionId: "fresh-sess", projectId: "legacy-proj", agentId: "legacy-agent",
    model: "claude-opus-4-8", ts: now, inputTokens: 50, outputTokens: 20, cacheCreationTokens: 5,
    cacheReadTokens: 2, costUsd: 0.05, taskId: "fresh-task-1",
  });
  const rawFresh = new Database(dbFile, { readonly: true });
  const freshRow = rawFresh.prepare("SELECT * FROM session_usage_samples WHERE id = ?").get(freshId);
  rawFresh.close();
  check("(4) a fresh insert's task_id round-trips at the raw column level", freshRow?.task_id === "fresh-task-1");

  db.close();
}

// ===== Idempotency: a THIRD open must not throw and must not duplicate the column or the index =====
{
  let threw = null;
  let db;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(5) a further re-open is idempotent — does not throw", threw === null);
  db.close();

  const raw = new Database(dbFile, { readonly: true });
  const colOccurrences = raw.prepare("PRAGMA table_info(session_usage_samples)").all().filter((c) => c.name === "task_id").length;
  check("(5) the column is still there, EXACTLY once (not duplicated by a repeated migration)", colOccurrences === 1);
  const idxOccurrences = raw.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_usage_samples_task'").get().c;
  check("(5) the index is still there, EXACTLY once (CREATE INDEX IF NOT EXISTS, not duplicated)", idxOccurrences === 1);
  raw.close();
}

// ===== statement-scoped + TABLE-scoped static guard — no CREATE INDEX/TRIGGER/VIEW in the base SCHEMA
// references BOTH session_usage_samples and task_id. "task_id" alone is too broad a string (it's also a
// real, already-migrated column on sessions/questions/orchestration_events/... — a bare match would
// false-positive on those unrelated, legitimate statements), so the filter requires BOTH tokens in the
// SAME statement. A synthetic positive control proves the filter mechanism itself can catch a real
// violation shape before trusting its zero-result on the real SCHEMA text. =====
{
  const dbTsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db.ts");
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

  const referencesTaskIdOn = (s, table) => ddlKindRe.test(s) && s.includes(table) && s.includes("task_id");
  const offenders = ddlStatements.filter((s) => referencesTaskIdOn(s, "session_usage_samples"));
  check("(6) NO CREATE INDEX/TRIGGER/VIEW statement in the base SCHEMA references session_usage_samples.task_id",
    offenders.length === 0);

  // Positive control: the SAME filter, against a synthetic statement shaped exactly like a real violation
  // — proves the filter can fire, so the zero result above isn't from a broken predicate.
  const syntheticViolation = "CREATE INDEX IF NOT EXISTS idx_fake ON session_usage_samples(task_id)";
  check("(6) positive control: the SAME filter DOES flag a synthetic session_usage_samples.task_id statement",
    referencesTaskIdOn(syntheticViolation, "session_usage_samples"));
  // And a negative control on an UNRELATED table's real task_id column (e.g. questions) — the filter must
  // NOT flag it, proving it discriminates by table, not just by the bare string "task_id".
  const unrelatedButRealTaskIdIndex = "CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id)";
  check("(6) negative control: the filter does NOT flag an unrelated table's own (legitimately migrated) task_id index",
    !referencesTaskIdOn(unrelatedButRealTaskIdIndex, "session_usage_samples"));
}

// ===== (7) a FRESH install (brand-new file, no legacy fixture at all) ALSO gets the column + index =====
{
  const freshFile = path.join(tmpHome, "fresh-install.db");
  const db = new Db(freshFile);
  const raw = new Database(freshFile, { readonly: true });
  const cols = raw.prepare("PRAGMA table_info(session_usage_samples)").all();
  check("(7) a fresh install's session_usage_samples carries task_id too (migration runs unconditionally)",
    cols.some((c) => c.name === "task_id"));
  const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_samples_task'").get();
  check("(7) a fresh install also gets idx_usage_samples_task", idx?.name === "idx_usage_samples_task");
  raw.close();
  db.close();
}

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — session_usage_samples.task_id migrates additively onto a genuinely blank, pre-card-58d5a36f table (the legacy row survives migration backfilled to task_id: NULL, a fresh insert round-trips a real value, re-open is idempotent, the index is created only inside the migration), a fresh install gets both unconditionally, and no base-SCHEMA DDL statement references session_usage_samples.task_id (table-scoped, not a bare string match)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
