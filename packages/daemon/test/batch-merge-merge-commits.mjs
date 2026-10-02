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
//   (6) card f01c219d — an EVIL REVERT merge: the merge commit reverts the branch's own prior change back to
//       its pre-branch content. Textually clean (empty --cc, same as (1)'s genuine no-op forward), so it is
//       skipped as a pure main-forward — but the earlier non-merge commit that made the now-reverted change
//       still replays, re-landing exactly what the merge discarded. Must be DROPPED (content-check), not landed.
//   (7) card f01c219d ROUND 2 — a branch carrying a real forward merge, where main later touches the SAME
//       file in a DIFFERENT hunk after that forward merge: the branch LANDS with BOTH hunks. RED under the
//       round-1 content-check (a raw-tip per-path comparison), which false-dropped this as "diverges".
//   (8) card f01c219d ROUND 2 — a merge-only path (never touched by any non-merge commit) whose resolution
//       keeps the branch's own prior content, discarding a conflicting main change: DROPPED, since the
//       landed result would otherwise silently diverge from the reviewed tip. RED under round 1, which
//       never examined this path at all (not in "paths the non-merge commits touched") and silently landed
//       main's side.
//   (9) card f01c219d ROUND 2 — a sibling candidate landed EARLIER in the same batch touches the same file
//       in a DIFFERENT hunk than a later candidate (which also carries its own forward merge): BOTH land,
//       combining both hunks. RED under round 1, which treated this as the accepted "sibling overlap" false
//       positive and dropped the later candidate.
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
  const r = await assembleBatchBranches(repo, batchWt, [w, other]);
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
  const r = await assembleBatchBranches(repo, batchWt, [w, other]);
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
  const r = await assembleBatchBranches(repo, batchWt, [w]);
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
  const r = await assembleBatchBranches(repo, batchWt, [w]);
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
  const r = await assembleBatchBranches(repo, batchWt, [w]);
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
  const r = await assembleBatchBranches(repo, batchWt, [w]);
  check("(5) a branch with only a forward merge is never landed as a new empty commit", r.landed.every((l) => l.branch !== w.branch || l.noop === true));
}

// ── (6) an EVIL REVERT merge: the merge commit reverts the branch's OWN prior change back to its
//     pre-branch content — textually clean (empty --cc, since every path's result equals one parent
//     exactly), so it is skipped as a pure main-forward; the non-merge commit that MADE the change the
//     merge reverted still replays, re-landing exactly what the merge commit discarded (card f01c219d).
{
  const repo = makeRepo("revert");
  write(repo, "revert-f.txt", "base\n");
  commitAll(repo, "chore(test): add revert-f.txt", GIT_ID);
  const w = await cut(repo, "revert");
  write(w.worktreePath, "revert-f.txt", "worker version\n");
  write(w.worktreePath, "revert-n.txt", "new file from worker\n");
  commitAll(w.worktreePath, "feat(test): revert own change", GIT_ID);
  advanceMain(repo, "main-advance.txt", "adv\n", "chore(test): main advances");
  const mainTip = git(repo, "rev-parse HEAD");
  execSync(`git ${GIT_ID} merge --no-commit --no-ff ${mainTip}`, { cwd: w.worktreePath, stdio: "pipe" });
  // The "evil" resolution: revert the branch's own prior change back to its pre-branch content — nothing
  // forced this (main never touched revert-f.txt); a real worker merge could do this by mistake.
  write(w.worktreePath, "revert-f.txt", "base\n");
  fs.rmSync(path.join(w.worktreePath, "revert-n.txt"));
  execSync("git add -A", { cwd: w.worktreePath });
  execSync(`git ${GIT_ID} commit -q -m "Merge main (reverts own change)"`, { cwd: w.worktreePath });
  check("(6) precondition: the merge's --cc diff is EMPTY (every path resolves to one parent exactly — a 'pure main-forward' by condition ii)",
    git(w.worktreePath, "rev-list --merges -n1 HEAD") !== "" && git(w.worktreePath, "diff-tree --cc --no-commit-id -p -r HEAD").trim() === "");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-revert-${sfx}`);
  const r = await assembleBatchBranches(repo, batchWt, [w]);
  const d = r.dropped.find((x) => x.branch === w.branch);
  check("(6) the revert branch is DROPPED — the content-check catches the lost revert — not landed", !!d && r.landed.length === 0);
  check("(6) the reason names its reviewed tip (the merge sha)", !!d && d.reason.includes(git(w.worktreePath, "rev-parse --short=7 HEAD")));
  check("(6) revert-n.txt is NOT re-landed in the batch worktree", !fs.existsSync(path.join(batchWt, "revert-n.txt")));
  check("(6) revert-f.txt is NOT re-landed with the worker's reverted-away content",
    !fs.existsSync(path.join(batchWt, "revert-f.txt")) || fs.readFileSync(path.join(batchWt, "revert-f.txt"), "utf8") !== "worker version\n");
}

// ── (7) card f01c219d ROUND 2 — false DROP: a forward merge, then main touches the SAME file in a
//     DIFFERENT hunk AFTER that merge. The branch must land with BOTH hunks (round 1's raw-tip per-path
//     comparison false-dropped this). ──
{
  const repo = makeRepo("falsedrop");
  write(repo, "hot.txt", "a\nb\nc\nd\ne\n");
  commitAll(repo, "chore(test): seed hot.txt", GIT_ID);
  const w = await cut(repo, "falsedrop");
  write(w.worktreePath, "hot.txt", "A\nb\nc\nd\ne\n");
  commitAll(w.worktreePath, "feat(test): worker edits line1", GIT_ID);
  advanceMain(repo, "main-advance1.txt", "adv1\n", "chore(test): main advances (unrelated)");
  const fwd = await mergeMainIntoWorktree(repo, w.worktreePath);
  check("(7) precondition: the forward merge is clean (no conflict)", fwd.ok === true && fwd.merged === true);
  check("(7) precondition: the forward merge's --cc diff is EMPTY (pure main-forward)",
    git(w.worktreePath, "diff-tree --cc --no-commit-id -p -r HEAD").trim() === "");
  // Main advances FURTHER, touching hot.txt in a DIFFERENT hunk (line 5) — AFTER the branch's own forward merge.
  advanceMain(repo, "hot.txt", "a\nb\nc\nd\nE\n", "chore(test): main edits hot.txt line5 (after the branch's forward merge)");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-falsedrop-${sfx}`);
  const r = await assembleBatchBranches(repo, batchWt, [w]);
  check("(7) the branch LANDS (not dropped) despite main's later, separate-hunk edit", r.landed.some((l) => l.branch === w.branch) && r.dropped.length === 0);
  check("(7) the landed file carries BOTH hunks — the worker's line1 AND main's line5",
    fs.readFileSync(path.join(batchWt, "hot.txt"), "utf8").replace(/\r/g, "") === "A\nb\nc\nd\nE\n");
}

