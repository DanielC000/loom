import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH MERGE GATE — ROBUSTNESS/EDGE CASES, PART 2 (card dbc6f660 — gate N ready branches once; card 6801c0a1 —
// land each branch's OWN commits INDIVIDUALLY, never squashed, only the branch's LAST commit carrying
// the Loom-Worker-Branch trailer — see git/batch-merge.ts's own header doc for the full correction).
// REAL git on temp repos, no claude, no live daemon, no Db/SessionService — fully exercised with a fake `runGate`.
//
// SPLIT OFF batch-merge-robustness.mjs (card 4e8e2d82): that file ran 92-117s (max pass 116,925ms, 3 SIGTERM
// kills at the 120s per-file ceiling; itself already split once from batch-merge.mjs by card b5af744d).
// Scenarios (10)-(noop) moved here verbatim; (7d)/(7e)/(8)/(9)/(9b) stay in the sibling file.
//
// Proves:
//   (10) EMPTY-COMMIT FAIL-CLOSED (card 43a9182d) — a stale/already-landed branch resubmitted after
//        another candidate has already contributed a genuinely-new commit this run is dropped, not
//        silently reported as landed while corrupting the other candidate's commit.
//   (11) REDUNDANT COMMIT INSIDE A MULTI-COMMIT BRANCH (card 2eb78eb2) — a branch with a genuinely new
//        FIRST commit and a redundant (already-landed-elsewhere) SECOND commit is dropped wholesale with a
//        reason naming the redundancy, never the generic "commit failed" text the empty-stage manual
//        `git commit` could otherwise surface. (11b) is the MOCK-forced variant that actually goes RED
//        against a revert of this card's own fix.
//   (12) SORT BY EARLIEST AUTHOR DATE (card 4763432b) — landing order follows each branch's earliest
//        author date, not array order, with a multi-commit branch's own commits still landing
//        contiguously and only its tip carrying the trailer.
//   fastForwardCanonicalMain: a no-op batch (nothing landed on top) is a safe success, not a refusal.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-robustness-redundancy.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// Card aac489a2: this file calls the REAL production createWorktree() (imported below), which resolves
// WORKTREES_DIR as a SIBLING of LOOM_HOME (paths.ts) — a bare `node batch-merge-robustness-redundancy.mjs` run with
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
  // ── (10) EMPTY-COMMIT FAIL-CLOSED (card 43a9182d) — a MULTI-CANDIDATE batch where a stale/already-landed
  //     branch is RESUBMITTED (its own original, pre-land ref never reset/deleted) AFTER another candidate
  //     has already contributed a genuinely-new commit THIS run. Pre-fix, the stale branch's cherry-pick
  //     lands on a clean index (its content is already present, having been landed under different SHAs by
  //     an earlier batch) — `git commit` resolves "nothing to commit" rather than rejecting, so no new
  //     commit is created, and control fell through to the tip-only Loom-Worker-Base/PathSet amend, which
  //     unconditionally amended WHATEVER HEAD currently was — silently rewriting the OTHER candidate's own
  //     real, brand-new commit with the stale branch's message/trailers. Fixed: the manual commit step now
  //     asserts HEAD actually moved and fails closed (drop + rollback) when it didn't. ─────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-emptycommit-${sfx}`);
    makeRepo(repo);

    // B lands ALONE first, in its own batch — this is the "already-batch-landed branch" whose ref is left
    // intact afterward (mirrors the real scenario: resubmitted before the ref is deleted).
    const b = await cutBranch(repo, "ec-stale-b", "ec-stale-b.txt", "stale content\n");
    const baseMainSha1 = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt1 } = await createWorktree(repo, projId, `bm-batch-ec1-${sfx}`);
    const first = await runBatchedMerge(repo, batchWt1, baseMainSha1, [b], passGate);
    check("(10) precondition: B's first (solo) landing succeeds", first.ok === true && first.landed.length === 1);
    const baseMainSha2 = git(repo, "rev-parse HEAD");

    // A is a genuinely NEW branch, cut from main's CURRENT tip — i.e. AFTER B already landed, so A's own
    // tree already contains B's content too (exactly as a real worker branch cut post-landing would).
    const a = await cutBranch(repo, "ec-new-a", "ec-new-a.txt", "new content\n");

    // Second batch: [A, B_stale] IN THAT ORDER — A lands first (a real new commit), then B is resubmitted
    // via its ORIGINAL (pre-land) branch ref. B's content is already present in the tree A was cut from,
    // so B's cherry-pick applies cleanly with an EMPTY diff — the exact precondition for the defect.
    const { worktreePath: batchWt2 } = await createWorktree(repo, projId, `bm-batch-ec2-${sfx}`);
    const assembled = await assembleBatchBranches(batchWt2, [a, b]);

    // THE DISCRIMINATING ASSERTIONS — these FAIL against pre-fix code, which reports B as landed (ok:true,
    // noop:undefined, a fabricated sha/subject) and silently corrupts A's commit in the process.
    check("(10) A lands normally", assembled.landed.length === 1 && assembled.landed[0]?.branch === a.branch);
    check("(10) B is DROPPED (fails closed), not silently reported as landed", assembled.dropped.length === 1 && assembled.dropped[0]?.branch === b.branch);
    check("(10) B's drop reason names the empty commit", !!assembled.dropped[0]?.reason.includes("empty commit"));

    // A's own commit must be COMPLETELY untouched: same sha, same trailer, reachable, and batch worktree
    // HEAD sitting exactly there (rollback reset the failed B attempt back to it, not left in some other state).
    const headAfter = git(batchWt2, "rev-parse HEAD");
    check("(10) batch worktree HEAD is exactly A's landed sha (rollback restored it, nothing left dangling)",
      headAfter === assembled.landed[0].sha);
    const headBody = git(batchWt2, "log -1 --format=%B");
    check("(10) HEAD still carries A's OWN Loom-Worker-Branch trailer", headBody.includes(`Loom-Worker-Branch: ${a.branch}`));
    check("(10) HEAD does NOT carry B's trailer (no corruption)", !headBody.includes(`Loom-Worker-Branch: ${b.branch}`));
    check("(10) batch worktree is clean post-rollback (no lingering cherry-pick/index state)",
      git(batchWt2, "status --porcelain") === "");

    // The fast-forward must land ONLY A's genuine commit — exactly 1 new commit on canonical main, correctly
    // attributed, never a rewritten sibling carrying B's identity.
    const ff = await fastForwardCanonicalMain(repo, baseMainSha2, headAfter);
    check("(10) fast-forward to A's real commit succeeds", ff.ok === true);
    check("(10) canonical main gained exactly 1 new commit (A's — B was dropped, not landed)",
      git(repo, `rev-list --count ${baseMainSha2}..HEAD`) === "1");
    check("(10) canonical main's new tip carries A's trailer, not B's",
      git(repo, "log -1 --format=%B").includes(`Loom-Worker-Branch: ${a.branch}`) &&
      !git(repo, "log -1 --format=%B").includes(`Loom-Worker-Branch: ${b.branch}`));
    check("(10) ec-new-a.txt landed on canonical main", fs.existsSync(path.join(repo, "ec-new-a.txt")));
  }

  // ── (11) REDUNDANT COMMIT INSIDE A MULTI-COMMIT BRANCH (card 2eb78eb2) — the `mergeBase === branchTip`
  //     noop check (untouched by this card, per its own DoD-4) only catches a WHOLE branch already landed.
  //     It does NOT catch ONE redundant commit inside an otherwise-new multi-commit branch: `mixed` below
  //     has a genuinely NEW first commit and a SECOND commit whose content `shared` already landed
  //     independently (both branches created the same file with the same content). THIS IS AN END-TO-END
  //     OUTCOME GUARD, NOT A POSITIVE CONTROL FOR THE PROBE: in THIS environment (this repo's installed
  //     simple-git/git-for-windows combo) the manual `git commit` for that second (empty-stage) commit
  //     RESOLVES rather than rejects, so the pre-existing `newHead === currentHead` fail-closed check
  //     (card 43a9182d) already classifies it with a redundancy-naming reason on its own, regardless of
  //     this card's fix — this block is green both pre- and post-fix HERE and never actually exercises
  //     the old generic catch. It still earns its place: it proves the branch drops wholesale with a
  //     redundancy-naming reason, end to end. THE DISCRIMINATING CASE — the one that actually goes RED
  //     without this card's empty-stage probe — is (11b) below, which force-rejects the manual commit via
  //     a mock to reproduce the pre-fix text that this environment does not naturally produce. ──────────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-mixedredundant-${sfx}`);
    makeRepo(repo);

    // Both `shared` and `mixed` are cut from the SAME original base, BEFORE `shared` lands — so `mixed`'s
    // own second commit has a genuine, non-empty diff on ITS OWN branch history (creating mc-shared.txt
    // fresh), and only becomes redundant later, when cherry-picked onto a batch tip that already carries
    // `shared`'s independently-landed copy of the same file+content.
    const shared = await cutBranch(repo, "mc-shared", "mc-shared.txt", "shared fix\n");
    const mixed = await cutBranchMultiCommit(repo, "mc-mixed", [
      { file: "mc-mixed-new.txt", content: "genuinely new\n", message: "feat(test): mc mixed new" },
      { file: "mc-shared.txt", content: "shared fix\n", message: "feat(test): mc mixed shared (redundant)" },
    ]);
    const baseMainSha1 = git(repo, "rev-parse HEAD");

    // `shared` lands ALONE first, in its own batch.
    const { worktreePath: batchWt1 } = await createWorktree(repo, projId, `bm-batch-mixed1-${sfx}`);
    const first = await runBatchedMerge(repo, batchWt1, baseMainSha1, [shared], passGate);
    check("(11) precondition: shared's solo landing succeeds", first.ok === true && first.landed.length === 1);
    const baseMainSha2 = git(repo, "rev-parse HEAD");

    // `fresh` is cut AFTER `shared` already landed — its own tree already contains mc-shared.txt, mirroring
    // a real worker branch cut post-landing (same role as test (10)'s `a`).
    const fresh = await cutBranch(repo, "mc-fresh", "mc-fresh.txt", "fresh\n");

    const { worktreePath: batchWt2 } = await createWorktree(repo, projId, `bm-batch-mixed2-${sfx}`);
    const assembled = await assembleBatchBranches(batchWt2, [fresh, mixed]);

    check("(11) fresh lands normally", assembled.landed.length === 1 && assembled.landed[0]?.branch === fresh.branch);
    check("(11) mixed is DROPPED WHOLESALE (DoD-2 decision (b) — not a partial landing of its first commit)",
      assembled.dropped.length === 1 && assembled.dropped[0]?.branch === mixed.branch);
    const mixedReason = assembled.dropped[0]?.reason ?? "";
    // END-TO-END OUTCOME ASSERTIONS (see this block's header comment above) — green both pre- and
    // post-fix in THIS environment; (11b) below carries the actual discriminating case.
    check("(11) the drop reason does NOT read as a bare/generic commit failure", !mixedReason.includes("commit failed while landing commit"));
    check("(11) the drop reason names redundancy (an empty commit already present in the batch tree)",
      mixedReason.includes("empty commit") && mixedReason.includes("already present in the batch tree"));

    // mixed's genuinely-new first commit must NOT have landed either — all-or-nothing per branch, same as
    // every other drop path in this loop (no partial landing of "just the good commit").
    const headAfter = git(batchWt2, "rev-parse HEAD");
    check("(11) batch worktree HEAD is exactly fresh's landed sha (rollback restored it, nothing left dangling)",
      headAfter === assembled.landed[0].sha);
    check("(11) mc-mixed-new.txt is absent from the batch worktree (mixed's first commit did not land)",
      !fs.existsSync(path.join(batchWt2, "mc-mixed-new.txt")));
    check("(11) batch worktree is clean post-rollback (no lingering cherry-pick/index state)",
      git(batchWt2, "status --porcelain") === "");

    const ff = await fastForwardCanonicalMain(repo, baseMainSha2, headAfter);
    check("(11) fast-forward to fresh's real commit succeeds", ff.ok === true);
    check("(11) canonical main gained exactly 1 new commit (fresh's — mixed was dropped, not landed)",
      git(repo, `rev-list --count ${baseMainSha2}..HEAD`) === "1");
    check("(11) mc-mixed-new.txt never lands on canonical main", !fs.existsSync(path.join(repo, "mc-mixed-new.txt")));
    check("(11) mc-fresh.txt landed on canonical main", fs.existsSync(path.join(repo, "mc-fresh.txt")));
  }

  // ── (11b) POSITIVE-CONTROLLED variant of (11), MOCK-forced (card 2eb78eb2) — measured empirically
  //     (this repo's installed simple-git@3.27+/git-for-windows combo) that the manual `git commit` on an
  //     empty stage RESOLVES rather than rejects, so (11) above never actually exercises the OLD generic
  //     catch (`commit failed while landing commit <sha7>: …`) — the pre-existing `newHead === currentHead`
  //     fail-closed check (card 43a9182d) already classifies it with a redundancy-naming reason on ITS OWN,
  //     in THIS environment, regardless of this card's fix. The card's own §WHY-p3 names the exact generic
  //     text as the observed pre-fix reason, which implies that manual `git commit` DOES reject in the
  //     environment the reviewer measured in — plausibly a different git/simple-git build. Rather than
  //     depend on that environment-specific resolve-vs-reject behavior either way, this variant FORCES the
  //     manual commit call to reject (mirroring the reviewer's exact observed shape) via a `gitFactory` mock
  //     and asserts structurally: with this card's fix applied, the mocked-to-fail `commit` call for the
  //     REDUNDANT sha is NEVER EVEN ATTEMPTED (the new empty-stage probe returns first), so the injected
  //     failure can't fire and the reason names redundancy. THE POSITIVE CONTROL (see this worker's own
  //     report for the transcript): reverting only this card's new empty-stage-probe block and re-running
  //     JUST this case turns both assertions RED — the mocked commit call fires (`commitAttemptedForRedundant
  //     ` flips true) and the reported reason becomes the generic "commit failed while landing commit
  //     <sha7>: simulated ..." text, matching the card's own quoted pre-fix shape exactly. ─────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-mixedredundant-mock-${sfx}`);
    makeRepo(repo);
    const REDUNDANT_MARKER = "mc mixed 2 shared (redundant)";
    const shared = await cutBranch(repo, "mc2-shared", "mc2-shared.txt", "shared fix 2\n");
    const mixed = await cutBranchMultiCommit(repo, "mc2-mixed", [
      { file: "mc2-mixed-new.txt", content: "genuinely new 2\n", message: "feat(test): mc mixed 2 new" },
      { file: "mc2-shared.txt", content: "shared fix 2\n", message: `feat(test): ${REDUNDANT_MARKER}` },
    ]);
    const baseMainSha1 = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt1 } = await createWorktree(repo, projId, `bm-batch-mixedmock1-${sfx}`);
    const first = await runBatchedMerge(repo, batchWt1, baseMainSha1, [shared], passGate);
    check("(11b) precondition: shared's solo landing succeeds", first.ok === true && first.landed.length === 1);
    const fresh = await cutBranch(repo, "mc2-fresh", "mc2-fresh.txt", "fresh 2\n");
    const { worktreePath: batchWt2 } = await createWorktree(repo, projId, `bm-batch-mixedmock2-${sfx}`);

    // A gitFactory that delegates EVERY call to a real boundedMergeGit instance EXCEPT the manual `commit`
    // whose message carries this run's REDUNDANT_MARKER — that one call throws, simulating the reviewer's
    // exact observed "nothing to commit, working tree clean"-shaped rejection, regardless of what real git
    // would actually do for it. Mirrors case (9)'s `failingAmendGitFactory` shape.
    let commitAttemptedForRedundant = false;
    function forcedRejectGitFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args.includes("commit") && !args.includes("--amend") &&
              args.some((a) => typeof a === "string" && a.includes(REDUNDANT_MARKER))) {
            commitAttemptedForRedundant = true;
            throw new Error("nothing to commit, working tree clean");
          }
          return real.raw(args);
        },
      };
    }

    const assembled = await assembleBatchBranches(batchWt2, [fresh, mixed], { gitFactory: forcedRejectGitFactory });

    check("(11b) fresh lands normally", assembled.landed.length === 1 && assembled.landed[0]?.branch === fresh.branch);
    check("(11b) mixed is DROPPED", assembled.dropped.length === 1 && assembled.dropped[0]?.branch === mixed.branch);
    // THE DISCRIMINATING ASSERTIONS — RED against a revert of just this card's empty-stage-probe block (see
    // this case's own header comment for the confirmed pre-fix transcript).
    check("(11b) the mocked-to-fail manual commit for the redundant sha was NEVER ATTEMPTED — the new empty-stage probe returns first",
      commitAttemptedForRedundant === false);
    const mixedReasonMock = assembled.dropped[0]?.reason ?? "";
    check("(11b) the drop reason does NOT read as a bare/generic commit failure", !mixedReasonMock.includes("commit failed while landing commit"));
    check("(11b) the drop reason names redundancy (an empty commit already present in the batch tree)",
      mixedReasonMock.includes("empty commit") && mixedReasonMock.includes("already present in the batch tree"));
  }

  // ── (12) SORT BY EARLIEST AUTHOR DATE (card 4763432b) ─────────────────────────────────────────────────
  // Three candidates passed in a DELIBERATELY non-chronological order — latest, a multi-commit middle
  // branch, then earliest. Proves: (a) landing order follows each branch's EARLIEST author date, not the
  // order candidates were passed in; (b) guard 1 survives sorting — the multi-commit branch's own 2 commits
  // still land INDIVIDUALLY, in original order, CONTIGUOUSLY (never interleaved with another branch's
  // commits just because sorting reordered the branches themselves); (c) guard 2 survives — only that
  // branch's LAST (tip) commit carries its Loom-Worker-Branch trailer, exactly as without sorting.
  {
    const repo = path.join(os.tmpdir(), `loom-bm-sort-${sfx}`);
    makeRepo(repo);
    // sortB: earliest (08:00).
    const sortB = await cutBranchWithAuthorDate(repo, "sortB", "sort-b.txt", "work b\n", "2020-01-01T08:00:00+00:00");
    // sortA: 2 commits, earliest author date 09:00 (its own tip commit is 09:05) — sorts BETWEEN B and C by
    // its EARLIEST commit, never by its tip.
    const sortA = await cutBranchMultiCommitWithAuthorDates(repo, "sortA", [
      { file: "sort-a1.txt", content: "a1\n", message: "sortA-1", authorDateIso: "2020-01-01T09:00:00+00:00" },
      { file: "sort-a2.txt", content: "a2\n", message: "sortA-2", authorDateIso: "2020-01-01T09:05:00+00:00" },
    ]);
    // sortC: latest (10:00).
    const sortC = await cutBranchWithAuthorDate(repo, "sortC", "sort-c.txt", "work c\n", "2020-01-01T10:00:00+00:00");
    const baseMainSha = git(repo, "rev-parse HEAD");

    // Passed in as [C, A, B] — the reverse of chronological, and not alphabetical either.
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-sort-${sfx}`);
    const assembled = await assembleBatchBranches(batchWt, [sortC, sortA, sortB]);
    check("(12) all 3 landed", assembled.landed.length === 3 && assembled.dropped.length === 0);
    check("(12) landing order is B, A, C (earliest-author-date-first) — NOT the passed-in [C, A, B] order",
      assembled.landed[0]?.branch === sortB.branch &&
      assembled.landed[1]?.branch === sortA.branch &&
      assembled.landed[2]?.branch === sortC.branch);

    // Run the real batch (fresh worktree — batchWt above is now dirty from the standalone assemble call,
    // same reasoning as case (3) above) and inspect canonical main's actual landed commit sequence.
    const { worktreePath: batchWt2 } = await createWorktree(repo, projId, `bm-batch-sort-run-${sfx}`);
    const result = await runBatchedMerge(repo, batchWt2, baseMainSha, [sortC, sortA, sortB], passGate);
    check("(12) batch succeeds", result.ok === true && result.landed.length === 3);
    check("(12) main gained exactly 4 new commits (B:1 + A:2 + C:1)", git(repo, `rev-list --count ${baseMainSha}..HEAD`) === "4");

    const shas = git(repo, `log --reverse ${baseMainSha}..HEAD --format=%H`).split("\n").filter(Boolean);
    check("(12) 4 commits landed on main", shas.length === 4);
    const subjects = shas.map((sha) => git(repo, `log -1 --format=%s ${sha}`));
    check("(12) landed order on main: sortB, sortA-1, sortA-2, sortC — A's own 2 commits land CONTIGUOUSLY between B and C, never interleaved (guard 1 survives sorting)",
      subjects.join(",") === "sortB,sortA-1,sortA-2,sortC");
    const bodies = shas.map((sha) => git(repo, `log -1 --format=%B ${sha}`));
    check("(12) only sortA-2 (A's tip, not sortA-1) carries A's Loom-Worker-Branch trailer (guard 2 survives sorting)",
      !bodies[1]?.includes(`Loom-Worker-Branch: ${sortA.branch}`) && !!bodies[2]?.includes(`Loom-Worker-Branch: ${sortA.branch}`));
    check("(12) B and C each carry their own trailer on their one commit",
      !!bodies[0]?.includes(`Loom-Worker-Branch: ${sortB.branch}`) && !!bodies[3]?.includes(`Loom-Worker-Branch: ${sortC.branch}`));
  }

  // ── fastForwardCanonicalMain: a no-op batch (nothing landed on top) is a safe success, not a refusal ──
  {
    const repo = path.join(os.tmpdir(), `loom-bm-noop-${sfx}`);
    makeRepo(repo);
    const baseMainSha = git(repo, "rev-parse HEAD");
    const ff = await fastForwardCanonicalMain(repo, baseMainSha, baseMainSha);
    check("(noop) fast-forward to the same sha succeeds without touching anything", ff.ok === true);
  }
} finally {
  // No per-test worktree cleanup needed: LOOM_HOME is now a temp dir (useOwnLoomHome, above), so
  // _guard.mjs's own exit hook removes its WORKTREES_DIR sibling (where createWorktree() put everything
  // this file created) automatically — see card aac489a2.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an empty-commit resubmission fails closed without corrupting a sibling's commit, a redundant commit inside a multi-commit branch drops the whole branch with a redundancy-naming reason, landing order follows each branch's earliest author date, and a no-op fast-forward succeeds. See batch-merge-robustness.mjs for the forgery/stamp scenarios."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
