import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH WORKTREE REMOVAL — LIVE RE-CHECK, NOT A STALE SNAPSHOT (card bde5d1fe item 3, follow-up to
// 24c0bdba). `mergeBatchTracked`'s own worktree-removal `finally` (sessions/service.ts) used to gate
// `removeWorktree` on `batchQuarantined` alone — a boolean SNAPSHOT captured from `runBatchedMerge`'s own
// return, BEFORE the per-branch finalize loop that follows it. That loop can run for a while (each landed
// branch's own `finishAlreadyMerged`), during which an ENTIRELY SEPARATE op (a concurrent solo merge) can
// quarantine the canonical repo — the stale snapshot would still read `false`, and the batch worktree
// (a linked worktree of the SAME repo, sharing the SAME hooks dir and object database) would be
// force-removed anyway, exactly the race the quarantine mechanism exists to prevent everywhere else on
// this path. `removeWorktree` has exactly ONE other caller, `gcWorktreeDir` (sessions/service.ts), which
// ALREADY re-checks fresh at its own call (`assertRepoNotQuarantined`, round 4) — this was the one
// remaining removeWorktree call site with no live check at all.
//
// The fix extracts the guard into a standalone, exported, directly-testable predicate,
// `safeToRemoveBatchWorktree(repoPath, batchQuarantinedSnapshot)` — the snapshot OR'd with a FRESH
// `assertRepoNotQuarantined` read — and the call site now gates on it instead of the bare snapshot.
//
// RED PROOF (mechanical, once, not re-run): with the fix reverted to `!batchQuarantinedSnapshot` alone
// (the old shape), this file's own SCENARIO 2 ("snapshot says safe, but the repo is now quarantined")
// flips from PASS to FAIL — see the worker's own report for the exact revert/run/restore commands.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-worktree-removal-live-recheck.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { safeToRemoveBatchWorktree } = await import("../dist/sessions/service.js");
const { enterMergeQuarantine, clearMergeQuarantine } = await import("../dist/git/merge-quarantine.js");

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repo = path.join(os.tmpdir(), `loom-bwrlr-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });

try {
  // SCENARIO 1 — ordinary case: no quarantine anywhere, snapshot correctly says safe.
  check("(1) not quarantined, snapshot=false: safe to remove", safeToRemoveBatchWorktree(repo, false) === true);

  // SCENARIO 1b — the snapshot ALONE already said unsafe (runBatchedMerge itself quarantined this batch):
  // the live re-check must never override a TRUE snapshot back to safe.
  check("(1b) snapshot=true (batch's own quarantine): NEVER safe, regardless of live state", safeToRemoveBatchWorktree(repo, true) === false);

  // SCENARIO 2 — THE GAP THIS CARD CLOSES: the snapshot says safe (false), but the LIVE state has since
  // been quarantined by an entirely separate, concurrent op. The old code (`!batchQuarantined` alone)
  // would remove anyway; the fix must refuse.
  enterMergeQuarantine(repo, "unrelated-concurrent-op", "manufactured for SCENARIO 2 — the stale-snapshot gap");
  check("(2) stale snapshot=false, but LIVE state is now quarantined: refuses (the live re-check catches it)", safeToRemoveBatchWorktree(repo, false) === false);

  // NEGATIVE CONTROL: once cleared, the identical call (same stale snapshot=false) is safe again — proves
  // SCENARIO 2's refusal was the live quarantine specifically, not some unrelated defect.
  clearMergeQuarantine(repo);
  check("(2) control: once cleared, the SAME stale-false-snapshot call is safe again", safeToRemoveBatchWorktree(repo, false) === true);
} finally {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
