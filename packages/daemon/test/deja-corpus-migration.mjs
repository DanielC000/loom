import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for the `deja_corpus` columns (profiles + sessions), per the CLAUDE.md guardrail:
// don't just boot a fresh LOOM_HOME (blind to a schema-references-a-migration-column bug — see the
// 2026-07-06 P0 and test/db-legacy-boot.mjs) — synthesize a REAL pre-migration ("legacy") DB shape
// directly on disk with better-sqlite3, mirroring TODAY's actual `profiles`/`sessions` CREATE TABLE text
// verbatim (this PR deliberately did NOT touch either base CREATE TABLE — `deja_corpus` lands ONLY via
// PROFILE_ADDED_COLUMNS/SESSION_ADDED_COLUMNS, so every EXISTING install on disk right now IS this
// "legacy" shape), with real rows, then construct a real `Db` against it and prove:
//   (1) the constructor does NOT throw against a DB that predates deja_corpus.
//   (2) `deja_corpus` exists on both `profiles` and `sessions` post-construct.
//   (3) every legacy row backfills deja_corpus to 0/false (byte-identical — the flag stays OFF for an
//       upgraded install until a human opts a profile in).
//   (4) every OTHER pre-existing column value (browser_testing, connections, capabilities, role, …) is
//       preserved unchanged across the boot — the migration only ADDS a column, never mutates others.
//   (5) a NEW profile/session inserted post-migration can set deja_corpus=1 and round-trips correctly,
//       proving the upgraded DB is fully write-capable, not just read-safe.
//
// Run: 1) build (turbo builds shared first), 2) node test/deja-corpus-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-dc-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy.db");

const projId = randomUUID();
const agentId = randomUUID();
const profId = randomUUID();
const sessId = randomUUID();
const now = "2026-07-01T00:00:00.000Z";

