import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f621f185 — the residual e076d2a2 deliberately left open: findLandedSquashCommit/getTaskMergedInfo's
// content-reachability check (merge-content-reachability.mjs) only runs while the worker branch ref is
// still LIVE. Once the branch is deleted (the normal end state for any older merge), there was no tip left
// to diff against, so a forged `Loom-Worker-Branch` trailer had nothing to falsify it — degrading back to
// the pre-e076d2a2 trailer-presence-only answer. REAL git on temp repos, NO claude and NO live daemon.
//
// THE FIX: mergeBranch now ALSO stamps a `Loom-Worker-PathSet` trailer — a sha256 digest over the SORTED
// set of paths the branch itself changed (git/worktrees.ts's changedPathSetDigest). Verification, once the
// branch is gone, recomputes that same digest from the landed commit's OWN ancestry (sha^..sha — both
// permanently reachable from HEAD, no branch ref or dangling object needed) and compares. A CONTENT hash
// (path+blob-sha) was prototyped and rejected: it fails on an HONEST merge when main advances (after the
// branch was cut) with a non-conflicting edit to a file the branch also touches, because the pre/post-image
// blobs differ between record time (mergeBase..branch) and verify time (sha^..sha) even though nothing is
// wrong. A path SET does not have that failure mode (proven by case 4 below) — its accepted, narrower
// residual is two DIFFERENT branches touching the exact same set of paths, which this suite does not need
// to defend against (the real incident's branches touched entirely disjoint paths).
//
// Proves:
//   (1) NEGATIVE — RED-FIRST case: a commit bearing branch A's Loom-Worker-Branch trailer AND a
//       Loom-Worker-PathSet trailer computed from branch A's OWN real diff, but whose actually-staged/
//       committed content is branch B's (disjoint files) — the exact incident shape (`fb1dbb2` carried
//       db.ts/gateway/server.ts under a trailer claiming a pty change). Branch A deleted BEFORE the query,
//       so the pre-f621f185 code has nothing left to verify against and would return the forged sha /a
//       false `merged`. Both findLandedSquashCommit and getTaskMergedInfo must refuse it (null).
//   (2) POSITIVE CONTROL — a REAL mergeBranch squash of branch A's own content, branch deleted afterward:
//       both functions must still resolve to the genuine sha (proves the check isn't just unconditionally
//       false).
//   (3) POST-GC — for BOTH (1) and (2): after `git branch -D` + `git reflog expire --expire=now --all` +
//       `git gc --prune=now`, re-querying must produce the SAME answers. This is the case that actually
//       discriminates a real fix from a "fix on a timer": a branch-tip-sha-based design passes (1)/(2) but
//       BREAKS here, because the dangling tip commit is exactly what gc prunes.
//   (4) MAIN-ADVANCES-ON-A-SHARED-FILE — a genuine merge where, after the branch was cut, a SEPARATE commit
//       lands on main first, editing the SAME file the branch also touches (non-conflicting hunk), before
//       the branch is squash-merged, deleted, and gc'd. Must still resolve. This is the case that would have
//       falsified a content-hash design (prototyped and confirmed broken here before this fix was written)
//       and confirms the path-set design survives it.
//   (5) PRE-FIX HISTORY — a manually-authored commit carrying ONLY a Loom-Worker-Branch trailer (no
//       Loom-Worker-PathSet — simulating history that predates this fix), branch absent: must still resolve
//       via the unchanged degraded trailer-presence-only fallback (no regression for old commits that can
//       never carry the new trailer).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-pathset-deleted-branch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch, findLandedSquashCommit, getTaskMergedInfo, taskKey, __resetMergedCommitMapCacheForTest } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=pgd@loom -c user.name=pgd";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const tmpDirs = [];

