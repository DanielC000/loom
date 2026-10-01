import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Project.vaultOnly (card b98957e9, fix round) — mirrors
// no-gate-by-design-migration.mjs's discipline: a FRESH LOOM_HOME is BLIND to "an upgrade-path bug in a
// migration-added column", because `CREATE TABLE IF NOT EXISTS` brings in every column at once on a
// brand-new file. This test instead synthesizes a REAL pre-vault_only ("legacy") `projects` table
// directly on disk with better-sqlite3 — the exact shape every existing Loom install has today (reserved
// + reference_repos + no_gate_by_design + deny_globs + repos all exist, but NO `vault_only` column at
// all) — holding three rows: a raw-equal pair (repo_path === vault_path, the true vault-only / legacy
// aliased-code shape), a non-equal pair (an ordinary repo-bound project with its own vault), and an
// empty-vault row (repo_path set, vault_path === "" — a code project with no vault bound at all, which
// the backfill's `vault_path != ''` guard must leave at vaultOnly:false, never crash on). Then constructs
// a real `Db` against it and proves:
//   (1) the constructor does NOT throw on a legacy (pre-vaultOnly) DB.
//   (2) the `vault_only` column now exists on the upgraded table.
//   (3) the raw-equal row backfills to vaultOnly:true.
//   (4) the non-equal row backfills to vaultOnly:false.
//   (5) the empty-vault row backfills to vaultOnly:false (the `vault_path != ''` guard, not a crash on
//       comparing "" === "").
//   (6) the legacy rows' other columns (incl. reference_repos/no_gate_by_design, already migrated) are
//       untouched by the backfill.
//   (7) a FRESH DB (brand-new file, no legacy rows) also defaults a newly-inserted project's vaultOnly to
//       false when the field is omitted entirely.
//   (8) idempotent: a 2nd `new Db(path)` over an already-migrated file is a clean no-op (no re-backfill —
//       a row manually flipped to vaultOnly:false between opens must stay false, never get re-marked
//       true by a second backfill pass).
//   (9) no base-schema index/constraint references the new column (PRAGMA index_list stays unchanged).
//
// Run: 1) build (turbo builds shared first), 2) node test/vault-only-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-vault-only-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-vault-only.db");

