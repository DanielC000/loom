import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT OFF batch-merge-head-moved.mjs (card 3aad1cb3): carries ONLY card 95940402's own landed-COMMIT-
// identity checks — (K)/(K2a)/(K2b)/(K3)/(K4)/(L)/(L2)/(M)/(R2)/(A1)/(S1) — as opposed to the sibling
// file's worktree-REF checks (card 043d83d2's (A)/(A2)/(B)/(D)/(E)/(F)/(G)/(H)/(I)/(J)). The comment below
// is this card's own — read it as describing ONLY the scenarios that actually live in THIS file now.
//
// CARD 95940402 (named OPEN RESIDUAL in 043d83d2's own third Code Review — see its decision record's
// "OPEN RESIDUAL" paragraph): every check in the sibling file only ever compares the batch worktree's REF
// to another ref/stamp — none of them verify a landed COMMIT's own identity. A racer who substitutes a
// commit with the SAME TREE as the real landing but a DIFFERENT PARENT (or message/trailers) right after
// a candidate's own `git commit` would pass every one of the sibling file's checks (they never inspect
// the commit object itself), and would have become this candidate's own pin — carrying whatever
// `Loom-Worker-Branch:` trailer the forger planted, read by hold-release/ALREADY_MERGED detection as if
// it were genuine.
// (K)  the FIX: `landBranchCommitsIndividually` now verifies each landing commit's parent+tree (the SAME
//      `verifyCommitParentAndTree` mechanism the solo squash path's `2a6a292a` round-21
//      `verifyLandedAsOwnCommit` already uses, extracted to a shared, exported function rather than
//      duplicated) before trusting it, both right after the plain `git commit` and again at the final
//      post-loop HEAD read — refusing `batchHeadMoved` on a mismatch, same as every check in the sibling.
//
// CODE REVIEW of 95940402 (4933cb39): (K)'s parent+tree check alone does NOT catch a SAME-PARENT,
// SAME-TREE substitute whose MESSAGE carries a forged `Loom-Worker-Branch:` trailer — reproduced live
// against commit 2b5a9ebf (ok:true, canonical main landed the forged trailer) via `commit-tree -p <real
// parent>` right after the plain commit, and again right after the pathset `--amend`. THE FIX (round 2):
// `verifyCommitParentAndTree` now also returns the raw commit body; the batch path additionally verifies
// a non-tip commit carries NO `Loom-Worker-*` trailer at all, and the tip's trailer names THIS branch and
// carries the Base/PathSet THIS process actually computed (or neither, matching `pathSetStamped`) — never
// merely "a trailer is present". Residual, honestly named (inherited from 2a6a292a round 22/23, same as
// before): a commit with the CORRECT parent, tree, AND trailers, differing only in an unrelated part of
// the SUBJECT line or author identity, is still unverified — this round closes the Loom trailer forgery
// specifically, not every conceivable message forgery.
// (K2a/K2b) the plain-commit hook AND the pathset-amend hook, each substituting a same-parent/same-tree,
//      forged-trailer commit — the amend leg on the TIP, the plain-commit leg on a NON-TIP commit of a
//      multi-commit branch (the tip's own plain-commit leg is accidentally neutralized by the subsequent
//      amend overwriting its message, so a non-tip commit is the one that actually exercises this path).
// (L)  S2 — `merge-base`/the noop leg's `findLandedSquashCommit` used to resolve the literal "HEAD" at
//      call time instead of the already-pinned `batchHeadBefore`; a HEAD swap in that narrow window could
//      misclassify a genuinely new candidate as already-landed (noop), silently skipping its real commit.
// (M)  card 95940402 round 4, R3 — the same shape as (L), for the empty-stage probe instead of the
//      merge-base call.
// (K3) Second Code Review 820ce6e3 — a same-parent, same-tree substitute that keeps (K2)'s own checked
//      fields correct but adds/corrupts something ELSE in the Loom namespace.
// (K4) card 95940402 round 4, A2 — a WORKER-AUTHORED commit whose own SUBJECT line is itself a reserved
//      Loom trailer is a content defect in that worker's own commit, dropped per-candidate, never a
//      racer tamper.
// (R2) card 95940402 round 4/5, R2/F4 — a worker's own commit BODY quoting an earlier Loom trailer
//      paragraph must be STRIPPED before landing, never refused.
// (A1) card 95940402 round 4, A1 — a non-Loom project's own "loom-bridge:"-shaped line must land
//      untouched (never mistaken for Loom's reserved namespace).
// (L2) Code Review 820ce6e3 item 4 — the noop leg's OWN `findLandedSquashCommit` lookup must also resolve
//      the pinned `batchHeadBefore`, never a literal "HEAD" re-resolved at call time.
// (S1) card 95940402 round 4, R4 — `landedSubject` must be derived from the SAME verified read that
//      already produced `landedSha`, never a second, independently-steerable read of whatever HEAD
//      CURRENTLY is.
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-head-moved-commit-identity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-bmhmci-home-");

requireHermeticEnv();

