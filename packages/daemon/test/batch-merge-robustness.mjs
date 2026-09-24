import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH MERGE GATE — ROBUSTNESS/EDGE CASES (card dbc6f660 — gate N ready branches once; card 6801c0a1 —
// land each branch's OWN commits INDIVIDUALLY, never squashed, only the branch's LAST commit carrying
// the Loom-Worker-Branch trailer — see git/batch-merge.ts's own header doc for the full correction).
// REAL git on temp repos, no claude, no live daemon, no Db/SessionService — the batching primitive
// (git/batch-merge.ts) is gate-mechanism-agnostic, so it's fully exercised with a fake `runGate` callback.
//
// SPLIT FROM batch-merge.mjs (card b5af744d, successor to diagnosis card 53a818eb): the single file used
// to run 88.4s solo against the blanket 120_000ms TEST_TIMEOUT_MS (1.36x headroom) — no single dead fixed
// cost, just pure git-volume content growth spread ~evenly across ~19 scenarios (profiled per-scenario
// before splitting; see this card's worker report for the full breakdown). This file carries the
// forgery/robustness/failure-mode/ordering scenarios; see batch-merge.mjs for the core landing mechanics
// (GREEN/RED/CONFLICT/FORFEIT/SHAPE/MERGE-COMMIT-IN-RANGE) and the PathSet/Base stamp basics.
//
// SPLIT AGAIN (card 4e8e2d82): this file then ran ~92-117s (max pass 116,925ms, 3 SIGTERM kills at the
// 120s per-file ceiling, n=12 rows in gate-timing) — scenarios (10)/(11)/(11b)/(12)/(noop) moved verbatim
// to batch-merge-robustness-redundancy.mjs. This file keeps (7d)/(7e)/(8)/(9)/(9b).
//
// Proves:
//   (7d) POSITIVE CONTROL — a WRONG/forged Loom-Worker-PathSet digest is REJECTED, not silently trusted.
//   (7e) ROBUSTNESS — a clean, non-conflicting rename-following cherry-pick stamps the digest against the
//        LANDED path, not the branch's own pre-landing path.
//   (8) Claude-Session TRAILER STRIPPING (card b7f965d2) — a worker's own doctrine-violating
//       Claude-Session trailer is stripped from every landed commit, tip and non-tip alike, while author
//       identity/date and Loom-Worker-* trailers survive.
//   (9) pathSetStamped (card 1d3f500e) — a forced failure of the follow-up Loom-Worker-Base/PathSet amend
//       surfaces as a structured `pathSetStamped:false` on the landed branch (previously only a
//       console.warn), and is DISTINCT from (9b) a noop landing, which omits the field entirely rather
//       than reporting `false` for a stamp it never attempted.
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-robustness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// Card aac489a2: this file calls the REAL production createWorktree() (imported below), which resolves
// WORKTREES_DIR as a SIBLING of LOOM_HOME (paths.ts) — a bare `node batch-merge-robustness.mjs` run with
// no LOOM_HOME set would otherwise leak real worktrees into the owner's real ~/.loom-worktrees.
// useOwnLoomHome reuses the harness's own per-test temp home when run via scripts/test-daemon.mjs (which
// already sets one), or mkdtemp's + registers its own when run bare directly — either way LOOM_HOME is a
// temp dir BEFORE the dist import below, and requireHermeticEnv() makes that fail closed rather than
// silently leak again.
useOwnLoomHome("loom-bmr-parent-");
requireHermeticEnv();

const { createWorktree, getTaskMergedInfo, __resetMergedCommitMapCacheForTest } = await import("../dist/git/worktrees.js");
const { assembleBatchBranches, fastForwardCanonicalMain, runBatchedMerge } = await import("../dist/git/batch-merge.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

// Mirrors production's changedPathSetDigest exactly (git/worktrees.ts) — independent re-computation used
// to assert the STAMPED digest is actually correct, not just present.
function pathSetDigest(cwd, base, ref) {
  const raw = execSync(`git diff --name-only --no-renames ${base}..${ref}`, { cwd }).toString();
  const paths = raw.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

function deleteBranchAndGc(repo, branch) {
  try { execSync(`git branch -D ${branch}`, { cwd: repo }); } catch { /* already gone */ }
  execSync("git reflog expire --expire=now --all", { cwd: repo });
  execSync("git gc --prune=now -q", { cwd: repo });
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bm@loom -c user.name=bm";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `bm-proj-${sfx}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# batch-merge\n");
  execSync(`git init -q && git config user.email bm@loom && git config user.name bm`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

/** Cut a fresh worker branch off `repo`'s current HEAD, commit one file to it, and return its identity —
 *  mirrors what a real worker's worktree looks like by the time a manager wants to merge it. */
async function cutBranch(repo, label, file, content) {
  const taskId = `bm-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { workerSessionId: `bm-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}

/** Cut a fresh worker branch and land MULTIPLE commits onto it, oldest first — card 6801c0a1 DoD-4: proves
 *  a branch with N commits lands N commits on main, not 1 (the old squash-per-branch shape this card
 *  replaced would have collapsed all of them into one). */
async function cutBranchMultiCommit(repo, label, commits) {
  const taskId = `bm-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  for (const { file, content, message } of commits) {
    fs.writeFileSync(path.join(worktreePath, file), content);
    commitAll(worktreePath, `${message}`, GIT_ID);
  }
  return { workerSessionId: `bm-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}

/** Same as {@link cutBranchMultiCommit}, but each commit's AUTHOR date is pinned explicitly (via
 *  `GIT_AUTHOR_DATE`) instead of following wall-clock creation order — card 4763432b's sort key is the
 *  author date, not the committer date (which stays wall-clock/monotonic either way), so a test that wants
 *  to prove the sort actually reorders branches needs author dates it controls independently of the order
 *  these git calls happen to run in. `commits` entries: `{file, content, message, authorDateIso}`. */
async function cutBranchMultiCommitWithAuthorDates(repo, label, commits) {
  const taskId = `bm-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  for (const { file, content, message, authorDateIso } of commits) {
    fs.writeFileSync(path.join(worktreePath, file), content);
    execSync("git add .", { cwd: worktreePath });
    execSync(`git ${GIT_ID} commit -q -m "${message}"`, {
      cwd: worktreePath,
      env: { ...process.env, GIT_AUTHOR_DATE: authorDateIso },
    });
  }
  return { workerSessionId: `bm-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}

/** Single-commit convenience wrapper around {@link cutBranchMultiCommitWithAuthorDates}. */
async function cutBranchWithAuthorDate(repo, label, file, content, authorDateIso) {
  return cutBranchMultiCommitWithAuthorDates(repo, label, [{ file, content, message: label, authorDateIso }]);
}

const passGate = async () => ({ passed: true });

try {
  // ── (7d) POSITIVE CONTROL — a WRONG/forged Loom-Worker-PathSet digest is REJECTED, not silently trusted ─
  //     Proves the check can actually FAIL: without this, a check that always reports "verified" would
  //     pass every test above for the wrong reason.
  {
    const repo = path.join(os.tmpdir(), `loom-bm-pathset-forged-${sfx}`);
    makeRepo(repo);
    // Card 4763432b: landing order now follows each candidate's own earliest AUTHOR date, not array order
    // — so `decoy` is created (and thus authored) FIRST and `wrong` SECOND, ensuring `wrong` sorts (and
    // lands) last regardless of which order they're passed to `runBatchedMerge` in below.
    const decoy = await cutBranch(repo, "ps-decoy", "ps-decoy.txt", "decoy branch work\n");
    const wrong = await cutBranch(repo, "ps-forged", "ps-forged.txt", "forged branch work\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-forged-${sfx}`);

    // `decoy` lands FIRST, `wrong` lands LAST — so wrong's tip commit ends up at canonical HEAD, where
    // `git commit --amend` can reach it directly.
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [decoy, wrong], passGate);
    check("(7d) precondition: both landed", result.ok === true && result.landed.length === 2);
    const wrongLanded = result.landed.find((l) => l.branch === wrong.branch);
    const decoyLanded = result.landed.find((l) => l.branch === decoy.branch);
    check("(7d) precondition: wrong's tip is canonical HEAD (landed last)", git(repo, "rev-parse HEAD") === wrongLanded.sha);

    // Corrupt the just-landed commit's trailer to declare the DECOY's own real digest instead of its own —
    // same forged-trailer shape as merge-pathset-deleted-branch.mjs's own case (1), applied to a batch-
    // landed single-commit tip. Rebuilt via separate -m paragraphs (not one embedded-newline string) to
    // avoid cross-platform shell-quoting hazards.
    const forgedDigest = pathSetDigest(repo, `${decoyLanded.sha}~1`, decoyLanded.sha);
    const realBody = git(repo, `log -1 --format=%B ${wrongLanded.sha}`);
    const subject = realBody.split("\n\n")[0];
    const branchTrailerLine = realBody.match(/^Loom-Worker-Branch: .+$/m)[0];
    check("(7d) precondition: the forged digest actually differs from the real stamped one", !realBody.includes(`Loom-Worker-PathSet: ${forgedDigest}`));
    execSync(`git ${GIT_ID} commit --amend -q -m "${subject.replace(/"/g, '\\"')}" -m "${branchTrailerLine}" -m "Loom-Worker-PathSet: ${forgedDigest}"`, { cwd: repo });
    const forgedSha = git(repo, "rev-parse HEAD");

    removeWorktree(repo, wrong.worktreePath);
    removeWorktree(repo, decoy.worktreePath);
    deleteBranchAndGc(repo, wrong.branch);
    deleteBranchAndGc(repo, decoy.branch);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, wrong.taskId);
    check("(7d) a forged/wrong PathSet digest is REJECTED once the branch is gone (verifyPersistedPathSet fails closed)", board === null);
    check("(7d) sanity: the forged commit really is what's on main now", git(repo, "rev-parse HEAD") === forgedSha);
  }

  // ── (7e) ROBUSTNESS — a single-commit branch cherry-picks CLEANLY (no conflict) onto a tree where an
  //     earlier-landed batch member RENAMED the very file this branch also edits. The stamped digest must
  //     reflect the LANDED file name, not the branch's own pre-landing file name — this is the exact
  //     divergence this card's investigation found and is why the digest is computed from the landed range
  //     (batchHeadBefore..landedSha), never from the branch's own pre-landing mergeBase..branchTip diff. ──
  {
    const repo = path.join(os.tmpdir(), `loom-bm-pathset-rename-${sfx}`);
    makeRepo(repo);
    fs.writeFileSync(path.join(repo, "renameable.txt"), "line1\nline2\nline3\n");
    commitAll(repo, "seed renameable.txt", GIT_ID);

    // "renamer" lands FIRST in the batch and renames the shared file.
    const renamerTaskId = `bm-task-renamer-${sfx}`;
    const renamerWt = await createWorktree(repo, projId, renamerTaskId);
    execSync(`git mv renameable.txt renamed.txt`, { cwd: renamerWt.worktreePath });
    execSync(`git ${GIT_ID} commit -q -m "renamer: rename the shared file"`, { cwd: renamerWt.worktreePath });
    const renamer = { workerSessionId: `bm-wkr-renamer-${sfx}`, taskId: renamerTaskId, branch: renamerWt.branch, taskTitle: "feat(test): renamer", worktreePath: renamerWt.worktreePath };

    // "editor" (single commit) edits a DIFFERENT line of the ORIGINAL (pre-rename) file — a clean,
    // non-conflicting cherry-pick once it lands on top of the renamer's already-landed rename.
    const editorTaskId = `bm-task-editor-${sfx}`;
    const editorWt = await createWorktree(repo, projId, editorTaskId);
    const lines = fs.readFileSync(path.join(editorWt.worktreePath, "renameable.txt"), "utf8").split("\n");
    lines[2] = "line3-EDITED";
    fs.writeFileSync(path.join(editorWt.worktreePath, "renameable.txt"), lines.join("\n"));
    commitAll(editorWt.worktreePath, "editor: edit the shared file", GIT_ID);
    const editor = { workerSessionId: `bm-wkr-editor-${sfx}`, taskId: editorTaskId, branch: editorWt.branch, taskTitle: "feat(test): editor", worktreePath: editorWt.worktreePath };

    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-rename-${sfx}`);
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [renamer, editor], passGate);

    check("(7e) precondition: both landed cleanly (no conflict — rename-following cherry-pick)", result.ok === true && result.landed.length === 2);
    const editorLanded = result.landed.find((l) => l.branch === editor.branch);
    const editorBody = git(repo, `log -1 --format=%B ${editorLanded.sha}`);
    check("(7e) precondition: the editor's landed commit touched the RENAMED path, not the original name",
      git(repo, `diff --name-only --no-renames ${editorLanded.sha}~1..${editorLanded.sha}`).trim() === "renamed.txt");
    check("(7e) the editor's stamped PathSet digest reflects the LANDED (renamed) path", (() => {
      const m = editorBody.match(/Loom-Worker-PathSet: (\S+)/);
      if (!m) return false;
      const landedDigest = pathSetDigest(repo, `${editorLanded.sha}~1`, editorLanded.sha);
      return m[1] === landedDigest;
    })());

    removeWorktree(repo, editor.worktreePath);
    removeWorktree(repo, renamer.worktreePath);
    deleteBranchAndGc(repo, editor.branch);
    deleteBranchAndGc(repo, renamer.branch);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, editor.taskId);
    check("(7e) verification still resolves to \"pathset\" post-deletion despite the upstream rename", board?.verification === "pathset");
  }

  // ── (8) Claude-Session TRAILER STRIPPING (card b7f965d2) — this is the batch cherry-pick path's own
  //     exposure: it lands a worker's own commit bodies verbatim, so a worker's own (doctrine-violating)
  //     `Claude-Session:` trailer would otherwise reach mainline unfiltered on EVERY commit it touched,
  //     not just a branch's tip. Covers a multi-commit branch where every commit carries the trailer, a
  //     branch with none (byte-identical continuity), and that Loom-Worker-* trailers always survive. ──
  {
    const repo = path.join(os.tmpdir(), `loom-bm-trailer-${sfx}`);
    makeRepo(repo);
    // Built via separate -m paragraphs per commit (not one embedded-newline string) — real newlines
    // inside a single quoted execSync arg are a cmd.exe hazard on Windows (same reason (7d)'s forged
    // amend above builds its message the same way).
    const taintedTaskId = `bm-task-trailer-tainted-${sfx}`;
    const { worktreePath: taintedWt, branch: taintedBranch } = await createWorktree(repo, projId, taintedTaskId);
    fs.writeFileSync(path.join(taintedWt, "trailer-1.txt"), "t1\n");
    commitAll(taintedWt, ["feat(test): trailer commit 1", "Claude-Session: https://claude.ai/code/session_FAKE001"], GIT_ID);
    fs.writeFileSync(path.join(taintedWt, "trailer-2.txt"), "t2\n");
    commitAll(taintedWt, ["fix(test): trailer commit 2", "Body text.", "Claude-Session: https://claude.ai/code/session_FAKE002"], GIT_ID);
    const tainted = { workerSessionId: `bm-wkr-trailer-tainted-${sfx}`, taskId: taintedTaskId, branch: taintedBranch, taskTitle: "feat(test): trailer-tainted", worktreePath: taintedWt };
    check("(8) precondition: both of the tainted branch's own commits carry a Claude-Session trailer before landing",
      git(taintedWt, `log --format=%B ${taintedBranch}`).split("Claude-Session").length - 1 === 2);
    // Capture the SOURCE author dates before landing — %at (epoch seconds), oldest-first, matching the
    // landed order below. This is the newly-introduced mechanism for a NON-tip commit specifically: it
    // previously got its date implicitly from cherry-pick's own auto-commit, and now goes through an
    // explicit `--date` on a manual `git commit` instead — precisely what would regress silently.
    // `--reverse ${taintedBranch}` walks the WHOLE history reachable from the branch (init + both tainted
    // commits) — slice to the last 2 (oldest-first among just the new ones) rather than range-scoping
    // against a not-yet-captured base sha.
    const taintedSourceDates = git(taintedWt, `log --reverse --format=%at ${taintedBranch}`).split("\n").slice(-2);
    check("(8) precondition: captured 2 source author dates from the tainted branch", taintedSourceDates.length === 2);
    const clean = await cutBranch(repo, "trailer-clean", "trailer-clean.txt", "no trailer here\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-trailer-${sfx}`);

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [tainted, clean], passGate);
    check("(8) precondition: both branches landed", result.ok === true && result.landed.length === 2 && result.dropped.length === 0);
    const allBodies = git(repo, `log --reverse --format=%B ${baseMainSha}..HEAD`);
    // THE DISCRIMINATING ASSERTION — must FAIL against pre-fix code (which cherry-picks non-tip commits
    // via auto-commit, landing the worker's original message, trailer and all).
    check("(8) NO landed commit carries a Claude-Session trailer, tainted branch included", !allBodies.includes("Claude-Session"));
    check("(8) the tainted branch's tip STILL carries its Loom-Worker-Branch trailer (strip never touches it)",
      allBodies.includes(`Loom-Worker-Branch: ${tainted.branch}`));
    check("(8) the tainted branch's non-tip commit body text survives (only the trailer line is gone)",
      allBodies.includes("Body text."));
    const taintedLanded = result.landed.find((l) => l.branch === tainted.branch);
    const cleanLanded = result.landed.find((l) => l.branch === clean.branch);
    check("(8) landed result reports strippedTrailerCount:2 for the tainted branch (both its commits)",
      taintedLanded?.strippedTrailerCount === 2);
    check("(8) landed result reports strippedTrailerCount:0 for the clean branch (nothing to strip)",
      cleanLanded?.strippedTrailerCount === 0);

    // Author identity AND date must still be preserved on EVERY commit, not just the tip — the strip now
    // routes every commit (not only the tip) through a manual `git commit --author ... --date ...`.
    const taintedShas = git(repo, `log --reverse --format=%H ${baseMainSha}..HEAD`).split("\n").slice(0, 2);
    taintedShas.forEach((sha, i) => {
      check(`(8) commit ${sha.slice(0, 7)} keeps the worker's own author identity (not the batch identity's)`,
        git(repo, `log -1 --format=%an ${sha}`) === "bm" && git(repo, `log -1 --format=%ae ${sha}`) === "bm@loom");
      // THE DISCRIMINATING ASSERTION for the --date round-trip specifically — a non-tip commit used to get
      // its date implicitly from cherry-pick's auto-commit; it now goes through an explicit `--date`
      // instead, which could silently drop or reset it if that flag were ever wrong/missing.
      check(`(8) commit ${sha.slice(0, 7)} keeps the worker's own original author DATE (%at round-trips through --date)`,
        git(repo, `log -1 --format=%at ${sha}`) === taintedSourceDates[i]);
    });

    // NEGATIVE CONTROL: a branch that never carried the trailer still lands normally — same shape section
    // (1)'s GREEN case already proves for an untainted branch, just with the strip in the pipeline now.
    const cleanBody = git(repo, `log -1 --format=%B ${cleanLanded.sha}`);
    check("(8) the clean branch's landed body still carries its subject", cleanBody.includes("trailer-clean"));
    check("(8) the clean branch's landed body still carries its Loom-Worker-Branch trailer", cleanBody.includes(`Loom-Worker-Branch: ${clean.branch}`));
    check("(8) the clean branch's landed body carries no Claude-Session trailer (never had one)", !cleanBody.includes("Claude-Session"));
  }

  // ── (9) pathSetStamped SURFACES A FAILED trailer-stamp (card 1d3f500e / Code Review c00a136c) ──────────
  //     Previously a failed follow-up `git commit --amend` (Loom-Worker-Base/PathSet) was only a
  //     console.warn — nothing structured reached LandResult/BatchLandedBranch/the batch report, so a
  //     stamp failure silently degraded a branch to the weaker "trailer-only" tier with a daemon-log line
  //     as its only trace. `pathSetStamped` makes that outcome a first-class field on the result.
  //
  //     DoD-3 CONSTRAINT (measured 2026-09-04): every PRODUCTION pathset-from-batch observation so far is a
  //     SINGLE-COMMIT branch, where `batchHeadBefore === sha^` degenerately — a control built on one would
  //     return the SAME answer whether the stamp mechanism works, is bypassed, or is broken. This uses a
  //     MULTI-COMMIT branch so a genuine stamp failure is actually distinguishable from a no-op.
  {
    const repo = path.join(os.tmpdir(), `loom-bm-stamp-${sfx}`);
    makeRepo(repo);
    const multi = await cutBranchMultiCommit(repo, "stamp-multi", [
      { file: "stamp-1.txt", content: "s1\n", message: "feat(test): stamp multi 1" },
      { file: "stamp-2.txt", content: "s2\n", message: "feat(test): stamp multi 2" },
    ]);
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-stamp-${sfx}`);

    // A gitFactory that delegates EVERY call to a real boundedSimpleGit instance EXCEPT the follow-up
    // `git commit --amend` that stamps Loom-Worker-Base/PathSet — that one call fails, simulating a real
    // (if rare) stamp failure while every earlier cherry-pick/commit step succeeds normally. Mirrors
    // merge-squash-target-toctou.mjs's own "delegate to real git, hook one specific call" shape.
    let amendAttempted = false;
    function failingAmendGitFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args.includes("commit") && args.includes("--amend")) {
            amendAttempted = true;
            throw new Error("simulated stamp-amend failure");
          }
          return real.raw(args);
        },
      };
    }

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [multi], passGate, { gitFactory: failingAmendGitFactory });
    check("(9) precondition: the forced amend failure actually fired", amendAttempted === true);
    check("(9) ok:true — a stamp failure degrades verification tier, it does NOT fail the merge", result.ok === true);
    check("(9) the branch still landed BOTH its commits (not partially, not dropped)",
      result.landed.length === 1 && result.dropped.length === 0 && git(repo, `rev-list --count ${baseMainSha}..HEAD`) === "2");
    const landed = result.landed[0];
    check("(9) pathSetStamped:false surfaces the forced stamp failure", landed.pathSetStamped === false);
    const body = git(repo, `log -1 --format=%B ${landed.sha}`);
    check("(9) the landed commit carries NO Loom-Worker-PathSet/-Base trailer (the amend never landed)",
      !body.includes("Loom-Worker-PathSet:") && !body.includes("Loom-Worker-Base:"));
    check("(9) the landed commit STILL carries its Loom-Worker-Branch trailer (only the follow-up amend failed)",
      body.includes(`Loom-Worker-Branch: ${multi.branch}`));

    // The mechanism pathSetStamped:false exists to make VISIBLE rather than silently discoverable only via
    // a downstream getTaskMergedInfo tier read: verification degrades to the weaker trailer-only tier.
    removeWorktree(repo, multi.worktreePath);
    deleteBranchAndGc(repo, multi.branch);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, multi.taskId);
    check("(9) getTaskMergedInfo still resolves the branch (trailer presence alone)", board !== null && landed.sha.startsWith(board.sha));
    check("(9) verification tier degrades to \"trailer-only\", matching the surfaced pathSetStamped:false",
      board?.verification === "trailer-only");
  }

  // ── (9b) DISTINGUISH a stamp failure from a stamp that was never attempted at all (a noop landing) ─────
  //     assembleBatchBranches classifies a candidate a noop when its OWN branch tip is already an ancestor
  //     of the batch worktree's HEAD (mergeBase === branchTip) — no cherry-pick, no commit, no stamp is
  //     ever attempted, so pathSetStamped must be OMITTED (key absent), never an explicit `false`.
  //     Constructed directly here (force the candidate's branch ref onto the already-landed commit) rather
  //     than by re-submitting the SAME pre-land candidate through a second real batch landing: a batch/solo
  //     landing always cherry-picks into a BRAND NEW commit, so a branch's ORIGINAL (pre-land) tip is never
  //     an ancestor of what actually lands — re-submitting it hits the ordinary cherry-pick path again
  //     (which then fails to commit an EMPTY diff and, per a separate, out-of-scope git.raw()-swallows-a-
  //     nonzero-exit gap this investigation surfaced, can silently corrupt the earlier landed commit's
  //     trailers — reported to the manager, not fixed here; card 1d3f500e scopes only (A) and (B)).
  {
    const repo = path.join(os.tmpdir(), `loom-bm-stamp-noop-${sfx}`);
    makeRepo(repo);
    const solo = await cutBranch(repo, "stamp-noop", "stamp-noop.txt", "noop work\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-stamp-noop-a-${sfx}`);
    const first = await runBatchedMerge(repo, batchWt, baseMainSha, [solo], passGate);
    check("(9b) precondition: the first landing succeeds normally with pathSetStamped:true",
      first.ok === true && first.landed[0]?.pathSetStamped === true);

    // Force the candidate's OWN branch ref back onto `baseMainSha` (its OWN pre-land fork point, a PROPER
    // ANCESTOR of the landed commit, not the landed commit itself) — constructs the exact precondition
    // assembleBatchBranches's noop classification checks for (mergeBase(HEAD, branchTip) === branchTip),
    // without re-running any of the cherry-pick/commit machinery landBranchCommitsIndividually performs.
    // (Pointing the ref AT the landed sha itself instead trips findLandedSquashCommit's own re-task guard —
    // "branch re-cut onto its own prior squash" — a DIFFERENT, deliberately-conservative refusal that would
    // report emptyKind:"STAGE_EMPTY_RETRY", not the ALREADY_MERGED noop this case means to exercise.)
    // The branch is still checked out in the worker's own worktree — remove it first (git refuses to
    // force-update a branch checked out elsewhere), mirroring production's removeWorktree-then-delete order.
    const landedSha = first.landed[0].sha;
    removeWorktree(repo, solo.worktreePath);
    execSync(`git branch -f ${solo.branch} ${baseMainSha}`, { cwd: repo });
    check("(9b) precondition: the candidate's branch ref is now a proper ancestor of the landed commit, not the landed commit itself",
      git(repo, `rev-parse ${solo.branch}`) === baseMainSha && baseMainSha !== landedSha);

    const { worktreePath: batchWt2 } = await createWorktree(repo, projId, `bm-batch-stamp-noop-b-${sfx}`);
    const { landed, dropped } = await assembleBatchBranches(batchWt2, [solo]);
    check("(9b) re-submitting the (now-ancestor) branch is classified a noop, not dropped",
      dropped.length === 0 && landed.length === 1 && landed[0].noop === true);
    check("(9b) the noop's sha is the SAME already-landed commit (reused, not re-created)",
      landed[0].sha === landedSha);
    check("(9b) a noop landing OMITS pathSetStamped entirely (key absent) — distinct from an explicit false",
      !("pathSetStamped" in landed[0]));
  }

} finally {
  // No per-test worktree cleanup needed: LOOM_HOME is now a temp dir (useOwnLoomHome, above), so
  // _guard.mjs's own exit hook removes its WORKTREES_DIR sibling (where createWorktree() put everything
  // this file created) automatically — see card aac489a2.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a forged/wrong PathSet digest is rejected, a rename-following cherry-pick stamps the landed path, a worker's own Claude-Session trailer is stripped from every landed commit, a stamp failure surfaces as pathSetStamped:false distinct from a noop's omitted key. See batch-merge-robustness-redundancy.mjs for the rest. See batch-merge.mjs for the core landing mechanics and the PathSet/Base stamp basics."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
