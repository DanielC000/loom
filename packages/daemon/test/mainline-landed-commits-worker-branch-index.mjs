import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card eaa057d5 — mainline_landed_commits.worker_branch gets an index (idx_mainline_landed_commits_worker_branch),
// created inside migrateMainlineLandedCommits() right after the ADD COLUMN, never in the static SCHEMA
// (same 5958c149 ordering rule: a SCHEMA index on a migration-added column throws on every existing
// install's boot). Without it, Db.getLandedCommitByWorkerTip and the hasAnyForBranch closure in
// Db.getWorkerTipLedgerFacts (both filtering on worker_branch) fall back to the table's own
// (project_id, repo_key)-prefixed idx_mainline_landed_commits_branch_id as a scope scan — or, WITH
// ANALYZE run (the e8d4fdc3 Code Review's own in-memory repro: 5000 rows, ANALYZE), a full
// "SCAN mainline_landed_commits" — never a table scan by default; ANALYZE is what turns a scope scan into
// a full scan here, and this repo's own production DB never runs one (see the NO-ANALYZE arm below).
//
// Proves, via the REAL prepared-statement SOURCE text (db.hasAnyForBranchStmt.source /
// db.getLandedCommitByWorkerTipStmt.source — never a hand-copied duplicate of the SQL, which would drift
// silently from the real query the moment either changes) run through EXPLAIN QUERY PLAN:
//   (1) a FRESH DB's planner uses the new index for both call sites, after a realistic-sized population
//       + ANALYZE (mirroring the reviewer's own repro conditions) — asserting not just the index NAME but
//       that `worker_branch=?` seeks IMMEDIATELY ahead of `worker_landed_tip` in the plan's own constraint
//       text (order-sensitive: see (1b) below for why a bare "contains worker_branch=?" check is not
//       enough to catch the column-order regression this index exists to prevent).
//     (1a) NEGATIVE CONTROL, in-process: with the index runtime-DROPped (no source edit), the SAME
//          EXPLAIN QUERY PLAN call on the SAME populated table reverts to a scope scan — proving the
//          index-usage assertion above can actually go RED, not just happen to read GREEN.
//     (1b) MUTANT CONTROL, in-process: a reviewer-proposed column-swap — the SAME index name recreated as
//          (project_id, repo_key, worker_landed_tip, worker_branch) instead of (…, worker_branch,
//          worker_landed_tip) — still passes a bare "index NAME present, no SCAN" check, and (because
//          getLandedCommitByWorkerTip's query is ALL-equality) still even contains the bare substring
//          "worker_branch=?" in its plan, just reordered — so only the ORDER-sensitive check in (1) can
//          tell the two apart. Proves THAT check goes RED under the swap for both call sites (hasAnyForBranch
//          loses the worker_branch seek entirely — a real cost regression; getLandedCommitByWorkerTip keeps
//          it, only reordered — the order-sensitive assertion is what still catches that reordering), then
//          restores the real index.
//   (2) the LEGACY (pre-worker_branch) shape mainline-worker-branch-migration.mjs already pins — reusing
//       that SAME pinned pre-round-2 CREATE TABLE text verbatim — migrates to the SAME indexed, order-
//       correct plan.
//   (3) NO-ANALYZE: production's own `mainline_landed_commits` DB never runs ANALYZE (see 1624-1638's own
//       comment in db.ts) — a FRESH, unpopulated-of-stats DB still picks the new index, with the SAME
//       worker_branch-before-worker_landed_tip seek order, for both call sites with no ANALYZE at all.
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/mainline-landed-commits-worker-branch-index.mjs
import path from "node:path";
import Database from "better-sqlite3";
import { useOwnLoomHome, mkdtempManaged, cleanupPathSync } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-mlci-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const INDEX_NAME = "idx_mainline_landed_commits_worker_branch";

// Runs `stmt`'s OWN source text (never a hand-copied duplicate) through EXPLAIN QUERY PLAN and joins
// every row's `detail` — the whole plan, not just its first step, since a short-circuiting LIMIT 1 or a
// covering-index decision can split the plan across more than one row.
function planDetail(db, stmt, params) {
  const rows = db.db.prepare(`EXPLAIN QUERY PLAN ${stmt.source}`).all(...params);
  return rows.map((r) => r.detail).join(" | ");
}

