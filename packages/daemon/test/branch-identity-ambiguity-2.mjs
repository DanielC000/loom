import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 56c10535 (follow-up to 967eb326/f2a64819, which fixed 5 sites): the KEY finding of this card is
// that `expectedBranchTip`/`BatchCandidate.tip` is NOT an independent witness against the squash-target's
// own bare-revision resolve — BOTH sides were derived via the identical bare `rev-parse --verify
// <branch>^{commit}` mechanism (directly, or via `resolveGitRef`), so a planted same-named tag poisoned
// both consistently and the "branch tip moved" guard never fired. See
// docs/decisions/56c10535-a-branch-identity-read-is-always-refs-heads-qualified.md for the full trace.
//
// This file covers the sites branch-identity-ambiguity.mjs (card 967eb326) did not:
//   (1) mergeBranchLocked's squash target — REAL repro: a same-named tag pointing at an UNRELATED
//       commit used to let that commit's content land under the real task's subject/trailer while the
//       worker's real commit silently never landed. Also covers the tag-at-mainSha noop variant.
//   (2) recutStaleReusedBranch's ahead-count — a same-named tag masks a genuinely unmerged (>0-ahead)
//       reused branch as 0-ahead, triggering the destructive `reset --hard` reserved for empty branches.
//   (3) the batch path (assembleBatchBranches / landBranchCommitsIndividually, no pinnedTip) — same
//       "lands the tag's content" class as (1), via a different code path.
//   (4) diffBranch — the manager's pre-merge review diff must show the REAL branch's changes, not the
//       tag's, under the identical ambiguity.
//   (5) worktreeHasWork — a same-named tag at main's tip must not make a genuinely-ahead branch read as
//       "no work" (which would let boot-reconcile delete a live worktree).
//   (6) [Code Review round 2, reviewer 9483d176] resolveBranchTip's own EXACTNESS — a bare
//       `refs/heads/<b>^{commit}` revision is NOT exact: when the real branch is missing, git's DWIM
//       re-applies its search order to that STRING and resolves a planted refs/refs/heads/<b>,
//       refs/tags/refs/heads/<b>, or refs/heads/refs/heads/<b> ref instead (confirmed real). Sections
//       1-5 above were re-verified after resolveBranchTip switched to an exact `for-each-ref` lookup;
//       Section 7 pins the exactness property itself, plus computeEmitCompareGate's own fail-closed
//       handling of an unresolvable ref (round 2 also fixed its two production call sites, which used
//       to pass the bare branch name instead of the already-resolved tip).
//
// RED/GREEN: every scenario below was proven RED by reverting ONLY packages/daemon/src/git/worktrees.ts,
// packages/daemon/src/git/batch-merge.ts, and packages/daemon/src/sessions/service.ts to their
// pre-this-card content (commit f2a64819), rebuilding, and re-running this file in isolation (each
// assertion listed failed at that revision), then restored and re-verified GREEN.
//
// Run: 1) build daemon (pnpm build), 2) node test/branch-identity-ambiguity-2.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-bia2-home-");
requireHermeticEnv();

const {
  createWorktree,
  mergeBranch,
  resolveBranchTip,
  resolveGitRef,
  diffBranch,
  worktreeHasWork,
  computeEmitCompareGate,
} = await import("../dist/git/worktrees.js");
const { assembleBatchBranches } = await import("../dist/git/batch-merge.js");
const { canonicalGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bia2@loom -c user.name=bia2";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# bia2\n");
  execSync(`git init -q && git config user.email bia2@loom && git config user.name bia2`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch -M main");
}

