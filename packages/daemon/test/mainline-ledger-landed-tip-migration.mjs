import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5958c149 — migration + Db-level round-trip for mainline_landed_commits.worker_landed_tip.
//
// (a) UPGRADED STORE: seeds a genuinely PRE-card mainline_landed_commits shape (the exact CREATE TABLE
//     text pinned at sha 702f5520 — lesson 250: never `git show HEAD:`, a fixed-point-in-time copy
//     instead) on a RAW better-sqlite3 connection, with a legacy row inserted via that OLD shape (no
//     worker_landed_tip column exists at all yet). Reopening via `new Db(path)` must: ADD the column,
//     leave the legacy row's value reading back NULL (= absent, per Db.getVerifiedLandedTip), and let a
//     NEW recordMainlineLandedCommit call (with the 6th param) write/read correctly afterward.
// (b) Idempotent: a second `new Db(path)` over an already-migrated file is a clean no-op (ALTER never
//     re-runs; PRAGMA table_info already reports the column).
// (c) SCOPE matching: getVerifiedLandedTip matches on `(project_id, repo_key, tip)` ONLY — NEVER this
//     table's own `branch` column (card 5958c149, corrected: that column is the MAINLINE branch landed
//     onto, not the worker's own branch, which is what every real caller actually has in scope; matching
//     on it made the lookup miss on every real call — see the card's own decision record's "Correction"
//     section). Two rows for the SAME (project, repoKey) at two DIFFERENT tips must resolve
//     independently, never "latest row in scope".
// (d) Batch rows (no workerLandedTip arg) write NULL, same as a legacy row — getVerifiedLandedTip reads
//     absent for both uniformly.
// (e) A deleted/pruned scope (rebind-style DELETE, already-existing production behavior) leaves
//     getVerifiedLandedTip reading absent afterward — no stale value survives a cleared scope.
// (f) MORE THAN ONE ROW for the SAME (project_id, repo_key, tip): no DB constraint prevents this (a
//     write-path property, not a schema one — see the decision record's "Multiple rows" section for why
//     the real write path can't produce it today, and why this is defense-in-depth regardless).
//     getVerifiedLandedTip must never pick a row arbitrarily ("first/last wins") — every non-null value
//     present must AGREE to return it; any genuine disagreement fails CLOSED to null, same as absent.
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/mainline-ledger-landed-tip-migration.mjs
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-mlltm-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Pinned verbatim from `git show 702f5520:packages/daemon/src/db.ts` (the mainline_landed_commits
// CREATE TABLE text immediately before this card) — never re-derived from a live HEAD read.
const PRE_CARD_TABLE_SQL = `
CREATE TABLE mainline_landed_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_key TEXT NOT NULL,
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  base TEXT NOT NULL,
  landed_at TEXT NOT NULL
);
CREATE INDEX idx_mainline_landed_commits_tip ON mainline_landed_commits(project_id, repo_key, branch, tip);
CREATE INDEX idx_mainline_landed_commits_branch_id ON mainline_landed_commits(project_id, repo_key, branch, id);
`;

const dir = mkdtempManaged("loom-mlltm-db-");
const now = new Date().toISOString();

// ======================= (a)/(b) UPGRADED STORE + IDEMPOTENCY =======================
{
  const file = path.join(dir, "a-upgrade.db");
  // Boot once via the real Db to create every OTHER table (projects, etc.) via SCHEMA, then replace
  // mainline_landed_commits with the genuinely pre-card shape on a RAW connection.
  const boot = new Db(file);
  boot.insertProject({ id: "p-a", name: "A", repoPath: "/tmp/a", vaultPath: "/tmp/a", config: {}, createdAt: now, archivedAt: null });
  boot.close();

  const raw = new Database(file);
  raw.exec("DROP TABLE mainline_landed_commits"); // also drops its two indexes
  raw.exec(PRE_CARD_TABLE_SQL);
  const legacyInsert = raw.prepare("INSERT INTO mainline_landed_commits (project_id, repo_key, branch, tip, base, landed_at) VALUES (?, ?, ?, ?, ?, ?)");
  legacyInsert.run("p-a", "primary", "loom/legacy1", "a".repeat(40), "b".repeat(40), now);
  const legacyCols = new Set(raw.prepare("PRAGMA table_info(mainline_landed_commits)").all().map((c) => c.name));
  check("(a) setup control: the pre-card raw table genuinely has NO worker_landed_tip column", !legacyCols.has("worker_landed_tip"));
  raw.close();

  const db = new Db(file);
  const migratedCols = new Set(db.db.prepare("PRAGMA table_info(mainline_landed_commits)").all().map((c) => c.name));
  check("(a) THE FIX: reopening via Db adds worker_landed_tip", migratedCols.has("worker_landed_tip"));
  check("(a) the legacy row's own column reads back NULL (absent), never a thrown error", db.getVerifiedLandedTip("p-a", "primary", "a".repeat(40)) === null);
  check("(a) a NEW row with no 6th arg ALSO reads absent (byte-identical to before this card)", (() => {
    db.recordMainlineLandedCommit("p-a", "primary", "loom/fresh-noarg", "c".repeat(40), "d".repeat(40));
    return db.getVerifiedLandedTip("p-a", "primary", "c".repeat(40)) === null;
  })());
  check("(a) a NEW row WITH the 6th arg round-trips exactly", (() => {
    db.recordMainlineLandedCommit("p-a", "primary", "loom/fresh-withtip", "e".repeat(40), "f".repeat(40), "1".repeat(40));
    return db.getVerifiedLandedTip("p-a", "primary", "e".repeat(40)) === "1".repeat(40);
  })());
  db.close();

  // (b) idempotent re-open: ALTER never re-fires (would throw "duplicate column name" if it did), and
  // every previously-written value survives.
  const db2 = new Db(file);
  check("(b) idempotent re-open does not throw and the column is still exactly one", new Set(db2.db.prepare("PRAGMA table_info(mainline_landed_commits)").all().map((c) => c.name).filter((n) => n === "worker_landed_tip")).size === 1);
  check("(b) values written before the re-open survive it", db2.getVerifiedLandedTip("p-a", "primary", "e".repeat(40)) === "1".repeat(40));
  db2.close();
}

// ======================= (c) SCOPE MATCHING — (project_id, repo_key, tip) ONLY, never "latest in scope" =
{
  const file = path.join(dir, "c-fullkey.db");
  const db = new Db(file);
  db.insertProject({ id: "p-c", name: "C", repoPath: "/tmp/c", vaultPath: "/tmp/c", config: {}, createdAt: now, archivedAt: null });
  // Same (project, repoKey) landed TWICE at two different tips (a branch re-cut and re-landed, OR a
  // second unrelated landing) — each tip's own value must resolve independently; the `branch` column
  // (always the MAINLINE branch here, never the worker's) plays no part in this lookup at all.
  db.recordMainlineLandedCommit("p-c", "primary", "main", "1".repeat(40), "0".repeat(40), "a".repeat(40));
  db.recordMainlineLandedCommit("p-c", "primary", "main", "2".repeat(40), "0".repeat(40), "b".repeat(40));
  check("(c) the FIRST landing's tip resolves its OWN value", db.getVerifiedLandedTip("p-c", "primary", "1".repeat(40)) === "a".repeat(40));
  check("(c) the SECOND (newer) landing's tip resolves its OWN, DIFFERENT value", db.getVerifiedLandedTip("p-c", "primary", "2".repeat(40)) === "b".repeat(40));
  check("(c) a THIRD, never-landed tip in the SAME scope resolves absent — never falls back to either real row", db.getVerifiedLandedTip("p-c", "primary", "3".repeat(40)) === null);
  check("(c) a DIFFERENT repoKey for the identical tip is a separate scope — absent", db.getVerifiedLandedTip("p-c", "secondary", "1".repeat(40)) === null);
  check("(c) a DIFFERENT projectId for the identical (repoKey, tip) is a separate scope — absent", db.getVerifiedLandedTip("p-other", "primary", "1".repeat(40)) === null);
  db.close();
}

// ======================= (e) a cleared scope leaves no stale value =======================
{
  const file = path.join(dir, "e-cleared.db");
  const db = new Db(file);
  db.insertProject({ id: "p-e", name: "E", repoPath: "/tmp/e", vaultPath: "/tmp/e", config: {}, createdAt: now, archivedAt: null });
  db.recordMainlineLandedCommit("p-e", "primary", "main", "9".repeat(40), "8".repeat(40), "7".repeat(40));
  check("(e) setup control: the row resolves before any clear", db.getVerifiedLandedTip("p-e", "primary", "9".repeat(40)) === "7".repeat(40));
  db.db.prepare("DELETE FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ?").run("p-e", "primary"); // same statement shape resetMainlineBaselinesForRepoChange already uses on a rebind
  check("(e) THE FIX's own contract: after the scope is cleared, the lookup reads absent — never a stale value", db.getVerifiedLandedTip("p-e", "primary", "9".repeat(40)) === null);
  db.close();
}

// ======================= (f) >1 row for one tip — FAIL CLOSED, never "first/last row wins" =============
{
  const file = path.join(dir, "f-multirow.db");
  const db = new Db(file);
  db.insertProject({ id: "p-f", name: "F", repoPath: "/tmp/f", vaultPath: "/tmp/f", config: {}, createdAt: now, archivedAt: null });

  // (f1) two rows, EQUAL non-null values — agree, resolve to that value.
  db.recordMainlineLandedCommit("p-f", "primary", "main", "1".repeat(40), "0".repeat(40), "a".repeat(40));
  db.recordMainlineLandedCommit("p-f", "primary", "develop", "1".repeat(40), "0".repeat(40), "a".repeat(40));
  check("(f1) two rows, equal non-null values, agree and resolve to that value", db.getVerifiedLandedTip("p-f", "primary", "1".repeat(40)) === "a".repeat(40));

  // (f2) two rows, CONFLICTING non-null values — fail closed to null (never "first row wins").
  db.recordMainlineLandedCommit("p-f", "primary", "main", "2".repeat(40), "0".repeat(40), "a".repeat(40));
  db.recordMainlineLandedCommit("p-f", "primary", "develop", "2".repeat(40), "0".repeat(40), "b".repeat(40));
  check("(f2) two rows, conflicting non-null values, fail closed to null", db.getVerifiedLandedTip("p-f", "primary", "2".repeat(40)) === null);

  // (f3) one row NULL + one row with a value — the single non-null value wins (not a conflict: there is
  // only ONE distinct non-null value across the scope).
  db.recordMainlineLandedCommit("p-f", "primary", "main", "3".repeat(40), "0".repeat(40)); // no 6th arg -> NULL
  db.recordMainlineLandedCommit("p-f", "primary", "develop", "3".repeat(40), "0".repeat(40), "c".repeat(40));
  check("(f3) one NULL row + one valued row resolve to the single non-null value", db.getVerifiedLandedTip("p-f", "primary", "3".repeat(40)) === "c".repeat(40));

  // (f4) two rows, BOTH NULL — absent, same as zero rows.
  db.recordMainlineLandedCommit("p-f", "primary", "main", "4".repeat(40), "0".repeat(40));
  db.recordMainlineLandedCommit("p-f", "primary", "develop", "4".repeat(40), "0".repeat(40));
  check("(f4) two rows, both NULL, resolve absent", db.getVerifiedLandedTip("p-f", "primary", "4".repeat(40)) === null);

  db.close();
}

console.log(failures === 0 ? `ALL PASS (mainline-ledger-landed-tip-migration)` : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
