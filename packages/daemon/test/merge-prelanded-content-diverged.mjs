import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CARD afa80698 / @decision 24c22912's own "Known gap" section — a dirty-worktree preLanded re-confirm's
// `branchStableSinceGateBase` exemption let `mergeBranchLocked` squash a branch whose previously-landed
// content a human (or the Platform Lead) had deliberately REVERTED on main, silently re-introducing
// exactly what the revert removed. THE FIX (`expectAlreadyLanded`, threaded explicitly from the preLanded
// producer in service.ts, never inferred from `gateBaseBranchHead` being set): the preLanded producer's
// own premise is that this branch's content is ALREADY on main, so the eventual squash MUST stage
// nothing. A non-empty stage proves that premise no longer holds — `mergeBranchLocked` resets the staged
// squash, lands no commit, and refuses with a distinct `landedContentDiverged` flag.
//
// FOUR real-git scenarios, each calling `mergeBranch` directly (the same function-level scope as
// merge-squash-target-toctou.mjs, this file's template) with exactly the params service.ts's preLanded
// producer would pass on this path:
//   (1) a revert landing DURING the gate (gateBaseMainHead captured BEFORE the revert) — refused.
//   (2) a revert that had ALREADY landed BEFORE the re-confirm ever captured gateBaseMainHead — refused
//       the same way, even though `requireCanonicalHead` trivially matches current HEAD (nothing moved
//       "during" this gate) — proving the fix does not depend on the branch-stability/main-moved timing
//       at all, only on what the squash actually stages.
//   (3) CONTROL: an unrelated edit to the SAME file (a non-overlapping hunk) landing during the gate —
//       must still merge cleanly (ALREADY_MERGED), not false-positive.
//   (4) CONTROL: an unrelated edit to a DIFFERENT file landing during the gate (the emit-compare-gate-
//       scope-reclassify.mjs (M2) shape) — must still merge cleanly.
//
// RED/GREEN proof for (1) and (2): `pnpm --filter @loom/daemon negative-control --file
// packages/daemon/src/git/worktrees.ts --file packages/daemon/src/sessions/service.ts --test
// packages/daemon/test/merge-prelanded-content-diverged.mjs` — RED on the pre-fix `HEAD` (the revert is
// silently undone), GREEN with this fix.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-prelanded-content-diverged.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-pcd-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { mergeBranch, createWorktree, findLandedSquashCommit, resolveGitRef } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=pcd@loom -c user.name=pcd";
const ID_ARGS = GIT_ID.split(" ").filter(Boolean);

function headSha(repo) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}
function statusPorcelain(repo) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString().trim();
}
function revert(repo, sha) {
  execFileSync("git", [...ID_ARGS, "revert", "--no-edit", sha], { cwd: repo });
}

function makeRepo(prefix) {
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repo = path.join(os.tmpdir(), `loom-pcd-${prefix}-${sfx}`);
  registerForCleanup(repo);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", [...ID_ARGS, "config", "core.autocrlf", "false"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# pcd\n");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

async function makeWorktree(repo, projId, taskId) {
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  execFileSync("git", [...ID_ARGS, "config", "core.autocrlf", "false"], { cwd: worktreePath });
  return { worktreePath, branch };
}