const { createWorktree } = await import("../dist/git/worktrees.js");
const { runBatchedMerge, assembleBatchBranches } = await import("../dist/git/batch-merge.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmhm", GIT_AUTHOR_EMAIL: "bmhm@loom", GIT_COMMITTER_NAME: "bmhm", GIT_COMMITTER_EMAIL: "bmhm@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmhm@loom -c user.name=bmhm";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Only a plain projectId string is needed here — every scenario in this file creates its OWN throwaway
// repo (never the sibling file's shared P.repo), and `createWorktree` never looks up an actual DB row for
// this id (it's used purely for worktree-path/branch naming).
const P = { projId: `bmhm-proj-${sfx}` };

/** The batch worktree's own private HEAD file path, inside the shared .git admin area — exactly the file
 *  card 043d83d2 names (`<main>/.git/worktrees/<batch>/HEAD`). Verbatim copy of the sibling file's own
 *  helper — kept duplicated rather than shared, matching this repo's own split convention (no
 *  cross-file imports between split test files). */
function batchHeadFilePath(batchWorktreePath) {
  const rel = execSync("git rev-parse --git-path HEAD", { cwd: batchWorktreePath }).toString().trim();
  return path.isAbsolute(rel) ? rel : path.join(batchWorktreePath, rel);
}

try {
  // ── (K) card 95940402: a same-tree, DIFFERENT-PARENT commit substituted right after a candidate's own
  //     `git commit` — never caught by any check in the sibling file, since none of them inspect the
  //     landed commit's own identity. Hooks the plain `commit --author ...` call (never the pathset
  //     `--amend`) and, after letting the real commit land, swaps HEAD to a forged sibling sharing the
  //     SAME tree but parented on an unrelated commit — exactly the shape the parent-half of
  //     `verifyCommitParentAndTree` must catch. This scenario alone does NOT cover a SAME-parent,
  //     same-tree, forged-MESSAGE substitute — see (K2a) below for that distinct (and, until Code Review
  //     4933cb39, unclosed) shape.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-forge-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-forge\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "k1.txt"), "k1\n");
    commitAll(candWt, "feat(x): change k1", GIT_ID);

    // A genuinely DIFFERENT commit in the SAME object store, used purely as the forged commit's decoy
    // parent — never fast-forwarded anywhere, never a batch candidate itself.
    const decoyWt = (await createWorktree(repo, P.projId, `bmhm-k-decoy-${sfx}`)).worktreePath;
    registerForCleanup(decoyWt);
    fs.writeFileSync(path.join(decoyWt, "DECOY-PARENT.txt"), "decoy parent\n");
    commitAll(decoyWt, "chore(test): decoy parent for the forged commit", GIT_ID);
    const decoyParentSha = git(decoyWt, "rev-parse", "HEAD");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k-batch-${sfx}`);
    registerForCleanup(batchWt);

    let forged = false;
    let forgedSha;
    function commitForgeFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (!forged && Array.isArray(args) && args[0] === "commit" && args[1] === "--author") {
            forged = true;
            const tree = (await real.raw(["rev-parse", "HEAD^{tree}"])).trim();
            forgedSha = (await real.raw([
              "commit-tree", tree, "-p", decoyParentSha, "-m",
              "feat(x): forged — same tree, different parent\n\nLoom-Worker-Branch: some-other-branch\n",
            ])).trim();
            await real.raw(["update-ref", "HEAD", forgedSha]);
          }
          return out;
        },
      };
    }
    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k-w1", taskId: "bmhm-k-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: commitForgeFactory });

    check("(K) precondition: the forge actually fired", forged === true && typeof forgedSha === "string");
    check("(K) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(K) reason names the tamper/verify failure", /HEAD|tampered|verify/i.test(result.reason ?? ""));
    check("(K) the gate was NEVER invoked — caught before assembly ever hands off to it", gateInvoked === false);
    check("(K) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (K2a) Code Review 4933cb39 of card 95940402: a SAME-PARENT, SAME-TREE substitute at the pathset
  //     AMEND hook, differing only in its MESSAGE (a forged `Loom-Worker-Branch: some-other-branch`
  //     trailer) — (K) above never catches this, since parent+tree alone matches. RED on commit 2b5a9ebf.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k2a-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-k2a\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k2a-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "k2a.txt"), "k2a\n");
    commitAll(candWt, "feat(x): change k2a", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k2a-batch-${sfx}`);
    registerForCleanup(batchWt);

    let forged = false;
    let forgedSha;
    function amendForgeFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (!forged && Array.isArray(args) && args[0] === "commit" && args[1] === "--amend") {
            forged = true;
            const tree = (await real.raw(["rev-parse", "HEAD^{tree}"])).trim();
            const sameParent = (await real.raw(["rev-parse", "HEAD^"])).trim();
            forgedSha = (await real.raw([
              "commit-tree", tree, "-p", sameParent, "-m",
              "FORGED subject — same parent, same tree\n\nLoom-Worker-Branch: some-other-branch\n",
            ])).trim();
            await real.raw(["update-ref", "HEAD", forgedSha]);
          }
          return out;
        },
      };
    }
    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k2a-w1", taskId: "bmhm-k2a-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: amendForgeFactory });

    check("(K2a) precondition: the amend-hook forge actually fired", forged === true && typeof forgedSha === "string");
    check("(K2a) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(K2a) reason names the tamper/verify failure", /HEAD|tampered|verify/i.test(result.reason ?? ""));
    check("(K2a) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (K2b) Code Review 4933cb39 of card 95940402: the SAME shape as (K2a), at the PLAIN-COMMIT hook, on
  //     a NON-TIP commit of a multi-commit branch — a single-commit branch's plain-commit forge is
  //     accidentally overwritten by the tip's own later pathset amend (see the probe behind this card),
  //     so a non-tip commit is the one that actually exercises this leg. RED on commit 2b5a9ebf.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k2b-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-k2b\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k2b-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "k2b-1.txt"), "k2b-1\n");
    commitAll(candWt, "feat(x): change k2b part 1", GIT_ID);
    fs.writeFileSync(path.join(candWt, "k2b-2.txt"), "k2b-2\n");
    commitAll(candWt, "feat(x): change k2b part 2", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k2b-batch-${sfx}`);
    registerForCleanup(batchWt);

    let forged = false;
    let forgedSha;
    function nonTipForgeFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          // The FIRST plain `commit --author ...` call is the branch's NON-TIP commit (part 1) — the tip
          // (part 2) is never reached once this refuses.
          if (!forged && Array.isArray(args) && args[0] === "commit" && args[1] === "--author") {
            forged = true;
            const tree = (await real.raw(["rev-parse", "HEAD^{tree}"])).trim();
            const sameParent = (await real.raw(["rev-parse", "HEAD^"])).trim();
            forgedSha = (await real.raw([
              "commit-tree", tree, "-p", sameParent, "-m",
              "FORGED subject — non-tip, same parent/tree\n\nLoom-Worker-Branch: some-other-branch\n",
            ])).trim();
            await real.raw(["update-ref", "HEAD", forgedSha]);
          }
          return out;
        },
      };
    }
    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k2b-w1", taskId: "bmhm-k2b-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: nonTipForgeFactory });

    check("(K2b) precondition: the non-tip plain-commit forge actually fired", forged === true && typeof forgedSha === "string");
    check("(K2b) the batch refuses, typed batchHeadMoved", result.ok === false && result.batchHeadMoved === true);
    check("(K2b) reason names the tamper/verify failure", /HEAD|tampered|verify/i.test(result.reason ?? ""));
    check("(K2b) canonical main untouched", git(repo, "rev-parse", "HEAD") === baseMainSha);
  }

  // ── (L) Code Review 4933cb39 of card 95940402, S2: `merge-base`/the noop leg's `findLandedSquashCommit`
  //     used to resolve the literal "HEAD" at call time rather than the already-pinned `batchHeadBefore`.
  //     Swaps the batch worktree's HEAD to a decoy commit — one that has the REAL candidate's own tip as
  //     its OWN parent — ONLY during the `merge-base` call's own execution window, restoring the real ref
  //     immediately after: a leave-no-trace race that defeats card 043d83d2's own pre-/post-gate stamp
  //     checks (which compare the ref only AFTER assembly, never during one call). Pre-fix, resolving
  //     "HEAD" inside that window misclassifies the genuinely-new candidate as already-landed (a SILENT
  //     noop — `ok:true`, nothing committed, no refusal, no trace) and its real commit never reaches main.
  //     Post-fix, resolving the pinned `batchHeadBefore` (immune to the swap) computes the correct,
  //     non-noop merge-base and the real commit lands normally.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-l-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-l\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-l-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "l1.txt"), "l1\n");
    commitAll(candWt, "feat(x): change l1", GIT_ID);
    const candTipSha = git(candWt, "rev-parse", "HEAD");

    // The decoy: a real commit whose OWN parent is the candidate's real tip — so merge-base(decoy,
    // candTip) === candTip trivially, exactly the shape that would misclassify the candidate as noop.
    const { worktreePath: decoyWt } = await createWorktree(repo, P.projId, `bmhm-l-decoy-${sfx}`, {}, undefined, candTipSha);
    registerForCleanup(decoyWt);
    fs.writeFileSync(path.join(decoyWt, "DECOY-WRAP.txt"), "decoy wraps the real tip\n");
    commitAll(decoyWt, "chore(test): decoy wraps the real candidate tip as its own parent", GIT_ID);
    const decoySha = git(decoyWt, "rev-parse", "HEAD");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-l-batch-${sfx}`);
    registerForCleanup(batchWt);

    // The swap is visible ONLY during the merge-base call's own execution window — restored to the real,
    // correct ref (`batchHeadBefore`, here `baseMainSha`) before anything else reads it, exactly the
    // leave-no-trace shape a real racer would use, and the shape that defeats the pre/post-gate STAMP
    // checks from card 043d83d2 (which compare the ref AFTER assembly, not during this one call).
    // `assembleBatchBranches`'s own sort step ALSO issues a `merge-base` call (already-resolved shas, to
    // order candidates by author date) BEFORE `landBranchCommitsIndividually` is ever reached for this
    // candidate — count occurrences and target the SECOND one (the real, vulnerable call) rather than the
    // first, so this test fires at the same call regardless of whether its 2nd argument is the literal
    // "HEAD" (pre-fix) or the pinned `batchHeadBefore` (post-fix, where matching on "HEAD" would never
    // fire at all).
    let swapped = false;
    let mergeBaseCalls = 0;
    function mergeBaseSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args[0] === "merge-base") {
            mergeBaseCalls++;
            if (!swapped && mergeBaseCalls === 2) {
              swapped = true;
              fs.writeFileSync(batchHeadFilePath(repoPath), `${decoySha}\n`);
              const out = await real.raw(args);
              fs.writeFileSync(batchHeadFilePath(repoPath), `${baseMainSha}\n`);
              return out;
            }
          }
          return real.raw(args);
        },
      };
    }
    let gateInvoked = false;
    const passGate = async () => { gateInvoked = true; return { passed: true }; };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-l-w1", taskId: "bmhm-l-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: mergeBaseSwapFactory });

    check("(L) precondition: the merge-base-time HEAD swap actually fired", swapped === true);
    check("(L) the candidate's real, brand-new commit actually lands — NEVER silently vanishes as a misclassified noop", result.ok === true && result.landed.length === 1 && result.landed[0]?.noop !== true);
    check("(L) canonical main advanced to the real candidate's content, not left at baseMainSha", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "l1.txt")));
  }

  // ── (M) card 95940402 round 4, R3 — the empty-stage probe (`git diff --cached --name-only
  //     <expectedParentForThisCommit>`) must compare the staged index against the PINNED expected parent,
  //     never an implicit `HEAD` re-resolved at call time (mutation M6 — reverting the pin to a bare
  //     `["diff", "--cached", "--name-only"]` — currently SURVIVES every other test in this file). Swaps
  //     the batch worktree's HEAD to the CANDIDATE'S OWN TIP (whose tree is exactly what gets staged once
  //     it's cherry-picked) for ONLY this one call's own execution window, restoring the real ref
  //     immediately after — a leave-no-trace race mirroring (L)'s own merge-base swap. Resolving implicit
  //     "HEAD" here would see ZERO diff against that swapped ref and WRONGLY misclassify a genuinely NEW,
  //     non-redundant commit as already-landed (an empty-commit drop) — the worst outcome this probe
  //     exists to prevent (real work silently dropped, not merely refused). Pinning
  //     `expectedParentForThisCommit` is immune to the swap, since it was captured BEFORE the swap could
  //     ever fire.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-m-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-m\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-m-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "m1.txt"), "m1\n");
    commitAll(candWt, "feat(x): change m1", GIT_ID);
    const candTipSha = git(candWt, "rev-parse", "HEAD");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-m-batch-${sfx}`);
    registerForCleanup(batchWt);

    let swapped = false;
    function probeSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (!swapped && Array.isArray(args) && args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") {
            swapped = true;
            fs.writeFileSync(batchHeadFilePath(repoPath), `${candTipSha}\n`);
            const out = await real.raw(args);
            fs.writeFileSync(batchHeadFilePath(repoPath), `${baseMainSha}\n`);
            return out;
          }
          return real.raw(args);
        },
      };
    }
    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-m-w1", taskId: "bmhm-m-t1", branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: probeSwapFactory });

    check("(M) precondition: the empty-stage probe's own HEAD swap actually fired", swapped === true);
    check("(M) the candidate's real, non-redundant commit lands — NEVER misclassified as already-present because of the swap",
      result.ok === true && result.landed.length === 1 && result.landed[0]?.noop !== true);
    check("(M) canonical main advanced to the real candidate's content", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "m1.txt")));
  }

  // ── (K3) Second Code Review 820ce6e3 of card 95940402: a same-parent, same-tree substitute that keeps
  //     (K2)'s own checked fields correct but adds/corrupts something ELSE in the Loom namespace — a
  //     duplicate `Loom-Worker-Branch:`, a lowercase case variant, a `Loom-Landed-Tip:` (which a batch
  //     tip must NEVER carry), a forged line hidden in an EARLIER paragraph, or a Loom-namespace line on
  //     a NON-TIP commit. None of these are visible to a check built from parseLoomTrailerBlock's own
  //     already-resolved fields (duplicate: the LAST match wins, so the real branch still reads back
  //     correctly; hidden: parseLoomTrailerBlock only ever reads the FINAL paragraph). RED on commit
  //     1d5cb0de (confirmed via the same capture-patch/revert/rebuild/restore cycle as (K)/(K2)); GREEN
  //     on this round's `verifyLoomNamespaceExact` fix. `extra-foreign` is the sibling POSITIVE control:
  //     a real (non-Loom) trailer, e.g. from a user's own commit-msg hook, must still land untouched.
  for (const m of [
    { tag: "landedtip", atTip: true, build: (real) => `${real}\nLoom-Landed-Tip: ${"a".repeat(40)}\n` },
    { tag: "dup", atTip: true, build: (real, br) => real.replace(`Loom-Worker-Branch: ${br}`, `Loom-Worker-Branch: some-other-branch\nLoom-Worker-Branch: ${br}`) + "\n" },
    { tag: "lower", atTip: true, build: (real) => `${real}\nloom-worker-branch: some-other-branch\n` },
    { tag: "hidden", atTip: true, build: (real) => { const [subj, ...rest] = real.split("\n"); return `${subj}\n\nLoom-Worker-Branch: some-other-branch\n${rest.join("\n")}\n`; } },
    { tag: "extra-foreign", atTip: true, build: (real) => `${real}\nReviewed-by: forger\n`, expectLands: true },
    { tag: "nontip-loom", atTip: false, build: (real) => `${real}\n\nLoom-Worker-Base: ${"b".repeat(40)}\nLoom-Worker-PathSet: deadbeef\n` },
    // @decision 95940402 (round 4, R1, Code Review a399cb11) — the namespace audit alone could report
    // "exact" while `parseLoomTrailerBlock` (the reader every mainline consumer actually uses) still
    // returned null — each mode below corrupts a line `scanLoomNamespaceLines`'s narrower reserved-key
    // match never sees (so the exact-set check stays "exact"), while breaking the READER's own per-line
    // `key: value` requirement for the WHOLE final paragraph. RED on beb12b93 (pre-round-4), GREEN on
    // `verifyLoomTrailersExactAndReadable`'s reader round-trip (this detects the `"unreadable"` KIND;
    // card 45036494 later changed what the batch path DOES with that kind — see `expectUnreadable`'s
    // own branch below, no longer an abort).
    { tag: "prose-in-trailer", atTip: true, build: (real) => `${real}\n[skip ci]`, expectUnreadable: true },
    { tag: "continuation", atTip: true, build: (real) => `${real}\n    (continued from the digest above)`, expectUnreadable: true },
    { tag: "zw-landedtip", atTip: true, build: (real) => `${real}\n​Loom-Landed-Tip: ${"a".repeat(40)}`, expectUnreadable: true },
  ]) {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k3-${m.tag}-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), `# bmhm-k3-${m.tag}\n`);
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k3-${m.tag}-c1-${sfx}`);
    registerForCleanup(candWt);
    if (!m.atTip) {
      // A non-tip commit needs a SECOND commit after it (the real tip) so it is genuinely non-tip.
      fs.writeFileSync(path.join(candWt, "k3nt.txt"), "k3nt\n");
      commitAll(candWt, "feat(x): change k3 non-tip part", GIT_ID);
    }
    fs.writeFileSync(path.join(candWt, `k3-${m.tag}.txt`), `${m.tag}\n`);
    commitAll(candWt, `feat(x): change k3 ${m.tag}`, GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k3-${m.tag}-batch-${sfx}`);
    registerForCleanup(batchWt);

    let forged = false;
    function forgeFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          const hit = m.atTip
            ? (Array.isArray(args) && args[0] === "commit" && args[1] === "--amend")
            : (Array.isArray(args) && args[0] === "commit" && args[1] === "--author");
          if (!forged && hit) {
            forged = true;
            const tree = (await real.raw(["rev-parse", "HEAD^{tree}"])).trim();
            const par = (await real.raw(["rev-parse", "HEAD^"])).trim();
            const realMsg = (await real.raw(["log", "-1", "--format=%B", "HEAD"])).replace(/\s+$/, "");
            const msg = m.build(realMsg, candBranch);
            const forgedSha = (await real.raw(["commit-tree", tree, "-p", par, "-m", msg])).trim();
            await real.raw(["update-ref", "HEAD", forgedSha]);
          }
          return out;
        },
      };
    }
    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: `bmhm-k3-${m.tag}-w1`, taskId: `bmhm-k3-${m.tag}-t1`, branch: candBranch, cutBaseSha: null },
    ], passGate, { gitFactory: forgeFactory });

    check(`(K3 ${m.tag}) precondition: the forge actually fired`, forged === true);
    if (m.expectLands) {
      check(`(K3 ${m.tag}) a foreign (non-Loom) trailer STILL lands untouched`, result.ok === true);
      check(`(K3 ${m.tag}) canonical main advanced`, git(repo, "rev-parse", "HEAD") !== baseMainSha);
    } else if (m.expectUnreadable) {
      // @decision 45036494 — card 45036494 made "unreadable" kept-VERIFIED (never aborted), mirroring the
      // solo path's own f224632d M1 ruling: only a genuine "forged" namespace mismatch still aborts.
      check(`(K3 ${m.tag}) THE RULING (card 45036494): the batch now LANDS kept-VERIFIED, never aborted`, result.ok === true);
      check(`(K3 ${m.tag}) the landed candidate carries trailerAdvisory "unreadable"`, result.landed?.[0]?.trailerAdvisory === "unreadable");
      check(`(K3 ${m.tag}) canonical main advanced with it`, git(repo, "rev-parse", "HEAD") !== baseMainSha);
    } else {
      check(`(K3 ${m.tag}) the batch refuses, typed batchHeadMoved`, result.ok === false && result.batchHeadMoved === true);
      check(`(K3 ${m.tag}) canonical main untouched`, git(repo, "rev-parse", "HEAD") === baseMainSha);
    }
  }

  // ── (K4) card 95940402 round 4, A2 — a WORKER-AUTHORED commit whose own SUBJECT line is itself a
  //     reserved Loom trailer ("Loom-Worker-Branch: other-branch") is a content defect in that worker's
  //     own commit, not a racer's tamper — it must drop ONLY that candidate, before anything is
  //     committed, and let the REST of the batch land normally. Letting it reach the post-commit
  //     `verifyLoomTrailersExactAndReadable` check instead would refuse `batchHeadMoved`, which
  //     `assembleBatchBranches` propagates as a full-batch abort with NO per-candidate fallback — the
  //     wrong remedy here. A second, well-formed candidate in the SAME batch proves the drop is scoped.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k4-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-k4\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, P.projId, `bmhm-k4-good-${sfx}`);
    registerForCleanup(goodWt);
    fs.writeFileSync(path.join(goodWt, "k4-good.txt"), "good\n");
    commitAll(goodWt, "feat(x): change k4 good", GIT_ID);

    const { worktreePath: evilWt, branch: evilBranch } = await createWorktree(repo, P.projId, `bmhm-k4-evil-${sfx}`);
    registerForCleanup(evilWt);
    fs.writeFileSync(path.join(evilWt, "k4-evil.txt"), "evil\n");
    // The commit's own SUBJECT (line 0) is itself a reserved Loom trailer line — `commitAll` here is the
    // worker's OWN commit, not Loom's; nothing downstream strips line 0 (stripReservedLoomTrailerLines
    // deliberately never touches it).
    commitAll(evilWt, `Loom-Worker-Branch: ${evilBranch}`, GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k4-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k4-good-w1", taskId: "bmhm-k4-good-t1", branch: goodBranch, cutBaseSha: null },
      { workerSessionId: "bmhm-k4-evil-w1", taskId: "bmhm-k4-evil-t1", branch: evilBranch, cutBaseSha: null },
    ], passGate);

    check("(K4) the batch still SUCCEEDS overall — a worker-authored defect is NOT a racer tamper", result.ok === true);
    check("(K4) the good candidate LANDED", result.landed.some((l) => l.branch === goodBranch));
    check("(K4) the evil candidate was DROPPED, never landed",
      !result.landed.some((l) => l.branch === evilBranch) && result.dropped.some((d) => d.branch === evilBranch));
    check("(K4) the drop reason names the reserved-subject defect, not a generic tamper",
      /reserved Loom trailer line/i.test(result.dropped.find((d) => d.branch === evilBranch)?.reason ?? ""));
    check("(K4) canonical main advanced with the good candidate's own content",
      git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "k4-good.txt")));
    check("(K4) the evil candidate's content did NOT land", !fs.existsSync(path.join(repo, "k4-evil.txt")));
  }

  // ── (R2) card 95940402 round 4/5, R2/F4 — a worker's own commit BODY quoting an EARLIER
  //     `Loom-Worker-Branch:` paragraph (the real 5e323196/6cc1333f shape — reproduced here via a
  //     multi-`-m` commit, which git joins as its own paragraph) must be STRIPPED before landing, never
  //     refused — Loom is about to overwrite that namespace anyway. The branch has TWO commits (round 5,
  //     F4): the quoted line sits in the NON-TIP commit specifically, so a regression that strips only
  //     the LAST commit (plausible, since the trailer-stamping logic itself IS tip-only) goes RED here.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-r2-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-r2\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-r2-c1-${sfx}`);
    registerForCleanup(candWt);
    // NON-TIP commit: its own body quotes the stale paragraph.
    fs.writeFileSync(path.join(candWt, "r2-nontip.txt"), "r2 nontip\n");
    commitAll(candWt, ["feat(x): change r2 nontip", "Loom-Worker-Branch: some-other-branch"], GIT_ID);
    // TIP commit: ordinary, carries no reserved line of its own.
    fs.writeFileSync(path.join(candWt, "r2.txt"), "r2\n");
    commitAll(candWt, "feat(x): change r2 tip", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-r2-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-r2-w1", taskId: "bmhm-r2-t1", branch: candBranch, cutBaseSha: null },
    ], passGate);

    check("(R2) the batch lands — a worker's own reserved line in the body is STRIPPED, never refused", result.ok === true && result.landed.length === 1);
    check("(R2) strippedReservedLineCount is non-zero and visible to the caller", (result.landed[0]?.strippedReservedLineCount ?? 0) > 0);
    const landedBody = result.landed[0]?.sha ? git(repo, "log", "-1", "--format=%B", result.landed[0].sha) : "";
    check("(R2) exactly ONE Loom-Worker-Branch line survives in the TIP's landed message",
      landedBody.split("\n").filter((l) => /^Loom-Worker-Branch:/i.test(l)).length === 1);
    check("(R2) the ONE remaining line names THIS branch, never the stale quoted value", landedBody.includes(`Loom-Worker-Branch: ${candBranch}`));
    const landedRange = result.landed[0]?.sha ? git(repo, "log", "--format=%H", `${baseMainSha}..${result.landed[0].sha}`).split("\n").filter(Boolean) : [];
    check("(R2 F4) both commits landed (non-tip + tip)", landedRange.length === 2);
    const nonTipSha = landedRange[1]; // `log` is newest-first; the older, non-tip commit is second.
    const nonTipBody = nonTipSha ? git(repo, "log", "-1", "--format=%B", nonTipSha) : "";
    check("(R2 F4) the NON-TIP commit's own quoted reserved line is ALSO stripped, not just the tip's", !/Loom-Worker-Branch/i.test(nonTipBody));
    check("(R2) canonical main advanced", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "r2.txt")) && fs.existsSync(path.join(repo, "r2-nontip.txt")));
  }

  // ── (A1) card 95940402 round 4, A1 — a non-Loom project's own "loom-bridge:"-shaped line, as either a
  //     NON-TIP commit's own SUBJECT or a TIP commit's own BODY line, must land completely untouched —
  //     neither is in Loom's RESERVED namespace, so neither the strip nor the exact-set scanner may see
  //     it (round 3's own broader "any loom-*" match would have refused this).
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-a1-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-a1\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-a1-c1-${sfx}`);
    registerForCleanup(candWt);
    // Non-tip commit: the SUBJECT itself reads "loom-bridge: fix crash" — a legitimate, unreserved use.
    fs.writeFileSync(path.join(candWt, "a1-nontip.txt"), "a1 nontip\n");
    commitAll(candWt, "loom-bridge: fix crash", GIT_ID);
    // Tip commit: a BODY line also reads "loom-cli: do a thing" — equally legitimate and unreserved.
    fs.writeFileSync(path.join(candWt, "a1-tip.txt"), "a1 tip\n");
    commitAll(candWt, ["feat(x): change a1 tip", "loom-cli: do a thing"], GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-a1-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-a1-w1", taskId: "bmhm-a1-t1", branch: candBranch, cutBaseSha: null },
    ], passGate);

    check("(A1) the batch lands — neither a non-tip 'loom-bridge:' subject nor a tip 'loom-cli:' body line trips the scanner", result.ok === true && result.landed.length === 1);
    check("(A1) nothing was stripped — both lines are UNRESERVED, never touched", (result.landed[0]?.strippedReservedLineCount ?? 0) === 0);
    check("(A1) the non-tip commit's subject survives verbatim", git(repo, "log", "--format=%s", `${baseMainSha}..HEAD`).includes("loom-bridge: fix crash"));
    const tipBody = result.landed[0]?.sha ? git(repo, "log", "-1", "--format=%B", result.landed[0].sha) : "";
    check("(A1) the tip commit's body line survives verbatim", tipBody.includes("loom-cli: do a thing"));
    check("(A1) canonical main advanced", git(repo, "rev-parse", "HEAD") !== baseMainSha);
  }

  // ── (K3 hook-paragraph) same Code Review, item 3: a hook appending a NON-trailer paragraph AFTER
  //     Loom's own, otherwise-intact trailer paragraph — "displaced". @decision 45036494 — card 45036494
  //     made this kept-VERIFIED (never aborted), mirroring the solo path's own f224632d M1 ruling; Loom's
  //     trailers are unmolested, just no longer the message's final paragraph, so discovery-time readers
  //     need the separate tolerant reader to find it again, but the LANDING itself is never refused.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-k3-hookpara-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-k3-hookpara\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const hooksDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "commit-msg"), "#!/bin/sh\nprintf '\\n[ci skip]\\n' >> \"$1\"\n");
    fs.chmodSync(path.join(hooksDir, "commit-msg"), 0o755);

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-k3-hookpara-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "hookpara.txt"), "hookpara\n");
    commitAll(candWt, "feat(x): change hookpara", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-k3-hookpara-batch-${sfx}`);
    registerForCleanup(batchWt);

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmhm-k3-hookpara-w1", taskId: "bmhm-k3-hookpara-t1", branch: candBranch, cutBaseSha: null },
    ], async () => ({ passed: true }));

    check("(K3 hookpara) THE RULING (card 45036494): the batch LANDS kept-VERIFIED, never aborted", result.ok === true);
    check("(K3 hookpara) the landed candidate carries trailerAdvisory \"displaced\"", result.landed?.[0]?.trailerAdvisory === "displaced");
    check("(K3 hookpara) canonical main advanced with it", git(repo, "rev-parse", "HEAD") !== baseMainSha);
  }

  // ── (L2) Code Review 820ce6e3 item 4: the noop leg's OWN `findLandedSquashCommit` lookup (never the
  //     `merge-base` call (L) already covers) must also resolve the pinned `batchHeadBefore`, never a
  //     literal "HEAD" re-resolved at call time. Lands a candidate for REAL first (so re-submitting it
  //     is a GENUINE noop, not a forced one), then re-runs the SAME branch; a HEAD swap scoped to ONLY
  //     that lookup's own `git log --grep=...` call (restored immediately after) points it at a decoy
  //     carrying a FORGED `Loom-Worker-Branch:` trailer for this branch — with the call pinned to
  //     `batchHeadBefore` (the fix), the swap has no effect and the REAL landed sha is still reported.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-l2-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-l2\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const base0 = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-l2-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "l2.txt"), "l2\n");
    commitAll(candWt, "feat(x): change l2", GIT_ID);

    // First, REAL landing — this is what makes the re-submit below a genuine noop.
    const { worktreePath: firstBatchWt } = await createWorktree(repo, P.projId, `bmhm-l2-batch1-${sfx}`);
    registerForCleanup(firstBatchWt);
    const firstResult = await runBatchedMerge(repo, firstBatchWt, base0, [
      { workerSessionId: "bmhm-l2-w0", taskId: "bmhm-l2-t0", branch: candBranch, cutBaseSha: null },
    ], async () => ({ passed: true }));
    check("(L2) precondition: the first (real) landing succeeds", firstResult.ok === true);
    const realLandedSha = firstResult.landed[0]?.sha;
    const batchHeadBefore2 = git(repo, "rev-parse", "HEAD");
    check("(L2) precondition: canonical advanced past base0 after the first landing", batchHeadBefore2 !== base0);

    // Force the candidate's OWN branch ref back onto its pre-land fork point (base0, a PROPER ancestor
    // of the real landing — mirrors batch-merge-robustness.mjs's own (9b) setup exactly) so re-submitting
    // it below is a GENUINE noop, not one forced by a tamper. A branch checked out in a worktree can't be
    // force-moved, so the candidate's own worktree is removed first.
    execFileSync("git", ["worktree", "remove", "--force", candWt], { cwd: repo });
    git(repo, "branch", "-f", candBranch, base0);
    check("(L2) precondition: the candidate's branch ref is now a proper ancestor of the real landing", git(repo, "rev-parse", candBranch) === base0);

    // The decoy: a real commit, cut from base0 (NOT an ancestor of the real landing), carrying a FORGED
    // trailer naming this SAME branch — a misclassifying lookup would report THIS sha instead.
    const { worktreePath: decoyWt } = await createWorktree(repo, P.projId, `bmhm-l2-decoy-${sfx}`, {}, undefined, base0);
    registerForCleanup(decoyWt);
    fs.writeFileSync(path.join(decoyWt, "DECOY-L2.txt"), "decoy l2\n");
    git(decoyWt, "add", "-A"); git(decoyWt, "commit", "-qm", `chore(test): decoy with a forged trailer\n\nLoom-Worker-Branch: ${candBranch}\n`, "--author", "bmhm <bmhm@loom>");
    const decoySha = git(decoyWt, "rev-parse", "HEAD");

    const { worktreePath: secondBatchWt } = await createWorktree(repo, P.projId, `bmhm-l2-batch2-${sfx}`);
    registerForCleanup(secondBatchWt);

    let swapped = false;
    function findLandedSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const isFindLandedLog = Array.isArray(args) && args[0] === "log" &&
            args.some((a) => typeof a === "string" && a.startsWith("--grep=Loom-Worker-Branch"));
          if (!swapped && isFindLandedLog) {
            swapped = true;
            fs.writeFileSync(batchHeadFilePath(repoPath), `${decoySha}\n`);
            const out = await real.raw(args);
            fs.writeFileSync(batchHeadFilePath(repoPath), `${batchHeadBefore2}\n`);
            return out;
          }
          return real.raw(args);
        },
      };
    }
    const secondResult = await runBatchedMerge(repo, secondBatchWt, batchHeadBefore2, [
      { workerSessionId: "bmhm-l2-w1", taskId: "bmhm-l2-t1", branch: candBranch, cutBaseSha: null },
    ], async () => ({ passed: true }), { gitFactory: findLandedSwapFactory });

    check("(L2) precondition: the findLandedSquashCommit-time swap actually fired", swapped === true);
    check("(L2) re-submitting the now-landed branch is classified a noop", secondResult.ok === true && secondResult.landed[0]?.noop === true);
    check("(L2) the noop reports the REAL landed sha — NEVER the decoy's forged-trailer sha", secondResult.landed[0]?.sha === realLandedSha && secondResult.landed[0]?.sha !== decoySha);
  }

  // ── (S1) card 95940402 round 4, R4 — BEHAVIOURAL replacement for the old structural argv check
  //     (Code Review 820ce6e3 item 4): `landedSubject` must be derived from the SAME verified read that
  //     already produced `landedSha`, never a second, independently-steerable read of whatever HEAD
  //     CURRENTLY is. Rather than assert a specific call shape never fires (a structural guard easy to
  //     satisfy by accident while still reading the wrong ref some OTHER way), swap the batch worktree's
  //     HEAD to a DECOY commit (same parent, DIFFERENT subject) immediately AFTER the `rev-parse HEAD`
  //     call that captures `landedSha`, and leave it swapped — never restored. Calls
  //     `assembleBatchBranches` DIRECTLY (not `runBatchedMerge`) so this is isolated from card 043d83d2's
  //     own, unrelated pre-/post-gate stamp check, which would otherwise ALSO trip on the same swap for a
  //     completely different reason and make the result ambiguous.
  //     Call-count note (corrected, 4th Code Review 89193398): `landBranchCommitsIndividually` has FIVE
  //     bare `["rev-parse","HEAD"]` call SITES total (:371 batchHeadBefore, :553 the rollback cleanliness
  //     probe, :752 the per-commit post-commit verify, :844 the post-amend-failure recovery probe, :877
  //     this one/landedSha) — the question "how many fire" is a DIFFERENT, scenario-dependent question
  //     from "how many sites exist": for this exact single-candidate, single-commit, no-`baseMainSha`,
  //     no-rollback, amend-succeeds happy path, only 4 of the 5 actually execute (the rollback probe and
  //     the post-amend-failure read never fire) — `assembleBatchBranches`'s own initial read, then those
  //     4, giving the bare call count THIS factory sees. Re-derive both numbers from the real source
  //     before trusting either if this test ever goes unexpectedly RED.
  {
    const repo = path.join(os.tmpdir(), `loom-bmhm-s1-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmhm-s1\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmhm@loom"); git(repo, "config", "user.name", "bmhm");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: candWt, branch: candBranch } = await createWorktree(repo, P.projId, `bmhm-s1-c1-${sfx}`);
    registerForCleanup(candWt);
    fs.writeFileSync(path.join(candWt, "s1.txt"), "s1\n");
    commitAll(candWt, "feat(x): change s1", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmhm-s1-batch-${sfx}`);
    registerForCleanup(batchWt);

    let revParseHeadCalls = 0;
    let swapped = false;
    let realLandedSha;
    const DECOY_SUBJECT = "chore(test): decoy subject, never reported";
    function postRevParseSwapFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          const out = await real.raw(args);
          if (Array.isArray(args) && args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
            revParseHeadCalls++;
            if (!swapped && revParseHeadCalls === 4) {
              swapped = true;
              realLandedSha = out.trim();
              const tree = (await real.raw(["rev-parse", `${realLandedSha}^{tree}`])).trim();
              const par = (await real.raw(["rev-parse", `${realLandedSha}^`])).trim();
              const decoySha = (await real.raw(["commit-tree", tree, "-p", par, "-m", DECOY_SUBJECT])).trim();
              await real.raw(["update-ref", "HEAD", decoySha]);
            }
          }
          return out;
        },
      };
    }
    const assembled = await assembleBatchBranches(repo, batchWt, [
      { workerSessionId: "bmhm-s1-w1", taskId: "bmhm-s1-t1", branch: candBranch, cutBaseSha: null },
    ], { gitFactory: postRevParseSwapFactory });

    check("(S1) precondition: the post-rev-parse HEAD swap actually fired", swapped === true);
    check("(S1) the branch still landed", assembled.landed.length === 1);
    check("(S1) landed[].sha is the REAL landed commit, never the decoy", assembled.landed[0]?.sha === realLandedSha);
    check("(S1) landed[].subject still describes the REAL landedSha, never the decoy's subject",
      assembled.landed[0]?.subject === git(repo, "log", "-1", "--format=%s", realLandedSha) &&
      assembled.landed[0]?.subject !== DECOY_SUBJECT);
  }
} finally {
  // no shared canonical repo to restore here (unlike the sibling file) — every scenario above creates its
  // OWN throwaway `repo`, registered for cleanup individually.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a same-tree, different-parent commit substituted right after a candidate's own commit refuses as batchHeadMoved, and so does a same-parent/same-tree, forged-trailer substitute at either the plain-commit or pathset-amend hook (tip and non-tip); a merge-base-time or empty-stage-probe-time HEAD swap that would otherwise misclassify a genuinely new candidate as an already-landed noop is caught; a worker-authored reserved-subject defect drops only that candidate; a worker's own stale/quoted reserved trailer line is stripped, never refused; a non-Loom project's own unreserved loom-shaped line lands untouched; a hook-appended non-trailer paragraph (and every other unreadable/displaced K3 shape) lands kept-VERIFIED with its own trailerAdvisory, never aborted (card 45036494); the noop leg's OWN findLandedSquashCommit lookup resolves the pinned batchHeadBefore, immune to a HEAD swap; and landedSubject is derived from the same verified read as landedSha, never a second, independently-steerable one (card 95940402, split from batch-merge-head-moved.mjs by card 3aad1cb3)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