// Deterministic 40-char "sha-shaped" value, distinct per (i, tag) pair — never hand-counted, so the
// value a seeded row carries and the value an assertion later looks up for the SAME i can never drift
// out of sync with each other (exactly the bug class a manually-padded literal risks).
function hexTag(i, tag) {
  const hex = i.toString(16).padStart(8, "0");
  return (hex + tag).padEnd(40, "0").slice(0, 40);
}

function seedRows(db, projectId, count) {
  for (let i = 0; i < count; i++) {
    db.recordMainlineLandedCommit(
      projectId, "primary", "main",
      hexTag(i, "tip"), hexTag(i, "base"), hexTag(i, "wtip"),
      `loom/worker-${i}`,
    );
  }
}

const dir = mkdtempManaged("loom-mlci-db-");
const now = new Date().toISOString();
const PROBE_I = 7; // an arbitrary mid-population row, exercised by every scenario below

// ============================= (1) FRESH DB — both call sites use the index =============================
{
  const file = path.join(dir, "fresh.db");
  const db = new Db(file);
  db.insertProject({ id: "p-fresh", name: "Fresh", repoPath: "/tmp/fresh", vaultPath: "/tmp/fresh", config: {}, createdAt: now, archivedAt: null });
  seedRows(db, "p-fresh", 200);
  db.db.exec("ANALYZE"); // mirrors the reviewer's own repro conditions (5000 rows, ANALYZE)

  // SEEK_ORDER: the plan's constraint text must seek on worker_branch=? immediately ahead of
  // worker_landed_tip (either "=?" exact or ">?" the IS-NOT-NULL range form) — order-sensitive, not a
  // bare substring-present check, because a column-swapped index can still contain the bare substring
  // "worker_branch=?" (see the (1b) mutant control below) without ever seeking on it in the right place.
  const SEEK_ORDER = "worker_branch=? AND worker_landed_tip";

  const hasAnyDetail = planDetail(db, db.hasAnyForBranchStmt, ["p-fresh", "primary", `loom/worker-${PROBE_I}`]);
  // "USING INDEX" or "USING COVERING INDEX" — this SELECT 1 query qualifies for a covering-index plan;
  // either wording is a real index use, so match on the index NAME rather than the "USING ..." prefix.
  check(`(1 fresh) hasAnyForBranch's own query USES ${INDEX_NAME} (plan: ${hasAnyDetail})`, hasAnyDetail.includes(INDEX_NAME));
  check("(1 fresh) hasAnyForBranch's own query does NOT fall back to a table scan", !hasAnyDetail.includes("SCAN mainline_landed_commits"));
  check(`(1 fresh) hasAnyForBranch's own query SEEKS on worker_branch=? ahead of worker_landed_tip, not just a bare index-name match (plan: ${hasAnyDetail})`, hasAnyDetail.includes(SEEK_ORDER));

  const byTipDetail = planDetail(db, db.getLandedCommitByWorkerTipStmt, ["p-fresh", "primary", `loom/worker-${PROBE_I}`, hexTag(PROBE_I, "wtip")]);
  check(`(1 fresh) getLandedCommitByWorkerTip's own query USES ${INDEX_NAME} (plan: ${byTipDetail})`, byTipDetail.includes(`USING INDEX ${INDEX_NAME}`));
  check("(1 fresh) getLandedCommitByWorkerTip's own query does NOT fall back to a table scan", !byTipDetail.includes("SCAN mainline_landed_commits"));
  check(`(1 fresh) getLandedCommitByWorkerTip's own query SEEKS on worker_branch=? ahead of worker_landed_tip, not just a bare index-name match (plan: ${byTipDetail})`, byTipDetail.includes(SEEK_ORDER));

  // behavior sanity: the seeded row genuinely round-trips via the real call (not just a plan artifact).
  check("(1 fresh) a seeded row resolves via the real getLandedCommitByWorkerTip call",
    db.getLandedCommitByWorkerTip("p-fresh", "primary", `loom/worker-${PROBE_I}`, hexTag(PROBE_I, "wtip")) === hexTag(PROBE_I, "tip"));

  // ===== (1a) negative control, in-process: drop the index on this SAME populated table and re-run the
  // SAME EXPLAIN QUERY PLAN — the assertion above must be capable of reading FALSE, not just happen to
  // read true; this proves it (no source edit needed for this particular arm). =====
  db.db.exec(`DROP INDEX ${INDEX_NAME}`);
  const hasAnyDetailNoIndex = planDetail(db, db.hasAnyForBranchStmt, ["p-fresh", "primary", `loom/worker-${PROBE_I}`]);
  check(`(1a negative control) with the index DROPped, the SAME query no longer uses it (plan: ${hasAnyDetailNoIndex})`, !hasAnyDetailNoIndex.includes(INDEX_NAME));
  check("(1a negative control) with the index DROPped, the SAME query falls back to a scan — proving the assertion above can actually fail", hasAnyDetailNoIndex.includes("SCAN mainline_landed_commits"));

  // ===== (1b) MUTANT CONTROL, in-process: recreate the SAME index name with its last two columns
  // swapped — (project_id, repo_key, worker_landed_tip, worker_branch) instead of the real (…,
  // worker_branch, worker_landed_tip). A bare "index name present, no SCAN" check (the shape (1) used to
  // have) stays GREEN under this mutant; prove the SEEK_ORDER check above is what actually catches it. =====
  db.db.exec(`CREATE INDEX ${INDEX_NAME} ON mainline_landed_commits(project_id, repo_key, worker_landed_tip, worker_branch)`);
  db.db.exec("ANALYZE"); // re-gather stats for the swapped index shape, same repro conditions as (1)

  const hasAnyMutant = planDetail(db, db.hasAnyForBranchStmt, ["p-fresh", "primary", `loom/worker-${PROBE_I}`]);
  check(`(1b mutant) column-swapped index still matches by NAME (plan: ${hasAnyMutant})`, hasAnyMutant.includes(INDEX_NAME));
  check(`(1b mutant) column-swapped index still avoids a table SCAN (plan: ${hasAnyMutant})`, !hasAnyMutant.includes("SCAN mainline_landed_commits"));
  check(`(1b mutant) hasAnyForBranch's SEEK_ORDER check correctly goes RED under the swap — the range column (worker_landed_tip) now precedes worker_branch, so the seek can no longer use worker_branch at all (plan: ${hasAnyMutant})`, !hasAnyMutant.includes(SEEK_ORDER));

  const byTipMutant = planDetail(db, db.getLandedCommitByWorkerTipStmt, ["p-fresh", "primary", `loom/worker-${PROBE_I}`, hexTag(PROBE_I, "wtip")]);
  check(`(1b mutant) column-swapped index still matches by NAME (plan: ${byTipMutant})`, byTipMutant.includes(INDEX_NAME));
  check(`(1b mutant) column-swapped index still avoids a table SCAN (plan: ${byTipMutant})`, !byTipMutant.includes("SCAN mainline_landed_commits"));
  check(`(1b mutant) getLandedCommitByWorkerTip's query is ALL-equality, so the swap still contains the BARE substring "worker_branch=?" (reordered, not lost) — this is exactly why a bare substring check is insufficient (plan: ${byTipMutant})`, byTipMutant.includes("worker_branch=?"));
  check(`(1b mutant) getLandedCommitByWorkerTip's SEEK_ORDER check correctly goes RED under the swap — worker_branch=? is still a seek column but reordered AFTER worker_landed_tip, not ahead of it (plan: ${byTipMutant})`, !byTipMutant.includes(SEEK_ORDER));

  // restore the real index so this file leaves no lingering mutated state behind (card eaa057d5's own
  // DoD review requires the mutant proof to restore afterward).
  db.db.exec(`DROP INDEX ${INDEX_NAME}`);
  db.db.exec(
    `CREATE INDEX ${INDEX_NAME} ON mainline_landed_commits(project_id, repo_key, worker_branch, worker_landed_tip)`,
  );
  db.db.exec("ANALYZE");
  const hasAnyRestored = planDetail(db, db.hasAnyForBranchStmt, ["p-fresh", "primary", `loom/worker-${PROBE_I}`]);
  check(`(1b restore) the real column order is back in place and SEEKS correctly again (plan: ${hasAnyRestored})`, hasAnyRestored.includes(SEEK_ORDER));

  db.close();
}