// ── (1) REVERT DURING THE GATE — gateBaseMainHead captured BEFORE the revert, mirroring the card's own
//        9-step sequence verbatim. ──────────────────────────────────────────────────────────────────────
{
  console.log("\n— (1) a human reverts the landed commit DURING the gate —");
  const repo = makeRepo("during");
  const { worktreePath, branch } = await makeWorktree(repo, "pcd-proj", "pcd-task-1");
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work for the branch\n");
  commitAll(worktreePath, "feature work", GIT_ID);

  const land = await mergeBranch(repo, branch, "feature landed");
  check("(1) precondition: landed cleanly", land.ok === true);
  const X = headSha(repo);

  const preLanded = await findLandedSquashCommit(repo, branch, "HEAD");
  check("(1) precondition: findLandedSquashCommit proves preLanded", preLanded === X);

  // Captured BEFORE the revert — mirrors service.ts's preLanded producer, read pre-gate.
  const gateBaseMainHead = await resolveGitRef(repo, "HEAD");
  const gateBaseBranchHead = await resolveGitRef(repo, branch);
  check("(1) precondition: gateBaseMainHead captured pre-revert equals X", gateBaseMainHead === X);

  revert(repo, X); // the human/Platform-Lead revert, landing mid-gate
  check("(1) precondition: the revert landed, feature.txt is gone again", !fs.existsSync(path.join(repo, "feature.txt")));
  const headAfterRevert = headSha(repo);

  const result = await mergeBranch(repo, branch, "re-confirm after revert", {}, gateBaseMainHead, gateBaseBranchHead, undefined, undefined, undefined, undefined, true);

  check("(1) REFUSED, not silently re-landed", result.ok === false);
  check("(1) refused with the distinct landedContentDiverged flag", result.landedContentDiverged === true);
  check("(1) feature.txt stays ABSENT — the revert is honored", !fs.existsSync(path.join(repo, "feature.txt")));
  check("(1) no new commit landed — HEAD is still the revert commit", headSha(repo) === headAfterRevert);
  check("(1) canonical index is clean after the refusal (the reset ran)", statusPorcelain(repo) === "");
}

// ── (2) REVERT BEFORE THE RE-CONFIRM — the revert is already on main before gateBaseMainHead is ever
//        read, so `requireCanonicalHead` trivially equals current HEAD and the pre-existing
//        `gateBaseInvalidated` mechanism has NO signal at all; only the staged-diff invariant catches it.
//        ─────────────────────────────────────────────────────────────────────────────────────────────
{
  console.log("\n— (2) the revert already landed BEFORE the re-confirm ever captured gateBaseMainHead —");
  const repo = makeRepo("before");
  const { worktreePath, branch } = await makeWorktree(repo, "pcd-proj", "pcd-task-2");
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work for the branch\n");
  commitAll(worktreePath, "feature work", GIT_ID);

  const land = await mergeBranch(repo, branch, "feature landed");
  check("(2) precondition: landed cleanly", land.ok === true);
  const X = headSha(repo);

  revert(repo, X); // lands BEFORE the re-confirm's own producer ever reads anything
  check("(2) precondition: the revert landed, feature.txt is gone again", !fs.existsSync(path.join(repo, "feature.txt")));

  const preLanded = await findLandedSquashCommit(repo, branch, "HEAD");
  check("(2) precondition: findLandedSquashCommit STILL proves preLanded (X is still reachable + trailer-matched)", preLanded === X);

  const gateBaseMainHead = await resolveGitRef(repo, "HEAD"); // reads the ALREADY-reverted HEAD
  const gateBaseBranchHead = await resolveGitRef(repo, branch);
  const headAfterRevert = gateBaseMainHead;
  check("(2) precondition: gateBaseMainHead captures the already-reverted HEAD, not X", gateBaseMainHead !== X);

  const result = await mergeBranch(repo, branch, "re-confirm after revert", {}, gateBaseMainHead, gateBaseBranchHead, undefined, undefined, undefined, undefined, true);

  check("(2) REFUSED even though requireCanonicalHead trivially matches current HEAD", result.ok === false && result.landedContentDiverged === true);
  check("(2) feature.txt stays ABSENT", !fs.existsSync(path.join(repo, "feature.txt")));
  check("(2) no new commit landed", headSha(repo) === headAfterRevert);
  check("(2) canonical index is clean", statusPorcelain(repo) === "");
}

