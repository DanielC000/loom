import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e8d4fdc3 round 2 — migration + Db-level proof for mainline_landed_commits.worker_branch (R3 +
// the round-2 "Migration" DoD item). The round-2 Code Review found the ledger fallback matched on worker
// TIP ALONE — a review fork cut from a landed branch's own headSha shares that SAME tip without being
// that branch, and resolved as "already landed". The fix keys Db.getLandedCommitByWorkerTip (and its
// batch-side twin) on (branch, tip) together via a new worker_branch column.
//
// Builds the legacy fixture from the REAL pre-round-2 mainline_landed_commits CREATE TABLE text — pinned
// verbatim from `git show d971cc17:packages/daemon/src/db.ts` (round 1's own commit; lesson 250: never
// `git show HEAD:`, a fixed-point-in-time copy instead) — which already has worker_landed_tip (card
// 5958c149) but NOT worker_branch. Opening THIS with the real Db class exercises `migrateMainlineLandedCommits`
// ADDing the new column onto an already-upgraded-once (worker_landed_tip-bearing) table.
//
// Proves:
//   (1) the constructor does NOT throw opening a DB that predates worker_branch.
//   (2) worker_branch exists again post-reopen (PRAGMA table_info), and a pre-existing (legacy) row's own
//       column reads back NULL.
//   (3) R3 — THE CRITICAL FIX's own fail-closed guarantee: a legacy row with worker_branch NULL can NEVER
//       satisfy getLandedCommitByWorkerTip's equality match against a real branch name, even when that
//       exact (project, repoKey, tip) pair IS present in the table — "no fallback" for a legacy row.
//   (4) isMainlineLedgerReachable's trust walk is UNCHANGED by this migration: reads only
//       (project_id, repo_key, branch, tip) -> base, never worker_landed_tip/worker_branch, so its verdict
//       on a short ancestry chain built in the LEGACY (pre-migration) shape is IDENTICAL before and after
//       the column is added.
//   (5) migration is idempotent on a THIRD open (PRAGMA table_info again — exactly one occurrence).
//   (6) a FRESH row written WITH a workerBranch round-trips through getLandedCommitByWorkerTip, and a
//       DIFFERENT branch sharing the SAME tip does not match it (the branch-keying fix, at the DB layer).
//   (7) statement-scoped (never line-scoped): no CREATE INDEX/TRIGGER/VIEW statement anywhere in db.ts's
//       own SCHEMA text references worker_branch (mirrors card 5958c149's own "no index here" rule).
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/mainline-worker-branch-migration.mjs
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { useOwnLoomHome, mkdtempManaged, cleanupPathSync } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-mwbm-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Pinned verbatim from `git show d971cc17:packages/daemon/src/db.ts` — the mainline_landed_commits
// CREATE TABLE text immediately before this round (has worker_landed_tip, NOT worker_branch).
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

const dir = mkdtempManaged("loom-mwbm-db-");
const now = new Date().toISOString();

// ======================= (1)/(2)/(4)/(5) UPGRADED STORE + TRUST-WALK PARITY + IDEMPOTENCY =============
{
  const file = path.join(dir, "upgrade.db");
  const boot = new Db(file);
  boot.insertProject({ id: "p-u", name: "U", repoPath: "/tmp/u", vaultPath: "/tmp/u", config: {}, createdAt: now, archivedAt: null });
  boot.close();

  const raw = new Database(file);
  raw.exec("DROP TABLE mainline_landed_commits"); // also drops its two indexes
  raw.exec(PRE_ROUND2_TABLE_SQL);
  const legacyCols = new Set(raw.prepare("PRAGMA table_info(mainline_landed_commits)").all().map((c) => c.name));
  check("(setup) the pre-round-2 raw table genuinely has NO worker_branch column", !legacyCols.has("worker_branch"));
  check("(setup) the pre-round-2 raw table DOES have worker_landed_tip (card 5958c149, a prior migration)", legacyCols.has("worker_landed_tip"));

  // A short, genuine ancestry chain in the LEGACY shape — trustSha <- T1 <- T2 — for the trust-walk
  // parity check below. legacyBranch is the MAINLINE branch column (unrelated to worker_branch).
  const trustSha = "0".repeat(40);
  const t1 = "1".repeat(40);
  const t2 = "2".repeat(40);
  const legacyInsert = raw.prepare("INSERT INTO mainline_landed_commits (project_id, repo_key, branch, tip, base, landed_at) VALUES (?, ?, ?, ?, ?, ?)");
  legacyInsert.run("p-u", "primary", "main", t1, trustSha, now);
  legacyInsert.run("p-u", "primary", "main", t2, t1, now);
  // A legacy row that DOES carry a worker_landed_tip (so it's a real match candidate for a tip-only
  // lookup), proving R3 below is a BRANCH-ONLY guard, not merely "no row at all".
  const legacyWorkerTip = "a".repeat(40);
  raw.prepare("INSERT INTO mainline_landed_commits (project_id, repo_key, branch, tip, base, landed_at, worker_landed_tip) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("p-u", "primary", "main", t2, t1, now, legacyWorkerTip);
  raw.close();

  const db = new Db(file);
  const migratedCols = new Set(db.db.prepare("PRAGMA table_info(mainline_landed_commits)").all().map((c) => c.name));
  check("(1) opening a pre-migration DB does NOT throw and worker_branch now exists", migratedCols.has("worker_branch"));
  const legacyRow = db.db.prepare("SELECT worker_branch FROM mainline_landed_commits WHERE project_id = ? AND tip = ? AND worker_landed_tip = ?").get("p-u", t2, legacyWorkerTip);
  check("(2) the legacy row's own worker_branch column reads back NULL", legacyRow?.worker_branch === null);

  // (4) trust-walk parity: isMainlineLedgerReachable reads only (project_id, repo_key, branch, tip) -> base
  // — never worker_landed_tip/worker_branch — so a short chain built entirely in the LEGACY shape walks
  // identically after the migration as it would have before it ever ran.
  check("(4) THE TRUST-WALK PARITY GUARANTEE: isMainlineLedgerReachable(T2 -> trustSha) is unaffected by this migration",
    db.isMainlineLedgerReachable("p-u", "primary", "main", t2, trustSha) === true);
  check("(4) a genuinely unreachable sha still fails closed, unaffected by this migration",
    db.isMainlineLedgerReachable("p-u", "primary", "main", t2, "f".repeat(40)) === false);

  // ===== (3) R3 — THE CRITICAL FIX's own fail-closed guarantee: the legacy row's NULL worker_branch can
  // NEVER satisfy an equality match against a REAL branch name, even though (project, repoKey, tip) all
  // match exactly and the row DOES carry a non-null worker_landed_tip. =====
  check("(3) R3 THE FIX: a legacy (NULL worker_branch) row never resolves via getLandedCommitByWorkerTip for ANY real branch name",
    db.getLandedCommitByWorkerTip("p-u", "primary", "main", legacyWorkerTip) === null);
  check("(3) R3 control: the SAME lookup with the row's own MAINLINE branch name (a plausible but wrong guess) also misses",
    db.getLandedCommitByWorkerTip("p-u", "primary", "some-other-branch-name", legacyWorkerTip) === null);

  db.close();

  // ===== (5) idempotent re-open: ALTER never re-fires (would throw "duplicate column name" if it did) =====
  let threw = null;
  let db2;
  try { db2 = new Db(file); } catch (e) { threw = e; }
  check("(5) a further re-open is idempotent — does not throw", threw === null);
  const occurrences = db2.db.prepare("PRAGMA table_info(mainline_landed_commits)").all().filter((c) => c.name === "worker_branch").length;
  check("(5) worker_branch is still there, EXACTLY once (not duplicated by a repeated migration)", occurrences === 1);
  db2.close();
}

// ======================= (6) a FRESH row with a real workerBranch round-trips, branch-keyed ============
{
  const file = path.join(dir, "fresh.db");
  const db = new Db(file);
  db.insertProject({ id: "p-f", name: "F", repoPath: "/tmp/f", vaultPath: "/tmp/f", config: {}, createdAt: now, archivedAt: null });
  const tip = "7".repeat(40);
  db.recordMainlineLandedCommit("p-f", "primary", "main", "6".repeat(40), "5".repeat(40), tip, "loom/real-worker");
  check("(6) a fresh row with the right branch resolves via getLandedCommitByWorkerTip",
    db.getLandedCommitByWorkerTip("p-f", "primary", "loom/real-worker", tip) === "6".repeat(40));
  check("(6) THE BRANCH-KEYING FIX: a DIFFERENT branch sharing the SAME tip does NOT resolve (the review-fork shape)",
    db.getLandedCommitByWorkerTip("p-f", "primary", "loom/review-fork-sharing-this-tip", tip) === null);
  // getWorkerTipLedgerFacts.hasAnyForBranch — the cheap pre-check tryWorkerTipLedgerFallback consults
  // before spending a git call — must agree: true for the real branch, false for the unrelated one.
  const facts = db.getWorkerTipLedgerFacts("p-f", "primary");
  check("(6) hasAnyForBranch is true for the branch that actually has a row", facts.hasAnyForBranch("loom/real-worker") === true);
  check("(6) hasAnyForBranch is false for an unrelated branch with no row at all", facts.hasAnyForBranch("loom/review-fork-sharing-this-tip") === false);
  check("(6) lookupByWorkerTip agrees with getLandedCommitByWorkerTip", facts.lookupByWorkerTip("loom/real-worker", tip) === "6".repeat(40));
  check("(6) lookupByWorkerTip also refuses the unrelated branch sharing the tip", facts.lookupByWorkerTip("loom/review-fork-sharing-this-tip", tip) === null);
  db.close();
}

// ======================= (7) statement-scoped static guard — no CREATE INDEX/TRIGGER/VIEW ON
// mainline_landed_commits SPECIFICALLY references worker_branch (mirrors card 5958c149's own "no index
// here" rule). batch_landed_worker_tips' OWN index legitimately references worker_branch — that table's
// column is NOT migration-added (it's in the CREATE TABLE directly, a brand-new table), so indexing it in
// SCHEMA carries none of mainline_landed_commits' upgrade-ordering hazard; the check below is scoped to
// mainline_landed_commits alone so that legitimate index is never a false positive here. =====
{
  const dbTsPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src", "db.ts");
  const dbTsSource = fs.readFileSync(dbTsPath, "utf8");
  const startMarker = "const SCHEMA = `";
  const startIdx = dbTsSource.indexOf(startMarker);
  check("(7) sanity: the SCHEMA template literal's own start marker was found", startIdx !== -1);
  const schemaStart = startIdx + startMarker.length;
  const schemaEnd = dbTsSource.indexOf("`;", schemaStart);
  check("(7) sanity: the SCHEMA template literal's own closing marker was found", schemaEnd !== -1);
  const schemaText = dbTsSource.slice(schemaStart, schemaEnd);

  const statements = schemaText.split(";");
  const ddlKindRe = /CREATE\s+(UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\b/i;
  const ddlStatements = statements.filter((s) => ddlKindRe.test(s));
  check("(7) negative control: the statement scan itself finds real CREATE INDEX/TRIGGER/VIEW statements", ddlStatements.length > 0);
  const mainlineDdl = ddlStatements.filter((s) => s.includes("mainline_landed_commits"));
  check("(7) negative control: the scan finds mainline_landed_commits' own real indexes", mainlineDdl.length > 0);
  const offenders = mainlineDdl.filter((s) => s.includes("worker_branch"));
  check("(7) NO CREATE INDEX/TRIGGER/VIEW on mainline_landed_commits references worker_branch", offenders.length === 0);
  // Positive control (not a false reassurance): batch_landed_worker_tips' OWN index DOES reference
  // worker_branch, proving the scoping above is real discrimination, not an accidentally-empty scan.
  const batchDdl = ddlStatements.filter((s) => s.includes("batch_landed_worker_tips") && s.includes("worker_branch"));
  check("(7) control: batch_landed_worker_tips' own index DOES reference worker_branch (that table is new, not migration-added)", batchDdl.length > 0);
}

cleanupPathSync(dir);

console.log(failures === 0
  ? "\n✅ ALL PASS — mainline_landed_commits.worker_branch migrates additively onto a genuinely pre-round-2 " +
    "(worker_landed_tip-bearing) table, a legacy NULL-branch row never resolves via getLandedCommitByWorkerTip " +
    "for any real branch name (R3), the mainline trust walk is unaffected, re-open is idempotent, a fresh " +
    "row round-trips branch-keyed, and no base-schema index/trigger/view statement references the column."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
