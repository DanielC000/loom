import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card aa7677fa round 3 (decision record 2a6a292a round 21) — Code Review 34562ac8, finding (2) MAJOR,
// reproduced: `mainline_landed_commits.project_id` is a `REFERENCES projects(id)` FK, enforced
// (better-sqlite3 defaults `PRAGMA foreign_keys = ON` — see `question-orphan-no-successor.mjs`'s own
// check for the standing proof of that premise), but `Db.deleteProject` never deleted its rows before
// this card — so `DELETE /api/projects/:id` threw "FOREIGN KEY constraint failed" for ANY project that
// had ever landed a single commit, i.e. essentially every real project. While fixing this, also close a
// pre-existing (round-6) gap: `deleteProject` never deleted the project's own `mainline-branch-trust:`
// app_meta keys either (no FK to violate there, since app_meta has no foreign key at all — so this one
// never threw, it just leaked rows for a deleted project forever).
//
//   (A) a project with a real ledger row AND a real trust record deletes cleanly (RED on pre-fix code:
//       threw FOREIGN KEY constraint failed on the ledger row alone).
//   (B) after deletion, the ledger rows are GONE (not just orphaned) and the trust app_meta key is GONE
//       too — never merely left behind once the project itself no longer exists.
//   (C) a SIBLING project's own ledger rows and trust key, sharing the exact same (repoKey, branch) name,
//       survive deleting the FIRST project untouched — the cleanup is scoped by project_id, never a bare
//       (repoKey, branch) match that could cross-delete an unrelated project's history.
//   (D) a project with NO ledger/trust rows at all (never landed) still deletes cleanly — the new cleanup
//       statements are unconditional DELETEs, never an existence check that could itself throw.
//
// Run: 1) build (turbo builds shared first), 2) node test/mainline-ledger-delete-project.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mainline-ledger-delproj-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const MW = await import("../dist/git/mainline-watch.js");

const db = new Db(path.join(tmpHome, "mainline-ledger-delproj.db"));
const now = new Date().toISOString();

function mkProject(id) {
  db.insertProject({ id, name: id, repoPath: `/tmp/${id}`, vaultPath: `/tmp/${id}`, config: {}, createdAt: now, archivedAt: null });
}

// ===================== (A)+(B): a landed project with a real ledger row + trust record deletes cleanly,
//                        and both are genuinely GONE afterward, not merely orphaned =======================
{
  const projId = "mwlf-a";
  mkProject(projId);
  db.recordMainlineLandedCommit(projId, "primary", "main", "f".repeat(40), "0".repeat(40));
  db.setMainlineBranchTrust(projId, "primary", "main", "f".repeat(40));
  check("(A) setup: the ledger row exists before deletion", db.db.prepare("SELECT COUNT(*) AS c FROM mainline_landed_commits WHERE project_id = ?").get(projId).c === 1);
  check("(A) setup: the trust key exists before deletion", db.getMainlineBranchTrust(projId, "primary", "main") === "f".repeat(40));

  let threw = null;
  try { db.deleteProject(projId); } catch (e) { threw = e; }
  check("(A) THE FIX: deleteProject on a landed project no longer throws FOREIGN KEY constraint failed", threw === null);
  if (threw) console.log(`  (A) threw: ${threw.message}`);

  check("(B) THE FIX: the ledger row is genuinely GONE, not merely orphaned", db.db.prepare("SELECT COUNT(*) AS c FROM mainline_landed_commits WHERE project_id = ?").get(projId).c === 0);
  check("(B) THE FIX: the trust app_meta key is ALSO gone", db.getMeta(MW.mainlineBranchTrustKey(projId, "primary", "main")) === undefined);
}

// ===================== (C): a sibling project sharing the exact same (repoKey, branch) survives =========
{
  const keep = "mwlf-c-keep", gone = "mwlf-c-gone";
  mkProject(keep);
  mkProject(gone);
  db.recordMainlineLandedCommit(keep, "primary", "main", "a".repeat(40), "b".repeat(40));
  db.setMainlineBranchTrust(keep, "primary", "main", "a".repeat(40));
  db.recordMainlineLandedCommit(gone, "primary", "main", "c".repeat(40), "d".repeat(40));
  db.setMainlineBranchTrust(gone, "primary", "main", "c".repeat(40));

  db.deleteProject(gone);

  check("(C) the SIBLING project's own ledger row survives untouched", db.db.prepare("SELECT tip FROM mainline_landed_commits WHERE project_id = ?").get(keep)?.tip === "a".repeat(40));
  check("(C) the SIBLING project's own trust record survives untouched", db.getMainlineBranchTrust(keep, "primary", "main") === "a".repeat(40));
  check("(C) the deleted project's own ledger row is gone", db.db.prepare("SELECT COUNT(*) AS c FROM mainline_landed_commits WHERE project_id = ?").get(gone).c === 0);
  check("(C) the deleted project's own trust record is gone", db.getMainlineBranchTrust(gone, "primary", "main") === null);
}

// ===================== (D): a never-landed project (no ledger/trust rows at all) still deletes cleanly ===
{
  const projId = "mwlf-d";
  mkProject(projId);
  let threw = null;
  try { db.deleteProject(projId); } catch (e) { threw = e; }
  check("(D) a never-landed project deletes cleanly (the new DELETEs are unconditional, never an existence check that could itself throw)", threw === null);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