// ── (3) CONTROL: an unrelated edit to the SAME file (a non-overlapping hunk) during the gate — must
//        still merge cleanly, never false-positive on expectAlreadyLanded. Construction verified
//        empirically (a top-of-file branch insert + a bottom-of-file main insert merge with ZERO staged
//        diff — `git merge --squash` recognizes the branch's own hunk is already present). ─────────────
{
  console.log("\n— (3) CONTROL: an unrelated edit to the SAME file (non-overlapping hunk) during the gate —");
  const repo = makeRepo("samefile");
  const nums = Array.from({ length: 20 }, (_, i) => String(i + 1));
  fs.writeFileSync(path.join(repo, "nums.txt"), `${nums.join("\n")}\n`);
  commitAll(repo, "seed nums.txt", GIT_ID);

  const { worktreePath, branch } = await makeWorktree(repo, "pcd-proj", "pcd-task-3");
  const branchLines = [...nums];
  branchLines.splice(2, 0, "INSERTED-BY-BRANCH"); // a hunk near the TOP
  fs.writeFileSync(path.join(worktreePath, "nums.txt"), `${branchLines.join("\n")}\n`);
  commitAll(worktreePath, "branch: insert near top", GIT_ID);

  const land = await mergeBranch(repo, branch, "feature landed");
  check("(3) precondition: landed cleanly", land.ok === true);
  const X = headSha(repo);

  const preLanded = await findLandedSquashCommit(repo, branch, "HEAD");
  check("(3) precondition: preLanded proven", preLanded === X);
  const gateBaseMainHead = await resolveGitRef(repo, "HEAD");
  const gateBaseBranchHead = await resolveGitRef(repo, branch);

  // UNRELATED edit during the "gate": append a line near the BOTTOM of the same file — a different hunk.
  const current = fs.readFileSync(path.join(repo, "nums.txt"), "utf8").replace(/\n$/, "");
  fs.writeFileSync(path.join(repo, "nums.txt"), `${current}\nINSERTED-BY-MAIN-UNRELATED\n`);
  commitAll(repo, "main: unrelated edit to the same file, different hunk", GIT_ID);

  const result = await mergeBranch(repo, branch, "re-confirm", {}, gateBaseMainHead, gateBaseBranchHead, undefined, undefined, undefined, undefined, true);

  check("(3) CONTROL: still merged:true (no false positive)", result.ok === true);
  check("(3) CONTROL: classified ALREADY_MERGED, no new commit", result.noop === true && result.emptyKind === "ALREADY_MERGED");
  check("(3) CONTROL: the unrelated main edit survives untouched", fs.readFileSync(path.join(repo, "nums.txt"), "utf8").includes("INSERTED-BY-MAIN-UNRELATED"));
}

// ── (4) CONTROL: an unrelated edit to a DIFFERENT file during the gate (the emit-compare-gate-scope-
//        reclassify.mjs (M2) shape) — must still merge cleanly. ───────────────────────────────────────
{
  console.log("\n— (4) CONTROL: an unrelated edit to a DIFFERENT file during the gate —");
  const repo = makeRepo("otherfile");
  const { worktreePath, branch } = await makeWorktree(repo, "pcd-proj", "pcd-task-4");
  fs.writeFileSync(path.join(worktreePath, "feature-p2.txt"), "work for P2\n");
  commitAll(worktreePath, "feat: P2's own work", GIT_ID);

  const land = await mergeBranch(repo, branch, "feature landed");
  check("(4) precondition: landed cleanly", land.ok === true);
  const X = headSha(repo);

  const preLanded = await findLandedSquashCommit(repo, branch, "HEAD");
  check("(4) precondition: preLanded proven", preLanded === X);
  const gateBaseMainHead = await resolveGitRef(repo, "HEAD");
  const gateBaseBranchHead = await resolveGitRef(repo, branch);

  fs.writeFileSync(path.join(repo, "unrelated.txt"), "unrelated main edit\n");
  commitAll(repo, "main: unrelated edit to a different file", GIT_ID);

  const result = await mergeBranch(repo, branch, "re-confirm", {}, gateBaseMainHead, gateBaseBranchHead, undefined, undefined, undefined, undefined, true);

  check("(4) CONTROL: still merged:true", result.ok === true);
  check("(4) CONTROL: classified ALREADY_MERGED", result.noop === true && result.emptyKind === "ALREADY_MERGED");
  check("(4) CONTROL: the unrelated main edit survives untouched", fs.existsSync(path.join(repo, "unrelated.txt")));
}

