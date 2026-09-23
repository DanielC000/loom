import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH MERGE — MERGE COMMITS IN A BRANCH'S RANGE (card bc2240d7).
// Root cause: a solo worker_merge_confirm's union-forward (`mergeMainIntoWorktree`) COMMITS "Merge commit
// '<main>'" onto the WORKER'S OWN branch at confirm START; cancelling the queued confirm does not undo it, and
// merge_batch used to drop every branch whose range held any merge commit — so cancel-then-rebatch dropped all.
// A merge commit is now SKIPPED only when it is a pure main-forward (every non-first parent already on the
// batch HEAD AND an empty `diff-tree --cc`); anything else drops with a reason naming the sha + which condition.
// REAL git on temp repos (no claude, no daemon). The union-forward is produced by the REAL mergeMainIntoWorktree.
//
// Proves:
//   (1) TRAP — a branch carrying the real union-forward merge commit lands its own commits, no merge commit
//       reaches the batch, and the landed TREE equals what a rebase (cherry-pick onto main) would produce.
//   (2) A branch with a forward merge AND own commits on both sides of it lands ALL its own commits, in order,
//       with the trailer on the tip only.
//   (3) A merge that carries HAND-RESOLVED conflict content (second parent IS on main) is DROPPED, reason names
//       the sha and "carries conflict-resolution content" and "rebase onto main". (RED-sensitive to condition ii.)
//   (3b) A textually clean merge that adds content of its own is DROPPED too (skipping it would lose that content).
//   (4) A merge whose second parent is NOT on main is DROPPED, reason names "not reachable from main".
//   (5) A branch that only carries a forward merge (no own commits) is never landed as an empty commit.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-merge-commits.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-bmmc-parent-");
requireHermeticEnv();

const { createWorktree, mergeMainIntoWorktree } = await import("../dist/git/worktrees.js");
const { assembleBatchBranches } = await import("../dist/git/batch-merge.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bmmc@loom -c user.name=bmmc";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `bmmc-proj-${sfx}`;

function makeRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-bmmc-${name}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# bmmc\n");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  execSync(`git init -q && git config user.email bmmc@loom && git config user.name bmmc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
async function cut(repo, label) {
  const taskId = `bmmc-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  return { workerSessionId: `bmmc-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}
async function cutWithFile(repo, label, file, content) {
  const w = await cut(repo, label);
  write(w.worktreePath, file, content);
  commitAll(w.worktreePath, `feat(test): ${label}`, GIT_ID);
  return w;
}
const write = (wt, f, c) => fs.writeFileSync(path.join(wt, f), c);
const advanceMain = (repo, f, c, msg) => { write(repo, f, c); commitAll(repo, msg, GIT_ID); };
const treeOf = (cwd, ref) => git(cwd, `rev-parse ${ref}:`);

// ── (1) TRAP: the REAL union-forward commit on the worker's own branch ──
{
  const repo = makeRepo("trap");
  const w = await cutWithFile(repo, "trap own", "trap-own.txt", "own\n");
  advanceMain(repo, "main-advance.txt", "adv\n", "chore(test): main advances");
  // Exactly what worker_merge_confirm does at confirm START, before its gate queue wait; a later cancel of the
  // queued confirm leaves this merge commit on the branch.
  const fwd = await mergeMainIntoWorktree(repo, w.worktreePath);
  check("(1) precondition: the real union-forward produced a merge commit on the worker branch",
    fwd.ok === true && fwd.merged === true && git(w.worktreePath, `rev-list --merges -n1 ${w.branch}`) !== "");
  const other = await cutWithFile(repo, "trap other", "trap-other.txt", "other\n");
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-trap-${sfx}`);
  const r = await assembleBatchBranches(batchWt, [w, other]);
  check("(1) the forwarded branch LANDS in the batch (not dropped)", r.landed.some((l) => l.branch === w.branch) && !r.dropped.some((d) => d.branch === w.branch));
  check("(1) no merge commit reaches the batch", git(batchWt, `log --merges ${baseMainSha}..HEAD --format=%H`) === "");
  check("(1) no landed subject is a 'Merge ...' subject", !git(batchWt, `log ${baseMainSha}..HEAD --format=%s`).split("\n").some((s) => /^Merge /.test(s)));
  // Landed TREE == what a rebase would produce: cherry-pick the branches' own (non-merge) commits onto main.
  const rb = path.join(os.tmpdir(), `loom-bmmc-rb-${sfx}`);
  git(repo, `worktree add --detach "${rb}" ${baseMainSha}`);
  for (const br of [w.branch, other.branch]) {
    for (const sha of git(repo, `rev-list --reverse --no-merges ${baseMainSha}..${br}`).split("\n").filter(Boolean)) {
      execSync(`git ${GIT_ID} cherry-pick ${sha}`, { cwd: rb });
    }
  }
  check("(1) the landed TREE equals the rebase (cherry-pick onto main) tree — nothing lost, nothing added", treeOf(batchWt, "HEAD") === treeOf(rb, "HEAD"));
  try { git(repo, `worktree remove --force "${rb}"`); } catch { /* best-effort */ }
}

// ── (2) forward merge with own commits on BOTH sides of it ──
{
  const repo = makeRepo("both");
  const w = await cutWithFile(repo, "both 1", "both-1.txt", "1\n");
  advanceMain(repo, "main-advance.txt", "adv\n", "chore(test): main advances");
  await mergeMainIntoWorktree(repo, w.worktreePath);
  write(w.worktreePath, "both-2.txt", "2\n");
  commitAll(w.worktreePath, "feat(test): both 2", GIT_ID);
  const other = await cutWithFile(repo, "both other", "both-other.txt", "o\n");
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-both-${sfx}`);
  const r = await assembleBatchBranches(batchWt, [w, other]);
  check("(2) the branch lands", r.landed.some((l) => l.branch === w.branch));
  const subjects = git(batchWt, `log --reverse --format=%s ${baseMainSha}..HEAD`).split("\n");
  check("(2) both own commits land, in order, no merge",
    subjects.filter((s) => /^feat\(test\): both [12]$/.test(s)).join("|") === "feat(test): both 1|feat(test): both 2"
    && git(batchWt, `log --merges ${baseMainSha}..HEAD --format=%H`) === "");
  const trailerCount = git(batchWt, `log ${baseMainSha}..HEAD --format=%B`).split("\n").filter((l) => l === `Loom-Worker-Branch: ${w.branch}`).length;
  check("(2) the branch's trailer is on exactly one commit (the tip)", trailerCount === 1);
}

