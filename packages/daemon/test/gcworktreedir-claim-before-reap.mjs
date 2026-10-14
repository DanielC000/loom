import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card beeae646 (Code Review f9833ee7 of 73cc6d06) — round 5 of card a5d9c458 (see that card's own
// decision record for the full narrative + the stated residual this fix does NOT close).
//
// `gcWorktreeDir`'s finalizeMerge call shape (no `opts.staleKnowledge`) had NO claim check anywhere
// before `reap(worktreePath)` ran: a reclaiming spawn's claim landing during the nested-repo scan's own
// await was only ever discovered by the POST-reap `claimedWorktreePaths` check — by which point reap had
// already enumerated and killed whatever OS processes it found rooted in the worktree, potentially
// including the reclaiming spawn's own in-flight provisioning. The fix adds one more, UNCONDITIONAL
// `claimedWorktreePaths` check immediately before reap (never gated on `opts.staleKnowledge` or
// `opts.forceRemoveWorktree`).
//
// (A) a claim seeded DURING the nested-repo scan's own await (via the real `findNestedGitRepos`
//     injection seam, exercised at exactly the point gcWorktreeDir awaits it) must stop reap from ever
//     running at all — outcome "claimed", the worktree dir left untouched on disk.
// (B) a `forceRemoveWorktree:true` caller skips the nested-repo scan entirely (no await there to seed a
//     claim during) but still reaches reap unconditionally — a claim already present BEFORE
//     gcWorktreeDir is even called must still stop reap from running, proving the new check is not
//     accidentally scoped only to the scan-gated branch.
// (C) negative control: the SAME finalizeMerge call shape as (A), but with NO claim seeded anywhere —
//     reap must still run, and the removal must still succeed normally. Proves (A)'s "reap NOT called"
//     assertion actually discriminates claim-present from claim-absent, rather than passing vacuously
//     (e.g. because the injected reap seam itself is silently never reached for any run).
// (D) CR follow-up (f9833ee7 on commit eb65fd44) — the `staleKnowledge:true` callers (the wedge sweep,
//     both boot-reconcile Pass B sites) have the SAME scan→reap window: their own early
//     `staleKnowledgeGuard()` runs BEFORE the scan, so it can't see a claim that lands during it. Same
//     shape as (A) but with `opts.staleKnowledge: true` — must ALSO stop reap, proving the new
//     unconditional check isn't accidentally scoped to finalizeMerge's own (non-staleKnowledge) shape.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gcworktreedir-claim-before-reap.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-gcwr-home-");
requireHermeticEnv();

const { resolveWorktreePath, normForCompare } = await import("../dist/git/worktrees.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=gcwr@loom -c user.name=gcwr";

const repo = path.join(os.tmpdir(), `loom-gcwr-repo-${Date.now()}-${process.pid}`);
const PROJ = "projGcwr";

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gcwr test\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  // ============================================================================================
  // (A) claim lands DURING the nested-repo scan's own await — reap must never run.
  // ============================================================================================
  const taskA = "gcwr-mid-scan-aaaa-0001";
  const pathA = resolveWorktreePath(PROJ, taskA);
  fs.mkdirSync(pathA, { recursive: true });

  let reapCalledA = false;
  const dbA = new Db();
  const sessionsA = new SessionService(dbA, {}, new OrchestrationControl(), {
    findNestedGitRepos: async (wt) => {
      // Simulate a reclaiming spawn's reclaimWedgedWorktreePathForSpawn claiming this exact path while
      // the nested-repo scan is still in flight — the real race window card beeae646 names.
      sessionsA.claimedWorktreePaths.add(normForCompare(wt));
      return { repos: [], truncated: false };
    },
    reapWorktreeProcesses: async () => { reapCalledA = true; return { killedPids: [] }; },
  });

  // finalizeMerge's own call shape: no staleKnowledge, no forceRemoveWorktree (scan runs), retainIfUncommitted:true.
  const resultA = await sessionsA.gcWorktreeDir(repo, pathA, undefined, { retainIfUncommitted: true });
  check("(A) reap was NOT called — the pre-reap claim check caught it first", reapCalledA === false);
  check("(A) outcome is 'claimed'", resultA.outcome === "claimed");
  check("(A) the worktree dir is still on disk, untouched", fs.existsSync(pathA));
  dbA.close();
  fs.rmSync(pathA, { recursive: true, force: true });

  // ============================================================================================
  // (B) forceRemoveWorktree:true — the nested-repo scan is skipped entirely, so there is no scan
  //     await to seed a claim during. The claim is instead already present BEFORE gcWorktreeDir is
  //     even called (white-box seed, same pattern createworktree-wedge-reclaim.mjs's (J) uses for
  //     removingWorktreePaths). Proves the new check is not scoped only to the scan-gated branch.
  // ============================================================================================
  const taskB = "gcwr-force-remove-bbbb-0002";
  const pathB = resolveWorktreePath(PROJ, taskB);
  fs.mkdirSync(pathB, { recursive: true });

  let findNestedCalledB = false;
  let reapCalledB = false;
  const dbB = new Db();
  const sessionsB = new SessionService(dbB, {}, new OrchestrationControl(), {
    findNestedGitRepos: async () => { findNestedCalledB = true; return { repos: [], truncated: false }; },
    reapWorktreeProcesses: async () => { reapCalledB = true; return { killedPids: [] }; },
  });
  sessionsB.claimedWorktreePaths.add(normForCompare(pathB));

  const resultB = await sessionsB.gcWorktreeDir(repo, pathB, undefined, { forceRemoveWorktree: true });
  check("(B setup) the nested-repo scan was genuinely skipped (forceRemoveWorktree)", findNestedCalledB === false);
  check("(B) reap was NOT called even though the scan itself never ran", reapCalledB === false);
  check("(B) outcome is 'claimed'", resultB.outcome === "claimed");
  check("(B) the worktree dir is still on disk, untouched", fs.existsSync(pathB));
  sessionsB.claimedWorktreePaths.delete(normForCompare(pathB));
  dbB.close();
  fs.rmSync(pathB, { recursive: true, force: true });

  // ============================================================================================
  // (C) NEGATIVE CONTROL — same shape as (A), but no claim seeded anywhere: reap must run, and the
  //     removal must succeed normally. Without this, (A)'s "reap NOT called" proves nothing — it could
  //     just as easily mean the injected reap seam is never reached for any run at all.
  // ============================================================================================
  const taskC = "gcwr-control-cccc-0003";
  const pathC = resolveWorktreePath(PROJ, taskC);
  fs.mkdirSync(pathC, { recursive: true });

  let reapCalledC = false;
  const dbC = new Db();
  const sessionsC = new SessionService(dbC, {}, new OrchestrationControl(), {
    findNestedGitRepos: async () => ({ repos: [], truncated: false }), // no claim seeded this time
    reapWorktreeProcesses: async () => { reapCalledC = true; return { killedPids: [] }; },
  });
  const resultC = await sessionsC.gcWorktreeDir(repo, pathC, undefined, { retainIfUncommitted: true });
  check("(C control) reap WAS called — proves (A)'s assertion discriminates claim-present from claim-absent", reapCalledC === true);
  check("(C control) with no race, the removal actually succeeds", resultC.outcome === "removed");
  check("(C control) the worktree dir is actually gone", !fs.existsSync(pathC));
  dbC.close();

  // ============================================================================================
  // (D) CR follow-up — the SAME mid-scan claim race as (A), but for a `staleKnowledge:true` caller
  //     (the wedge sweep / boot Pass B shape). Their own early staleKnowledgeGuard() runs BEFORE the
  //     scan and so can't see a claim that lands during it; the new unconditional check must still
  //     stop reap here too.
  // ============================================================================================
  const taskD = "gcwr-stale-knowledge-dddd-0004";
  const pathD = resolveWorktreePath(PROJ, taskD);
  fs.mkdirSync(pathD, { recursive: true });

  let reapCalledD = false;
  const dbD = new Db();
  const sessionsD = new SessionService(dbD, {}, new OrchestrationControl(), {
    findNestedGitRepos: async (wt) => {
      sessionsD.claimedWorktreePaths.add(normForCompare(wt));
      return { repos: [], truncated: false };
    },
    reapWorktreeProcesses: async () => { reapCalledD = true; return { killedPids: [] }; },
  });
  const resultD = await sessionsD.gcWorktreeDir(repo, pathD, undefined, { staleKnowledge: true });
  check("(D) reap was NOT called for a staleKnowledge:true caller either", reapCalledD === false);
  check("(D) outcome is 'claimed'", resultD.outcome === "claimed");
  check("(D) the worktree dir is still on disk, untouched", fs.existsSync(pathD));
  dbD.close();
  fs.rmSync(pathD, { recursive: true, force: true });
} finally {
  try { execSync("git worktree prune", { cwd: repo }); } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gcWorktreeDir's pre-reap claimedWorktreePaths check stops reap from ever running against a worktree a reclaiming spawn already claimed, whether the claim landed during the nested-repo scan's own await (A) or was already present before a forceRemoveWorktree:true call that skips the scan entirely (B); the removal itself is correctly refused (outcome 'claimed', dir untouched) in both cases; the no-claim control (C) proves these assertions actually discriminate claim-present from claim-absent — reap still runs and the removal still succeeds when nothing claimed the path; and a staleKnowledge:true caller (D) gets the same mid-scan protection, not just finalizeMerge's own shape."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
