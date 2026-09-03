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
// Also covers computeBatchSize's fixed K = min(ready, maxWorkers) rule.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const { createWorktree } = await import("../dist/git/worktrees.js");
const { assembleBatchBranches, fastForwardCanonicalMain, runBatchedMerge, computeBatchSize } =
  await import("../dist/git/batch-merge.js");

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