// ── (8) card f01c219d ROUND 2 — false NEGATIVE: a merge-only path (no non-merge commit ever touches it)
//     whose resolution keeps the branch's own prior content, discarding a conflicting main change. Round 1
//     never examined this path (not in "paths the non-merge commits touched") and silently landed main's
//     side; must now be DROPPED instead of silently diverging from the reviewed tip. ──
{
  const repo = makeRepo("mergeonly");
  write(repo, "shared2.txt", "base\n");
  commitAll(repo, "chore(test): seed shared2.txt", GIT_ID);
  const w = await cut(repo, "mergeonly");
  // The branch's own non-merge commit never touches shared2.txt.
  write(w.worktreePath, "own.txt", "own\n");
  commitAll(w.worktreePath, "feat(test): own work", GIT_ID);
  advanceMain(repo, "shared2.txt", "main v1\n", "chore(test): main advances shared2");
  const mainTipAtMerge = git(repo, "rev-parse HEAD");
  // Manually override shared2.txt back to its pre-branch content during the merge — a resolution git
  // itself would not have required (the branch never touched shared2.txt, so a trivial auto-merge would
  // otherwise just take main's "main v1").
  execSync(`git ${GIT_ID} merge --no-commit --no-ff ${mainTipAtMerge}`, { cwd: w.worktreePath, stdio: "pipe" });
  write(w.worktreePath, "shared2.txt", "base\n");
  execSync("git add -A", { cwd: w.worktreePath });
  execSync(`git ${GIT_ID} commit -q -m "Merge main (keep our own shared2.txt)"`, { cwd: w.worktreePath });
  check("(8) precondition: the merge's --cc diff is EMPTY (resolves to one parent exactly)",
    git(w.worktreePath, "diff-tree --cc --no-commit-id -p -r HEAD").trim() === "");
  // Main advances FURTHER before the batch is cut.
  advanceMain(repo, "main-advance2.txt", "adv2\n", "chore(test): main advances again");
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-mergeonly-${sfx}`);
  const r = await assembleBatchBranches(repo, batchWt, [w]);
  const d = r.dropped.find((x) => x.branch === w.branch);
  check("(8) the branch is DROPPED rather than silently landing main's side", !!d && r.landed.length === 0);
  check("(8) the reason names the shared2.txt divergence", !!d && /shared2\.txt/.test(d.reason));
}

// ── (9) card f01c219d ROUND 2 — the sibling-overlap case round 1 treated as an accepted false positive:
//     a sibling candidate lands EARLIER in the same batch touching the same file in a DIFFERENT hunk than a
//     LATER candidate (which also carries its own forward merge). Both must land, combining both hunks. ──
{
  const repo = makeRepo("sibling");
  write(repo, "hot2.txt", "a\nb\nc\nd\ne\n");
  commitAll(repo, "chore(test): seed hot2.txt", GIT_ID);
  const sibling = await cut(repo, "sibling-earlier");
  write(sibling.worktreePath, "hot2.txt", "A\nb\nc\nd\ne\n");
  commitAll(sibling.worktreePath, "feat(test): sibling edits line1", GIT_ID);
  await new Promise((resolve) => setTimeout(resolve, 1100)); // distinct, later author date for the branch below (landing order is earliest-author-date-first)
  const branch = await cut(repo, "sibling-later");
  write(branch.worktreePath, "hot2.txt", "a\nb\nc\nd\nE\n");
  commitAll(branch.worktreePath, "feat(test): branch edits line5", GIT_ID);
  advanceMain(repo, "main-advance3.txt", "adv3\n", "chore(test): main advances (unrelated)");
  const fwd = await mergeMainIntoWorktree(repo, branch.worktreePath);
  check("(9) precondition: the later branch's forward merge is clean", fwd.ok === true && fwd.merged === true);
  const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmmc-batch-sibling-${sfx}`);
  const r = await assembleBatchBranches(repo, batchWt, [branch, sibling]);
  check("(9) both candidates LAND (neither dropped)",
    r.dropped.length === 0 && r.landed.some((l) => l.branch === sibling.branch) && r.landed.some((l) => l.branch === branch.branch));
  check("(9) the landed file carries BOTH hunks — the sibling's line1 AND the branch's line5",
    fs.readFileSync(path.join(batchWt, "hot2.txt"), "utf8").replace(/\r/g, "") === "A\nb\nc\nd\nE\n");
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
