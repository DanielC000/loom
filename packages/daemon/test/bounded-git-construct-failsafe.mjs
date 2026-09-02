import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 0f965ab7: simpleGit(<nonexistent dir>) throws GitConstructError SYNCHRONOUSLY. Seven
// git/worktrees.ts helpers built their bounded git handle via boundedGit/boundedMergeGit/boundedDiffGit
// OUTSIDE their own try/catch, so that synchronous construct throw escaped every one of their catches
// (which only guard the calls made INSIDE them) and rejected the function outright instead of honouring
// its own documented fail-safe contract. This re-runs the reviewer's own probe table against a
// nonexistent repoPath, directly against dist/git/worktrees.js: every listed function must fail safe to
// its documented default, never throw — except listCheckedOutBranches, which is DOCUMENTED to throw and
// must keep doing so (DoD-2 — do NOT "fix" it).
// Run: 1) build daemon (pnpm build), 2) node test/bounded-git-construct-failsafe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bgcf-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const {
  worktreeHasWork, findLandedSquashCommit, precheckWorkerDone, detectStrandedWork,
  isBranchMerged, resolveMainlineBranch, listMergedLoomBranches, deleteBranch, deleteBranches,
  countCommitsBehind, listCheckedOutBranches, createWorktree, gitConstructFailure,
} = await import("../dist/git/worktrees.js");
const { simpleGit } = await import("simple-git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bgcf@loom -c user.name=bgcf";

// A repoPath / worktreePath that has NEVER existed on disk.
const noRepo = path.join(os.tmpdir(), `loom-bgcf-no-such-repo-${Date.now()}-${process.pid}`);
const noWorktree = path.join(os.tmpdir(), `loom-bgcf-no-such-worktree-${Date.now()}-${process.pid}`);
const branch = "loom/whatever";

// A real, existing repo — used both as an existing-dir CONSTRUCT control and to give precheckWorkerDone
// a REAL worktree (so its worktree-status step succeeds and execution actually reaches the repoPath-based
// git call this card's DoD-5 "uncontained path" is about, instead of short-circuiting earlier).
const realRepo = path.join(os.tmpdir(), `loom-bgcf-real-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(realRepo, { recursive: true });
fs.writeFileSync(path.join(realRepo, "README.md"), "# bgcf\n");
execSync(`git init -q && git config user.email bgcf@loom && git config user.name bgcf && git add . && git commit -q -m init`, { cwd: realRepo });

try {
  // ── CONSTRUCT CONTROLS — prove the fixture is genuinely provocative, not vacuously safe ───────────
  {
    let threw = false;
    try { simpleGit(noRepo); } catch { threw = true; }
    check("(control-a) simpleGit(<nonexistent dir>) really does throw synchronously (the defect this fixes)", threw);
  }
  {
    let threw = false;
    try { simpleGit(realRepo); } catch { threw = true; }
    check("(control-b) simpleGit(<existing dir>) constructs fine (fixture isn't provocative for the wrong reason)", !threw);
  }

  // ── THE STUB MUST NOT BE A THENABLE — a `get` trap that answers EVERY property (including `then`)
  //     makes the stub satisfy JS's thenable check: `await`ing it, returning it from an `async` function,
  //     or `Promise.resolve(stub)` would then call `stub.then(resolve, reject)`. A trapped `then` that
  //     ignores both callbacks and returns its OWN fresh (unattached) rejected promise instead of
  //     invoking either one leaves the OUTER awaiting promise never settling on its own — AND, measured
  //     directly (mutation-tested against this exact assertion with the exclusion below reverted): under
  //     Node's default `--unhandled-rejections=throw`, that orphaned, never-`.catch()`ed rejected promise
  //     CRASHES THE WHOLE PROCESS almost immediately (an uncaught-exception exit, not a graceful timeout)
  //     — worse than a hang, not milder. No current caller awaits the {git} handle directly (every one
  //     destructures it and calls a method), so this is LATENT, not reachable today — this proves the
  //     primitive is safe for the caller that doesn't exist yet. BOUNDED by a real race timeout regardless
  //     (belt-and-suspenders): if some future Node/host configuration ever tolerates the orphaned
  //     rejection instead of crashing on it, the outer promise genuinely never settling must still FAIL
  //     this test on a bounded clock, not hang the whole suite.
  {
    const stub = gitConstructFailure(new Error("simulated construct failure"));
    check("(thenable-a) stub.then is undefined (not trapped into a rejecting function)", stub.then === undefined);
    check("(thenable-b) stub.catch is undefined", stub.catch === undefined);
    check("(thenable-c) stub.finally is undefined", stub.finally === undefined);
    check("(thenable-d) a symbol-keyed property (Symbol.toPrimitive) is undefined, not trapped", stub[Symbol.toPrimitive] === undefined);

    const RACE_TIMEOUT_MS = 1000;
    let settled = false;
    let timedOut = false;
    await Promise.race([
      Promise.resolve(stub).then(() => { settled = true; }, () => { settled = true; }),
      new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, RACE_TIMEOUT_MS)),
    ]);
    check(`(thenable-e) Promise.resolve(stub) SETTLES within ${RACE_TIMEOUT_MS}ms (not a broken thenable that hangs forever)`,
      settled === true && timedOut === false);
  }

  // ── THE RED HALF: the reviewer's own probe table, re-run against a nonexistent repoPath ───────────
  // Every one of these must FAIL SAFE to its documented default, never throw/reject.
  let threw;

  threw = false; let r1;
  try { r1 = await worktreeHasWork(noRepo, noWorktree, branch); } catch { threw = true; }
  check("(1) worktreeHasWork(nonexistent repoPath) fails safe to true, never throws (POSITIVE CONTROL, pre-fixed)", threw === false && r1 === true);

  threw = false; let r2;
  try { r2 = await findLandedSquashCommit(noRepo, branch); } catch { threw = true; }
  check("(2) findLandedSquashCommit(nonexistent repoPath) fails safe to null, never throws (POSITIVE CONTROL, pre-fixed)", threw === false && r2 === null);

  threw = false; let r4;
  try { r4 = await detectStrandedWork(noRepo, noWorktree, branch); } catch { threw = true; }
  check("(4) detectStrandedWork(nonexistent repoPath) fails safe to {stranded:false}, never throws", threw === false && r4.stranded === false);

  threw = false; let r5;
  try { r5 = await isBranchMerged(noRepo, branch); } catch { threw = true; }
  check("(5) isBranchMerged(nonexistent repoPath) fails safe to false, never throws", threw === false && r5 === false);

  threw = false; let r6;
  try { r6 = await resolveMainlineBranch(noRepo); } catch { threw = true; }
  check("(6) resolveMainlineBranch(nonexistent repoPath) fails safe to null, never throws", threw === false && r6 === null);

  threw = false; let r7;
  try { r7 = await listMergedLoomBranches(noRepo, "main"); } catch { threw = true; }
  check("(7) listMergedLoomBranches(nonexistent repoPath) fails safe to {branches:[],failed:true}, never throws",
    threw === false && Array.isArray(r7.branches) && r7.branches.length === 0 && r7.failed === true);

  threw = false;
  try { await deleteBranch(noRepo, branch); } catch { threw = true; }
  check("(8) deleteBranch(nonexistent repoPath) is swallowed (best-effort), never throws", threw === false);

  // deleteBranches (the batched variant, NOT individually named in the card's seven — same unwrapped
  // boundedGit(repoPath) construct call, fixed for free by the shared-helper design) falls back to
  // per-branch deleteBranch/branchExistsInRepo on a batch failure, both already fail-safe.
  threw = false; let r8b;
  try { r8b = await deleteBranches(noRepo, [branch]); } catch { threw = true; }
  check("(8b) deleteBranches(nonexistent repoPath) fails safe to {deleted:[]}, never throws",
    threw === false && Array.isArray(r8b?.deleted) && r8b.deleted.length === 0);

  threw = false; let r9;
  try { r9 = await countCommitsBehind(noRepo, branch); } catch { threw = true; }
  check("(9) countCommitsBehind(nonexistent repoPath) fails safe to undefined, never throws", threw === false && r9 === undefined);

  // (10) listCheckedOutBranches is DOCUMENTED to throw — DoD-2: this fix must NOT change that.
  threw = false;
  try { await listCheckedOutBranches(noRepo); } catch { threw = true; }
  check("(10) listCheckedOutBranches(nonexistent repoPath) STILL THROWS (documented, deliberately unfixed)", threw === true);

  // ── (3) precheckWorkerDone — the UNCONTAINED path (DoD-5). Give it a REAL, clean, ahead-of-base
  //     worktree (so step 1 succeeds and execution actually reaches the repoPath-based rev-list in step
  //     2) paired with a nonexistent repoPath, mirroring "canonical repo moved/renamed while the worktree
  //     itself is still physically intact" — the exact TRIGGER the card names.
  const { worktreePath: pWt, branch: pBranch } = await createWorktree(realRepo, "bgcfProj", "bgcf-task-precheck");
  fs.writeFileSync(path.join(pWt, "work.txt"), "real committed work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "precheck work"`, { cwd: pWt });
  threw = false; let r3;
  try { r3 = await precheckWorkerDone(noRepo, pWt, pBranch); } catch { threw = true; }
  check("(3) precheckWorkerDone(nonexistent repoPath, REAL clean+ahead worktree) fails safe (uncommitted:false, zeroAhead:false), never throws",
    threw === false && r3?.uncommitted === false && r3?.zeroAhead === false);

  // ── SANITY: the same probes against a REAL repo behave normally, not vacuously "always fail-safe" ──
  const realBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: realRepo }).toString().trim();
  check("(sanity) isBranchMerged(realRepo, <its own branch>, <itself>) is genuinely true (a branch is always merged with itself)",
    (await isBranchMerged(realRepo, realBranch, realBranch)) === true);
  check("(sanity) resolveMainlineBranch(realRepo) — a plain `git init` repo with no origin — resolves null (KNOWN GAP, not a bug)",
    (await resolveMainlineBranch(realRepo)) === null);
} finally {
  fs.rmSync(realRepo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boundedGit/boundedMergeGit/boundedDiffGit fail safe on a nonexistent repoPath for every caller, EXCEPT the deliberately-throwing listCheckedOutBranches."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
