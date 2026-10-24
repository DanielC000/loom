import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 967eb326 (from card 1bc9602b's sweep, worker bd9b9ba0): FIVE sites in
// packages/daemon/src/git/worktrees.ts used an ambiguity-prone ref spelling (`rev-parse --abbrev-ref`,
// a bare revision, `%(refname:short)`, `symbolic-ref --short`) as an identity/membership key. Git
// shortens a branch to `heads/<name>` (or resolves a BARE name to `refs/tags/<name>` FIRST) when a
// same-named tag or `refs/remotes/<name>/HEAD` exists — plantable by any worker through the shared
// .git. Fix pattern (established by 4fabafd1 round 13 / 1bc9602b): `%(refname:lstrip=2)`, full refs, or
// `refs/heads/<name>`-qualified revisions — never ambiguity-dependent. See
// docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-signal.md "Round 13".
//
// REAL git on temp repos, NO claude and NO live daemon. Five sections, one per fixed site:
//   (1) detectStrandedWork        — a same-named tag at the fork point masks a worker's real commits as
//                                    "stranded" on a self-created branch (REAL, reproduced false
//                                    refusal — the card's own repro recipe); a refs/remotes/<name>/HEAD
//                                    collision corrupts the REPORTED divergent-branch name on a
//                                    genuinely stranded worktree.
//   (2) worktreeAddLandedTestOnly — a worktree that DID land correctly on its assigned branch reads as
//                                    not-landed under either ambiguity (false negative).
//   (3) attemptCodexAutoCommit    — a codex worker's own auto-commit-on-done is silently skipped
//                                    (headMismatch) under either ambiguity, even though HEAD really is
//                                    the assigned branch.
//   (4) listMergedLoomBranches    — a merged branch lists as "heads/loom/<id>" under either ambiguity,
//                                    so `git branch -D` never matches it and it's never GC'd (fail-safe
//                                    but ineffective).
//   (5) resolveMainlineBranchState — a colliding local ref/tag named "origin/<mainline>" corrupts the
//                                    resolved mainline branch name downstream.
//
// RED/GREEN: every scenario below was proven RED by reverting ONLY packages/daemon/src/git/worktrees.ts
// to its pre-this-card content, rebuilding, and re-running this file in isolation (each assertion
// listed below failed at that revision), then restored and re-verified GREEN. Scenario-by-scenario RED
// values are noted inline next to each assertion.
//
// Run: 1) build daemon (pnpm build), 2) node test/branch-identity-ambiguity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

// Card 967eb326 Code Review minors (committed on top of 1466710a, new commits — see each site's own
// @decision 967eb326 comment): the detached-HEAD classification in detectStrandedWork/
// attemptCodexAutoCommit now (1) pins LC_ALL/LANGUAGE=C so it matches git's fatal text under any
// locale, and (2) treats a SUCCESSFUL-but-EMPTY symbolic-ref read (a killed/transient child, card
// 787dd2a7's own precedent) as "fail safe", never as "confirmed detached" — only a THROWN
// "not a symbolic ref" message is trusted as a real detached-HEAD signal. Sections 1 and 3 below each
// add: a genuinely detached HEAD with real work (must still be CAUGHT, not silently fail-safe'd away),
// plus two injected-failure cases proving the fail-safe path — an empty-but-resolved read (RED at
// 1466710a: that revision's `wtBranch`/`headRef` fallback treated empty output as confirmed-detached,
// per the Code Review's own finding) and a genuinely unrelated thrown error (already correct at
// 1466710a — kept as a forward regression guard, not a RED proof).

// createworktree-loom-home-guard: this file calls the real createWorktree( below, so a temp LOOM_HOME
// must be in force BEFORE the dist import (WORKTREES_DIR is a sibling of LOOM_HOME).
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bia-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const {
  createWorktree,
  detectStrandedWork,
  worktreeAddLandedTestOnly,
  attemptCodexAutoCommit,
  listMergedLoomBranches,
  resolveMainlineBranchState,
} = await import("../dist/git/worktrees.js");
const { canonicalGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bia@loom -c user.name=bia";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [process.env.LOOM_HOME];

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# bia\n");
  execSync(`git init -q && git config user.email bia@loom && git config user.name bia`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch -M main");
}

// A `deps.gitFactory` override for detectStrandedWork/attemptCodexAutoCommit that intercepts ONLY the
// `symbolic-ref` call and either resolves it to an EMPTY string (mode "empty" — the card 787dd2a7
// killed/transient-child shape: a successful exit with nothing captured) or throws a message that does
// NOT match NOT_A_SYMBOLIC_REF (mode "throw-unrelated" — a genuine, unrelated read failure). Every
// OTHER call delegates to a real canonicalGit instance, so the rest of the function behaves normally.
// @decision 3a5c5d4a (round 3, B3-class) — both callers invoke this factory with `p` = the worktree's
// own worktreePath (a FILE-shaped .git); a bare `canonicalGit(p, ms)` with no trustedMainRoot now REFUSES
// every delegated call post-round-2/3, not just the injected symbolic-ref one. Factory-of-a-factory,
// closing over the caller's own real trusted main root, same pattern as the B3 fixtures this card fixed.
function gitFactoryWithSymbolicRefFailure(mode, trustedMainRoot, extraUnsafe) {
  return (p, ms) => {
    const real = extraUnsafe ? canonicalGit(p, ms, undefined, undefined, extraUnsafe, trustedMainRoot) : canonicalGit(p, ms, undefined, undefined, undefined, trustedMainRoot);
    return {
      raw: async (args) => {
        if (Array.isArray(args) && args.includes("symbolic-ref")) {
          if (mode === "empty") return "";
          throw new Error("fatal: a genuinely unrelated read failure, injected by the test");
        }
        return real.raw(args);
      },
    };
  };
}

try {
  // ══ Section 1: detectStrandedWork (site 1) ═══════════════════════════════════════════════════════
  console.log("\n— Section 1: detectStrandedWork —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia-s1-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    const mainSha = git(repo, "rev-parse HEAD");
    const { worktreePath, branch } = await createWorktree(repo, `bia-s1-p-${sfx}`, `bia-s1-t-${sfx}`);
    tmpDirs.push(worktreePath);

    // The worker commits ONE real change on its own assigned branch — the normal, non-stranded shape.
    fs.writeFileSync(path.join(worktreePath, "work.txt"), "work\n");
    commitAll(worktreePath, "work", GIT_ID);

    // (S1-baseline) no ambiguity at all ⇒ correctly not stranded.
    const base = await detectStrandedWork(repo, worktreePath, branch);
    check("(S1-baseline) no ambiguity ⇒ stranded:false", base.stranded === false);

    // (S1-TAG) the card's own repro: a same-named tag AT THE FORK POINT. A bare revision resolves the
    // tag FIRST (git's revision-priority order puts refs/tags/ ahead of refs/heads/), so the
    // unqualified `rev-list --count main..<branch>` reads 0 (tag is at the fork point) instead of 1 —
    // RED at pre-fix: this returned {stranded:true, branch:"heads/<branch>", ...} (the exact incident:
    // "stranded work on 'heads/loom/<id>' ... assigned branch 'loom/<id>' is empty").
    git(repo, `tag ${branch} ${mainSha}`);
    const tagAmbig = await detectStrandedWork(repo, worktreePath, branch);
    check("(S1-TAG) same-named tag at fork point ⇒ still stranded:false (not a false refusal)", tagAmbig.stranded === false);
    git(repo, `tag -d ${branch}`);

    // (S1-REMOTEHEAD) a refs/remotes/<branch>/HEAD ref — the second, independent trigger named by
    // round 13 — does NOT affect bare-revision resolution (refs/heads/ outranks refs/remotes/.../HEAD
    // in git's own priority order), so this alone can't reproduce the false refusal above (and the
    // assigned branch above already carries a real commit, which would short-circuit step (1) before
    // ever reaching the worktree-branch check). It DOES still corrupt `rev-parse --abbrev-ref HEAD`'s
    // shortening of the worktree's own HEAD, so prove that half separately, on a FRESH, GENUINELY
    // stranded worktree (assigned branch left at 0-ahead; the worktree itself commits on a
    // self-created branch instead — the same precondition merge-stranded-backstop.mjs's own "setupStranded"
    // uses): the REPORTED divergent-branch name must stay correct even under the collision.
    const repo2 = path.join(os.tmpdir(), `loom-bia-s1b-${sfx}`);
    tmpDirs.push(repo2);
    initRepo(repo2);
    const { worktreePath: wt2, branch: branch2 } = await createWorktree(repo2, `bia-s1b-p-${sfx}`, `bia-s1b-t-${sfx}`);
    tmpDirs.push(wt2);
    execSync(`git ${GIT_ID} checkout -q -b my-own-branch`, { cwd: wt2 });
    fs.writeFileSync(path.join(wt2, "stray.txt"), "stray\n");
    commitAll(wt2, "stray", GIT_ID);
    git(repo2, "update-ref refs/remotes/my-own-branch/HEAD refs/heads/main");
    const remoteheadAmbig = await detectStrandedWork(repo2, wt2, branch2);
    check("(S1-REMOTEHEAD) genuinely stranded ⇒ stranded:true", remoteheadAmbig.stranded === true);
    // RED at pre-fix: this read "heads/my-own-branch" (rev-parse --abbrev-ref HEAD's own ambiguous
    // shortening), not the real branch name — a confusing warning naming the wrong branch string.
    check("(S1-REMOTEHEAD) reports the REAL branch name, not an ambiguity-shortened one", remoteheadAmbig.branch === "my-own-branch");
    git(repo2, "update-ref -d refs/remotes/my-own-branch/HEAD");

    // (S1-DETACHED) Code Review minor: a GENUINELY detached HEAD (not a named branch at all) with real
    // stray commits must still be caught — `symbolic-ref HEAD` THROWS "fatal: ref HEAD is not a
    // symbolic ref" for this state (confirmed via NOT_A_SYMBOLIC_REF), reported as branch "HEAD".
    const repo3 = path.join(os.tmpdir(), `loom-bia-s1c-${sfx}`);
    tmpDirs.push(repo3);
    initRepo(repo3);
    const { worktreePath: wt3, branch: branch3 } = await createWorktree(repo3, `bia-s1c-p-${sfx}`, `bia-s1c-t-${sfx}`);
    tmpDirs.push(wt3);
    git(wt3, `checkout -q --detach ${git(repo3, "rev-parse main")}`);
    fs.writeFileSync(path.join(wt3, "detached-stray.txt"), "detached stray\n");
    commitAll(wt3, "detached stray", GIT_ID);
    const detachedWork = await detectStrandedWork(repo3, wt3, branch3);
    check("(S1-DETACHED) detached HEAD with real work ⇒ stranded:true", detachedWork.stranded === true);
    check("(S1-DETACHED) reports branch \"HEAD\"", detachedWork.branch === "HEAD");

    // (S1-READFAIL-EMPTY) Code Review minor 2: an injected successful-but-EMPTY symbolic-ref read on
    // the SAME genuinely-stranded worktree (repo2/wt2, still on "my-own-branch" with its stray commit)
    // must fail safe to stranded:false — RED at 1466710a (that revision's empty-string fallback to
    // branch "HEAD" let this report stranded:true instead, an unreliable signal masquerading as proof).
    const readFailEmpty = await detectStrandedWork(repo2, wt2, branch2, { gitFactory: gitFactoryWithSymbolicRefFailure("empty", repo2) });
    check("(S1-READFAIL-EMPTY) empty-but-resolved read ⇒ stranded:false (fail safe)", readFailEmpty.stranded === false);

    // (S1-READFAIL-THROW) a genuinely unrelated thrown error must ALSO fail safe, and must NEVER be
    // treated as detached — already correct at 1466710a (the NOT_A_SYMBOLIC_REF mismatch already
    // re-threw to the outer catch); kept as a forward regression guard, not a RED proof.
    const readFailThrow = await detectStrandedWork(repo2, wt2, branch2, { gitFactory: gitFactoryWithSymbolicRefFailure("throw-unrelated", repo2) });
    check("(S1-READFAIL-THROW) genuine read failure ⇒ stranded:false (fail safe, not treated as detached)", readFailThrow.stranded === false);
  }

  // ══ Section 2: worktreeAddLandedTestOnly (site 2) ════════════════════════════════════════════════
  console.log("\n— Section 2: worktreeAddLandedTestOnly —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia-s2-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `bia-s2-p-${sfx}`, `bia-s2-t-${sfx}`);
    tmpDirs.push(worktreePath);

    const base = await worktreeAddLandedTestOnly(worktreePath, branch, {});
    check("(S2-baseline) no ambiguity ⇒ landed:true", base === true);

    // (S2-TAG) RED at pre-fix: `rev-parse --abbrev-ref HEAD` reads "heads/<branch>", never string-equal
    // to the bare branch name ⇒ worktreeAddLanded wrongly returned false (a worktree that DID land
    // correctly read as "did not land").
    git(repo, `tag ${branch} HEAD`);
    const tagAmbig = await worktreeAddLandedTestOnly(worktreePath, branch, {});
    check("(S2-TAG) same-named tag ⇒ still landed:true", tagAmbig === true);
    git(repo, `tag -d ${branch}`);

    // (S2-REMOTEHEAD) the second, independent trigger.
    git(repo, `update-ref refs/remotes/${branch}/HEAD refs/heads/main`);
    const remoteheadAmbig = await worktreeAddLandedTestOnly(worktreePath, branch, {});
    check("(S2-REMOTEHEAD) refs/remotes/<branch>/HEAD ⇒ still landed:true", remoteheadAmbig === true);
    git(repo, `update-ref -d refs/remotes/${branch}/HEAD`);
  }

  // ══ Section 3: attemptCodexAutoCommit (site 3) ═══════════════════════════════════════════════════
  console.log("\n— Section 3: attemptCodexAutoCommit —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia-s3-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `bia-s3-p-${sfx}`, `bia-s3-t-${sfx}`);
    tmpDirs.push(worktreePath);
    execSync(`git config user.email bia@loom && git config user.name bia`, { cwd: worktreePath });

    fs.writeFileSync(path.join(worktreePath, "base.txt"), "untracked\n");
    // @decision 3a5c5d4a (round 3, B2) — every real caller of attemptCodexAutoCommit threads a real
    // trustedMainRoot (service.ts's own call site does); thread it here too, or the function's own
    // default makeGit/identity-probe construction now refuses a bare FILE-shaped .git with none at all —
    // a fixture gap, not a production one, caught by (S3-baseline) itself going RED with no deps change.
    const base = await attemptCodexAutoCommit(worktreePath, branch, { summary: "bia baseline" }, { trustedMainRoot: repo });
    check("(S3-baseline) no ambiguity ⇒ committed:true", base.committed === true);
    check("(S3-baseline) no headMismatch reported", base.headMismatch === undefined);

    // (S3-TAG) RED at pre-fix: `rev-parse --abbrev-ref HEAD` read "heads/<branch>" !== branch ⇒
    // {attempted:true, committed:false, headMismatch:{head:"heads/<branch>"}} — the codex worker's
    // auto-commit-on-done was silently skipped even though HEAD really was the assigned branch.
    fs.writeFileSync(path.join(worktreePath, "tag-case.txt"), "untracked\n");
    git(repo, `tag ${branch} HEAD`);
    const tagAmbig = await attemptCodexAutoCommit(worktreePath, branch, { summary: "bia tag case" }, { trustedMainRoot: repo });
    check("(S3-TAG) same-named tag ⇒ still committed:true (no false headMismatch)", tagAmbig.committed === true);
    check("(S3-TAG) no headMismatch reported", tagAmbig.headMismatch === undefined);
    git(repo, `tag -d ${branch}`);

    // (S3-REMOTEHEAD) the second, independent trigger.
    fs.writeFileSync(path.join(worktreePath, "remotehead-case.txt"), "untracked\n");
    git(repo, `update-ref refs/remotes/${branch}/HEAD refs/heads/main`);
    const remoteheadAmbig = await attemptCodexAutoCommit(worktreePath, branch, { summary: "bia remotehead case" }, { trustedMainRoot: repo });
    check("(S3-REMOTEHEAD) refs/remotes/<branch>/HEAD ⇒ still committed:true (no false headMismatch)", remoteheadAmbig.committed === true);
    check("(S3-REMOTEHEAD) no headMismatch reported", remoteheadAmbig.headMismatch === undefined);
    git(repo, `update-ref -d refs/remotes/${branch}/HEAD`);

    // Detached-HEAD behavior (preserved, not changed by this fix): a real head mismatch is still
    // reported, naming "HEAD" — never silently fails-safe-skipped just because symbolic-ref throws for
    // a detached checkout.
    git(worktreePath, `checkout -q ${git(repo, "rev-parse main")}`);
    fs.writeFileSync(path.join(worktreePath, "detached-case.txt"), "untracked\n");
    const detached = await attemptCodexAutoCommit(worktreePath, branch, { summary: "bia detached case" }, { trustedMainRoot: repo });
    check("(S3-detached) detached HEAD ⇒ attempted:true, committed:false", detached.attempted === true && detached.committed === false);
    check("(S3-detached) headMismatch names the literal \"HEAD\"", detached.headMismatch && detached.headMismatch.head === "HEAD");

    // (S3-READFAIL-EMPTY) Code Review minor 2: an injected successful-but-EMPTY symbolic-ref read must
    // fail safe to {attempted:false, committed:false} with NO headMismatch — RED at 1466710a (that
    // revision's empty-string fallback reported {attempted:true, committed:false,
    // headMismatch:{head:"HEAD"}} instead, an unreliable signal masquerading as a real head mismatch).
    const extraUnsafe = { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true };
    const readFailEmpty = await attemptCodexAutoCommit(worktreePath, branch, { summary: "bia read-fail empty" }, { gitFactory: gitFactoryWithSymbolicRefFailure("empty", repo, extraUnsafe) });
    check("(S3-READFAIL-EMPTY) empty-but-resolved read ⇒ attempted:false, committed:false (fail safe)", readFailEmpty.attempted === false && readFailEmpty.committed === false);
    check("(S3-READFAIL-EMPTY) no headMismatch reported", readFailEmpty.headMismatch === undefined);

    // (S3-READFAIL-THROW) a genuinely unrelated thrown error must ALSO fail safe — already correct at
    // 1466710a; kept as a forward regression guard, not a RED proof.
    const readFailThrow = await attemptCodexAutoCommit(worktreePath, branch, { summary: "bia read-fail throw" }, { gitFactory: gitFactoryWithSymbolicRefFailure("throw-unrelated", repo, extraUnsafe) });
    check("(S3-READFAIL-THROW) genuine read failure ⇒ attempted:false, committed:false (fail safe)", readFailThrow.attempted === false && readFailThrow.committed === false);
    check("(S3-READFAIL-THROW) no headMismatch reported", readFailThrow.headMismatch === undefined);
  }

  // ══ Section 4: listMergedLoomBranches (site 4) ═══════════════════════════════════════════════════
  console.log("\n— Section 4: listMergedLoomBranches —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia-s4-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    const branch = `loom/bia-s4-${sfx}`;
    git(repo, `checkout -q -b ${branch}`);
    git(repo, "checkout -q main");
    git(repo, `merge --no-ff -q -m merge ${branch}`);

    const base = await listMergedLoomBranches(repo, "main");
    check("(S4-baseline) no ambiguity ⇒ lists the real short name", base.branches.includes(branch) && !base.failed);

    // (S4-TAG) RED at pre-fix: `%(refname:short)` shortened to "heads/<branch>" ⇒ never matched by
    // `git branch -D <branch>` downstream (fail-safe but ineffective — never GC'd).
    git(repo, `tag ${branch}`);
    const tagAmbig = await listMergedLoomBranches(repo, "main");
    check("(S4-TAG) same-named tag ⇒ still lists the real short name", tagAmbig.branches.includes(branch) && !tagAmbig.failed);
    check("(S4-TAG) never lists the ambiguity-shortened form", !tagAmbig.branches.includes(`heads/${branch}`));
    git(repo, `tag -d ${branch}`);

    // (S4-REMOTEHEAD) the second, independent trigger.
    git(repo, `update-ref refs/remotes/${branch}/HEAD refs/heads/main`);
    const remoteheadAmbig = await listMergedLoomBranches(repo, "main");
    check("(S4-REMOTEHEAD) refs/remotes/<branch>/HEAD ⇒ still lists the real short name", remoteheadAmbig.branches.includes(branch) && !remoteheadAmbig.failed);
    check("(S4-REMOTEHEAD) never lists the ambiguity-shortened form", !remoteheadAmbig.branches.includes(`heads/${branch}`));
    git(repo, `update-ref -d refs/remotes/${branch}/HEAD`);
  }

  // ══ Section 5: resolveMainlineBranchState (site 5) ═══════════════════════════════════════════════
  console.log("\n— Section 5: resolveMainlineBranchState —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia-s5-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    git(repo, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");

    const base = await resolveMainlineBranchState(repo);
    check("(S5-baseline) no ambiguity ⇒ resolves to \"main\"", base.state === "resolved" && base.branch === "main");

    // (S5-TAG) RED at pre-fix: `symbolic-ref --short refs/remotes/origin/HEAD` shortened to the
    // disambiguated "remotes/origin/main" (not "origin/main") once a same-named tag exists — the JS
    // `.slice("origin/".length)` strip never matched, so `branch` came back as the WHOLE corrupted
    // string "remotes/origin/main", not "main".
    git(repo, "tag origin/main");
    const tagAmbig = await resolveMainlineBranchState(repo);
    check("(S5-TAG) colliding tag named origin/main ⇒ still resolves to \"main\"", tagAmbig.state === "resolved" && tagAmbig.branch === "main");
    git(repo, "tag -d origin/main");

    // (S5-BRANCH) the identical corruption via a colliding LOCAL BRANCH instead of a tag (round 13's
    // "where that applies" — there is no refs/remotes/<name>/HEAD analogue inside refs/remotes/origin/*
    // itself, so a same-named local branch is the second independent trigger for THIS site).
    git(repo, "branch origin/main");
    const branchAmbig = await resolveMainlineBranchState(repo);
    check("(S5-BRANCH) colliding branch named origin/main ⇒ still resolves to \"main\"", branchAmbig.state === "resolved" && branchAmbig.branch === "main");
    git(repo, "branch -D origin/main");
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — detectStrandedWork/worktreeAddLanded/attemptCodexAutoCommit/listMergedLoomBranches/resolveMainlineBranchState all resolve branch identity by full refname — a same-named tag or refs/remotes/<name>/HEAD can no longer launder a false refusal, a silently-skipped auto-commit, an un-GC'd branch, or a corrupted mainline name."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