// ======================= (2) LEGACY (pre-worker_branch) shape — same plan after migration =======================
{
  // Pinned verbatim from `git show d971cc17:packages/daemon/src/db.ts` — the SAME pre-round-2 table text
  // mainline-worker-branch-migration.mjs already uses (lesson 250: never `git show HEAD:` as a "before"
  // snapshot; this is a fixed-point-in-time copy, not HEAD).
  const PRE_ROUND2_TABLE_SQL = `
CREATE TABLE mainline_landed_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_key TEXT NOT NULL,
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  base TEXT NOT NULL,
  landed_at TEXT NOT NULL,
  worker_landed_tip TEXT
);
CREATE INDEX idx_mainline_landed_commits_tip ON mainline_landed_commits(project_id, repo_key, branch, tip);
CREATE INDEX idx_mainline_landed_commits_branch_id ON mainline_landed_commits(project_id, repo_key, branch, id);
`;

  const file = path.join(dir, "legacy.db");
  const boot = new Db(file);
  boot.insertProject({ id: "p-legacy", name: "Legacy", repoPath: "/tmp/legacy", vaultPath: "/tmp/legacy", config: {}, createdAt: now, archivedAt: null });
  boot.close();

  const raw = new Database(file);
  raw.exec("DROP TABLE mainline_landed_commits"); // also drops its two indexes
  raw.exec(PRE_ROUND2_TABLE_SQL);
  const legacyCols = new Set(raw.prepare("PRAGMA table_info(mainline_landed_commits)").all().map((c) => c.name));
  check("(2 legacy setup) the pre-round-2 raw table genuinely has NO worker_branch column", !legacyCols.has("worker_branch"));
  raw.close();

  const db = new Db(file); // migrateMainlineLandedCommits() ADD COLUMNs worker_branch AND creates the index
  const migratedCols = new Set(db.db.prepare("PRAGMA table_info(mainline_landed_commits)").all().map((c) => c.name));
  check("(2 legacy) opening the pre-migration DB does not throw and worker_branch now exists", migratedCols.has("worker_branch"));
  const indexExists = db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX_NAME) !== undefined;
  check(`(2 legacy) ${INDEX_NAME} exists post-migration`, indexExists);

  seedRows(db, "p-legacy", 200);
  db.db.exec("ANALYZE");

  const SEEK_ORDER_LEGACY = "worker_branch=? AND worker_landed_tip";

  const hasAnyDetail = planDetail(db, db.hasAnyForBranchStmt, ["p-legacy", "primary", `loom/worker-${PROBE_I}`]);
  check(`(2 legacy) hasAnyForBranch's own query USES ${INDEX_NAME} after migration (plan: ${hasAnyDetail})`, hasAnyDetail.includes(INDEX_NAME));
  check("(2 legacy) hasAnyForBranch's own query does NOT fall back to a table scan after migration", !hasAnyDetail.includes("SCAN mainline_landed_commits"));
  check(`(2 legacy) hasAnyForBranch's own query SEEKS on worker_branch=? ahead of worker_landed_tip after migration (plan: ${hasAnyDetail})`, hasAnyDetail.includes(SEEK_ORDER_LEGACY));

  const byTipDetail = planDetail(db, db.getLandedCommitByWorkerTipStmt, ["p-legacy", "primary", `loom/worker-${PROBE_I}`, hexTag(PROBE_I, "wtip")]);
  check(`(2 legacy) getLandedCommitByWorkerTip's own query USES ${INDEX_NAME} after migration (plan: ${byTipDetail})`, byTipDetail.includes(`USING INDEX ${INDEX_NAME}`));
  check("(2 legacy) getLandedCommitByWorkerTip's own query does NOT fall back to a table scan after migration", !byTipDetail.includes("SCAN mainline_landed_commits"));
  check(`(2 legacy) getLandedCommitByWorkerTip's own query SEEKS on worker_branch=? ahead of worker_landed_tip after migration (plan: ${byTipDetail})`, byTipDetail.includes(SEEK_ORDER_LEGACY));

  // behavior parity, same as mainline-worker-branch-migration.mjs's own (6): a real row still round-trips.
  check("(2 legacy) a seeded row still resolves via the real getLandedCommitByWorkerTip call",
    db.getLandedCommitByWorkerTip("p-legacy", "primary", `loom/worker-${PROBE_I}`, hexTag(PROBE_I, "wtip")) === hexTag(PROBE_I, "tip"));

  db.close();
}

