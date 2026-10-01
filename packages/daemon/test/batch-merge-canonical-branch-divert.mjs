import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 — `fastForwardCanonicalMain` (git/batch-merge.ts) already takes `withCanonicalIndexLock`
// around its HEAD check + `git merge --ff-only` (round 6, card 24c0bdba), so a GitWriter write call can no
// longer INTERLEAVE with the fast-forward itself (see merge-quarantine-lock-convergence.mjs's own "(ff)"
// scenario, and this file's own scenario 1, below). But the forfeit check it runs BEFORE taking that lock's
// own action compares only `currentMainSha` to `expectedBaseSha` — a `git checkout -b <name>` that ran
// entirely BEFORE this function was even called (e.g. during the batch's own gate run, which can take many
// minutes and does NOT hold the lock) moves canonical HEAD to a brand-new branch pointing at the SAME
// commit. The sha-only check cannot see this: `currentMainSha` still reads as `expectedBaseSha`, so the
// fast-forward proceeds — ON THE DIVERTED BRANCH, not mainline. Reproduced directly in scenario 2 below,
// against the REAL pre-fix behavior (no `expectedBaseBranch` passed): `fastForwardCanonicalMain` reports
// `{ok:true}` while the batch's content actually landed on a stray branch and mainline's own ref was never
// touched.
//
// THE FIX: `BatchGitDeps.expectedBaseBranch` (optional, mirroring `mergeBranchLocked`'s own optional
// `expectedBranchTip`) pins the branch canonical HEAD was checked out on when the batch was cut. When set,
// `fastForwardCanonicalMain` refuses (typed `branchDiverted: true`) BOTH before the `--ff-only` (never
// mutating anything) and after an apparently-successful one (`verifyLanded`, re-reading HEAD's sha AND the
// checked-out branch) — see docs/decisions/b801bad0-batch-fast-forward-pins-and-reverifies-the-checked-out-
// branch.md for the full narrative.
//
// SCENARIO 1 — a batch fast-forward racing a REAL, concurrent solo squash merge (mergeBranch) through the
// shared canonical index lock. Not a new defect (the lock already serializes the two), but no existing
// test drives this pair concurrently against the REAL lock — proves the already-fixed lock still holds
// specifically for fastForwardCanonicalMain, deterministically: the squash's own commit is delayed by a
// hanging pre-commit hook WHILE it holds the lock, so the fast-forward (fired mid-hook) is forced to queue
// behind it and, once it finally runs, sees main having genuinely advanced — a clean, deterministic forfeit,
// never a corrupted/interleaved landing.
//
// SCENARIO 2 — the real defect: a GitWriter.createBranch() checkout diverts canonical HEAD to a new branch
// at the SAME commit. UNPINNED (no `expectedBaseBranch`) reproduces the latent bug directly against the
// real, unmodified current code (RED: this card's own fix narrows but does not remove the unpinned path —
// it remains "today's behavior" by design, see BatchGitDeps's own doc). PINNED proves the fix: the SAME
// divert is refused, canonical repo untouched.
//
// SCENARIO 3 — a fake gitFactory proves the POST-ff verification independently of the pre-check: even when
// the pre-merge branch read reports the correct branch, a divert "discovered" only by the POST-merge
// re-read still refuses rather than reporting a false `ok:true`.
//
// SCENARIO 4 (fix round, Code Review MINOR 2) — a FAILED post-ff re-read (the `!post` branch of
// `verifyLanded`, e.g. a timeout) is distinct from scenario 3's successful-but-wrong re-read: the
// `--ff-only` itself did not throw, so the landing almost certainly happened, it just could not be
// confirmed. Typed `unverified: true`, never `branchDiverted: true` — a confirmed divert implies something
// is actively wrong with the checkout, while an unverified one implies only that THIS read failed.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-canonical-branch-divert.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { mergeBranch } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { GitWriter } = await import(pathToFileURL(path.join(distGitDir, "writer.js")).href);
const { fastForwardCanonicalMain } = await import(pathToFileURL(path.join(distGitDir, "batch-merge.js")).href);
const { boundedSimpleGit } = await import(pathToFileURL(path.join(distGitDir, "bounded.js")).href);
const { nonInteractiveEnv } = await import(pathToFileURL(path.join(distGitDir, "writer.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bfd@loom -c user.name=bfd";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const HOOK_SLEEP_S = 3;
const WRITER_FIRE_DELAY_MS = 600;
const GUARD_MS = 25_000;

const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bfd-repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email bfd@loom && git config user.name bfd && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content, tag) {
  const wt = path.join(os.tmpdir(), `loom-bfd-wt-${branch.replace(/\//g, "-")}-${tag}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

function installHangingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\n`);
  fs.chmodSync(hookPath, 0o755);
}

const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

// Cuts the "batch's own landed content" directly on a side branch from the repo's CURRENT HEAD (no real
// createWorktree needed — fastForwardCanonicalMain only needs a reachable targetSha), then returns to the
// mainline branch — mirrors what a real batch worktree's HEAD looks like by the time the gate goes green.
function cutBatchContent(repo, mainlineBranch, tag) {
  execSync(`git checkout -q -b batch-content-${tag}`, { cwd: repo });
  fs.writeFileSync(path.join(repo, `batch-${tag}.txt`), `batch-${tag}\n`);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "batch content ${tag}"`, { cwd: repo });
  const targetSha = git(repo, "rev-parse HEAD");
  execSync(`git checkout -q ${mainlineBranch}`, { cwd: repo });
  return targetSha;
}

async function scenarioFfRacingSquash(tag) {
  const repo = makeRepo(tag);
  const mainlineBranch = git(repo, "rev-parse --abbrev-ref HEAD");
  const baseSha = git(repo, "rev-parse HEAD");
  const soloBranch = "loom/ffrs-solo";
  makeWorktree(repo, soloBranch, "solo.txt", `solo-content-${tag}\n`, tag);
  const targetSha = cutBatchContent(repo, mainlineBranch, tag);
  installHangingHook(repo);

  // Fire the solo squash — its own `git commit` will hit the hanging hook and block for HOOK_SLEEP_S,
  // holding `withCanonicalIndexLock` the whole time.
  const mergePromise = mergeBranch(repo, soloBranch, "Solo Squash Card");

  // Fire the batch ff WHILE the squash is still blocked in the hook — it must queue behind the lock the
  // squash already holds, so by the time its own closure runs, the squash has ALREADY committed.
  await new Promise((r) => setTimeout(r, WRITER_FIRE_DELAY_MS));
  const ffPromise = fastForwardCanonicalMain(repo, baseSha, targetSha, { expectedBaseBranch: mainlineBranch });

  const [mergeResult, ffResult] = await Promise.all([
    Promise.race([mergePromise, guard(GUARD_MS, "merge")]),
    Promise.race([ffPromise, guard(GUARD_MS, "ff")]),
  ]);

  check("[race] [guard] the solo squash settled within the test's patience window (not wedged)", mergeResult?.__guardFired !== "merge");
  check("[race] [guard] the batch ff settled within the test's patience window (not wedged)", ffResult?.__guardFired !== "ff");
  check("[race] the solo squash itself succeeds (queued cleanly behind/ahead of the ff, never corrupted)", mergeResult?.ok === true);
  // Deterministic by construction: the ff fires mid-hook, strictly after the squash already holds the lock,
  // so the ff can only run once the squash's own commit has landed — main has genuinely moved by then.
  check("[race] the batch ff correctly FORFEITS rather than landing on top of an unvalidated squash commit", ffResult?.ok === false && ffResult?.forfeited === true);
  check("[race] the forfeit is NOT misreported as a branch divert", ffResult?.branchDiverted !== true);
  check("[race] canonical main carries the solo squash's own content (it was never corrupted/rolled back)", fs.existsSync(path.join(repo, "solo.txt")));
  check("[race] canonical main does NOT carry the forfeited batch's content", !fs.existsSync(path.join(repo, `batch-${tag}.txt`)));
  // No same-target re-confirm control here: `batch-content-${tag}` branched off the ORIGINAL baseSha, so
  // once main has genuinely advanced past it (the squash's own commit), `targetSha` is no longer a
  // descendant of main's new tip — a real `--ff-only` against it would correctly fail as non-fast-forwardable,
  // same as production's own behavior (a forfeited batch falls back to re-gating each candidate against the
  // NEW main, never a blind re-call with the stale target).
}

async function scenarioDivertedByCreateBranch(tag) {
  const repo = makeRepo(tag);
  const mainlineBranch = git(repo, "rev-parse --abbrev-ref HEAD");
  const baseSha = git(repo, "rev-parse HEAD");
  const targetSha = cutBatchContent(repo, mainlineBranch, tag);

  // DIVERT: a human REST GitWriter.createBranch() call lands while the batch's own gate is (hypothetically)
  // still running — canonical HEAD moves to a BRAND NEW branch at the SAME commit as mainline.
  const strayBranch1 = `stray-divert-${tag}`;
  const writer = new GitWriter(repo);
  const createResult = await writer.createBranch(strayBranch1);
  check(`[divert ${tag}] precondition: the diverting createBranch() itself succeeded`, createResult?.ok === true);
  check(`[divert ${tag}] precondition: canonical HEAD is now on the stray branch, not mainline`, git(repo, "rev-parse --abbrev-ref HEAD") === strayBranch1);
  check(`[divert ${tag}] precondition: the divert did not move the commit — same sha as before`, git(repo, "rev-parse HEAD") === baseSha);

  // UNPINNED (no expectedBaseBranch): reproduces the real pre-fix-shaped bug against the REAL current
  // code's documented fallback behavior — the sha-only forfeit check passes trivially, so the ff-only
  // succeeds ON THE STRAY BRANCH.
  const unpinned = await fastForwardCanonicalMain(repo, baseSha, targetSha);
  check(`[divert ${tag}] UNPINNED: the sha-only check cannot see the divert, so ok:true`, unpinned.ok === true);
  check(`[divert ${tag}] UNPINNED: it actually landed on the STRAY branch`, git(repo, `rev-parse refs/heads/${strayBranch1}`) === targetSha);
  check(`[divert ${tag}] UNPINNED: mainline's OWN ref was never advanced — the batch's content never reached it`, git(repo, `rev-parse refs/heads/${mainlineBranch}`) === baseSha);

  // Re-create the SAME divert precondition for the pinned call.
  execSync(`git checkout -q ${mainlineBranch}`, { cwd: repo });
  execSync(`git branch -q -D ${strayBranch1}`, { cwd: repo });
  const strayBranch2 = `stray-divert-2-${tag}`;
  await new GitWriter(repo).createBranch(strayBranch2);
  check(`[divert ${tag}] re-diverted for the pinned call`, git(repo, "rev-parse --abbrev-ref HEAD") === strayBranch2);

  // PINNED (expectedBaseBranch: mainlineBranch) — THE FIX: the same divert is refused outright, before any
  // mutation, canonical repo completely untouched.
  const pinned = await fastForwardCanonicalMain(repo, baseSha, targetSha, { expectedBaseBranch: mainlineBranch });
  check(`[divert ${tag}] PINNED: refuses rather than landing on the wrong branch`, pinned.ok === false);
  check(`[divert ${tag}] PINNED: refusal is typed branchDiverted, distinct from an ordinary forfeit`, pinned.branchDiverted === true && pinned.forfeited !== true);
  check(`[divert ${tag}] PINNED: the stray branch was NOT advanced`, git(repo, `rev-parse refs/heads/${strayBranch2}`) === baseSha);
  check(`[divert ${tag}] PINNED: mainline's own ref still untouched`, git(repo, `rev-parse refs/heads/${mainlineBranch}`) === baseSha);

  // Control: once back on mainline (no divert in effect), the SAME pinned call succeeds normally.
  execSync(`git checkout -q ${mainlineBranch}`, { cwd: repo });
  const control = await fastForwardCanonicalMain(repo, baseSha, targetSha, { expectedBaseBranch: mainlineBranch });
  check(`[divert ${tag}] control: once back on mainline, the pinned ff succeeds normally`, control.ok === true);
  check(`[divert ${tag}] control: mainline actually advanced to the batch's target`, git(repo, `rev-parse refs/heads/${mainlineBranch}`) === targetSha);
}

// Proves the POST-ff re-verification (`verifyLanded`) independently of the pre-check: a gitFactory fake lets
// the pre-merge branch read report the CORRECT branch (so the pre-check passes and the real `--ff-only`
// actually runs) while the POST-merge re-read reports a DIFFERENT branch — simulating a divert the pre-check
// could not have seen. Proves the post-check is not dead code: it independently catches a bad result.
async function scenarioPostVerificationCatchesDivert(tag) {
  const repo = makeRepo(tag);
  const mainlineBranch = git(repo, "rev-parse --abbrev-ref HEAD");
  const baseSha = git(repo, "rev-parse HEAD");
  const targetSha = cutBatchContent(repo, mainlineBranch, tag);

  let combinedCalls = 0;
  function divertAfterMergeGitFactory(repoPath, blockTimeoutMs) {
    const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
    return {
      raw: async (args) => {
        if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
          combinedCalls++;
          // 1st call = the pre-check (reused for the forfeit-sha check too) — let it see the REAL state so
          // the pre-check passes and the real --ff-only actually runs. 2nd call = the post-check
          // (verifyLanded) — fake a wrong branch on an otherwise-correct sha, simulating a divert the
          // pre-check could not have seen.
          if (combinedCalls > 1) return `${targetSha}\nrefs/heads/a-branch-that-does-not-exist\n`;
        }
        return real.raw(args);
      },
    };
  }

  const result = await fastForwardCanonicalMain(repo, baseSha, targetSha, { expectedBaseBranch: mainlineBranch, gitFactory: divertAfterMergeGitFactory });
  check(`[post-verify ${tag}] precondition: the fake's combined-call interception actually fired more than once`, combinedCalls > 1);
  check(`[post-verify ${tag}] the real ff-only DID run (HEAD actually advanced)`, git(repo, `rev-parse refs/heads/${mainlineBranch}`) === targetSha);
  check(`[post-verify ${tag}] but the function still refuses to report ok:true on the FAKE post-merge mismatch`, result.ok === false && result.branchDiverted === true);
}

// Fix round (Code Review MINOR 2): a FAILED post-ff RE-READ (e.g. a timeout) — as opposed to a re-read
// that SUCCEEDS and reports a mismatch (scenario above) — must NOT be reported as a confirmed
// `branchDiverted`. The `--ff-only` call itself did not throw (HEAD genuinely advanced), so this is purely
// a verification failure: typed `unverified: true` instead, distinct from `branchDiverted`.
async function scenarioPostReadFailureIsUnverified(tag) {
  const repo = makeRepo(tag);
  const mainlineBranch = git(repo, "rev-parse --abbrev-ref HEAD");
  const baseSha = git(repo, "rev-parse HEAD");
  const targetSha = cutBatchContent(repo, mainlineBranch, tag);

  let combinedCalls = 0;
  function postReadFailsGitFactory(repoPath, blockTimeoutMs) {
    const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
    return {
      raw: async (args) => {
        if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
          combinedCalls++;
          // 1st call = the pre-check — let it see the REAL state so the real --ff-only actually runs.
          // 2nd call = the post-check (verifyLanded) — simulate a transient read failure (e.g. a timeout),
          // never a wrong-but-readable answer.
          if (combinedCalls > 1) throw new Error("git rev-parse timed out after 10000ms");
        }
        return real.raw(args);
      },
    };
  }

  const result = await fastForwardCanonicalMain(repo, baseSha, targetSha, { expectedBaseBranch: mainlineBranch, gitFactory: postReadFailsGitFactory });
  check(`[post-unverified ${tag}] precondition: the fake's combined-call interception actually fired more than once`, combinedCalls > 1);
  check(`[post-unverified ${tag}] the real ff-only DID run (HEAD actually advanced) despite the post-read failure`, git(repo, `rev-parse refs/heads/${mainlineBranch}`) === targetSha);
  check(`[post-unverified ${tag}] reports ok:false, unverified:true — NOT branchDiverted (the landing almost certainly happened, it just couldn't be confirmed)`, result.ok === false && result.unverified === true && result.branchDiverted !== true);
  check(`[post-unverified ${tag}] observedBranch is absent on this outcome (nothing was read to report)`, result.observedBranch === undefined);
}

try {
  await scenarioFfRacingSquash(`race-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await scenarioDivertedByCreateBranch(`div-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await scenarioPostVerificationCatchesDivert(`post-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await scenarioPostReadFailureIsUnverified(`unv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the batch fast-forward queues cleanly behind a real concurrent solo squash (deterministic forfeit, never corruption), refuses rather than landing on a checkout-diverted branch when the mainline branch is pinned, the post-ff re-verification independently catches a divert the pre-check could not have seen, and a FAILED post-ff re-read (distinct from a successful-but-wrong one) is reported as unverified, never a confirmed divert."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