// ── (5) ROUND 2, ITEM 1 (BLOCKING, closed) — `resetOrSkip` SKIPS the reset because the canonical repo
//        has pre-existing UNSTAGED dirt on an UNRELATED path before this merge attempt even starts —
//        reproduces the Code Reviewer's own observation (the reverted content and the pre-existing dirt
//        BOTH survive, uncommitted, side by side). The refusal's own wording must name the residue,
//        never falsely claim "canonical repo untouched". ─────────────────────────────────────────────
{
  console.log("\n— (5) the dirt-skip path: resetOrSkip cannot run because of pre-existing unrelated unstaged dirt —");
  const repo = makeRepo("dirtskip");
  const { worktreePath, branch } = await makeWorktree(repo, "pcd-proj", "pcd-task-5");
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work for the branch\n");
  commitAll(worktreePath, "feature work", GIT_ID);

  const land = await mergeBranch(repo, branch, "feature landed");
  check("(5) precondition: landed cleanly", land.ok === true);
  const X = headSha(repo);

  revert(repo, X);
  check("(5) precondition: the revert landed, feature.txt is gone again", !fs.existsSync(path.join(repo, "feature.txt")));

  const preLanded = await findLandedSquashCommit(repo, branch, "HEAD");
  check("(5) precondition: preLanded still proven", preLanded === X);
  const gateBaseMainHead = await resolveGitRef(repo, "HEAD");
  const gateBaseBranchHead = await resolveGitRef(repo, branch);

  // Pre-existing UNSTAGED dirt in the CANONICAL repo (not the worktree), on a path totally unrelated to
  // the branch — makes `hadUnstagedDirtAtEntry` true, so `resetOrSkip` SKIPS the cleanup rather than
  // risk discarding it.
  fs.appendFileSync(path.join(repo, "README.md"), "a human's own in-progress edit\n");
  check("(5) precondition: canonical repo genuinely carries pre-existing unstaged dirt", statusPorcelain(repo) !== "");

  const result = await mergeBranch(repo, branch, "re-confirm after revert", {}, gateBaseMainHead, gateBaseBranchHead, undefined, undefined, undefined, undefined, true);

  check("(5) still REFUSED with landedContentDiverged", result.ok === false && result.landedContentDiverged === true);
  check("(5) THE FIX: residuePossible is set — the cleanup could not run", result.residuePossible === true);
  check("(5) the pre-existing unstaged README.md edit survives untouched (resetOrSkip correctly declined to discard it)", fs.readFileSync(path.join(repo, "README.md"), "utf8").includes("a human's own in-progress edit"));
  check("(5) THE BUG THIS CLOSES: the refusal's own reason names the residue, never claims the repo was restored", /residue/i.test(result.reason) && !/restored to its pre-merge state/.test(result.reason));
  // Reproduces the Code Reviewer's own observation: the reverted branch content (feature.txt) sits
  // ADDED next to the pre-existing dirt (README.md), simultaneously — BOTH survive this refusal
  // uncommitted (measured: `git merge --squash` itself re-stages a pre-existing unstaged modification
  // to an unrelated tracked file as part of resolving the merge, so README.md shows as staged-modified
  // here too, not unstaged as a naive before-the-squash mental model would predict — `hadUnstagedDirtAtEntry`
  // is captured ONCE at entry, before the squash ever runs, so the skip decision is unaffected either way).
  const status = statusPorcelain(repo);
  check("(5) reproduces the Code Reviewer's observation: feature.txt added + README.md modified, BOTH present at once (uncommitted)", /A\s+feature\.txt/.test(status) && /M\s+README\.md/.test(status));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the preLanded producer's expectAlreadyLanded invariant refuses a squash that would silently re-land a reverted commit, however the revert's timing relates to the gate, while an unrelated edit (same file or different file) still lands as a clean, gate-free ALREADY_MERGED no-op."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