// ============================= (3) NO-ANALYZE — both call sites still use the index =============================
// Production's own DB never runs ANALYZE (db.ts's idx_mainline_landed_commits_tip/_branch_id comment, and
// the 825e4a79 no-automatic-VACUUM/no-ANALYZE posture this project holds generally) — so the REAL-world
// condition is a planner with NO gathered stats at all, not the ANALYZE-primed condition (1)/(2) above
// mirror from the reviewer's own repro. Confirms the index is picked, and picked in the right seek order,
// on a plain fresh DB with ANALYZE never run.
{
  const file = path.join(dir, "no-analyze.db");
  const db = new Db(file);
  db.insertProject({ id: "p-noanalyze", name: "NoAnalyze", repoPath: "/tmp/noanalyze", vaultPath: "/tmp/noanalyze", config: {}, createdAt: now, archivedAt: null });
  seedRows(db, "p-noanalyze", 200);
  // deliberately NO db.db.exec("ANALYZE") here.

  const SEEK_ORDER_NOANALYZE = "worker_branch=? AND worker_landed_tip";

  const hasAnyDetail = planDetail(db, db.hasAnyForBranchStmt, ["p-noanalyze", "primary", `loom/worker-${PROBE_I}`]);
  check(`(3 no-analyze) hasAnyForBranch's own query USES ${INDEX_NAME} with no ANALYZE run (plan: ${hasAnyDetail})`, hasAnyDetail.includes(INDEX_NAME));
  check("(3 no-analyze) hasAnyForBranch's own query does NOT fall back to a table scan with no ANALYZE run", !hasAnyDetail.includes("SCAN mainline_landed_commits"));
  check(`(3 no-analyze) hasAnyForBranch's own query SEEKS on worker_branch=? ahead of worker_landed_tip with no ANALYZE run (plan: ${hasAnyDetail})`, hasAnyDetail.includes(SEEK_ORDER_NOANALYZE));

  const byTipDetail = planDetail(db, db.getLandedCommitByWorkerTipStmt, ["p-noanalyze", "primary", `loom/worker-${PROBE_I}`, hexTag(PROBE_I, "wtip")]);
  check(`(3 no-analyze) getLandedCommitByWorkerTip's own query USES ${INDEX_NAME} with no ANALYZE run (plan: ${byTipDetail})`, byTipDetail.includes(`USING INDEX ${INDEX_NAME}`));
  check("(3 no-analyze) getLandedCommitByWorkerTip's own query does NOT fall back to a table scan with no ANALYZE run", !byTipDetail.includes("SCAN mainline_landed_commits"));
  check(`(3 no-analyze) getLandedCommitByWorkerTip's own query SEEKS on worker_branch=? ahead of worker_landed_tip with no ANALYZE run (plan: ${byTipDetail})`, byTipDetail.includes(SEEK_ORDER_NOANALYZE));

  check("(3 no-analyze) a seeded row resolves via the real getLandedCommitByWorkerTip call",
    db.getLandedCommitByWorkerTip("p-noanalyze", "primary", `loom/worker-${PROBE_I}`, hexTag(PROBE_I, "wtip")) === hexTag(PROBE_I, "tip"));

  db.close();
}

cleanupPathSync(dir);

console.log(failures === 0
  ? "\n✅ ALL PASS — idx_mainline_landed_commits_worker_branch is actually SEEKED on worker_branch=? ahead " +
    "of worker_landed_tip by both hasAnyForBranch's and getLandedCommitByWorkerTip's own prepared-statement " +
    "SQL, on a fresh DB (with and without ANALYZE), and on the legacy (pre-worker_branch) shape after " +
    "migration — and the order-sensitive assertion is proven capable of failing both on a runtime DROP " +
    "INDEX (reverts to a scan) and on a column-swapped mutant index (keeps the index name and avoids a " +
    "scan, but loses the correct seek order)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
