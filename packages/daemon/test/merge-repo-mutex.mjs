import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// P0 CRITICAL DATA-LOSS regression test (board card e076d2a2, incident: commit fb1dbb2, 2026-07-23).
// REAL git on temp repos, NO claude and NO live daemon — calls mergeBranch() directly, concurrently,
// against the SAME canonical repo, exactly mirroring what two overlapping worker_merge_confirm ops do
// once BOTH have passed their build gate and reach the squash-merge step (reachable in production once
// `orchestration.maxConcurrentGates` >= 2).
//
// THE BUG (verified against the real unmodified pre-fix code before this test was written — see the
// investigation's throwaway repro scripts, not checked in): mergeBranch stages + commits directly against
// the canonical repo's SHARED git index at `repoPath`, with zero mutual exclusion between concurrent
// calls. Two concurrent mergeBranch() calls for two DIFFERENT branches of the SAME repo can produce a
// commit bearing ONE branch's subject + Loom-Worker-Branch trailer while its tree contains ONLY the
// OTHER branch's content — reproduced on the FIRST unguarded attempt, no artificial delays needed. The
// trigger: mergeBranch's up-front residue-clear only fires on an affirmative `ls-files --unmerged` /
// `MERGE_HEAD` signal, neither of which a normal concurrent `--squash` sets — so when one op's OWN
// `git merge --squash` fails (e.g. `.git/index.lock` contention with the other op's concurrent squash),
// the old code had no way to distinguish "my squash never touched anything" from "my squash landed
// cleanly": it just checked whether ANYTHING was staged and, if so, blindly committed it under its own
// subject/trailer — even when that staged content belonged to the OTHER op entirely.
//
// THE FIX: a per-canonical-repo-path async mutex now serializes mergeBranch's WHOLE
// residue-clear→squash→conflict-check→commit sequence, so two concurrent calls for the same repo can
// never interleave on its shared index — and (defense in depth) mergeBranch now fails loud UNCONDITIONALLY
// on its own squash raw error, never falling through to "something's staged, ship it" regardless of
// whether the mutex is what prevented that leftover stage from existing.
//
// Proves, over MANY trials (the original incident needed real production timing to trigger — a small
// fixed trial count could pass by luck even on genuinely racy code):
//   (1) BOTH concurrent ops succeed, each producing its OWN correctly-labeled commit (no more silent
//       swallowing of one op under "ALREADY_MERGED"/rejection because of index contention).
//   (2) Content integrity, checked the STRONGEST way available: for EVERY commit in the resulting history
//       that carries a `Loom-Worker-Branch: <branch>` trailer, that branch's own changed file is ACTUALLY
//       present with the CORRECT content in that exact commit's tree — i.e. it is IMPOSSIBLE for a
//       trailer to point at content that isn't really its own. This is the DoD's "asserts BOTH-ops-report-
//       merged is impossible [with cross-corrupted content]" requirement, verified structurally rather
//       than by re-deriving one specific interleaving.
//   (3) No content is ever lost: both branches' files are present SOMEWHERE in the final tree.
// Run: 1) build daemon (pnpm build), 2) node test/merge-repo-mutex.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mrm@loom -c user.name=mrm";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const TRIALS = 15;
const tmpDirs = [];

function makeTrialRepo(sfx) {
  const repo = path.join(os.tmpdir(), `loom-mrm-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mrm@loom && git config user.name mrm && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content, sfx) {
  const wt = path.join(os.tmpdir(), `loom-mrm-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

try {
  for (let t = 0; t < TRIALS; t++) {
    const sfx = `${Date.now()}-${t}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeTrialRepo(sfx);
    makeWorktree(repo, "loom/branch-a", "file-a.txt", `a-content-${sfx}\n`, sfx);
    makeWorktree(repo, "loom/branch-b", "file-b.txt", `b-content-${sfx}\n`, sfx);

    const [resA, resB] = await Promise.all([
      mergeBranch(repo, "loom/branch-a", "Card A title"),
      mergeBranch(repo, "loom/branch-b", "Card B title"),
    ]);

    check(`[trial ${t}] op A succeeded (mutex: no more losing to index contention)`, resA.ok === true);
    check(`[trial ${t}] op B succeeded (mutex: no more losing to index contention)`, resB.ok === true);

    // ── (2) Content-integrity sweep over the WHOLE resulting history: for every Loom-Worker-Branch
    //    trailer commit, the trailer's own branch content must be genuinely present in THAT commit's tree.
    //    This is the structural "impossible to cross-corrupt" proof, not a re-check of one interleaving.
    const log = git(repo, `--no-pager log --format=%H`);
    const shas = log.split("\n").filter(Boolean);
    let trailerCommitsChecked = 0;
    for (const sha of shas) {
      const msg = execSync(`git --no-pager log -1 --format=%B ${sha}`, { cwd: repo }).toString();
      const m = msg.match(/^Loom-Worker-Branch:\s*(\S+)/m);
      if (!m) continue;
      trailerCommitsChecked++;
      const branch = m[1];
      const expectedFile = branch === "loom/branch-a" ? "file-a.txt" : "file-b.txt";
      let ownContent;
      try { ownContent = execSync(`git show ${sha}:${expectedFile}`, { cwd: repo }).toString(); } catch { ownContent = null; }
      check(`[trial ${t}] commit ${sha.slice(0, 7)} (trailer ${branch}) contains ITS OWN file ${expectedFile}`, ownContent !== null);
      // The corruption's exact shape: the trailer's file is present, but the content is the WRONG branch's
      // — so compare directly against that branch's own tip content, not just presence of the path.
      const branchTipContent = execSync(`git show ${branch}:${expectedFile}`, { cwd: repo }).toString();
      check(`[trial ${t}] commit ${sha.slice(0, 7)}'s ${expectedFile} content MATCHES branch ${branch}'s own tip (not swapped)`, ownContent === branchTipContent);
    }
    check(`[trial ${t}] both trailer commits were found and checked`, trailerCommitsChecked === 2);

    // ── (3) No content lost: both files present somewhere in final HEAD tree.
    const finalTree = git(repo, "ls-tree -r --name-only HEAD");
    check(`[trial ${t}] file-a.txt present in final tree`, finalTree.includes("file-a.txt"));
    check(`[trial ${t}] file-b.txt present in final tree`, finalTree.includes("file-b.txt"));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? `\n✅ ALL PASS — ${TRIALS} concurrent-merge trials produced zero cross-branch content corruption; the per-repo mutex closes the incident's silent-data-loss race.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
