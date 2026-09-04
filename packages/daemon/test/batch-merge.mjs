import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH MERGE GATE (card dbc6f660 — gate N ready branches once; card 6801c0a1 — land each branch's OWN
// commits INDIVIDUALLY, never squashed, only the branch's LAST commit carrying the Loom-Worker-Branch
// trailer — see git/batch-merge.ts's own header doc for the full correction).
// REAL git on temp repos, no claude, no live daemon, no Db/SessionService — the batching primitive
// (git/batch-merge.ts) is gate-mechanism-agnostic, so it's fully exercised with a fake `runGate` callback.
//
// Proves:
//   (1) GREEN K=3 — a batch of 3 clean (single-commit) branches lands 3 commits on canonical main, each
//       carrying its own Loom-Worker-Branch trailer, and zero merge commits.
//   (2) RED K=3 — a failing batch gate falls back: canonical main is left COMPLETELY untouched, and every
//       candidate is reported so the caller can re-gate each individually.
//   (3) CONFLICT DROP — a branch that conflicts with an earlier one in the SAME batch is dropped without
//       failing the batch; the other two still land.
//   (4) FORFEIT — canonical main advancing DURING the (simulated) gate is caught at the fast-forward step
//       and refused, never landing unverified content; canonical main ends up exactly at the advanced sha.
//   (5) SHAPE (card 6801c0a1 DoD-4) — K=2, branch A has 3 commits + branch B has 1: main gains 4 commits,
//       in order, zero merge commits; only A's LAST commit carries A's trailer.
//   (6) MERGE-COMMIT-IN-RANGE — a branch carrying its own merge commit (a real stale-base auto-forward
//       shape) is dropped cleanly rather than mis-landed.
//   (9) pathSetStamped (card 1d3f500e) — a forced failure of the follow-up Loom-Worker-Base/PathSet amend
//       surfaces as a structured `pathSetStamped:false` on the landed branch (previously only a
//       console.warn), and is DISTINCT from a noop landing, which omits the field entirely rather than
//       reporting `false` for a stamp it never attempted.
// Also covers computeBatchSize's fixed K = min(ready, maxWorkers) rule.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const { createWorktree, getTaskMergedInfo, __resetMergedCommitMapCacheForTest } = await import("../dist/git/worktrees.js");
const { assembleBatchBranches, fastForwardCanonicalMain, runBatchedMerge, computeBatchSize } =
  await import("../dist/git/batch-merge.js");
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
  execSync(`git init -q && git config user.email bm@loom && git config user.name bm && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

/** Cut a fresh worker branch off `repo`'s current HEAD, commit one file to it, and return its identity —
 *  mirrors what a real worker's worktree looks like by the time a manager wants to merge it. */
async function cutBranch(repo, label, file, content) {
  const taskId = `bm-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  execSync(`git add . && git ${GIT_ID} commit -q -m "${label}"`, { cwd: worktreePath });
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
    execSync(`git add . && git ${GIT_ID} commit -q -m "${message}"`, { cwd: worktreePath });
  }
  return { workerSessionId: `bm-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}

// ── computeBatchSize: fixed K = min(ready, maxWorkers), never adaptive ─────────────────────────────────
check("computeBatchSize(5, 4) === 4 (capped by maxWorkers)", computeBatchSize(5, 4) === 4);
check("computeBatchSize(2, 4) === 2 (capped by ready count)", computeBatchSize(2, 4) === 2);
check("computeBatchSize(0, 4) === 0", computeBatchSize(0, 4) === 0);
check("computeBatchSize(4, 4) === 4 (exact match)", computeBatchSize(4, 4) === 4);

const passGate = async () => ({ passed: true });
const failGate = async () => ({ passed: false, reason: "simulated test failure" });

try {
  // ── (1) GREEN K=3 ──────────────────────────────────────────────────────────────────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-green-${sfx}`);
    makeRepo(repo);
    const a = await cutBranch(repo, "a", "feature-a.txt", "work a\n");
    const b = await cutBranch(repo, "b", "feature-b.txt", "work b\n");
    const c = await cutBranch(repo, "c", "feature-c.txt", "work c\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-green-${sfx}`);

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [a, b, c], passGate);

    check("(1) ok:true", result.ok === true);
    check("(1) all 3 landed, 0 dropped", result.landed.length === 3 && result.dropped.length === 0);
    check("(1) gatePassed:true", result.gatePassed === true);
    const headAfter = git(repo, "rev-parse HEAD");
    check("(1) canonical main advanced to the batch head", headAfter === result.batchHeadSha && headAfter !== baseMainSha);
    check("(1) canonical main gained exactly 3 new commits", git(repo, `rev-list --count ${baseMainSha}..HEAD`) === "3");
    check("(1) zero merge commits on main", git(repo, `log --merges ${baseMainSha}..HEAD --format=%H`) === "");
    for (const w of [a, b, c]) {
      check(`(1) a Loom-Worker-Branch trailer for ${w.branch} landed on main`,
        git(repo, `log ${baseMainSha}..HEAD --format=%B`).includes(`Loom-Worker-Branch: ${w.branch}`));
    }
    for (const f of ["feature-a.txt", "feature-b.txt", "feature-c.txt"]) {
      check(`(1) ${f} present on canonical main after fast-forward`, fs.existsSync(path.join(repo, f)));
    }
  }

  // ── (2) RED K=3 — falls back, canonical main untouched ────────────────────────────────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-red-${sfx}`);
    makeRepo(repo);
    const a = await cutBranch(repo, "ra", "red-a.txt", "work a\n");
    const b = await cutBranch(repo, "rb", "red-b.txt", "work b\n");
    const c = await cutBranch(repo, "rc", "red-c.txt", "work c\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-red-${sfx}`);

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [a, b, c], failGate);

    check("(2) ok:false", result.ok === false);
    check("(2) gateFailed:true", result.gateFailed === true);
    check("(2) all 3 assembled (landed in the batch worktree) so the caller knows what to re-gate individually",
      result.landed.length === 3);
    check("(2) canonical main COMPLETELY untouched", git(repo, "rev-parse HEAD") === baseMainSha);
    for (const f of ["red-a.txt", "red-b.txt", "red-c.txt"]) {
      check(`(2) ${f} did NOT land on canonical main`, !fs.existsSync(path.join(repo, f)));
    }
  }

  // ── (3) CONFLICT DROP — a conflicting branch drops out, the other two still land ──────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-conflict-${sfx}`);
    makeRepo(repo);
    fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "seed shared.txt"`, { cwd: repo });
    const a = await cutBranch(repo, "ca", "conflict-a.txt", "work a\n");
    // b edits shared.txt on its own branch.
    const bTaskId = `bm-task-cb-${sfx}`;
    const bWt = await createWorktree(repo, projId, bTaskId);
    fs.writeFileSync(path.join(bWt.worktreePath, "shared.txt"), "changed by b\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m cb`, { cwd: bWt.worktreePath });
    const b = { workerSessionId: `bm-wkr-cb-${sfx}`, taskId: bTaskId, branch: bWt.branch, taskTitle: "feat(test): cb" };
    // c ALSO edits shared.txt, differently — will conflict against b once b has already landed in the batch.
    const cTaskId = `bm-task-cc-${sfx}`;
    const cWt = await createWorktree(repo, projId, cTaskId);
    fs.writeFileSync(path.join(cWt.worktreePath, "shared.txt"), "changed by c, differently\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m cc`, { cwd: cWt.worktreePath });
    const c = { workerSessionId: `bm-wkr-cc-${sfx}`, taskId: cTaskId, branch: cWt.branch, taskTitle: "feat(test): cc" };

    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-conflict-${sfx}`);
    const assembled = await assembleBatchBranches(batchWt, [a, b, c]);

    check("(3) 2 landed (a, b)", assembled.landed.length === 2);
    check("(3) 1 dropped (c, conflicting with b)", assembled.dropped.length === 1);
    check("(3) the dropped branch is c", assembled.dropped[0]?.branch === c.branch);
    check("(3) the drop is flagged as a real conflict", assembled.dropped[0]?.conflict === true);
    check("(3) canonical main untouched by assembly alone (batching happens in the dedicated worktree)",
      git(repo, "rev-parse HEAD") === baseMainSha);

    // The batch proceeds with the 2 that landed — a single conflicting branch never fails the whole batch.
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [a, b, c], passGate);
    check("(3) batch still succeeds with the 2 survivors", result.ok === true && result.landed.length === 2);
    check("(3) conflict-a.txt and shared.txt(b) land; c's own edit does not",
      fs.existsSync(path.join(repo, "conflict-a.txt")) &&
      fs.readFileSync(path.join(repo, "shared.txt"), "utf8").trim() === "changed by b");
  }

  // ── (4) FORFEIT — main advances mid-gate, fast-forward refuses rather than landing unverified ─────────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-forfeit-${sfx}`);
    makeRepo(repo);
    const a = await cutBranch(repo, "fa", "forfeit-a.txt", "work a\n");
    const b = await cutBranch(repo, "fb", "forfeit-b.txt", "work b\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-forfeit-${sfx}`);

    // Simulate a real race: something ELSE lands on canonical main WHILE the batch's gate is "running" —
    // this is exactly what the injected runGate callback stands in for.
    let advancedSha;
    const gateThatRacesMain = async () => {
      fs.writeFileSync(path.join(repo, "unrelated-human-commit.txt"), "meanwhile, on main\n");
      execSync(`git add . && git ${GIT_ID} commit -q -m "unrelated human commit"`, { cwd: repo });
      advancedSha = git(repo, "rev-parse HEAD");
      return { passed: true };
    };

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [a, b], gateThatRacesMain);

    check("(4) ok:false", result.ok === false);
    check("(4) forfeited:true (not misreported as an ordinary gate failure)", result.forfeited === true);
    check("(4) gatePassed:true (the gate itself was green — the forfeit is a separate, later check)", result.gatePassed === true);
    check("(4) canonical main ends up EXACTLY at the advanced commit — no partial/unverified landing",
      git(repo, "rev-parse HEAD") === advancedSha);
    for (const f of ["forfeit-a.txt", "forfeit-b.txt"]) {
      check(`(4) ${f} did NOT land on canonical main`, !fs.existsSync(path.join(repo, f)));
    }
    check("(4) the unrelated human commit is intact", fs.existsSync(path.join(repo, "unrelated-human-commit.txt")));
  }

  // ── (5) DoD-4 SHAPE TEST (card 6801c0a1) — K=2, branch A has 3 commits, branch B has 1: main must gain
  //     4 commits, IN ORDER, with ZERO merge commits — the whole point of this card: a batched landing
  //     preserves each branch's own commits individually, never squashing them into one-per-branch. ─────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-shape-${sfx}`);
    makeRepo(repo);
    const a = await cutBranchMultiCommit(repo, "shape-a", [
      { file: "shape-a-1.txt", content: "a1\n", message: "feat(test): shape a commit 1" },
      { file: "shape-a-2.txt", content: "a2\n", message: "feat(test): shape a commit 2" },
      { file: "shape-a-3.txt", content: "a3\n", message: "feat(test): shape a commit 3" },
    ]);
    const b = await cutBranch(repo, "shape-b", "shape-b.txt", "b1\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-shape-${sfx}`);

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [a, b], passGate);

    check("(5) ok:true", result.ok === true);
    check("(5) 2 branches landed (not per-commit)", result.landed.length === 2 && result.dropped.length === 0);
    // THE DISCRIMINATING ASSERTION: 4 commits, not 2. This is the exact check that FAILS against the
    // original shipped assembly (`b577f43`, `git merge --squash` per branch — see this file's own header
    // doc for the correction) — that implementation would have landed exactly 2 commits here (one per
    // branch), collapsing A's 3 commits into 1. POSITIVE-CONTROLLED: verified RED against a `git checkout
    // HEAD -- git/batch-merge.ts` revert to that shipped squash implementation (rebuilt + re-run,
    // `rev-list --count` read 2, not 4), then GREEN again after restoring this card's implementation — see
    // this card's worker report for the transcript.
    check("(5) canonical main gained exactly 4 new commits (3 from A + 1 from B, none squashed)",
      git(repo, `rev-list --count ${baseMainSha}..HEAD`) === "4");
    check("(5) zero merge commits on main", git(repo, `log --merges ${baseMainSha}..HEAD --format=%H`) === "");
    const shapeSubjects = git(repo, `log --reverse --format=%s ${baseMainSha}..HEAD`).split("\n");
    check("(5) commits land IN ORDER: A's 3 (oldest-first), then B's 1", JSON.stringify(shapeSubjects) === JSON.stringify([
      "feat(test): shape a commit 1", "feat(test): shape a commit 2", "feat(test): shape a commit 3", "shape-b",
    ]));
    const shapeShas = git(repo, `log --reverse --format=%H ${baseMainSha}..HEAD`).split("\n");
    const shapeBodies = shapeShas.map((s) => git(repo, `log -1 --format=%B ${s}`));
    check("(5) exactly ONE of A's commits carries A's Loom-Worker-Branch trailer (the tip, not all 3)",
      shapeBodies.filter((body) => body.includes(`Loom-Worker-Branch: ${a.branch}`)).length === 1);
    check("(5) A's trailer lands on A's LAST commit specifically, not an earlier one",
      shapeBodies[2].includes(`Loom-Worker-Branch: ${a.branch}`) &&
      !shapeBodies[0].includes("Loom-Worker-Branch") && !shapeBodies[1].includes("Loom-Worker-Branch"));
    check("(5) B's single commit carries B's own trailer", shapeBodies[3].includes(`Loom-Worker-Branch: ${b.branch}`));
    // NEGATIVE CONTROL: a branch name this batch never had must NOT appear in any trailer — proves the
    // `.includes` checks above are discriminating, not vacuously true on any string.
    check("(5) negative control: a fabricated branch name is absent from every trailer",
      !shapeBodies.some((body) => body.includes("Loom-Worker-Branch: totally-fake-branch-shape-test")));
    for (const f of ["shape-a-1.txt", "shape-a-2.txt", "shape-a-3.txt", "shape-b.txt"]) {
      check(`(5) ${f} present on canonical main after fast-forward`, fs.existsSync(path.join(repo, f)));
    }
  }

  // ── (6) MERGE-COMMIT-IN-RANGE — a branch carrying its own merge commit (e.g. a real stale-base
  //     auto-forward, `mergeMainIntoWorktree`, unioning main mid-work) is DROPPED cleanly, not partially
  //     or incorrectly landed — cherry-pick refuses a merge commit outright, so this must fail closed. ──
  {
    const repo = path.join(os.tmpdir(), `loom-bm-mergecommit-${sfx}`);
    makeRepo(repo);
    const { worktreePath: wtM, branch: brM } = await createWorktree(repo, projId, `bm-task-mc-${sfx}`);
    fs.writeFileSync(path.join(wtM, "mc-1.txt"), "mc1\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "mc commit 1"`, { cwd: wtM });
    // Canonical main advances independently, then gets unioned into the worker's OWN worktree — exactly
    // what a real stale-base auto-forward produces: a genuine merge commit on the worker's own branch.
    fs.writeFileSync(path.join(repo, "mc-main-advance.txt"), "advanced\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "mc: main advances independently"`, { cwd: repo });
    const mainAdvanceSha = git(repo, "rev-parse HEAD");
    execSync(`git ${GIT_ID} merge --no-edit ${mainAdvanceSha}`, { cwd: wtM });
    const m = { workerSessionId: `bm-wkr-mc-${sfx}`, taskId: `bm-task-mc-${sfx}`, branch: brM, taskTitle: "feat(test): mc" };
    const other = await cutBranch(repo, "mc-other", "mc-other.txt", "other\n");

    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-mc-${sfx}`);
    const assembled = await assembleBatchBranches(batchWt, [m, other]);

    check("(6) the merge-commit branch is dropped, not landed", assembled.dropped.some((d) => d.branch === brM));
    check("(6) the drop reason names the merge commit",
      !!assembled.dropped.find((d) => d.branch === brM)?.reason.includes("merge commit"));
    check("(6) the OTHER branch (no merge commit) still lands cleanly",
      assembled.landed.some((l) => l.branch === other.branch));
    check("(6) canonical main untouched by assembly alone", git(repo, "rev-parse HEAD") === baseMainSha);
  }

  // ── (7) Loom-Worker-Base + Loom-Worker-PathSet STAMP (card d62dad73 phase 2, subsumes phase 1) ─────────
  //     EVERY batched branch's tip now carries both trailers, regardless of commit count — a single-commit
  //     branch (phase 1's now-folded-away special case) AND a multi-commit branch alike. Also: a POSITIVE
  //     CONTROL that a wrong/forged digest is REJECTED, DoD-3's "verify against sha^ must FAIL" for a
  //     multi-commit contribution, and a ROBUSTNESS case for the exact divergence this card's own
  //     investigation found (a clean, non-conflicting rename-following cherry-pick) — the stamped digest
  //     must reflect the LANDED file name, not the branch's own pre-landing file name.
  {
    const repo = path.join(os.tmpdir(), `loom-bm-pathset-${sfx}`);
    makeRepo(repo);
    const single = await cutBranch(repo, "ps-single", "ps-single.txt", "single commit work\n");
    const multi = await cutBranchMultiCommit(repo, "ps-multi", [
      { file: "ps-multi-1.txt", content: "m1\n", message: "feat(test): ps multi 1" },
      { file: "ps-multi-2.txt", content: "m2\n", message: "feat(test): ps multi 2" },
      { file: "ps-multi-3.txt", content: "m3\n", message: "feat(test): ps multi 3" },
    ]);
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-pathset-${sfx}`);

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [single, multi], passGate);
    check("(7) ok:true", result.ok === true);
    check("(7) both branches landed", result.landed.length === 2 && result.dropped.length === 0);

    const singleLanded = result.landed.find((l) => l.branch === single.branch);
    const multiLanded = result.landed.find((l) => l.branch === multi.branch);
    const singleBody = git(repo, `log -1 --format=%B ${singleLanded.sha}`);
    const multiBody = git(repo, `log -1 --format=%B ${multiLanded.sha}`);

    // ── (7a) single-commit branch: Base is redundant with sha^ here, but stamped uniformly anyway ────────
    check("(7a) single-commit branch's tip carries a Loom-Worker-PathSet trailer", /Loom-Worker-PathSet: \S+/.test(singleBody));
    check("(7a) single-commit branch's tip ALSO carries a Loom-Worker-Base trailer", /Loom-Worker-Base: \S+/.test(singleBody));
    const expectedSingleDigest = pathSetDigest(repo, `${singleLanded.sha}~1`, singleLanded.sha);
    check("(7a) the stamped digest matches an independent recomputation from the commit's own sha^..sha",
      singleBody.includes(`Loom-Worker-PathSet: ${expectedSingleDigest}`));

    // ── (7b) multi-commit branch: NOW stamped too (phase 2 subsumes phase 1's single-commit-only gate) ───
    check("(7b) multi-commit branch's tip carries a Loom-Worker-PathSet trailer (no longer omitted)", /Loom-Worker-PathSet: \S+/.test(multiBody));
    check("(7b) multi-commit branch's tip carries a Loom-Worker-Base trailer", /Loom-Worker-Base: \S+/.test(multiBody));
    const multiBaseMatch = multiBody.match(/Loom-Worker-Base: (\S+)/);
    // THE DISCRIMINATING ASSERTION: the digest must cover ALL 3 commits (batchHeadBefore..tip), not just
    // the tip's own last commit (sha^..sha, which would only see ps-multi-3.txt) — this is exactly the gap
    // phase 1 could not close and phase 2 exists to close.
    const expectedMultiDigest = pathSetDigest(repo, multiBaseMatch[1], multiLanded.sha);
    const wrongTipOnlyDigest = pathSetDigest(repo, `${multiLanded.sha}~1`, multiLanded.sha);
    check("(7b) precondition: the TRUE full-contribution digest differs from a tip-only (sha^..sha) digest",
      expectedMultiDigest !== wrongTipOnlyDigest);
    check("(7b) the stamped digest is the TRUE full-contribution one (batchHeadBefore..tip, all 3 commits), not tip-only",
      multiBody.includes(`Loom-Worker-PathSet: ${expectedMultiDigest}`) && !multiBody.includes(`Loom-Worker-PathSet: ${wrongTipOnlyDigest}`));
    check("(7b) the stamped Base is exactly this branch's own batchHeadBefore (single's landed sha, since single landed first)",
      multiBaseMatch[1] === singleLanded.sha);

    // ── (7c) POSITIVE: after both branches are deleted + gc'd, verification recovers to "pathset" tier ───
    removeWorktree(repo, single.worktreePath);
    removeWorktree(repo, multi.worktreePath);
    deleteBranchAndGc(repo, single.branch);
    deleteBranchAndGc(repo, multi.branch);
    __resetMergedCommitMapCacheForTest();
    const singleBoard = await getTaskMergedInfo(repo, single.taskId);
    check("(7c) getTaskMergedInfo resolves the single-commit branch after deletion+gc", singleBoard !== null && singleLanded.sha.startsWith(singleBoard.sha));
    check("(7c) single-commit verification tier is \"pathset\"", singleBoard?.verification === "pathset");
    __resetMergedCommitMapCacheForTest();
    const multiBoard = await getTaskMergedInfo(repo, multi.taskId);
    check("(7c) getTaskMergedInfo resolves the MULTI-commit branch after deletion+gc (was impossible under phase 1)", multiBoard !== null && multiLanded.sha.startsWith(multiBoard.sha));
    check("(7c) multi-commit verification tier is \"pathset\", not the weaker \"trailer-only\"", multiBoard?.verification === "pathset");
  }

  // ── (7f) DoD-3 for PHASE 2 — a multi-commit contribution verified against sha^ (i.e. the Base trailer
  //     lost/stripped) MUST FAIL, not silently pass. Proves Loom-Worker-Base is load-bearing, not
  //     decorative: without it, verification falls back to sha^..sha, which only spans this branch's LAST
  //     commit — a real digest mismatch against the true (larger) stored PathSet, correctly rejected. ─────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-pathset-nobase-${sfx}`);
    makeRepo(repo);
    const multi3 = await cutBranchMultiCommit(repo, "ps-nobase", [
      { file: "ps-nobase-1.txt", content: "n1\n", message: "feat(test): ps nobase 1" },
      { file: "ps-nobase-2.txt", content: "n2\n", message: "feat(test): ps nobase 2" },
      { file: "ps-nobase-3.txt", content: "n3\n", message: "feat(test): ps nobase 3" },
    ]);
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-nobase-${sfx}`);
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [multi3], passGate);
    check("(7f) precondition: the 3-commit branch landed", result.ok === true && result.landed.length === 1);
    const landed = result.landed[0];
    check("(7f) precondition: canonical main gained exactly 3 commits (all 3, not squashed)",
      git(repo, `rev-list --count ${baseMainSha}..HEAD`) === "3");

    // Strip ONLY the Loom-Worker-Base trailer, keeping the real Loom-Worker-PathSet (the TRUE 3-commit
    // digest) untouched — simulates the exact case DoD-3 asks for: verifying a multi-commit contribution
    // with no base override, so verifyPersistedPathSet falls back to sha^.
    const realBody = git(repo, `log -1 --format=%B ${landed.sha}`);
    check("(7f) precondition: the real commit carries both trailers before stripping", /Loom-Worker-Base: \S+/.test(realBody) && /Loom-Worker-PathSet: \S+/.test(realBody));
    const subject = realBody.split("\n\n")[0];
    const branchTrailerLine = realBody.match(/^Loom-Worker-Branch: .+$/m)[0];
    const pathSetTrailerLine = realBody.match(/^Loom-Worker-PathSet: .+$/m)[0];
    execSync(`git ${GIT_ID} commit --amend -q -m "${subject.replace(/"/g, '\\"')}" -m "${branchTrailerLine}" -m "${pathSetTrailerLine}"`, { cwd: repo });
    const strippedSha = git(repo, "rev-parse HEAD");
    check("(7f) precondition: the Base trailer is really gone now", !/Loom-Worker-Base:/.test(git(repo, `log -1 --format=%B ${strippedSha}`)));

    removeWorktree(repo, multi3.worktreePath);
    deleteBranchAndGc(repo, multi3.branch);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, multi3.taskId);
    check("(7f) DoD-3: verifying the TRUE multi-commit PathSet against sha^ (no Base trailer) FAILS closed — getTaskMergedInfo returns null, not a false pathset/content pass", board === null);
  }

  // ── (7g) AUTHOR PRESERVATION ACROSS THE PATHSET AMEND — the pre-amend code deliberately invests in
  //     `--author`/`--date` to keep the worker's own authorship (batch-merge.ts); the follow-up
  //     `git commit --amend` that adds Loom-Worker-Base/PathSet relies on git's IMPLICIT default of
  //     preserving author on an unattributed amend, rather than passing `--author`/`--date` again. Only a
  //     discriminating test if the worker's author identity DIFFERS from the identity performing the
  //     amend — every other test in this file uses the SAME identity for both, so this is a dedicated case. ─
  {
    const repo = path.join(os.tmpdir(), `loom-bm-author-${sfx}`);
    makeRepo(repo);
    const taskId = `bm-task-author-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(worktreePath, "author-check.txt"), "authored work\n");
    // Distinct from GIT_ID (bm@loom/bm) — the identity that will later perform the amend in the batch
    // worktree (its own git config, inherited from makeRepo). A broken amend that silently resets author
    // to the CURRENT committer would produce bm/bm@loom here instead — this is what makes it discriminating.
    const WORKER_AUTHOR_NAME = "Worker Author";
    const WORKER_AUTHOR_EMAIL = "worker-author@example.com";
    const WORKER_AUTHOR_DATE_INPUT = "2020-01-01T00:00:00+00:00";
    execSync(`git add author-check.txt`, { cwd: worktreePath });
    execSync(
      `git -c user.name="${WORKER_AUTHOR_NAME}" -c user.email=${WORKER_AUTHOR_EMAIL} commit -q -m "author-check work"`,
      { cwd: worktreePath, env: { ...process.env, GIT_AUTHOR_DATE: WORKER_AUTHOR_DATE_INPUT, GIT_COMMITTER_DATE: WORKER_AUTHOR_DATE_INPUT } },
    );
    // Read git's OWN %aI normalization back (it renders a "+00:00" offset as "Z") rather than assuming a
    // format, so this doesn't depend on guessing git's exact ISO-8601 rendering rules.
    const WORKER_AUTHOR_DATE = git(worktreePath, "log -1 --format=%aI");
    const worker = { workerSessionId: `bm-wkr-author-${sfx}`, taskId, branch, taskTitle: "feat(test): author-check" };
    // NOTE: `<`, `>`, `|` are all cmd.exe metacharacters (redirection / pipe) — query each field with its
    // OWN plain `git log` call rather than a delimited multi-field format, or execSync silently
    // mis-parses the command on Windows.
    check("(7g) precondition: the worker's own commit is authored under the DISTINCT identity, not GIT_ID's",
      git(worktreePath, "log -1 --format=%an") === WORKER_AUTHOR_NAME && git(worktreePath, "log -1 --format=%ae") === WORKER_AUTHOR_EMAIL);

    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-batch-author-${sfx}`);
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [worker], passGate);
    check("(7g) precondition: it landed and carries a PathSet trailer (went through the amend path)",
      result.ok === true && result.landed.length === 1 && /Loom-Worker-PathSet: \S+/.test(git(repo, `log -1 --format=%B ${result.landed[0].sha}`)));

    const landedSha = result.landed[0].sha;
    check("(7g) the AMENDED (PathSet-bearing) commit still carries the worker's own author name+email, not the batch identity's",
      git(repo, `log -1 --format=%an ${landedSha}`) === WORKER_AUTHOR_NAME && git(repo, `log -1 --format=%ae ${landedSha}`) === WORKER_AUTHOR_EMAIL);
    check("(7g) the AMENDED commit still carries the worker's own original author date",
      git(repo, `log -1 --format=%aI ${landedSha}`) === WORKER_AUTHOR_DATE);
  }

  // ── (7d) POSITIVE CONTROL — a WRONG/forged Loom-Worker-PathSet digest is REJECTED, not silently trusted ─
  //     Proves the check can actually FAIL: without this, a check that always reports "verified" would
  //     pass every test above for the wrong reason.
  {
    const repo = path.join(os.tmpdir(), `loom-bm-pathset-forged-${sfx}`);
    makeRepo(repo);
    const wrong = await cutBranch(repo, "ps-forged", "ps-forged.txt", "forged branch work\n");
    const decoy = await cutBranch(repo, "ps-decoy", "ps-decoy.txt", "decoy branch work\n");
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
    execSync(`git add . && git ${GIT_ID} commit -q -m "seed renameable.txt"`, { cwd: repo });

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
    execSync(`git add . && git ${GIT_ID} commit -q -m "editor: edit the shared file"`, { cwd: editorWt.worktreePath });
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
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat(test): trailer commit 1" -m "Claude-Session: https://claude.ai/code/session_FAKE001"`, { cwd: taintedWt });
    fs.writeFileSync(path.join(taintedWt, "trailer-2.txt"), "t2\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "fix(test): trailer commit 2" -m "Body text." -m "Claude-Session: https://claude.ai/code/session_FAKE002"`, { cwd: taintedWt });
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

  // ── fastForwardCanonicalMain: a no-op batch (nothing landed on top) is a safe success, not a refusal ──
  {
    const repo = path.join(os.tmpdir(), `loom-bm-noop-${sfx}`);
    makeRepo(repo);
    const baseMainSha = git(repo, "rev-parse HEAD");
    const ff = await fastForwardCanonicalMain(repo, baseMainSha, baseMainSha);
    check("(noop) fast-forward to the same sha succeeds without touching anything", ff.ok === true);
  }
} finally {
  // best-effort cleanup of the daemon-managed worktrees dir this test created under; harmless if absent.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a green batch lands each branch's own commits INDIVIDUALLY (never squashed) with no merge commits, each branch's LAST commit carrying its Loom-Worker-Branch trailer; a red batch falls back with canonical main untouched; a conflicting branch (or one carrying its own merge commit) drops out without failing the batch; and main advancing mid-gate is caught at the fast-forward and refused rather than landing unverified."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