// Mirrors production's changedPathSetDigest exactly (git/worktrees.ts) — used here to build the FORGED
// trailer's declared digest from branch A's real diff, independent of whatever actually gets staged.
function pathSetDigest(cwd, base, ref) {
  const raw = execSync(`git diff --name-only --no-renames ${base}..${ref}`, { cwd }).toString();
  const paths = raw.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

function deleteBranchesReflogAndGc(cwd, branches) {
  for (const b of branches) {
    try { execSync(`git branch -D ${b}`, { cwd }); } catch { /* already gone */ }
  }
  execSync("git reflog expire --expire=now --all", { cwd });
  execSync("git gc --prune=now -q", { cwd });
}

function newRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-pgd-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  tmpDirs.push(repo);
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email pgd@loom && git config user.name pgd && git commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktreeBranch(repo, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-pgd-wt-${branch.replace(/\//g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

// `git branch -D` refuses a branch still checked out in a worktree — remove the worktree first (mirrors
// production's removeWorktree-then-deleteBranch order) so the later delete/gc step actually runs.
function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

try {
  // ── (1) + (3a) NEGATIVE: forged trailer + forged (but self-consistent-looking) path-set trailer ───────
  {
    const repo = newRepo("forged");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskIdA = `pgd-task-a-${sfx}`;
    const branchA = `loom/${taskKey(taskIdA)}`;
    const branchB = "loom/pgd-branch-b";
    const base = git(repo, "rev-parse HEAD");
    const wtA = makeWorktreeBranch(repo, branchA, "file-a.txt", "real branch-a content\n");
    const wtB = makeWorktreeBranch(repo, branchB, "file-b.txt", "real branch-b content\n");
    removeWorktree(repo, wtA);
    removeWorktree(repo, wtB);

    const fpA = pathSetDigest(repo, base, branchA); // branch A's OWN real path-set digest
    execSync(`git merge --squash ${branchB}`, { cwd: repo }); // stage B's content
    execSync(
      `git ${GIT_ID} commit -q -m "chore: forged card A title" -m "Loom-Worker-Branch: ${branchA}" -m "Loom-Worker-PathSet: ${fpA}"`,
      { cwd: repo },
    );
    const forgedSha = git(repo, "rev-parse HEAD");
    check("(1) precondition: forged commit's content is branch B's file, not branch A's", (() => {
      try { execSync(`git show ${forgedSha}:file-a.txt`, { cwd: repo }); return false; } catch { /* expected absent */ }
      try { execSync(`git show ${forgedSha}:file-b.txt`, { cwd: repo }); return true; } catch { return false; }
    })());

    deleteBranchesReflogAndGc(repo, [branchA, branchB]); // branch gone BEFORE the query — the residual's precondition

    const preGcFind = await findLandedSquashCommit(repo, branchA);
    check("(1) RED-FIRST: findLandedSquashCommit REFUSES the forged commit once the branch is gone (returns null, not the forged sha)", preGcFind === null);
    __resetMergedCommitMapCacheForTest();
    const preGcBoard = await getTaskMergedInfo(repo, taskIdA);
    check("(1) getTaskMergedInfo ALSO refuses the forged commit (board `merged` stays null)", preGcBoard === null);

    // (3a) same queries again — branch was ALREADY gc'd above, so this specifically proves the refusal
    // isn't relying on any object that a real gc would have already reaped by this point.
    const postGcFind = await findLandedSquashCommit(repo, branchA);
    check("(3a) POST-GC: findLandedSquashCommit STILL refuses the forged commit", postGcFind === null);
    __resetMergedCommitMapCacheForTest();
    const postGcBoard = await getTaskMergedInfo(repo, taskIdA);
    check("(3a) POST-GC: getTaskMergedInfo STILL refuses the forged commit", postGcBoard === null);
  }

  // ── (2) + (3b) POSITIVE CONTROL: a genuine mergeBranch squash, branch deleted + gc'd afterward ─────────
  {
    const repo = newRepo("genuine");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pgd-task-genuine-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;
    const wt = makeWorktreeBranch(repo, branch, "landed.txt", "genuinely landed content\n");
    removeWorktree(repo, wt);

    const merged = await mergeBranch(repo, branch, "Card genuine title");
    check("(2) precondition: genuine mergeBranch succeeded", merged.ok === true && typeof merged.sha === "string");
    check("(2) precondition: the squash commit carries the new Loom-Worker-PathSet trailer",
      git(repo, "log -1 --format=%B").includes("Loom-Worker-PathSet: "));

    deleteBranchesReflogAndGc(repo, [branch]);

    const find = await findLandedSquashCommit(repo, branch);
    check("(2) findLandedSquashCommit ACCEPTS the genuine commit (branch gone)", find === merged.sha);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, taskId);
    check("(2) getTaskMergedInfo ACCEPTS the genuine commit too", board !== null && merged.sha.startsWith(board.sha));

    // (3b) — the discriminating case: a tip-sha design passes the checks above but breaks HERE, because
    // the dangling branch tip is exactly what a real gc prunes. The path-set design needs nothing but the
    // landed commit's own ancestry, which gc never touches.
    const findPostGc = await findLandedSquashCommit(repo, branch);
    check("(3b) POST-GC: findLandedSquashCommit STILL accepts the genuine commit", findPostGc === merged.sha);
    __resetMergedCommitMapCacheForTest();
    const boardPostGc = await getTaskMergedInfo(repo, taskId);
    check("(3b) POST-GC: getTaskMergedInfo STILL accepts the genuine commit", boardPostGc !== null && merged.sha.startsWith(boardPostGc.sha));
  }

  // ── (4) MAIN ADVANCES on a file the branch ALSO touches (non-conflicting), then squash + delete + gc ───
  {
    const repo = newRepo("shared-file");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pgd-task-shared-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;

    fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\nline4\nline5\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "add shared file"`, { cwd: repo });
    const wt = makeWorktreeBranch(repo, branch, "unrelated.txt", "branch's own separate file\n");
    // branch ALSO edits shared.txt's TOP line (non-overlapping with what main will edit below).
    const sharedInWt = fs.readFileSync(path.join(wt, "shared.txt"), "utf8").split("\n");
    sharedInWt[0] = "line1-BRANCH";
    fs.writeFileSync(path.join(wt, "shared.txt"), sharedInWt.join("\n"));
    execSync(`git add -A && git ${GIT_ID} commit -q -m "branch: edit top of shared file"`, { cwd: wt });
    removeWorktree(repo, wt);

    // main advances AFTER the branch was cut, editing the BOTTOM of the SAME file (non-conflicting hunk).
    const sharedOnMain = fs.readFileSync(path.join(repo, "shared.txt"), "utf8").split("\n");
    sharedOnMain[4] = "line5-MAIN-ADVANCED";
    fs.writeFileSync(path.join(repo, "shared.txt"), sharedOnMain.join("\n"));
    execSync(`git add -A && git ${GIT_ID} commit -q -m "main: advance, edit bottom of shared file"`, { cwd: repo });

    const merged = await mergeBranch(repo, branch, "Card shared-file title");
    check("(4) precondition: squash onto advanced main succeeded (no conflict)", merged.ok === true && typeof merged.sha === "string");
    check("(4) precondition: both edits present in the landed content",
      fs.readFileSync(path.join(repo, "shared.txt"), "utf8").includes("line1-BRANCH")
      && fs.readFileSync(path.join(repo, "shared.txt"), "utf8").includes("line5-MAIN-ADVANCED"));

    deleteBranchesReflogAndGc(repo, [branch]);

    const find = await findLandedSquashCommit(repo, branch);
    check("(4) findLandedSquashCommit ACCEPTS a genuine merge despite main advancing a shared file (path-set survives 3-way-merge drift)", find === merged.sha);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, taskId);
    check("(4) getTaskMergedInfo ALSO accepts it", board !== null && merged.sha.startsWith(board.sha));
  }

  // ── (5) PRE-FIX HISTORY: a commit with ONLY the old Loom-Worker-Branch trailer, no PathSet ──────────────
  {
    const repo = newRepo("prefix-history");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pgd-task-prefix-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;
    execSync(`git ${GIT_ID} commit --allow-empty -q -m "feat(x): landed before this fix" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
    const sha = git(repo, "log -1 --format=%H");

    const find = await findLandedSquashCommit(repo, branch);
    check("(5) pre-fix history (no PathSet trailer, branch never even existed) still resolves via degraded trailer-presence fallback", find === sha);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, taskId);
    check("(5) getTaskMergedInfo ALSO still resolves it", board !== null && sha.startsWith(board.sha));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — once a worker branch is deleted (and even after a real `git gc --prune=now`), a forged Loom-Worker-Branch trailer is refused via the persisted Loom-Worker-PathSet digest, a genuine merge still resolves (including when main concurrently advanced a shared file), and pre-fix history without the new trailer keeps its old degraded-but-unchanged behavior."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
