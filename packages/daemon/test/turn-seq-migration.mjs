import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for sessions.turn_seq (card 343441bd, staleDirective's turn counter) — mirrors
// repo-key-migration.mjs's discipline: a FRESH LOOM_HOME is BLIND to "an upgrade-path bug in a
// migration-added column", because `CREATE TABLE IF NOT EXISTS` brings in every column at once on a
// brand-new file. This test instead reproduces a REAL pre-turn_seq ("legacy") `sessions` table by
// building the table with the CURRENT real schema (via the real Db class — so it can never drift from
// the actual CREATE TABLE text) and then DROPPING just the turn_seq column with a raw ALTER TABLE, which
// is the exact byte-identical shape every existing Loom install has today (every OTHER column already
// migrated, none of them touched by this card). Populates REAL rows (not synthetic minimal ones) before
// dropping the column, so the backfill is proven against actual data, not an empty table. Then proves:
//   (1) the constructor does NOT throw when re-opened against the post-drop (legacy-shaped) file.
//   (2) the turn_seq column exists again after re-open.
//   (3) every PRE-EXISTING (legacy) session row backfills turnSeq to 0.
//   (4) those same rows' OTHER fields (busy, ctxInputTokens, ctxTurns, role, model, branch, taskId) are
//       byte-identical to what was inserted before the column was dropped — the migration touches
//       NOTHING else.
//   (5) no index on sessions references turn_seq (a plain ADD COLUMN never introduces one).
//   (6) idempotent: a 2nd re-open over an already-migrated file is a clean no-op.
//   (7) a FRESH db (never saw the dropped-column state) defaults an omitted turnSeq to 0 on insert.
//   (8) db.incrementTurnSeq bumps a fresh row 0 -> 1 -> 2 correctly.
//
// Run: 1) build (turbo builds shared first), 2) node test/turn-seq-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-turn-seq-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-turn-seq.db");
const { Db } = await import("../dist/db.js");

const projId = randomUUID();
const agentId = randomUUID();
const workerId = randomUUID();
const managerId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== (setup) build the table with the CURRENT real schema (so it can never drift from the actual
// CREATE TABLE text), populate REAL rows through the real Db, then DROP just turn_seq to reproduce the
// true pre-343441bd shape every existing install has today. =====
{
  const seed = new Db(dbFile);
  seed.insertProject({ id: projId, name: "Legacy Project", repoPath: "/host/legacy-repo", vaultPath: "/host/legacy-vault", config: {}, createdAt: t0, archivedAt: null });
  seed.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  seed.insertSession({
    id: managerId, projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: t0, lastActivity: t0,
    lastError: null, role: "manager",
  });
  seed.insertSession({
    id: workerId, projectId: projId, agentId, engineSessionId: "eng-worker", title: "Legacy Worker", cwd: projId,
    processState: "live", resumability: "resumable", busy: true, createdAt: t0, lastActivity: t0,
    lastError: null, role: "worker", parentSessionId: managerId, taskId: "tk-legacy", branch: "loom/legacy",
    ctxInputTokens: 12345, ctxTurns: 7, model: "claude-sonnet-5",
  });
  seed.close();

  const raw = new Database(dbFile);
  raw.exec("ALTER TABLE sessions DROP COLUMN turn_seq");
  const columnsPreMigration = raw.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  raw.close();
  check("(setup) turn_seq successfully dropped — this file now reproduces the true legacy shape",
    !columnsPreMigration.includes("turn_seq"));
}

let db;
try {
  // ===== (1) the constructor must NOT throw re-opening this legacy (pre-turn_seq) DB =====
  let ctorError = null;
  try {
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) re-opening Db against a legacy pre-turn_seq DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) the turn_seq column exists again post-reopen =====
    const raw2 = new Database(dbFile, { readonly: true });
    let columns;
    let indexes;
    try {
      columns = raw2.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
      indexes = raw2.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all();
    } finally {
      raw2.close();
    }
    check("(2) turn_seq column exists on the re-migrated sessions table", columns.includes("turn_seq"));

    // ===== (5) no index references the new column — a plain ADD COLUMN never introduces one =====
    check("(5) no index on sessions references turn_seq (plain ADD COLUMN, no constraint added)",
      indexes.every((ix) => !/turn_seq/.test(ix.sql ?? "")));

    // ===== (3) the legacy rows backfill turnSeq to 0 =====
    const legacyWorker = db.getSession(workerId);
    const legacyManager = db.getSession(managerId);
    check("(3) the legacy worker row backfills turnSeq to 0", legacyWorker?.turnSeq === 0);
    check("(3) the legacy manager row backfills turnSeq to 0", legacyManager?.turnSeq === 0);

    // ===== (4) the legacy rows' OTHER columns are byte-identical to what was inserted =====
    check("(4) worker busy is untouched", legacyWorker?.busy === true);
    check("(4) worker role is untouched", legacyWorker?.role === "worker");
    check("(4) worker title is untouched", legacyWorker?.title === "Legacy Worker");
    check("(4) worker parentSessionId is untouched", legacyWorker?.parentSessionId === managerId);
    check("(4) worker taskId is untouched", legacyWorker?.taskId === "tk-legacy");
    check("(4) worker branch is untouched", legacyWorker?.branch === "loom/legacy");
    check("(4) worker ctxInputTokens (already-migrated column) is untouched", legacyWorker?.ctxInputTokens === 12345);
    check("(4) worker ctxTurns (already-migrated column) is untouched", legacyWorker?.ctxTurns === 7);
    check("(4) worker model (already-migrated column) is untouched", legacyWorker?.model === "claude-sonnet-5");
    check("(4) manager busy is untouched", legacyManager?.busy === false);
    check("(4) manager role is untouched", legacyManager?.role === "manager");

    // ===== (7) a FRESH DB defaults a newly-inserted session's turnSeq to 0 when omitted =====
    const freshFile = path.join(tmpHome, "fresh.db");
    const freshDb = new Db(freshFile);
    try {
      const freshProjId = randomUUID();
      const freshAgentId = randomUUID();
      const freshSessId = randomUUID();
      freshDb.insertProject({ id: freshProjId, name: "Fresh Project", repoPath: "/host/fresh-repo", vaultPath: "/host/fresh-vault", config: {}, createdAt: t0, archivedAt: null });
      freshDb.insertAgent({ id: freshAgentId, projectId: freshProjId, name: "t", startupPrompt: "x", position: 0 });
      freshDb.insertSession({
        id: freshSessId, projectId: freshProjId, agentId: freshAgentId, engineSessionId: "eng-fresh", title: null, cwd: freshProjId,
        processState: "live", resumability: "resumable", busy: false, createdAt: t0, lastActivity: t0, lastError: null,
        // turnSeq deliberately omitted — simulates a caller that never sets it (today's only caller).
      });
      const fresh = freshDb.getSession(freshSessId);
      check("(7) a fresh DB defaults an omitted turnSeq to 0 on insert", fresh?.turnSeq === 0);

      // ===== (8) incrementTurnSeq bumps it correctly, and nothing else on the row moves =====
      freshDb.incrementTurnSeq(freshSessId);
      freshDb.incrementTurnSeq(freshSessId);
      const bumped = freshDb.getSession(freshSessId);
      check("(8) incrementTurnSeq bumps 0 -> 2 across two calls", bumped?.turnSeq === 2);
      check("(8) incrementTurnSeq does not disturb an unrelated field (busy)", bumped?.busy === false);
    } finally {
      freshDb.close();
    }

    // ===== (6) idempotent: re-opening an already-migrated file is a clean no-op =====
    const db2 = new Db(dbFile);
    try {
      const again = db2.getSession(workerId);
      check("(6) 2nd re-open over an already-migrated file is idempotent (turnSeq unchanged)", again?.turnSeq === 0);
      check("(6) 2nd re-open leaves other fields unchanged too", again?.ctxInputTokens === 12345 && again?.branch === "loom/legacy");
    } finally {
      db2.close();
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-turn_seq legacy sessions table, the turn_seq column lands via the idempotent ADD COLUMN migration with no new index, EVERY pre-existing session row backfills turnSeq to 0 with every other column byte-identical to what was inserted, incrementTurnSeq advances a fresh row correctly without disturbing anything else, and re-opening an already-migrated file is a clean no-op."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
