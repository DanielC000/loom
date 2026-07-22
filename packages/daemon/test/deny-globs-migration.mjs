import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Project.denyGlobs (card d5d3bdc9) — mirrors no-gate-by-design-migration.mjs's
// discipline: a FRESH LOOM_HOME is BLIND to "an upgrade-path bug in a migration-added column", because
// `CREATE TABLE IF NOT EXISTS` brings in every column at once on a brand-new file. This test instead
// synthesizes a REAL pre-denyGlobs ("legacy") `projects` table directly on disk with better-sqlite3 — the
// exact shape every existing Loom install has today (post no-gate-by-design: `reserved` + `reference_repos`
// + `no_gate_by_design` all exist, but NO `deny_globs` column at all) — then constructs a real `Db` against
// it and proves:
//   (1) the constructor does NOT throw on a legacy (pre-denyGlobs) DB.
//   (2) the `deny_globs` column now exists on the upgraded table.
//   (3) a legacy project row backfills to denyGlobs: ["mockups/**"] (the SAME default a fresh project
//       gets — not [] like reference_repos) via getProject.
//   (4) the legacy row's other columns (incl. no_gate_by_design, already migrated) are untouched.
//   (5) a FRESH DB (brand-new file, no legacy rows) also defaults a newly-inserted project's denyGlobs to
//       ["mockups/**"] when the field is omitted entirely.
//   (6) idempotent: a 2nd `new Db(path)` over an already-migrated file is a clean no-op.
//   (7) no base-schema index/constraint references the new column (PRAGMA index_list stays unchanged).
//
// Run: 1) build (turbo builds shared first), 2) node test/deny-globs-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-deny-globs-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-deny-globs.db");

const projId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-denyGlobs, post-noGateByDesign) `projects` table shape directly,
// bypassing Db — the REAL shape of a project row on main today, before this card. =====
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
      no_gate_by_design INTEGER NOT NULL DEFAULT 0
    );
    -- NO deny_globs column — the true pre-d5d3bdc9 shape every existing Loom install has today.
  `);

  raw.prepare(
    "INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved, reference_repos, no_gate_by_design) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0, '[]', 0)",
  ).run(projId, "Legacy Project", "/host/legacy-repo", "/host/legacy-vault", t0);

  raw.close();
}

let db;
let Db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-denyGlobs) DB =====
  let ctorError = null;
  try {
    ({ Db } = await import("../dist/db.js"));
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-denyGlobs DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) the deny_globs column now exists post-construct =====
    const raw2 = new Database(dbFile, { readonly: true });
    let columns;
    let indexes;
    try {
      columns = raw2.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
      indexes = raw2.prepare("PRAGMA index_list(projects)").all();
    } finally {
      raw2.close();
    }
    check("(2) deny_globs column exists on the upgraded projects table", columns.includes("deny_globs"));

    // ===== (7) no index/constraint references the new column — a plain ADD COLUMN never introduces one ===
    check("(7) no index on projects references deny_globs (plain ADD COLUMN, no constraint added)",
      indexes.every((ix) => !/deny_globs/.test(ix.name)));

    // ===== (3) the legacy row backfills to denyGlobs: ["mockups/**"] via getProject =====
    const legacy = db.getProject(projId);
    check("(3) the legacy project row backfills denyGlobs to [\"mockups/**\"]",
      Array.isArray(legacy?.denyGlobs) && legacy.denyGlobs.length === 1 && legacy.denyGlobs[0] === "mockups/**");

    // ===== (4) the legacy row's other columns are untouched =====
    check("(4) the legacy project's name is untouched", legacy?.name === "Legacy Project");
    check("(4) the legacy project's repoPath is untouched", legacy?.repoPath === "/host/legacy-repo");
    check("(4) the legacy project's vaultPath is untouched", legacy?.vaultPath === "/host/legacy-vault");
    check("(4) the legacy project's reserved flag is untouched", legacy?.reserved === false);
    check("(4) the legacy project's referenceRepos (already migrated) is untouched", Array.isArray(legacy?.referenceRepos) && legacy.referenceRepos.length === 0);
    check("(4) the legacy project's noGateByDesign (already migrated) is untouched", legacy?.noGateByDesign === false);

    // ===== (5) a FRESH DB defaults a newly-inserted project's denyGlobs to ["mockups/**"] when omitted ====
    const freshFile = path.join(tmpHome, "fresh.db");
    const freshDb = new Db(freshFile);
    try {
      const freshId = randomUUID();
      freshDb.insertProject({
        id: freshId, name: "Fresh Project", repoPath: "/host/fresh-repo", vaultPath: "/host/fresh-vault",
        config: {}, createdAt: t0, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false,
        // denyGlobs deliberately omitted — simulates a caller that hasn't been updated yet.
      });
      const fresh = freshDb.getProject(freshId);
      check("(5) a fresh DB defaults an omitted denyGlobs to [\"mockups/**\"] on insert",
        Array.isArray(fresh?.denyGlobs) && fresh.denyGlobs.length === 1 && fresh.denyGlobs[0] === "mockups/**");
    } finally {
      freshDb.close();
    }

    // ===== (6) idempotent: re-opening an already-migrated file is a clean no-op =====
    const db2 = new Db(dbFile);
    try {
      const again = db2.getProject(projId);
      check("(6) 2nd open over an already-migrated file is idempotent (denyGlobs unchanged)",
        Array.isArray(again?.denyGlobs) && again.denyGlobs.length === 1 && again.denyGlobs[0] === "mockups/**");
    } finally {
      db2.close();
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-denyGlobs legacy DB, the deny_globs column lands via the idempotent ADD COLUMN migration with no new index/constraint, a legacy row backfills to denyGlobs: [\"mockups/**\"] (the same default a fresh project gets) with every other column untouched, a fresh DB defaults an omitted denyGlobs the same way on insert, and re-opening an already-migrated file is a clean no-op."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
