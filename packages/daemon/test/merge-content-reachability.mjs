import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Content-reachability regression test (board card e076d2a2, DoD item 2). REAL git on temp repos, NO
// claude and NO live daemon.
//
// THE GAP THIS CLOSES: findLandedSquashCommit (and getTaskMergedInfo, the board's `merged` field
// producer — same trailer-only pattern, NOT a subject match as an earlier read of the incident assumed)
// both used to trust a `Loom-Worker-Branch: <branch>` trailer's mere PRESENCE as proof the branch landed.
// Under the squash+commit race (see merge-repo-mutex.mjs), a commit can carry one branch's trailer while
// its tree contains a COMPLETELY DIFFERENT branch's content — trailer presence is a CLAIM, not proof. This
// test constructs that exact shape DETERMINISTICALLY (no race needed) via git plumbing, independent of the
// concurrency repro, per the card's explicit requirement that this case stay proven on its own.
//
// Proves:
//   (1) NEGATIVE (the DoD's forged-trailer case): a commit bearing branch A's trailer but branch B's
//       content is REFUSED by findLandedSquashCommit(branch-a) — returns null, not the forged sha.
//   (2) POSITIVE CONTROL: the SAME check, run against a commit that genuinely and correctly carries branch
//       A's own content under branch A's own trailer, DOES return that sha — proving the check isn't just
//       unconditionally false (which would trivially "pass" (1) while breaking every real ALREADY_MERGED
//       case).
//   (3) getTaskMergedInfo (the board `merged` field) shares the SAME fix: refuses the forged commit,
//       accepts the genuine one.
// Run: 1) build daemon (pnpm build), 2) node test/merge-content-reachability.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch, findLandedSquashCommit, getTaskMergedInfo, taskKey, __resetMergedCommitMapCacheForTest } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcr@loom -c user.name=mcr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repo = path.join(os.tmpdir(), `loom-mcr-repo-${sfx}`);
const taskIdA = `mcr-task-a-${sfx}`;
const branchA = `loom/${taskKey(taskIdA)}`;
const branchB = "loom/mcr-branch-b";
const tmpDirs = [repo];

try {
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email mcr@loom && git config user.name mcr && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });

  function makeWorktree(branch, file, content) {
    const wt = path.join(os.tmpdir(), `loom-mcr-wt-${branch.replace(/\//g, "-")}-${sfx}`);
    tmpDirs.push(wt);
    execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
    fs.writeFileSync(path.join(wt, file), content);
    execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
    return wt;
  }
  makeWorktree(branchA, "file-a.txt", "real branch-a content\n");
  makeWorktree(branchB, "file-b.txt", "real branch-b content\n");

  // ── (1) NEGATIVE: deliberately forge a commit bearing branch A's trailer but branch B's content ──────
  execSync(`git merge --squash ${branchB}`, { cwd: repo }); // stage B's content
  execSync(`git ${GIT_ID} commit -q -m "chore: forged card A title" -m "Loom-Worker-Branch: ${branchA}"`, { cwd: repo });
  const forgedSha = git(repo, "rev-parse HEAD");
  check("(1) precondition: forged commit carries branch A's trailer", git(repo, `log -1 --format=%B ${forgedSha}`).includes(`Loom-Worker-Branch: ${branchA}`));
  check("(1) precondition: forged commit's content is actually branch B's file, NOT branch A's", (() => {
    try { execSync(`git show ${forgedSha}:file-a.txt`, { cwd: repo }); return false; } catch { /* expected: absent */ }
    try { execSync(`git show ${forgedSha}:file-b.txt`, { cwd: repo }); return true; } catch { return false; }
  })());

  const forgedResult = await findLandedSquashCommit(repo, branchA);
  check("(1) findLandedSquashCommit REFUSES the forged trailer-only match (returns null, not the forged sha)", forgedResult === null);

  __resetMergedCommitMapCacheForTest();
  const forgedBoardResult = await getTaskMergedInfo(repo, taskIdA);
  check("(1) getTaskMergedInfo ALSO refuses the forged commit (board `merged` field stays null, not a false positive)", forgedBoardResult === null);

  // ── (2) POSITIVE CONTROL: a REAL merge of branch A's own content under its own trailer ─────────────
  // Reset the canonical repo back to a clean state before the forged commit, so this genuine merge lands
  // on top of a clean history (isolating this check from the forged commit's side effects).
  execSync(`git reset --hard ${forgedSha}^`, { cwd: repo });
  const genuine = await mergeBranch(repo, branchA, "Card A title");
  check("(2) precondition: genuine mergeBranch succeeded", genuine.ok === true && typeof genuine.sha === "string");

  const genuineResult = await findLandedSquashCommit(repo, branchA);
  check("(2) findLandedSquashCommit ACCEPTS the genuine, content-matching commit (proves the check is not unconditionally false)", genuineResult === genuine.sha);

  __resetMergedCommitMapCacheForTest();
  const genuineBoardResult = await getTaskMergedInfo(repo, taskIdA);
  check("(2) getTaskMergedInfo ACCEPTS the genuine commit too", genuineBoardResult !== null && genuine.sha.startsWith(genuineBoardResult.sha));
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a trailer-forged commit (right trailer, wrong content) is refused by both findLandedSquashCommit and getTaskMergedInfo; a genuine content-matching commit is still correctly accepted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