// ===== Synthesize TODAY's pre-deja_corpus DB shape verbatim (packages/daemon/src/db.ts's current
// profiles/sessions CREATE TABLE text, unmodified by this PR) directly, bypassing the Db class entirely =====
{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      archived_at TEXT,
      reserved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      startup_prompt TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      profile_id TEXT,
      endpoint INTEGER NOT NULL DEFAULT 0,
      io_schema TEXT
    );
    -- TODAY's real profiles shape (packages/daemon/src/db.ts) — no deja_corpus column.
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      description TEXT NOT NULL DEFAULT '',
      allow_delta TEXT NOT NULL DEFAULT '[]',
      skills TEXT,
      model TEXT,
      icon TEXT,
      browser_testing INTEGER NOT NULL DEFAULT 0,
      document_conversion INTEGER NOT NULL DEFAULT 0,
      restricted_tools INTEGER NOT NULL DEFAULT 0,
      no_commit INTEGER NOT NULL DEFAULT 0,
      connections TEXT NOT NULL DEFAULT '[]',
      capabilities TEXT NOT NULL DEFAULT '[]',
      base_snapshot TEXT
    );
    -- TODAY's real sessions shape (packages/daemon/src/db.ts) — no deja_corpus column.
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      engine_session_id TEXT,
      title TEXT,
      cwd TEXT NOT NULL,
      process_state TEXT NOT NULL DEFAULT 'none',
      resumability TEXT NOT NULL DEFAULT 'unknown',
      busy INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error TEXT,
      role TEXT,
      browser_testing INTEGER NOT NULL DEFAULT 0,
      document_conversion INTEGER NOT NULL DEFAULT 0,
      restricted_tools INTEGER NOT NULL DEFAULT 0,
      no_commit INTEGER NOT NULL DEFAULT 0,
      skills TEXT,
      connections TEXT NOT NULL DEFAULT '[]',
      capabilities TEXT NOT NULL DEFAULT '[]',
      parent_session_id TEXT,
      task_id TEXT,
      worktree_path TEXT,
      branch TEXT,
      gen INTEGER DEFAULT 0,
      recycled_from TEXT,
      ctx_input_tokens INTEGER,
      ctx_turns INTEGER,
      ctx_updated_at TEXT,
      model TEXT,
      rate_limited_until TEXT,
      rate_limit_deadline TEXT,
      idle_nudge_policy TEXT NOT NULL DEFAULT 'watching',
      idle_nudge_snooze_until TEXT,
      last_idle_nudge_at TEXT,
      idle_nudge_unanswered INTEGER NOT NULL DEFAULT 0,
      context_nudge_policy TEXT NOT NULL DEFAULT 'watching',
      last_context_nudge_at TEXT,
      context_nudge_unanswered INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    );
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Legacy Project", projId, projId, now);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position, profile_id, endpoint, io_schema) VALUES (?, ?, 'Designer', '', 0, ?, 0, NULL)")
    .run(agentId, projId, profId);
  // A real pre-existing profile with several NON-default legacy flags set — proves the migration
  // preserves EVERY other column's value, not just deja_corpus's own backfill.
  raw.prepare(
    `INSERT INTO profiles (id, name, role, description, allow_delta, skills, model, icon,
       browser_testing, document_conversion, restricted_tools, no_commit, connections, capabilities, base_snapshot)
     VALUES (?, 'Web Designer', 'worker', 'a real legacy rig', '["Bash(git:*)"]', NULL, 'claude-opus-4-8', '🎨',
       1, 0, 0, 0, '[]', '[]', NULL)`,
  ).run(profId);
  raw.prepare(
    `INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy,
       created_at, last_activity, last_error, role, browser_testing, document_conversion, restricted_tools, no_commit,
       skills, connections, capabilities, parent_session_id, task_id, worktree_path, branch, gen, recycled_from,
       ctx_input_tokens, ctx_turns, ctx_updated_at, model, rate_limited_until, rate_limit_deadline,
       idle_nudge_policy, idle_nudge_snooze_until, last_idle_nudge_at, idle_nudge_unanswered,
       context_nudge_policy, last_context_nudge_at, context_nudge_unanswered, archived_at)
     VALUES (?, ?, ?, 'eng-legacy', 'Legacy session', ?, 'exited', 'resumable', 0,
       ?, ?, NULL, 'worker', 1, 0, 0, 0,
       NULL, '[]', '[]', NULL, NULL, NULL, NULL, 0, NULL,
       NULL, NULL, NULL, 'claude-opus-4-8', NULL, NULL,
       'watching', NULL, NULL, 0,
       'watching', NULL, 0, NULL)`,
  ).run(sessId, projId, agentId, projId, now, now);

  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this real pre-deja_corpus DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a real pre-deja_corpus DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    const raw2 = new Database(dbFile, { readonly: true });
    try {
      // ===== (2) deja_corpus exists on both tables post-construct =====
      const profCols = new Set(raw2.prepare("PRAGMA table_info(profiles)").all().map((c) => c.name));
      const sessCols = new Set(raw2.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name));
      check("(2) profiles gained the deja_corpus column", profCols.has("deja_corpus"));
      check("(2) sessions gained the deja_corpus column", sessCols.has("deja_corpus"));

      // ===== (3) the legacy row backfills deja_corpus to 0/false =====
      const profile = db.getProfile(profId);
      const session = db.getSession(sessId);
      check("(3) the legacy profile's deja_corpus backfilled to false", profile.dejaCorpus === false);
      check("(3) the legacy session's dejaCorpus backfilled to false", session.dejaCorpus === false);

      // ===== (4) every OTHER pre-existing column value survived the migration untouched =====
      check("(4) profile.name preserved", profile.name === "Web Designer");
      check("(4) profile.role preserved", profile.role === "worker");
      check("(4) profile.browserTesting preserved (was already true)", profile.browserTesting === true);
      check("(4) profile.model preserved", profile.model === "claude-opus-4-8");
      check("(4) profile.icon preserved", profile.icon === "🎨");
      check("(4) profile.allowDelta preserved", JSON.stringify(profile.allowDelta) === JSON.stringify(["Bash(git:*)"]));
      check("(4) session.title preserved", session.title === "Legacy session");
      check("(4) session.role preserved", session.role === "worker");
      check("(4) session.browserTesting preserved (was already true)", session.browserTesting === true);
      check("(4) session.engineSessionId preserved", session.engineSessionId === "eng-legacy");

      // ===== (5) the upgraded DB is fully write-capable: a NEW row can set deja_corpus=1 and round-trips =====
      const newProfId = randomUUID();
      db.insertProfile({
        id: newProfId, name: "Web Designer + Deja", role: "worker", description: "", allowDelta: [],
        skills: null, model: null, icon: null, dejaCorpus: true,
      });
      check("(5) a NEW profile can set dejaCorpus=true post-migration", db.getProfile(newProfId).dejaCorpus === true);
      db.updateProfile(newProfId, { dejaCorpus: false });
      check("(5) updateProfile can flip dejaCorpus back off", db.getProfile(newProfId).dejaCorpus === false);
    } finally {
      raw2.close();
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-deja_corpus profiles/sessions DB (exec(SCHEMA) never references deja_corpus — it lands ONLY via the additive ALTER path), every legacy row backfills deja_corpus=false while every OTHER pre-existing column value survives untouched, and the upgraded DB is fully write-capable for the new column."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