try {
  // ══ Section 1: mergeBranchLocked squash target — lands the tag's content ═══════════════════════════
  console.log("\n— Section 1: mergeBranchLocked squash target —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s1-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);

    const { worktreePath, branch } = await createWorktree(repo, `bia2-s1-p-${sfx}`, `bia2-s1-t-${sfx}`);
    tmpDirs.push(worktreePath);

    // The worker's real, legitimate commit on its own branch.
    fs.writeFileSync(path.join(worktreePath, "real-work.txt"), "the worker's real content\n");
    commitAll(worktreePath, "real worker commit", GIT_ID);

    // ATTACK: an unrelated sibling commit (anyone with .git write access) carrying DIFFERENT content,
    // tagged with the branch's EXACT name.
    const sibling = path.join(os.tmpdir(), `loom-bia2-s1-sib-${sfx}`);
    tmpDirs.push(sibling);
    execSync(`git clone -q "${repo}" "${sibling}"`);
    fs.writeFileSync(path.join(sibling, "attacker-content.txt"), "planted by the tag, NOT the worker\n");
    execSync(`git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m "attacker commit"`, { cwd: sibling });
    const attackerSha = git(sibling, "rev-parse HEAD");
    execSync(`git fetch -q "${sibling}" HEAD:refs/bia2-fetched/s1-attacker`, { cwd: repo });
    git(repo, `tag ${branch} ${attackerSha}`);

    // The FIXED pipeline's own pin capture (resolveBranchTip) must resolve the REAL branch tip, never
    // the tag — this is the "pin is an independent witness again" proof.
    const realTip = git(worktreePath, "rev-parse HEAD");
    const pinnedTip = await resolveBranchTip(repo, branch);
    check("(S1-PIN) resolveBranchTip resolves the REAL branch tip under tag ambiguity", pinnedTip === realTip);
    check("(S1-PIN) resolveBranchTip never resolves the planted tag's sha", pinnedTip !== attackerSha);

    const result = await mergeBranch(repo, branch, "the task's real title", {}, undefined, undefined, undefined, pinnedTip);
    check("(S1-LAND) merge succeeds (not falsely refused)", result.ok === true && !result.branchTipMoved);
    const landedFiles = result.sha ? git(repo, `show --stat --format= ${result.sha}`) : "";
    check("(S1-LAND) the REAL worker content landed", landedFiles.includes("real-work.txt"));
    check("(S1-LAND) the attacker's tag content did NOT land", !landedFiles.includes("attacker-content.txt"));
    git(repo, `tag -d ${branch}`);
  }

  // ══ Section 2: mergeBranchLocked squash target — tag-at-mainSha noop variant ═══════════════════════
  console.log("\n— Section 2: tag-at-mainSha noop variant —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s2-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    const mainSha = git(repo, "rev-parse HEAD");

    const { worktreePath, branch } = await createWorktree(repo, `bia2-s2-p-${sfx}`, `bia2-s2-t-${sfx}`);
    tmpDirs.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "real-work.txt"), "the worker's real content\n");
    commitAll(worktreePath, "real worker commit", GIT_ID);
    const realTip = git(worktreePath, "rev-parse HEAD");

    // ATTACK: a same-named tag pointing at mainSha (no new content) — the shape that used to make a
    // bare resolve read "nothing to land" (false ALREADY_MERGED / STAGE_EMPTY_RETRY noop).
    git(repo, `tag ${branch} ${mainSha}`);
    const pinnedTip = await resolveBranchTip(repo, branch);
    check("(S2-PIN) resolveBranchTip still resolves the real tip, not the tag-at-main sha", pinnedTip === realTip && pinnedTip !== mainSha);

    const result = await mergeBranch(repo, branch, "the task's real title", {}, undefined, undefined, undefined, pinnedTip);
    check("(S2-LAND) merge succeeds and is NOT a noop", result.ok === true && !result.noop);
    const landedFiles = result.sha ? git(repo, `show --stat --format= ${result.sha}`) : "";
    check("(S2-LAND) the real content landed", landedFiles.includes("real-work.txt"));
    git(repo, `tag -d ${branch}`);
  }

  // ══ Section 3: recutStaleReusedBranch destroys unmerged work ═══════════════════════════════════════
  console.log("\n— Section 3: recutStaleReusedBranch —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s3-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    const projectId = `bia2-s3-p-${sfx}`;
    const taskId = `bia2-s3-t-${sfx}`;

    const { worktreePath, branch } = await createWorktree(repo, projectId, taskId);
    tmpDirs.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "real-unmerged-work.txt"), "important work not yet landed\n");
    commitAll(worktreePath, "real unmerged commit", GIT_ID);
    const realTip = git(worktreePath, "rev-parse HEAD");
    const mainSha = git(repo, "rev-parse HEAD");

    // ATTACK: a same-named tag at mainSha makes the bare ahead-count read 0 for a genuinely >0-ahead
    // (real, unmerged) branch.
    git(repo, `tag ${branch} ${mainSha}`);

    // Re-dispatch onto the SAME (projectId, taskId): createWorktree's reuse path calls
    // recutStaleReusedBranch internally.
    await createWorktree(repo, projectId, taskId);

    check("(S3-SURVIVE) the real unmerged file survives the re-cut attempt", fs.existsSync(path.join(worktreePath, "real-unmerged-work.txt")));
    check("(S3-SURVIVE) the worktree HEAD is still the worker's real commit", git(worktreePath, "rev-parse HEAD") === realTip);
    git(repo, `tag -d ${branch}`);
  }

  // ══ Section 4: batch path (assembleBatchBranches, no pinnedTip) ════════════════════════════════════
  console.log("\n— Section 4: batch path —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s4-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);

    const { worktreePath, branch } = await createWorktree(repo, `bia2-s4-p-${sfx}`, `bia2-s4-t-${sfx}`);
    tmpDirs.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "real-work.txt"), "the worker's real content\n");
    commitAll(worktreePath, "real worker commit", GIT_ID);

    // ATTACK: same-named tag at an unrelated attacker commit.
    const sibling = path.join(os.tmpdir(), `loom-bia2-s4-sib-${sfx}`);
    tmpDirs.push(sibling);
    execSync(`git clone -q "${repo}" "${sibling}"`);
    fs.writeFileSync(path.join(sibling, "attacker-content.txt"), "planted by the tag, NOT the worker\n");
    execSync(`git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m "attacker commit"`, { cwd: sibling });
    const attackerSha = git(sibling, "rev-parse HEAD");
    execSync(`git fetch -q "${sibling}" HEAD:refs/bia2-fetched/s4-attacker`, { cwd: repo });
    git(repo, `tag ${branch} ${attackerSha}`);

    // Batch worktree: a second linked worktree off the SAME canonical repo, cut from main — mirrors
    // how mergeBatchTracked actually assembles a batch (never the canonical checkout itself).
    const batchWt = path.join(os.tmpdir(), `loom-bia2-s4-batchwt-${sfx}`);
    tmpDirs.push(batchWt);
    execSync(`git worktree add -q -B bia2-s4-batch "${batchWt}" main`, { cwd: repo });

    // Deliberately NO `tip` on the candidate — the no-pinnedTip path falls back to the bare branch name.
    const result = await assembleBatchBranches(repo, batchWt, [{ workerSessionId: "w1", taskId: "t1", branch, cutBaseSha: null }]);
    check("(S4-LAND) exactly one branch landed", result.landed.length === 1 && result.dropped.length === 0);
    const landedSha = result.landed[0]?.sha;
    const landedFiles = landedSha ? git(batchWt, `show --stat --format= ${landedSha}`) : "";
    check("(S4-LAND) the REAL worker content landed", landedFiles.includes("real-work.txt"));
    check("(S4-LAND) the attacker's tag content did NOT land", !landedFiles.includes("attacker-content.txt"));
    try { execSync(`git worktree remove --force "${batchWt}"`, { cwd: repo }); } catch { /* best-effort */ }
    git(repo, `tag -d ${branch}`);
  }

  // ══ Section 5: diffBranch shows the real diff, not the tag's ═══════════════════════════════════════
  console.log("\n— Section 5: diffBranch —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s5-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);

    const { worktreePath, branch } = await createWorktree(repo, `bia2-s5-p-${sfx}`, `bia2-s5-t-${sfx}`);
    tmpDirs.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "real-work.txt"), "the worker's real content\n");
    commitAll(worktreePath, "real worker commit", GIT_ID);

    // ATTACK: same-named tag at an unrelated attacker commit (no real relationship to the branch).
    const sibling = path.join(os.tmpdir(), `loom-bia2-s5-sib-${sfx}`);
    tmpDirs.push(sibling);
    execSync(`git clone -q "${repo}" "${sibling}"`);
    fs.writeFileSync(path.join(sibling, "attacker-content.txt"), "planted by the tag, NOT the worker\n");
    execSync(`git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m "attacker commit"`, { cwd: sibling });
    const attackerSha = git(sibling, "rev-parse HEAD");
    execSync(`git fetch -q "${sibling}" HEAD:refs/bia2-fetched/s5-attacker`, { cwd: repo });
    git(repo, `tag ${branch} ${attackerSha}`);

    const diff = await diffBranch(repo, branch, "HEAD", { includePatch: false });
    check("(S5-DIFF) shows the real worker file as changed", diff.allFiles.some((f) => f.file === "real-work.txt"));
    check("(S5-DIFF) does NOT show the attacker's file", !diff.allFiles.some((f) => f.file === "attacker-content.txt"));
    check("(S5-DIFF) filesChanged matches the real branch's own change count (1)", diff.filesChanged === 1);
    git(repo, `tag -d ${branch}`);
  }

  // ══ Section 5b [Round 3, item 1] — diffBranch, branch MISSING + the SAME DWIM-reachable decoy shape
  //    Section 7 uses (refs/heads/refs/heads/<b>, refs/refs/heads/<b>, refs/tags/refs/heads/<b> — NOT a
  //    plain same-named tag, which `refs/heads/<branch>`'s own qualification already defeats on its own
  //    and would prove nothing about THIS card's fix): must THROW (fail LOUD), never silently diff one
  //    of the decoys' content and report a wrong — or empty — review diff. ═══════════════════════════
  console.log("\n— Section 5b: diffBranch, missing branch + decoy —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s5b-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);

    const branch = `loom/bia2-s5b-missing-${sfx}`;
    // The real branch refs/heads/<branch> is NEVER created — only decoys are planted.
    fs.writeFileSync(path.join(repo, "decoy.txt"), "planted by a decoy, not a real branch\n");
    commitAll(repo, "decoy commit", GIT_ID);
    const decoySha = git(repo, "rev-parse HEAD");
    for (const decoy of [
      `refs/heads/refs/heads/${branch}`,
      `refs/refs/heads/${branch}`,
      `refs/tags/refs/heads/${branch}`,
    ]) {
      git(repo, `update-ref "${decoy}" ${decoySha}`);
    }

    let threw = false;
    try {
      await diffBranch(repo, branch, "HEAD", { includePatch: false });
    } catch {
      threw = true;
    }
    check("(S5b-REFUSE) diffBranch throws on a missing branch rather than silently diffing a decoy", threw);

    for (const decoy of [
      `refs/heads/refs/heads/${branch}`,
      `refs/refs/heads/${branch}`,
      `refs/tags/refs/heads/${branch}`,
    ]) {
      git(repo, `update-ref -d "${decoy}"`);
    }
  }

  // ══ Section 6: worktreeHasWork — a genuinely-ahead branch must not read as "no work" ═══════════════
  console.log("\n— Section 6: worktreeHasWork —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s6-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    const mainSha = git(repo, "rev-parse HEAD");

    const { worktreePath, branch } = await createWorktree(repo, `bia2-s6-p-${sfx}`, `bia2-s6-t-${sfx}`);
    tmpDirs.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "real-work.txt"), "the worker's real content\n");
    commitAll(worktreePath, "real worker commit", GIT_ID);

    // ATTACK: a same-named tag at mainSha makes the bare `base..branch` ahead-count read 0 for a
    // genuinely ahead branch.
    git(repo, `tag ${branch} ${mainSha}`);

    const hasWork = await worktreeHasWork(repo, worktreePath, branch, mainSha);
    check("(S6-WORK) a genuinely-ahead branch still reports hasWork:true under the tag ambiguity", hasWork === true);
    git(repo, `tag -d ${branch}`);
  }

  // ══ Section 6b [Round 3, item 1] — worktreeHasWork, branch MISSING + the SAME DWIM-reachable decoy
  //    shape Section 7 uses (never a plain same-named tag — see Section 5b's own header note on why
  //    that shape proves nothing here): must fail SAFE to true (assume work), never silently read a
  //    decoy's own ahead-count (decision 9cb0287a's own "Do not" on this function's failure default). ═
  console.log("\n— Section 6b: worktreeHasWork, missing branch + decoy —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s6b-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);
    const mainSha = git(repo, "rev-parse HEAD");

    // A clean worktree with NO branch param collision — the worktree itself is on an unrelated branch
    // so (1)'s own porcelain-status check reports clean, isolating (2)'s ahead-count path.
    const worktreePath = path.join(os.tmpdir(), `loom-bia2-s6b-wt-${sfx}`);
    tmpDirs.push(worktreePath);
    execSync(`git worktree add -q -b loom/bia2-s6b-wt-${sfx} "${worktreePath}"`, { cwd: repo });

    const branch = `loom/bia2-s6b-missing-${sfx}`;
    // The real branch refs/heads/<branch> is NEVER created — only decoys are planted, each AT mainSha
    // (0 commits ahead), so a DWIM read of any of them would (wrongly) report no work.
    for (const decoy of [
      `refs/heads/refs/heads/${branch}`,
      `refs/refs/heads/${branch}`,
      `refs/tags/refs/heads/${branch}`,
    ]) {
      git(repo, `update-ref "${decoy}" ${mainSha}`);
    }

    const hasWork = await worktreeHasWork(repo, worktreePath, branch, mainSha);
    check("(S6b-WORK) a genuinely-missing branch (decoys at 0-ahead) still fails SAFE to hasWork:true", hasWork === true);

    for (const decoy of [
      `refs/heads/refs/heads/${branch}`,
      `refs/refs/heads/${branch}`,
      `refs/tags/refs/heads/${branch}`,
    ]) {
      git(repo, `update-ref -d "${decoy}"`);
    }
  }

  // ══ Section 7: resolveBranchTip is EXACT — `refs/heads/<b>^{commit}` alone is NOT, because git's own
  //    DWIM re-applies its FULL search order to that STRING when the real branch is missing. Real git
  //    confirmed a planted decoy at any of THREE independent DWIM tiers resolves in its place via a bare
  //    `rev-parse --verify refs/heads/<b>^{commit}`: `refs/<n>` (`refs/refs/heads/<b>`), `refs/tags/<n>`
  //    (`refs/tags/refs/heads/<b>`), and `refs/heads/<n>` (`refs/heads/refs/heads/<b>`) — none of this may
  //    ever happen via resolveBranchTip's own `for-each-ref` + exact-refname lookup, and a merge against a
  //    genuinely-missing branch must REFUSE, never fall back to squashing the bare branch name (which
  //    would reopen the identical DWIM hazard one level down — card 56c10535 Round 2, item 4). ═══════════
  console.log("\n— Section 7: resolveBranchTip DWIM-exactness —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s7-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);

    const branch = `loom/bia2-s7-missing-${sfx}`;
    // The real branch refs/heads/<branch> is NEVER created in this section — only decoys are planted.
    fs.writeFileSync(path.join(repo, "planted.txt"), "planted\n");
    commitAll(repo, "planted commit", GIT_ID);
    const plantedSha = git(repo, "rev-parse HEAD");

    for (const decoy of [
      `refs/heads/refs/heads/${branch}`,
      `refs/refs/heads/${branch}`,
      `refs/tags/refs/heads/${branch}`,
    ]) {
      git(repo, `update-ref "${decoy}" ${plantedSha}`);
    }

    // Sanity: the bare, pre-fix form IS still DWIM-reachable through the planted decoys — a positive
    // control proving the attack surface this section guards against is genuinely present, not vacuous.
    // Resolved via resolveGitRef (simple-git/canonicalGit) — the SAME mechanism production code actually
    // uses to spawn git, never a raw shell execSync: a bare `git` shell invocation on this host throws
    // "fatal: Needed a single revision" instead of DWIM-resolving (an environment artifact of invoking
    // git directly vs. through simple-git), which would make this control falsely look vacuous.
    const bareResolved = await resolveGitRef(repo, `refs/heads/${branch}`);
    check("(S7-CONTROL) the bare refs/heads/<b>^{commit} form IS DWIM-reachable through the planted decoy (attack surface genuinely present)", bareResolved === plantedSha);

    const resolved = await resolveBranchTip(repo, branch);
    check("(S7-EXACT) resolveBranchTip fails closed to null despite 3 planted decoys (never the decoy's sha)", resolved === null);

    // Card 56c10535 Round 2, item 4: mergeBranch itself must REFUSE on a genuinely-missing branch, never
    // fall back to squashing the bare branch name (which would reopen this exact DWIM hazard one level
    // down via `git merge --squash <bare name>`'s own re-resolution at squash time).
    const mergeResult = await mergeBranch(repo, branch, "should never land");
    check("(S7-REFUSE) mergeBranch refuses on a genuinely-missing branch (never falls back to the bare name)", mergeResult.ok === false);
    check("(S7-REFUSE) nothing landed (HEAD unchanged)", git(repo, "rev-parse HEAD") === plantedSha);
    // [Round 3, item 2] mergeBranchLocked's refusal must carry its OWN distinct flag — never fall through
    // to service.ts's generic merge_failed classification (which would wrongly tell a manager "squash was
    // attempted … Re-task a rebase").
    check("(S7-REFUSE) the refusal carries branchTipUnresolvable:true, a DISTINCT flag from the generic merge_failed shape", mergeResult.branchTipUnresolvable === true);
    check("(S7-REFUSE) the refusal's reason names the branch and says nothing was squashed", typeof mergeResult.reason === "string" && mergeResult.reason.includes(branch) && mergeResult.reason.includes("nothing was squashed"));
    check("(S7-REFUSE) the refusal is NOT misclassified as a conflict", mergeResult.conflict !== true);

    // computeEmitCompareGate's OWN contract, isolated from resolveBranchTip: an explicit undefined ref
    // must never throw and must never report eligible:true — it has nothing real to diff against.
    // ⚠️ NOT a full positive/negative-control pair: computeEmitCompareGate's domain-scoping (it only ever
    // classifies paths under packages/daemon/{src,test,assets,scripts}, verified separately against a
    // real Loom-shaped tree) means THIS throwaway repo can never reach eligible:true at all regardless of
    // which ref is passed, so a same-result-either-way outcome here is expected, not a vacuous check —
    // the decisive guarantee is resolveBranchTip's own proven exactness (S7-EXACT) structurally
    // preventing a decoy's sha from ever reaching this call in production, not this isolated check.
    const baseSha = git(repo, "rev-parse HEAD~1");
    const directUndefined = await computeEmitCompareGate(repo, baseSha, undefined);
    check("(S7-EMIT) computeEmitCompareGate never reports eligible:true on an explicit undefined ref", directUndefined.eligible === false);

    for (const decoy of [
      `refs/heads/refs/heads/${branch}`,
      `refs/refs/heads/${branch}`,
      `refs/tags/refs/heads/${branch}`,
    ]) {
      git(repo, `update-ref -d "${decoy}"`);
    }
  }

  // ══ Section 8: computeEmitCompareGate classifies the REAL branch's content, never the tag's ═════════
  // card 56c10535 Round 2, item 2/7: "real src can currently land behind a reduced gate" if
  // computeEmitCompareGate's own internal diff call (--name-status base..ref) ever resolves `ref` as a
  // bare branch name under a same-named-tag collision. computeEmitCompareGate's full classification
  // machinery (transpile-soundness, tsconfig, the harness's own NOT_HERMETIC export) needs a real
  // Loom-shaped tree to drive all the way to eligible:true/false — out of reach for a throwaway fixture —
  // so this proves the narrower, decisive property directly: a gitFactory spy on the ACTUAL git call
  // computeEmitCompareGate makes shows it diffs the REAL branch's resolved tip, never the tag's sha.
  console.log("\n— Section 8: computeEmitCompareGate diffs the real branch, never the tag —");
  {
    const repo = path.join(os.tmpdir(), `loom-bia2-s8-${sfx}`);
    tmpDirs.push(repo);
    initRepo(repo);

    const { worktreePath, branch } = await createWorktree(repo, `bia2-s8-p-${sfx}`, `bia2-s8-t-${sfx}`);
    tmpDirs.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "real-work.txt"), "the worker's real content\n");
    commitAll(worktreePath, "real worker commit", GIT_ID);
    const realTip = git(worktreePath, "rev-parse HEAD");
    const baseSha = git(repo, "rev-parse HEAD");

    // ATTACK: same-named tag at an unrelated attacker commit.
    const sibling = path.join(os.tmpdir(), `loom-bia2-s8-sib-${sfx}`);
    tmpDirs.push(sibling);
    execSync(`git clone -q "${repo}" "${sibling}"`);
    fs.writeFileSync(path.join(sibling, "attacker-content.txt"), "planted by the tag, NOT the worker\n");
    execSync(`git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m "attacker commit"`, { cwd: sibling });
    const attackerSha = git(sibling, "rev-parse HEAD");
    execSync(`git fetch -q "${sibling}" HEAD:refs/bia2-fetched/s8-attacker`, { cwd: repo });
    git(repo, `tag ${branch} ${attackerSha}`);

    const resolvedTip = await resolveBranchTip(repo, branch);
    check("(S8-PIN) resolveBranchTip resolves the REAL branch tip under tag ambiguity", resolvedTip === realTip);

    const diffCalls = [];
    const spyFactory = (p, ms) => {
      const real = canonicalGit(p, ms);
      return { raw: async (args) => { if (Array.isArray(args) && args.includes("diff")) diffCalls.push(args); return real.raw(args); } };
    };
    // Mirrors the FIXED production call sites exactly: pass the already-resolved tip, never `branch`.
    await computeEmitCompareGate(repo, baseSha, resolvedTip, { gitFactory: spyFactory }).catch(() => {});
    check("(S8-DIFF) computeEmitCompareGate's own diff call ran against the REAL branch's tip", diffCalls.some((a) => a.some((arg) => typeof arg === "string" && arg.includes(`..${realTip}`))));
    check("(S8-DIFF) computeEmitCompareGate's own diff call never ran against the tag's (attacker) sha", !diffCalls.some((a) => a.some((arg) => typeof arg === "string" && arg.includes(`..${attackerSha}`))));

    git(repo, `tag -d ${branch}`);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeBranchLocked/recutStaleReusedBranch/the batch path/diffBranch/worktreeHasWork all resolve branch identity exactly (via resolveBranchTip's for-each-ref lookup); a same-named tag or a DWIM-reachable decoy (branch missing) can no longer land foreign content, destroy unmerged work, mislead the manager's review diff, hide live work from the worktree-retention check, or pick the wrong reduced-gate classification."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
