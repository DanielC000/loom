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
//   (6) RENAME REGRESSION (card 756a2cd8, DoD-2) — main RENAMES a path the branch also edited, then the
//       branch squash-merges CLEANLY (git's rename-following 3-way merge; zero conflicts). Before this fix
//       the STAMP was computed from the branch's own PRE-landing diff (`merge-base(HEAD, branch)..branch` —
//       names the ORIGINAL path), while VERIFY always recomputes from the LANDED range (`sha^..sha` — names
//       the RENAMED path): different digests, so a genuinely-merged card resolved to null once the branch
//       was deleted. MUST FAIL against unfixed code (verified below by reverting the fix and re-running).
//   (7) POSITIVE CONTROL (DoD-3) — a WRONG `Loom-Worker-Base` must still be REJECTED, not blindly trusted.
//       d62dad73's own equivalent (case 7f in test/batch-merge.mjs) strips the Base trailer outright — for a
//       BATCHED multi-commit contribution the sha^ fallback then under-spans and a mismatch is guaranteed.
//       That exact recipe does NOT discriminate for a solo squash: a solo commit's `sha^` IS its own
//       Loom-Worker-Base by construction (see LOOM_WORKER_BASE_TRAILER's doc in git/worktrees.ts) — stripping
//       the trailer here would fall back to the identical value and still verify green, proving nothing. The
//       meaningful equivalent for a single-commit contribution is a WRONG base substituted in place of the
//       real one (the OLD pre-756a2cd8 base, `merge-base(HEAD, branch)` — exactly what the buggy code used
//       to stamp) while the TRUE PathSet digest (computed from the real `sha^..sha`) is kept untouched: the
//       verifier must recompute against the wrong base, land on a different digest, and reject. ATTRIBUTION
//       (Code Review follow-up): the genuine, uncorrupted commit is first asserted to resolve "pathset" via
//       the SAME branch-deleted+gc'd path, before it is corrupted — so the later `null` can only mean "the
//       wrong base was rejected", never "this fixture is broken in some unrelated way".
//   (8) BACKWARD-COMPAT GUARD (DoD-5, Code Review Blocking-2) — `Loom-Worker-PathSet` present,
//       `Loom-Worker-Base` ABSENT (case (7)'s own strip-only recipe, minus its corruption step): must still
//       resolve "pathset" via the sha^ fallback. This is the shape of nearly all of Loom's real merged
//       history (every solo commit landed before card 756a2cd8), and once every FRESH commit stamps both
//       trailers, this is the only case in the corpus still exercising that fallback at all — a future
//       regression to it would silently flip that whole population from "pathset" to "null" unnoticed.
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
    // Card 52e978ad: branch is gone but the landed commit carries the Loom-Worker-PathSet trailer —
    // verified from the commit's OWN ancestry, weaker than a live byte-diff but still a real check.
    check("(2) getTaskMergedInfo reports verification:\"pathset\" (branch gone, path-set trailer present)", board?.verification === "pathset");

    // (3b) — the discriminating case: a tip-sha design passes the checks above but breaks HERE, because
    // the dangling branch tip is exactly what a real gc prunes. The path-set design needs nothing but the
    // landed commit's own ancestry, which gc never touches.
    const findPostGc = await findLandedSquashCommit(repo, branch);
    check("(3b) POST-GC: findLandedSquashCommit STILL accepts the genuine commit", findPostGc === merged.sha);
    __resetMergedCommitMapCacheForTest();
    const boardPostGc = await getTaskMergedInfo(repo, taskId);
    check("(3b) POST-GC: getTaskMergedInfo STILL accepts the genuine commit", boardPostGc !== null && merged.sha.startsWith(boardPostGc.sha));
    check("(3b) POST-GC: getTaskMergedInfo STILL reports verification:\"pathset\" (survives git gc --prune=now, as designed)", boardPostGc?.verification === "pathset");
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
    // Card 52e978ad — the third and weakest mode: no path-set trailer at all (pre-f621f185 history), so
    // the answer rests on Loom-Worker-Branch trailer PRESENCE alone. Must be reported as such, not
    // silently upgraded to look as confident as the "content"/"pathset" cases above.
    check("(5) getTaskMergedInfo reports verification:\"trailer-only\" for pre-fix history (no path-set trailer)", board?.verification === "trailer-only");
  }

  // ── (6) RENAME REGRESSION (card 756a2cd8) — clean squash onto a path main renamed, zero conflicts ──────
  {
    const repo = newRepo("rename");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pgd-task-rename-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;

    fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "add shared file"`, { cwd: repo });
    const wt = makeWorktreeBranch(repo, branch, "shared.txt", "line1-BRANCH-EDIT\nline2\nline3\n");
    removeWorktree(repo, wt);

    // main renames the SAME file the branch edited, AFTER the branch was cut — no conflict with the
    // branch's own edit (git's rename-following 3-way merge lands it cleanly under the new name).
    execSync(`git mv shared.txt renamed.txt`, { cwd: repo });
    execSync(`git ${GIT_ID} commit -q -m "main: rename shared file"`, { cwd: repo });

    const merged = await mergeBranch(repo, branch, "Card rename title");
    check("(6) precondition: squash onto a renamed path succeeded (no conflict — rename-following)", merged.ok === true && typeof merged.sha === "string");
    check("(6) precondition: the landed commit touched the RENAMED path, not the original name",
      git(repo, `diff --name-only --no-renames ${merged.sha}~1..${merged.sha}`).trim() === "renamed.txt");
    check("(6) precondition: the squash commit carries a Loom-Worker-Base trailer (card 756a2cd8)",
      git(repo, "log -1 --format=%B").includes("Loom-Worker-Base: "));

    deleteBranchesReflogAndGc(repo, [branch]);

    const find = await findLandedSquashCommit(repo, branch);
    check("(6) DoD-2: findLandedSquashCommit ACCEPTS a genuine merge despite the upstream RENAME (must fail on unfixed code)", find === merged.sha);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, taskId);
    check("(6) getTaskMergedInfo ALSO accepts it", board !== null && merged.sha.startsWith(board.sha));
    check("(6) verification tier is \"pathset\", not degraded to \"trailer-only\"", board?.verification === "pathset");
  }

  // ── (7) POSITIVE CONTROL (DoD-3) — a WRONG Loom-Worker-Base is REJECTED, not blindly trusted ───────────
  {
    const repo = newRepo("wrong-base");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pgd-task-wrongbase-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;

    fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "add shared file"`, { cwd: repo });
    const preLandingMergeBase = git(repo, "rev-parse HEAD"); // the OLD (pre-756a2cd8, buggy) stamp base
    const wt = makeWorktreeBranch(repo, branch, "shared.txt", "line1-BRANCH-EDIT\nline2\nline3\n");
    removeWorktree(repo, wt);

    execSync(`git mv shared.txt renamed.txt`, { cwd: repo });
    execSync(`git ${GIT_ID} commit -q -m "main: rename shared file"`, { cwd: repo });

    const merged = await mergeBranch(repo, branch, "Card wrong-base title");
    check("(7) precondition: squash landed", merged.ok === true && typeof merged.sha === "string");
    const realBody = git(repo, `log -1 --format=%B ${merged.sha}`);
    const trueDigest = realBody.match(/Loom-Worker-PathSet: (\S+)/)?.[1];
    check("(7) precondition: the real commit carries both trailers", /Loom-Worker-Base: \S+/.test(realBody) && !!trueDigest);
    check("(7) precondition: the pre-landing merge-base genuinely differs from the real (sha^) base",
      !realBody.includes(`Loom-Worker-Base: ${preLandingMergeBase}`));

    // ── ATTRIBUTION (Code Review follow-up): prove the GENUINE, uncorrupted commit resolves "pathset" —
    //     via the SAME branch-deleted+gc'd path the corrupted assertion below will also go through — BEFORE
    //     corrupting anything. Without this, a later `null` result is ambiguous: it could mean "the wrong
    //     base was correctly rejected" (what this case claims) OR "something about this fixture is broken"
    //     (an unrelated failure that would ALSO read as null). Pinning "pathset" here first rules the latter
    //     out, so the corrupted assertion's `null` can only be attributed to the base substitution itself.
    deleteBranchesReflogAndGc(repo, [branch]);
    __resetMergedCommitMapCacheForTest();
    const genuineBoard = await getTaskMergedInfo(repo, taskId);
    check("(7) ATTRIBUTION: the genuine, uncorrupted commit resolves \"pathset\" (rules out a broken fixture before corrupting it)",
      genuineBoard !== null && merged.sha.startsWith(genuineBoard.sha) && genuineBoard.verification === "pathset");

    // Substitute the WRONG (pre-landing) base while keeping the TRUE digest untouched. Rebuilt via separate
    // -m paragraphs (not one embedded-newline string) to avoid cross-platform shell-quoting hazards.
    const subject = realBody.split("\n\n")[0];
    const branchTrailerLine = realBody.match(/^Loom-Worker-Branch: .+$/m)[0];
    execSync(
      `git ${GIT_ID} commit --amend -q -m "${subject.replace(/"/g, '\\"')}" -m "${branchTrailerLine}" -m "Loom-Worker-Base: ${preLandingMergeBase}" -m "Loom-Worker-PathSet: ${trueDigest}"`,
      { cwd: repo },
    );
    const corruptedSha = git(repo, "rev-parse HEAD");
    check("(7) precondition: the corrupted commit really carries the wrong base now",
      git(repo, `log -1 --format=%B ${corruptedSha}`).includes(`Loom-Worker-Base: ${preLandingMergeBase}`));

    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, taskId);
    check("(7) DoD-3: a WRONG Loom-Worker-Base is REJECTED, not blindly trusted (verifyPersistedPathSet fails closed)", board === null);
  }

  // ── (8) BACKWARD-COMPAT GUARD (DoD-5, Code Review Blocking-2 follow-up) — Loom-Worker-PathSet present,
  //     Loom-Worker-Base ABSENT, must still resolve "pathset" via verifyPersistedPathSet's sha^ fallback.
  //     This is the shape of nearly all of Loom's real merged history: every commit landed before card
  //     756a2cd8 (which is the first thing to ever stamp Base on the solo path) has PathSet with no Base.
  //     Before this case, once every FRESH solo commit started carrying both trailers, no test in this
  //     corpus asserted that shape resolves correctly any more — a future regression to the sha^ fallback
  //     would silently flip that entire population from "pathset" to "null" with nothing here to catch it.
  //     Same strip-a-trailer-via-amend recipe as case (7)'s own precondition, but WITHOUT (7)'s corruption
  //     step — the point here is that a MISSING Base still verifies correctly, not that a WRONG one is
  //     rejected (case (7)'s own case already covers "strip Base alone does not discriminate" for why THAT
  //     shape isn't a meaningful DoD-3 positive control — it just happens to be exactly the right shape for
  //     this DoD-5 backward-compat assertion instead).
  {
    const repo = newRepo("no-base-fallback");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pgd-task-nobasefallback-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;
    const wt = makeWorktreeBranch(repo, branch, "no-base-fallback.txt", "genuine content\n");
    removeWorktree(repo, wt);

    const merged = await mergeBranch(repo, branch, "Card no-base-fallback title");
    check("(8) precondition: squash landed", merged.ok === true && typeof merged.sha === "string");
    const realBody = git(repo, `log -1 --format=%B ${merged.sha}`);
    check("(8) precondition: the real commit carries both trailers before stripping",
      /Loom-Worker-Base: \S+/.test(realBody) && /Loom-Worker-PathSet: \S+/.test(realBody));

    // Strip ONLY the Loom-Worker-Base line, keeping the TRUE Loom-Worker-PathSet digest untouched — exactly
    // the shape a solo squash produced before card 756a2cd8 (no Base trailer existed on that path at all).
    const subject = realBody.split("\n\n")[0];
    const branchTrailerLine = realBody.match(/^Loom-Worker-Branch: .+$/m)[0];
    const pathSetTrailerLine = realBody.match(/^Loom-Worker-PathSet: .+$/m)[0];
    execSync(
      `git ${GIT_ID} commit --amend -q -m "${subject.replace(/"/g, '\\"')}" -m "${branchTrailerLine}" -m "${pathSetTrailerLine}"`,
      { cwd: repo },
    );
    const strippedSha = git(repo, "rev-parse HEAD");
    check("(8) precondition: the Base trailer is really gone now, PathSet is unchanged",
      !/Loom-Worker-Base:/.test(git(repo, `log -1 --format=%B ${strippedSha}`))
      && git(repo, `log -1 --format=%B ${strippedSha}`).includes(pathSetTrailerLine));

    deleteBranchesReflogAndGc(repo, [branch]);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, taskId);
    check("(8) DoD-5: PathSet present, Base ABSENT still resolves \"pathset\" via the sha^ fallback " +
      "(the pre-756a2cd8 shape — nearly all of Loom's real merged history)",
      board !== null && strippedSha.startsWith(board.sha) && board.verification === "pathset");
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — once a worker branch is deleted (and even after a real `git gc --prune=now`), a forged Loom-Worker-Branch trailer is refused via the persisted Loom-Worker-PathSet digest, a genuine merge still resolves (including when main concurrently advanced a shared file, or renamed a path the branch also edited — card 756a2cd8), pre-fix history (and any fresh commit missing Loom-Worker-Base) keeps resolving via the unchanged sha^ fallback, and a WRONG Loom-Worker-Base is rejected rather than blindly trusted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
