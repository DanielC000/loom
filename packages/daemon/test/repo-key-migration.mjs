import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Task.repoKey (multi-repo epic 49136451, phase 1) — mirrors
// repos-registry-migration.mjs's discipline: a FRESH LOOM_HOME is BLIND to "an upgrade-path bug in a
// migration-added column", because `CREATE TABLE IF NOT EXISTS` brings in every column at once on a
// brand-new file. This test instead synthesizes a REAL pre-repoKey ("legacy") `tasks` table directly on
// disk with better-sqlite3 — the exact shape every existing Loom install has today (priority/held/
// deferred/held_by all exist, but NO `repo_key` column at all) — then constructs a real `Db` against it
// and proves:
//   (1) the constructor does NOT throw on a legacy (pre-repoKey) DB.
//   (2) the `repo_key` column now exists on the upgraded table.
//   (3) a legacy task row backfills to repoKey: null (= "primary repo") via getTask.
//   (4) the legacy row's other columns (incl. held/deferred/held_by, already migrated) are untouched.
//   (5) a FRESH DB (brand-new file, no legacy rows) also defaults a newly-inserted task's repoKey to
//       null when the field is omitted entirely.
//   (6) idempotent: a 2nd `new Db(path)` over an already-migrated file is a clean no-op.
//   (7) no base-schema index/constraint references the new column (PRAGMA index_list stays unchanged).
//
// Run: 1) build (turbo builds shared first), 2) node test/repo-key-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-repo-key-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-repo-key.db");

const projId = randomUUID();
const taskId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-repoKey, post-held_by) `projects` + `tasks` table shape directly,
// bypassing Db — the REAL shape a task row has on main today, before this card. `tasks` has an FK to
// `projects`, so a minimal legacy `projects` table is synthesized too. =====
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
      reserved INTEGER NOT NULL DEFAULT 0,
      reference_repos TEXT NOT NULL DEFAULT '[]',
      no_gate_by_design INTEGER NOT NULL DEFAULT 0,
      deny_globs TEXT NOT NULL DEFAULT '["mockups/**"]'
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      column_key TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'p2',
      held INTEGER NOT NULL DEFAULT 0,
      deferred INTEGER NOT NULL DEFAULT 0,
      held_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- NO repo_key column — the true pre-49136451 shape every existing Loom install has today.
  `);

  raw.prepare(
    "INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved, reference_repos, no_gate_by_design, deny_globs) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0, '[]', 0, '[\"mockups/**\"]')",
  ).run(projId, "Legacy Project", "/host/legacy-repo", "/host/legacy-vault", t0);

  raw.prepare(
    "INSERT INTO tasks (id, project_id, title, body, column_key, position, priority, held, deferred, held_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(taskId, projId, "Legacy Task", "legacy body", "backlog", 1.0, "p1", 1, 0, "human", t0, t0);

  raw.close();
}

let db;
let Db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-repoKey) DB =====
  let ctorError = null;
  try {
    ({ Db } = await import("../dist/db.js"));
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-repoKey DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) the repo_key column now exists post-construct =====
    const raw2 = new Database(dbFile, { readonly: true });
    let columns;
    let indexes;
    try {
      columns = raw2.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
      indexes = raw2.prepare("PRAGMA index_list(tasks)").all();
    } finally {
      raw2.close();
    }
    check("(2) repo_key column exists on the upgraded tasks table", columns.includes("repo_key"));

    // ===== (7) no index/constraint references the new column — a plain ADD COLUMN never introduces one ===
    check("(7) no index on tasks references repo_key (plain ADD COLUMN, no constraint added)",
      indexes.every((ix) => !/repo_key/.test(ix.name)));

    // ===== (3) the legacy row backfills to repoKey: null via getTask =====
    const legacy = db.getTask(taskId);
    check("(3) the legacy task row backfills repoKey to null (= primary repo)", legacy?.repoKey === null);

    // ===== (4) the legacy row's other columns are untouched =====
    check("(4) the legacy task's title is untouched", legacy?.title === "Legacy Task");
    check("(4) the legacy task's body is untouched", legacy?.body === "legacy body");
    check("(4) the legacy task's columnKey is untouched", legacy?.columnKey === "backlog");
    check("(4) the legacy task's priority (already migrated) is untouched", legacy?.priority === "p1");
    check("(4) the legacy task's held (already migrated) is untouched", legacy?.held === true);
    check("(4) the legacy task's heldBy (already migrated) is untouched", legacy?.heldBy === "human");

    // ===== (5) a FRESH DB defaults a newly-inserted task's repoKey to null when omitted =====
    const freshFile = path.join(tmpHome, "fresh.db");
    const freshDb = new Db(freshFile);
    try {
      const freshProjId = randomUUID();
      freshDb.insertProject({
        id: freshProjId, name: "Fresh Project", repoPath: "/host/fresh-repo", vaultPath: "/host/fresh-vault",
        config: {}, createdAt: t0, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [],
      });
      const freshTaskId = randomUUID();
      freshDb.insertTask({
        id: freshTaskId, projectId: freshProjId, title: "Fresh Task", body: "", columnKey: "backlog", position: 1,
        priority: "p2", createdAt: t0, updatedAt: t0,
        // repoKey deliberately omitted — simulates a caller that hasn't been updated yet.
      });
      const fresh = freshDb.getTask(freshTaskId);
      check("(5) a fresh DB defaults an omitted repoKey to null on insert", fresh?.repoKey === null);
    } finally {
      freshDb.close();
    }

    // ===== (6) idempotent: re-opening an already-migrated file is a clean no-op =====
    const db2 = new Db(dbFile);
    try {
      const again = db2.getTask(taskId);
      check("(6) 2nd open over an already-migrated file is idempotent (repoKey unchanged)", again?.repoKey === null);
    } finally {
      db2.close();
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-repoKey legacy DB, the repo_key column lands via the idempotent ADD COLUMN migration with no new index/constraint, a legacy row backfills to repoKey: null (primary repo) with every other column untouched, a fresh DB defaults an omitted repoKey the same way on insert, and re-opening an already-migrated file is a clean no-op."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
