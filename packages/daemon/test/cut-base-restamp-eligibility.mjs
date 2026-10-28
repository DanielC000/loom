import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cc788ae4 — checkCutBaseRestampEligibility. Design/trust analysis: docs/decisions/cc788ae4-*.md.
//
// Scenario 1: clean linear rebase onto the target → ok:true.
// Scenario 2: branch does not yet contain the target → notAncestor.
// Scenario 3: branch contains the target but carries a merge commit beyond it (a legitimate mainline
//   forward-merge) → mergeCommitSha.
// Scenario 4: branchTip === targetTip → ok:true trivially, branchExtraCount 0.
// Scenario 5: a planted `git replace` object forging ancestry (Check A) — positive (canonicalGit)
//   refuses, control (plain simpleGit) is fooled.
// Scenario 5b: a real 2-parent merge commit with a planted single-parent `git replace` (Check B) —
//   positive (canonicalGit) refuses mergeCommitSha, control (plain simpleGit) is fooled ok:true.
// Scenario 6: a git call that throws (unresolvable sha) → probeFailed.
// Scenario 7: branch over CUT_BASE_RESTAMP_MAX_SCAN commits beyond the target → tooManyCommits.
//
// Run: 1) build daemon (pnpm build), 2) node test/cut-base-restamp-eligibility.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cbre-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { checkCutBaseRestampEligibility, CUT_BASE_RESTAMP_MAX_SCAN } = await import("../dist/git/worktrees.js");
const { canonicalGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cbre@loom -c user.name=cbre";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const tmpDirs = [];
function freshDir(tag) {
  const dir = path.join(os.tmpdir(), `loom-cbre-${tag}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeRepo(tag) {
  const repo = freshDir(`repo-${tag}`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", [..."config user.email cbre@loom".split(" ")], { cwd: repo });
  execFileSync("git", [..."config user.name cbre".split(" ")], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ===================================================================================
  // SCENARIO 1 — a clean linear rebase onto the target lands ok:true.
  // ===================================================================================
  {
    const repo = makeRepo("1");
    const base = git(repo, "rev-parse HEAD");
    // Mainline advances to the target tip BEFORE the (simulated) rebase.
    fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advanced\n");
    commitAll(repo, "main advances", GIT_ID);
    const targetTip = git(repo, "rev-parse HEAD");
    // The worker's own branch, rebased LINEARLY onto targetTip (plain commits, single parent each).
    execFileSync("git", ["checkout", "-q", "-b", "loom/task-1", targetTip], { cwd: repo });
    fs.writeFileSync(path.join(repo, "worker-1a.txt"), "worker work 1a\n");
    commitAll(repo, "worker commit 1a", GIT_ID);
    fs.writeFileSync(path.join(repo, "worker-1b.txt"), "worker work 1b\n");
    commitAll(repo, "worker commit 1b", GIT_ID);
    const branchTip = git(repo, "rev-parse HEAD");

    const gitInst = canonicalGit(repo, 15_000);
    const result = await checkCutBaseRestampEligibility(gitInst, 15_000, branchTip, targetTip);
    check("(1) ok:true", result.ok === true);
    check("(1) branchExtraCount is exactly 2 (the two worker commits)", result.branchExtraCount === 2);
    check("(1) no notAncestor/mergeCommitSha/tooManyCommits/probeFailed set", !result.notAncestor && !result.mergeCommitSha && !result.tooManyCommits && !result.probeFailed);
  }

  // ===================================================================================
  // SCENARIO 2 — the branch does NOT yet contain the target tip → notAncestor.
  // ===================================================================================
  {
    const repo = makeRepo("2");
    const base = git(repo, "rev-parse HEAD");
    const defaultBranch = git(repo, "symbolic-ref --short HEAD");
    // Worker's own branch, cut from `base`, with its OWN work — never incorporating a later mainline advance.
    execFileSync("git", ["checkout", "-q", "-b", "loom/task-2", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "worker-2.txt"), "worker work 2\n");
    commitAll(repo, "worker commit 2", GIT_ID);
    const branchTip = git(repo, "rev-parse HEAD");
    // Mainline advances AFTER the branch was cut — the branch never incorporated this.
    execFileSync("git", ["checkout", "-q", defaultBranch], { cwd: repo });
    fs.writeFileSync(path.join(repo, "main-advance-2.txt"), "main advanced 2\n");
    commitAll(repo, "main advances 2", GIT_ID);
    const targetTip = git(repo, "rev-parse HEAD");

    const gitInst = canonicalGit(repo, 15_000);
    const result = await checkCutBaseRestampEligibility(gitInst, 15_000, branchTip, targetTip);
    check("(2) ok:false", result.ok === false);
    check("(2) classified notAncestor", result.notAncestor === true);
    check("(2) no mergeCommitSha/tooManyCommits/probeFailed set", !result.mergeCommitSha && !result.tooManyCommits && !result.probeFailed);
  }

  // ===================================================================================
  // SCENARIO 3 — the branch contains the target but carries a merge commit beyond it → refused, EVEN
  // for a legitimate union-forward merge of the current mainline (owner's fail-closed ruling).
  // ===================================================================================
  {
    const repo = makeRepo("3");
    const base = git(repo, "rev-parse HEAD");
    const defaultBranch = git(repo, "symbolic-ref --short HEAD");
    // Worker's own branch, cut from base.
    execFileSync("git", ["checkout", "-q", "-b", "loom/task-3", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "worker-3.txt"), "worker work 3\n");
    commitAll(repo, "worker commit 3", GIT_ID);
    // Mainline advances to the target tip.
    execFileSync("git", ["checkout", "-q", defaultBranch], { cwd: repo });
    fs.writeFileSync(path.join(repo, "main-advance-3.txt"), "main advanced 3\n");
    commitAll(repo, "main advances 3", GIT_ID);
    const targetTip = git(repo, "rev-parse HEAD");
    // The worker branch now union-merges the current mainline (a LEGITIMATE forward-merge, exactly what
    // mergeMainIntoWorktree does in production) — this is the shape being deliberately refused.
    execFileSync("git", ["checkout", "-q", "loom/task-3"], { cwd: repo });
    execFileSync("git", ["merge", "--no-edit", "-q", defaultBranch], { cwd: repo });
    const branchTip = git(repo, "rev-parse HEAD");
    check("(3 setup) the branch's own tip IS a merge commit", Number(git(repo, `rev-list --count --merges ${targetTip}..${branchTip}`)) === 1);
    check("(3 setup) the branch DOES contain the target (union-merge ancestry)",
      git(repo, `merge-base ${targetTip} ${branchTip}`) === targetTip);

    const gitInst = canonicalGit(repo, 15_000);
    const result = await checkCutBaseRestampEligibility(gitInst, 15_000, branchTip, targetTip);
    check("(3) ok:false — refused DESPITE the merge being a legitimate mainline forward-merge", result.ok === false);
    check("(3) classified mergeCommitSha, naming the merge commit", result.mergeCommitSha === branchTip);
    check("(3) no notAncestor/tooManyCommits/probeFailed set", !result.notAncestor && !result.tooManyCommits && !result.probeFailed);
  }

  // ===================================================================================
  // SCENARIO 4 — branchTip === targetTip (nothing beyond the target) → ok:true trivially.
  // ===================================================================================
  {
    const repo = makeRepo("4");
    const targetTip = git(repo, "rev-parse HEAD");
    const gitInst = canonicalGit(repo, 15_000);
    const result = await checkCutBaseRestampEligibility(gitInst, 15_000, targetTip, targetTip);
    check("(4) ok:true (trivial)", result.ok === true);
    check("(4) branchExtraCount is exactly 0", result.branchExtraCount === 0);
  }

  // ===================================================================================
  // SCENARIO 5 — a planted `git replace` object forging ancestry; canonicalGit (positive) refuses,
  // a plain replace-honoring wrapper (control) is fooled.
  // ===================================================================================
  {
    const repo = makeRepo("5");
    const base = git(repo, "rev-parse HEAD");
    // Mainline advances to the target tip.
    fs.writeFileSync(path.join(repo, "main-advance-5.txt"), "main advanced 5\n");
    commitAll(repo, "main advances 5", GIT_ID);
    const targetTip = git(repo, "rev-parse HEAD");
    // An UNRELATED "atlas" branch, cut from `base` (never incorporating targetTip) — genuinely diverged,
    // the exact shape Check A must refuse.
    execFileSync("git", ["checkout", "-q", "-b", "atlas-5", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-5.txt"), "atlas work 5\n");
    commitAll(repo, "atlas work 5", GIT_ID);
    const branchTip = git(repo, "rev-parse HEAD");
    check("(5 setup) targetTip is genuinely NOT an ancestor of branchTip (the cross-lineage precondition)",
      (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", targetTip, branchTip], { cwd: repo }); return false; } catch { return true; } })());
    // Forge a commit carrying branchTip's OWN tree but targetTip as its PARENT, then plant it as a `git
    // replace` for branchTip — a replace-honoring merge-base now wrongly resolves "targetTip is an
    // ancestor of branchTip" to TRUE, exactly the false "the branch contains the target" Check A exists
    // to prevent. execFileSync (argv, no shell) — a shell-string `git(repo, ...)` call mangles the
    // "^{tree}" suffix on Windows (cmd.exe treats "^" as its own escape character).
    const branchTree = execFileSync("git", ["rev-parse", `${branchTip}^{tree}`], { cwd: repo }).toString().trim();
    const forged = execFileSync("git", ["-c", "user.email=cbre@loom", "-c", "user.name=cbre", "commit-tree", branchTree, "-p", targetTip], { cwd: repo }).toString().trim();
    execFileSync("git", ["replace", branchTip, forged], { cwd: repo });
    check("(5 setup) WITH replace refs honored, merge-base is fooled into resolving to targetTip",
      git(repo, `merge-base ${targetTip} ${branchTip}`) === targetTip);

    const positiveGit = canonicalGit(repo, 15_000); // production's real, replace-disabling instance
    const positive = await checkCutBaseRestampEligibility(positiveGit, 15_000, branchTip, targetTip);
    check("(5 positive) canonicalGit is NOT fooled — ok:false, notAncestor", positive.ok === false && positive.notAncestor === true);

    const controlGit = simpleGit(repo); // a plain, replace-honoring wrapper (no core.useReplaceRefs=false)
    const control = await checkCutBaseRestampEligibility(controlGit, 15_000, branchTip, targetTip);
    check("(5 control) a plain replace-honoring wrapper IS fooled — ok:true (RED where the positive case is GREEN)", control.ok === true);
  }

  // ===================================================================================
  // SCENARIO 5b (Code Review fix round) — a REAL 2-parent merge commit with a planted single-parent
  // `git replace` on it; canonicalGit (positive) refuses mergeCommitSha, a plain replace-honoring
  // wrapper (control) is fooled into ok:true, wrongly accepting the merge as if it were a plain commit.
  // ===================================================================================
  {
    const repo = makeRepo("5b");
    const targetTip = git(repo, "rev-parse HEAD");
    // The worker's own branch: ONE plain commit (w1) cut from targetTip.
    execFileSync("git", ["checkout", "-q", "-b", "loom/task-5b", targetTip], { cwd: repo });
    fs.writeFileSync(path.join(repo, "worker-5b.txt"), "worker work 5b\n");
    commitAll(repo, "worker commit 5b", GIT_ID);
    const w1 = git(repo, "rev-parse HEAD");
    // A sibling branch, ALSO cut from targetTip, with its own plain commit — genuinely new content
    // (unlike merging targetTip itself back in, which git treats as "already up to date" and creates NO
    // commit even with `--no-ff`, since there'd be nothing to bring in).
    execFileSync("git", ["checkout", "-q", "-b", "sibling-5b", targetTip], { cwd: repo });
    fs.writeFileSync(path.join(repo, "sibling-5b.txt"), "sibling work 5b\n");
    commitAll(repo, "sibling commit 5b", GIT_ID);
    const sibling = git(repo, "rev-parse HEAD");
    // A REAL 2-parent merge commit M: merging the sibling's genuinely new content into the worker branch.
    execFileSync("git", ["checkout", "-q", "loom/task-5b"], { cwd: repo });
    execFileSync("git", ["merge", "--no-ff", "--no-edit", "-q", "sibling-5b"], { cwd: repo });
    const m = git(repo, "rev-parse HEAD");
    check("(5b setup) M is genuinely NOT the same commit as either parent (a real merge happened)", m !== w1 && m !== sibling);
    check("(5b setup) M is a real 2-parent commit", Number(execFileSync("git", ["cat-file", "-p", m], { cwd: repo }).toString().split("\n").filter((l) => l.startsWith("parent ")).length) === 2);
    const branchTip = m;
    // Forge a commit sharing M's own tree but with ONLY w1 as its parent (M's real first parent), then
    // plant it as a `git replace` for M — a replace-honoring reader of M now sees a single-parent commit.
    const mTree = execFileSync("git", ["rev-parse", `${m}^{tree}`], { cwd: repo }).toString().trim();
    const forgedM = execFileSync("git", ["-c", "user.email=cbre@loom", "-c", "user.name=cbre", "commit-tree", mTree, "-p", w1], { cwd: repo }).toString().trim();
    execFileSync("git", ["replace", m, forgedM], { cwd: repo });
    check("(5b setup) WITH replace refs honored, cat-file -p reports M as single-parent",
      execFileSync("git", ["cat-file", "-p", m], { cwd: repo }).toString().split("\n").filter((l) => l.startsWith("parent ")).length === 1);

    const positiveGit = canonicalGit(repo, 15_000); // production's real, replace-disabling instance
    const positive = await checkCutBaseRestampEligibility(positiveGit, 15_000, branchTip, targetTip);
    check("(5b positive) canonicalGit is NOT fooled — ok:false, mergeCommitSha names the real merge commit", positive.ok === false && positive.mergeCommitSha === m);

    const controlGit = simpleGit(repo); // a plain, replace-honoring wrapper (no core.useReplaceRefs=false)
    const control = await checkCutBaseRestampEligibility(controlGit, 15_000, branchTip, targetTip);
    check("(5b control) a plain replace-honoring wrapper IS fooled — ok:true (RED where the positive case is GREEN)", control.ok === true);
  }

  // ===================================================================================
  // SCENARIO 6 — a git call that THROWS (an unresolvable sha) → probeFailed, never a confirmed verdict.
  // ===================================================================================
  {
    const repo = makeRepo("6");
    const targetTip = git(repo, "rev-parse HEAD");
    const bogusBranchTip = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // never committed anywhere in this repo
    const gitInst = canonicalGit(repo, 15_000);
    const result = await checkCutBaseRestampEligibility(gitInst, 15_000, bogusBranchTip, targetTip);
    check("(6) ok:false", result.ok === false);
    check("(6) classified probeFailed — the git call itself threw, never a confirmed pass/refusal", result.probeFailed === true);
    check("(6) NOT classified notAncestor/mergeCommitSha/tooManyCommits", !result.notAncestor && !result.mergeCommitSha && !result.tooManyCommits);
    // Sanity: a genuinely resolvable pair (self against self) still resolves fine — proves the bogus-sha
    // failure above is about resolvability, not a broken harness/timeout.
    const selfResult = await checkCutBaseRestampEligibility(gitInst, 15_000, targetTip, targetTip);
    check("(6 control) a real, present sha against itself resolves ok:true (harness sanity)", selfResult.ok === true);
  }

  // ===================================================================================
  // SCENARIO 7 — the branch carries more commits beyond the target than CUT_BASE_RESTAMP_MAX_SCAN →
  // refused (tooManyCommits), never scanned unboundedly.
  // ===================================================================================
  {
    const repo = makeRepo("7");
    const targetTip = git(repo, "rev-parse HEAD");
    const targetTree = execFileSync("git", ["rev-parse", `${targetTip}^{tree}`], { cwd: repo }).toString().trim();
    // One commit over the cap. Building this many REAL commits through the working tree (write + add +
    // commit per iteration) is far too slow for a test — chain plain `commit-tree` objects directly onto
    // the object database (reusing targetTip's own tree unchanged; content is irrelevant to this check,
    // only the PARENT COUNT/chain length is) and move the branch ref to the tip in ONE `update-ref` call.
    const overCap = CUT_BASE_RESTAMP_MAX_SCAN + 1;
    let tip = targetTip;
    for (let i = 0; i < overCap; i++) {
      tip = execFileSync("git", ["-c", "user.email=cbre@loom", "-c", "user.name=cbre", "commit-tree", targetTree, "-p", tip, "-m", `worker commit 7-${i}`], { cwd: repo }).toString().trim();
    }
    execFileSync("git", ["update-ref", "refs/heads/loom/task-7", tip], { cwd: repo });
    const branchTip = git(repo, "rev-parse loom/task-7");
    const gitInst = canonicalGit(repo, 30_000);
    const result = await checkCutBaseRestampEligibility(gitInst, 30_000, branchTip, targetTip);
    check("(7) ok:false", result.ok === false);
    check("(7) classified tooManyCommits", result.tooManyCommits === true);
    check(`(7) branchExtraCount reports the real, over-cap count (${overCap})`, result.branchExtraCount === overCap);
    check("(7) no notAncestor/mergeCommitSha/probeFailed set", !result.notAncestor && !result.mergeCommitSha && !result.probeFailed);
  }
} finally {
  for (const dir of tmpDirs) cleanupPathSync(dir);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a clean linear rebase onto the target lands ok:true, a branch not yet containing the target refuses (notAncestor), a branch carrying ANY merge commit beyond the target refuses (mergeCommitSha) even for a legitimate mainline forward-merge, a trivial branchTip===targetTip resolves ok:true, a planted git-replace ancestry forgery (Check A) and a planted git-replace on a real 2-parent merge commit (Check B, scenario 5b) are both defeated by canonicalGit but fool a plain replace-honoring wrapper, an unresolvable sha fails probeFailed (never a confirmed verdict), and a branch over the scan cap refuses (tooManyCommits) rather than scanning unboundedly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