// ── (3) hand-resolved conflict merge (second parent IS on main) — must be DROPPED ──
{
  const repo = makeRepo("resolved");
  const w = await cutWithFile(repo, "resolved own", "shared.txt", "worker version\n");
  advanceMain(repo, "shared.txt", "main version\n", "chore(test): main edits shared");
  const mainTip = git(repo, "rev-parse HEAD");
  try { execSync(`git ${GIT_ID} merge --no-edit ${mainTip}`, { cwd: w.worktreePath, stdio: "pipe" }); } catch { /* conflict expected */ }
  write(w.worktreePath, "shared.txt", "hand resolved: both\n"); // the human resolution — real content of its own
  commitAll(w.worktreePath, "Merge main into branch (resolved)", GIT_ID);
  check("(3) precondition: the tip is a merge commit whose --cc diff is non-empty (resolution content)",
    git(w.worktreePath, "rev-list --merges -n1 HEAD") !== "" && git(w.worktreePath, "diff-tree --cc --no-commit-id -p -r HEAD").trim() !== "");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-resolved-${sfx}`);
  const r = await assembleBatchBranches(batchWt, [w]);
  const d = r.dropped.find((x) => x.branch === w.branch);
  check("(3) the hand-resolved merge branch is DROPPED, not landed", !!d && r.landed.length === 0);
  check("(3) the reason names the merge sha", !!d && d.reason.includes(git(w.worktreePath, "rev-parse --short=7 HEAD")));
  check("(3) the reason names the failed condition (resolution content), not 'not reachable'", !!d && /conflict-resolution content/.test(d.reason) && !/not reachable/.test(d.reason));
  check("(3) the reason says to rebase onto main", !!d && /rebase onto main/.test(d.reason));
}

// ── (3b) an EVIL merge: textually clean (no conflict) but the merge commit ITSELF adds content — landing
//     by skipping it would silently lose evil.txt (the sensitive case for condition ii; (3)'s own commit also
//     conflicts on cherry-pick, so it would drop even without ii). ──
{
  const repo = makeRepo("evil");
  const w = await cutWithFile(repo, "evil own", "evil-own.txt", "own\n");
  advanceMain(repo, "main-advance.txt", "adv\n", "chore(test): main advances");
  const mainTip = git(repo, "rev-parse HEAD");
  execSync(`git ${GIT_ID} merge --no-commit --no-ff ${mainTip}`, { cwd: w.worktreePath, stdio: "pipe" });
  write(w.worktreePath, "evil.txt", "content that exists ONLY in the merge commit\n");
  execSync("git add evil.txt", { cwd: w.worktreePath });
  execSync(`git ${GIT_ID} commit -q -m "Merge main (with extra content)"`, { cwd: w.worktreePath });
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-evil-${sfx}`);
  const r = await assembleBatchBranches(batchWt, [w]);
  const d = r.dropped.find((x) => x.branch === w.branch);
  check("(3b) a merge carrying its own content is DROPPED (never skipped, which would lose evil.txt)", !!d && r.landed.length === 0 && !fs.existsSync(path.join(batchWt, "evil-own.txt")));
  check("(3b) the reason names resolution content", !!d && /conflict-resolution content/.test(d.reason));
}

// ── (4) merge whose second parent is NOT on main — must be DROPPED ──
{
  const repo = makeRepo("foreign");
  const w = await cutWithFile(repo, "foreign own", "foreign-own.txt", "own\n");
  const side = await cutWithFile(repo, "foreign side", "side.txt", "side\n");
  execSync(`git ${GIT_ID} merge --no-edit ${side.branch}`, { cwd: w.worktreePath, stdio: "pipe" });
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-foreign-${sfx}`);
  const r = await assembleBatchBranches(batchWt, [w]);
  const d = r.dropped.find((x) => x.branch === w.branch);
  check("(4) a merge of a branch NOT on main is DROPPED", !!d && r.landed.length === 0);
  check("(4) the reason names 'not reachable from main' and 'rebase onto main'", !!d && /not reachable from main/.test(d.reason) && /rebase onto main/.test(d.reason));
}

// ── (5) only a forward merge, no own commits ──
{
  const repo = makeRepo("only");
  const w = await cut(repo, "only");
  advanceMain(repo, "main-advance.txt", "adv\n", "chore(test): main advances");
  await mergeMainIntoWorktree(repo, w.worktreePath);
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-only-${sfx}`);
  const r = await assembleBatchBranches(batchWt, [w]);
  check("(5) a branch with only a forward merge is never landed as a new empty commit", r.landed.every((l) => l.branch !== w.branch || l.noop === true));
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
