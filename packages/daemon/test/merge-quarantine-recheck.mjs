import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE QUARANTINE — RE-CHECK BEFORE EACH KILLABLE MUTATING CALL (card bde5d1fe item 1, follow-up to
// 24c0bdba). Round 6 moved the quarantine check to `withCanonicalIndexLock` (lock ACQUISITION) — a single
// point-in-time check. Two gaps survived that fix:
//
//   (a) A solo merge (`mergeBranchLocked`) holds the lock across its WHOLE multi-step sequence
//       (residue-clear -> squash -> commit) after passing its own entry check ONCE. An entirely separate,
//       UNLOCKED op (a concurrent batch assembly) can quarantine the repo mid-sequence, and the solo merge
//       would keep mutating canonical past it.
//   (b) Batch assembly (`landBranchCommitsIndividually`) never takes `withCanonicalIndexLock` at all (it
//       mutates the batch WORKTREE, not canonical's index directly) — so it never benefited from round 6's
//       fix even at entry-per-call; only its OWN function-entry check (round 4) ever ran, once, before its
//       whole per-branch cherry-pick/commit loop.
//
// The fix: `killableCanonicalRaw` (git/bounded.ts) — the ONE shared chokepoint every mutating
// canonical/batch-merge git call already routes through (per 24c0bdba's own "Do not" list) — now
// re-checks the quarantine immediately before EVERY call, real or test-seam, throwing RepoQuarantinedError
// before spawning anything on a hit. A new `quarantineRepoPath` param (default `repoPath`) lets a caller
// whose `repoPath` is an EPHEMERAL worktree (the batch land path) name the real CANONICAL repo to check —
// batch-merge.ts's five killableCanonicalRaw call sites now pass it explicitly.
//
// SCENARIO 1 — killableCanonicalRaw's own pre-check, in isolation: quarantined -> refuses BEFORE the
//   underlying call ever runs (the test-seam raw() is never invoked); not quarantined -> runs normally.
// SCENARIO 2 — the `quarantineRepoPath` threading itself: the SAME call, same worktree `repoPath`, differs
//   ONLY in whether a distinct canonical path is named — proves the batch-merge.ts fix (passing `repoPath`
//   as the 8th arg) is what makes the re-check actually protective for ITS shape of call.
// SCENARIO 3 — BATCH mid-sequence race (gap (b) above), through the real `landBranchCommitsIndividually`
//   (via `assembleBatchBranches`): a 2-commit candidate branch: after the FIRST commit lands, an
//   INDEPENDENT quarantine is raised (simulating a concurrent, unrelated op) — the SECOND commit's own
//   cherry-pick must refuse, WITHOUT running rollback (the first commit stays landed) and WITHOUT minting
//   a second quarantine token.
// SCENARIO 4 — SOLO mid-sequence race (gap (a) above), through the real `mergeBranch`: after the squash
//   stages content, an INDEPENDENT quarantine is raised before the final commit — the commit call must
//   refuse, WITHOUT running the commit-failure cleanup (the squash's staged diff survives untouched).
//
// RED PROOF (mechanical, once, not re-run): with `killableCanonicalRaw`'s pre-check removed (git diff --
// src/git/bounded.ts captured, reverted, re-applied — see the worker doctrine's documented revert/restore
// recipe), SCENARIO 1's "refuses before the call runs" assertion and SCENARIO 3/4's "the next call is
// refused" assertions both fail — the seam's raw() DOES run, and (in 3/4) a real second commit/cherry-pick
// lands past the quarantine. Restored afterward; see the worker's own report for the exact commands run.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-recheck.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqrc-");
requireHermeticEnv();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { killableCanonicalRaw } = await import("../dist/git/bounded.js");
const { RepoQuarantinedError } = await import("../dist/git/repo-lock.js");
const {
  enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor,
} = await import("../dist/git/merge-quarantine.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");
const { assembleBatchBranches } = await import("../dist/git/batch-merge.js");

const GIT_ID = ["-c", "user.email=mqrc@loom", "-c", "user.name=mqrc"];
const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `mqrc-proj-${sfx}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqrc-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-recheck\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mqrc@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mqrc"], { cwd: repo });
  commitAll(repo, "init", "-c user.email=mqrc@loom -c user.name=mqrc");
  return repo;
}

// A REAL-git-backed passthrough gitFactory (never a canned response) so a multi-step function
// (landBranchCommitsIndividually / mergeBranchLocked) actually lands real content through it — with an
// injection hook fired AFTER a caller-chosen call succeeds, simulating a concurrent, unrelated op
// quarantining the canonical repo mid-sequence.
function injectingGitFactory(onCall) {
  return (repoPath) => ({
    raw: async (args) => {
      const rawArgs = Array.isArray(args[0]) ? args[0] : args;
      const out = execFileSync("git", rawArgs, { cwd: repoPath, encoding: "utf8" });
      onCall?.(rawArgs);
      return out;
    },
  });
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — killableCanonicalRaw's own pre-check, in isolation
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("s1");
    let calls = 0;
    const gitFactory = () => ({ raw: async () => { calls++; return "ok"; } });

    const r1 = await killableCanonicalRaw(repo, ["rev-parse", "HEAD"], 5000, "s1 baseline", gitFactory);
    check("(S1) baseline (not quarantined): succeeds", r1 === "ok");
    check("(S1) baseline: the underlying call ran exactly once", calls === 1);

    enterMergeQuarantine(repo, "unrelated", "manufactured for SCENARIO 1");
    let threw;
    try { await killableCanonicalRaw(repo, ["rev-parse", "HEAD"], 5000, "s1 quarantined", gitFactory); }
    catch (e) { threw = e; }
    check("(S1) quarantined: the call REJECTS", threw !== undefined);
    check("(S1) quarantined: rejects with RepoQuarantinedError specifically", threw instanceof RepoQuarantinedError);
    check("(S1) quarantined: the underlying call NEVER ran (refused BEFORE spawning anything)", calls === 1);

    clearMergeQuarantine(repo);
    const r2 = await killableCanonicalRaw(repo, ["rev-parse", "HEAD"], 5000, "s1 cleared", gitFactory);
    check("(S1) control: once cleared, the SAME call succeeds again", r2 === "ok" && calls === 2);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — quarantineRepoPath threading: a worktree repoPath is NEVER the quarantine key by itself
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const canonicalRepo = makeRepo("s2-canonical");
    const worktreeLikePath = makeRepo("s2-worktree"); // a SEPARATE real repo, standing in for an ephemeral batch worktree
    let calls = 0;
    const gitFactory = () => ({ raw: async () => { calls++; return "ok"; } });

    enterMergeQuarantine(canonicalRepo, "unrelated", "manufactured for SCENARIO 2");
    check("(S2) precondition: canonical reads as quarantined, the worktree-like path does not",
      !!activeMergeQuarantineFor(canonicalRepo) && !activeMergeQuarantineFor(worktreeLikePath));

    // Omitting quarantineRepoPath defaults it to `repoPath` itself (the worktree-like path) — NOT
    // quarantined, so this call wrongly SUCCEEDS. This is exactly why a caller passing an ephemeral
    // worktree as `repoPath` (the batch land path) MUST pass the real canonical repo explicitly.
    const r1 = await killableCanonicalRaw(worktreeLikePath, ["rev-parse", "HEAD"], 5000, "s2 default", gitFactory);
    check("(S2) default quarantineRepoPath (= the worktree path itself): call succeeds (NOT protective for this shape)", r1 === "ok" && calls === 1);

    let threw;
    try {
      await killableCanonicalRaw(worktreeLikePath, ["rev-parse", "HEAD"], 5000, "s2 explicit-canonical", gitFactory, undefined, undefined, canonicalRepo);
    } catch (e) { threw = e; }
    check("(S2) explicit quarantineRepoPath=canonical: the SAME worktree-path call now REFUSES", threw instanceof RepoQuarantinedError);
    check("(S2) explicit quarantineRepoPath=canonical: the underlying call never ran for this one", calls === 1);

    clearMergeQuarantine(canonicalRepo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — BATCH mid-sequence race: an independent quarantine raised between two commits in the
  // SAME candidate's own landing loop must stop the SECOND commit, with no rollback and no extra token.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("s3");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `mqrc-batch-${sfx}`);
    const { worktreePath: candWt, branch } = await createWorktree(repo, projId, `mqrc-cand-${sfx}`);
    // Two commits on the candidate branch, so landBranchCommitsIndividually makes TWO cherry-pick+commit
    // passes through killableCanonicalRaw.
    fs.writeFileSync(path.join(candWt, "s3-a.txt"), "a\n");
    commitAll(candWt, "feat(test): s3 commit A", "-c user.email=mqrc@loom -c user.name=mqrc");
    fs.writeFileSync(path.join(candWt, "s3-b.txt"), "b\n");
    commitAll(candWt, "feat(test): s3 commit B", "-c user.email=mqrc@loom -c user.name=mqrc");

    let commitCalls = 0;
    let injected = false;
    const gitFactory = injectingGitFactory((args) => {
      if (args.includes("commit") && !args.includes("--amend")) {
        commitCalls++;
        if (commitCalls === 1 && !injected) {
          injected = true;
          enterMergeQuarantine(repo, "unrelated-concurrent-op", "manufactured for SCENARIO 3");
        }
      }
    });

    const headBeforeAssembly = git(batchWt, ["rev-parse", "HEAD"]);
    const result = await assembleBatchBranches(repo, batchWt, [{ workerSessionId: "s3-w", taskId: "s3-t", branch }], { gitFactory });

    check("(S3) the first commit landed before the race fired", commitCalls >= 1);
    check("(S3) assembly reports the batch as quarantined (typed flag)", result.quarantined === true);
    check("(S3) nothing classified as cleanly landed (the candidate never finished)", result.landed.length === 0);
    const dropReason = result.dropped[0]?.reason ?? "";
    check("(S3) the drop reason names the quarantine refusal, not a generic failure", /quarantined/i.test(dropReason));

    // NO ROLLBACK: rollback() would reset --hard the batch worktree back to headBeforeAssembly. Since the
    // FIRST commit landed before the refusal and no rollback ran, the batch worktree's HEAD must still be
    // ONE commit ahead of where assembly started (never reset back to it).
    const headAfter = git(batchWt, ["rev-parse", "HEAD"]);
    check("(S3) no rollback ran — the batch worktree's HEAD moved (still holds the first commit)", headAfter !== headBeforeAssembly);

    const entry = activeMergeQuarantineFor(repo);
    check("(S3) exactly ONE outstanding token — the refusal did NOT mint a second one", !!entry && entry.tokens.length === 1);

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 — SOLO mid-sequence race: an independent quarantine raised between the squash and the
  // final commit must stop the commit, with no commit-failure cleanup (the staged diff survives).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("s4");
    const { worktreePath: candWt, branch } = await createWorktree(repo, projId, `mqrc-solo-${sfx}`);
    fs.writeFileSync(path.join(candWt, "s4.txt"), "solo\n");
    commitAll(candWt, "feat(test): s4 solo change", "-c user.email=mqrc@loom -c user.name=mqrc");

    let injected = false;
    const gitFactory = injectingGitFactory((args) => {
      if (args[0] === "merge" && args[1] === "--squash" && !injected) {
        injected = true;
        enterMergeQuarantine(repo, "unrelated-concurrent-op", "manufactured for SCENARIO 4");
      }
    });

    const result = await mergeBranch(repo, branch, "feat(test): s4 solo change", { gitFactory });

    check("(S4) mergeBranch refuses", result.ok === false);
    check("(S4) refusal names the quarantine, not a generic squash-commit failure", /quarantined/i.test(result.reason ?? ""));
    // Code Review of b4315b52, item 4 — the refusal must make the real STAGED residue visible (the squash
    // already landed before this refusal) and name the `git reset --hard` a human needs after clearing —
    // otherwise the NEXT solo merge attempt would itself refuse at the entry-time dirty-tree check with no
    // visible link back to why.
    check("(S4) refusal names the STAGED squash residue by branch", result.reason?.includes(`${branch}'s STAGED squash residue`));
    check("(S4) refusal names the required `git reset --hard` remedy", /git reset --hard/.test(result.reason ?? ""));

    // NO CLEANUP: resetOrSkip's "commit-failure cleanup" would reset --hard the canonical repo, clearing
    // the squash's staged diff. Since the refusal skipped it, the staged diff must still be there.
    const staged = git(repo, ["diff", "--cached", "--name-only"]);
    check("(S4) no commit-failure cleanup ran — the squash's staged diff survives untouched", staged.includes("s4.txt"));

    const entry = activeMergeQuarantineFor(repo);
    check("(S4) exactly ONE outstanding token — the refusal did NOT mint a second one", !!entry && entry.tokens.length === 1);

    clearMergeQuarantine(repo);
    // Control: canonical repo is left with real staged residue from the refused attempt above (by
    // design — no cleanup ran) — a real merge would refuse independently on that ground now; not
    // asserted further here, this scenario's own checks are already complete.
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