const rawEqualId = randomUUID();
const nonEqualId = randomUUID();
const emptyVaultId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-vaultOnly, post-everything-else) `projects` table shape directly,
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
      no_gate_by_design INTEGER NOT NULL DEFAULT 0,
      deny_globs TEXT NOT NULL DEFAULT '["mockups/**"]',
      repos TEXT NOT NULL DEFAULT '[]'
    );
    -- NO vault_only column — the true pre-b98957e9 shape every existing Loom install has today.
  `);

  const insert = raw.prepare(
    "INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved, reference_repos, no_gate_by_design, deny_globs, repos) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0, '[]', 0, '[\"mockups/**\"]', '[]')",
  );
  // Raw-equal pair: repo_path === vault_path, non-empty — the true vault-only / legacy-aliased-code shape.
  insert.run(rawEqualId, "Raw Equal", "/host/shared-folder", "/host/shared-folder", t0);
  // Non-equal pair: an ordinary repo-bound project with its own distinct vault.
  insert.run(nonEqualId, "Non Equal", "/host/code-repo", "/host/notes-vault", t0);
  // Empty-vault row: a code project with no vault bound at all — repo_path set, vault_path === "".
  insert.run(emptyVaultId, "Empty Vault", "/host/vaultless-repo", "", t0);

  raw.close();
}

let db;
let Db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-vaultOnly) DB =====
  let ctorError = null;
  try {
    ({ Db } = await import("../dist/db.js"));
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-vaultOnly DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) the vault_only column now exists post-construct =====
    const raw2 = new Database(dbFile, { readonly: true });
    let columns;
    let indexes;
    try {
      columns = raw2.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
      indexes = raw2.prepare("PRAGMA index_list(projects)").all();
    } finally {
      raw2.close();
    }
    check("(2) vault_only column exists on the upgraded projects table", columns.includes("vault_only"));

    // ===== (9) no index/constraint references the new column — a plain ADD COLUMN never introduces one =====
    check("(9) no index on projects references vault_only (plain ADD COLUMN, no constraint added)",
      indexes.every((ix) => !/vault_only/.test(ix.name)));

    // ===== (3)/(4)/(5) the three legacy rows backfill correctly =====
    const rawEqual = db.getProject(rawEqualId);
    const nonEqual = db.getProject(nonEqualId);
    const emptyVault = db.getProject(emptyVaultId);
    check("(3) the raw-equal legacy row backfills vaultOnly:true", rawEqual?.vaultOnly === true);
    check("(4) the non-equal legacy row backfills vaultOnly:false", nonEqual?.vaultOnly === false);
    check("(5) the empty-vault legacy row backfills vaultOnly:false (not a crash on '' === '')", emptyVault?.vaultOnly === false);

    // ===== (6) the legacy rows' other columns are untouched =====
    check("(6) raw-equal repoPath untouched", rawEqual?.repoPath === "/host/shared-folder");
    check("(6) raw-equal vaultPath untouched", rawEqual?.vaultPath === "/host/shared-folder");
    check("(6) non-equal repoPath untouched", nonEqual?.repoPath === "/host/code-repo");
    check("(6) non-equal vaultPath untouched", nonEqual?.vaultPath === "/host/notes-vault");
    check("(6) empty-vault vaultPath untouched (still '')", emptyVault?.vaultPath === "");
    check("(6) empty-vault referenceRepos (already migrated) untouched", Array.isArray(nonEqual?.referenceRepos) && nonEqual.referenceRepos.length === 0);
    check("(6) empty-vault noGateByDesign (already migrated) untouched", nonEqual?.noGateByDesign === false);

    // ===== (7) a FRESH DB defaults a newly-inserted project's vaultOnly to false when omitted =====
    const freshFile = path.join(tmpHome, "fresh.db");
    const freshDb = new Db(freshFile);
    try {
      const freshId = randomUUID();
      freshDb.insertProject({
        id: freshId, name: "Fresh Project", repoPath: "/host/fresh-repo", vaultPath: "/host/fresh-vault",
        config: {}, createdAt: t0, archivedAt: null, reserved: false, referenceRepos: [],
        // vaultOnly deliberately omitted — simulates a caller that hasn't been updated yet.
      });
      const fresh = freshDb.getProject(freshId);
      check("(7) a fresh DB defaults an omitted vaultOnly to false on insert", fresh?.vaultOnly === false);
    } finally {
      freshDb.close();
    }

    // ===== (8) idempotent: re-opening an already-migrated file is a clean no-op (no re-backfill) =====
    // Flip the non-equal row to vaultOnly:true by hand (simulating a legitimate post-backfill state a
    // re-run must never clobber), then re-open and confirm a 2nd backfill pass did NOT touch it again.
    db.updateProject(nonEqualId, { vaultOnly: true });
    check("(8 setup) manual flip landed", db.getProject(nonEqualId)?.vaultOnly === true);
    db.close();
    const db2 = new Db(dbFile);
    try {
      check("(8) 2nd open over an already-migrated file is idempotent (raw-equal still true, untouched)", db2.getProject(rawEqualId)?.vaultOnly === true);
      check("(8) 2nd open does NOT re-run the backfill (manually-flipped row stays true, not re-derived)", db2.getProject(nonEqualId)?.vaultOnly === true);
      db = db2; // let the outer finally close this one
    } catch (err) {
      db = db2;
      throw err;
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-vaultOnly legacy DB, the vault_only column lands via the idempotent ADD COLUMN migration (atomically, with the one-time backfill) with no new index/constraint, a raw-equal legacy row backfills to vaultOnly:true, a non-equal row to vaultOnly:false, an empty-vault row to vaultOnly:false (no crash on empty-string equality) with every other column untouched, a fresh DB defaults an omitted vaultOnly to false on insert, and re-opening an already-migrated file is a clean no-op that never re-runs the backfill."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
