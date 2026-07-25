// getWorkerDiffCached test — the perf fix for the polled orchestration-view diff endpoint
// (GET /api/sessions/:id/diff): `reviewQueue.tsx` polls this every 8000ms for a worker awaiting merge;
// `Overview.tsx`/`ReviewPanel.tsx` set no interval at all and refetch on every mount instead (react-query's
// default staleTime:0) — so the real hot path is likely burst mount traffic, not a steady tick. Either way
// workerDiff() always shells out to git (350-415ms/poll in the 2026-07-16 perf profile). getWorkerDiffCached
// wraps it with a git-free freshness proof so an unchanged poll skips the subprocess entirely, while staying
// correct across BOTH a real working-tree write and a genuinely uncommitted edit (the stale-diff trap: HEAD
// sha alone can't see an uncommitted edit, since it never touches a git ref). REAL git on a temp repo
// (worker-diff.mjs style).
//
// Card 31552de1: the freshness PROOF itself (the recursive stat walk in fingerprintWorktree — ~94ms /
// ~1742 stats on a real worktree, measured 2026-07-17) was the actual daemon-side cost, worse than the
// git subprocess it replaces (a separate process) — it ran on EVERY poll, even a cache HIT, because the
// walk IS the cache key and used to run before the cache was ever consulted. getWorkerDiffCached now adds
// a TTL fast path (DIFF_FINGERPRINT_TTL_MS, internal — not exported, tests only prove its externally
// observable behavior): within the TTL of the last REAL walk, a poll is served from cache with ZERO
// walks, verified only by a cheap HEAD re-read. This file adds `deps.fingerprint` (mirrors `deps.compute`)
// as a counting seam on the walk itself, and `deps.now` as an injectable clock so the TTL can be driven
// deterministically without a real sleep.
// LOOM_HOME set before importing dist/* so WORKTREES_DIR is isolated. Run: 1) build daemon, 2) node test/worker-diff-cache.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wdc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const {
  createWorktree, removeWorktree, deleteBranch, workerDiff, fingerprintWorktree,
  getWorkerDiffCached, __resetWorkerDiffCacheForTest, __workerDiffCacheSizeForTest,
} = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add . && git -c user.email=wd@loom -c user.name=wd commit -qm "${msg}"`, { cwd: dir });
};

// Comfortably larger than any reasonable TTL (the fix's own doc suggests 10-15s) without hard-coding the
// internal constant — a test that imported the exact TTL value would just be restating the implementation.
const PAST_TTL_MS = 60_000;

const repo = path.join(os.tmpdir(), `loom-wdc-repo-${Date.now()}`);

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# v1\n");
  execSync(`git init -q && git config user.email wd@loom && git config user.name wd && git add . && git commit -q -m "init"`, { cwd: repo });

  // ── CASE A — TTL fast path: within the TTL a repeat poll performs ZERO stat walks — true for an
  //    uncommitted edit AND for a committed working-tree WRITE (both are working-tree content changes only
  //    the walk can see, so both share the same bounded-staleness budget; `git commit` itself is not what
  //    matters — a commit that writes no new bytes is invisible to the walk at ANY TTL, see (A10) below).
  //    The ONE thing the fast path's cheap HEAD re-read DOES catch immediately, TTL or not, is the
  //    CANONICAL repo's own checked-out branch moving (e.g. another worker's PR landing on main). Once the
  //    TTL elapses, the walk runs again and picks up whatever changed meanwhile.
  {
    __resetWorkerDiffCacheForTest();
    let computeCalls = 0;
    let walkCalls = 0;
    const countingCompute = async (repoPath, opts) => { computeCalls++; return workerDiff(repoPath, opts); };
    const countingFingerprint = async (wt) => { walkCalls++; return fingerprintWorktree(wt); };
    let clock = 1_700_000_000_000;
    const dep = { compute: countingCompute, fingerprint: countingFingerprint, now: () => clock };

    const { worktreePath, branch } = await createWorktree(repo, "projWDC", "cache-aaaa-1111");

    const d1 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A1) baseline diff computed (walk #1, compute #1)", walkCalls === 1 && computeCalls === 1);
    check("(A1) baseline shows no changes yet", !!d1 && d1.filesChanged === 0);

    const d2 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A2) identical immediate repeat poll: zero walks (TTL fast path)", walkCalls === 1);
    check("(A2) identical immediate repeat poll: zero recomputes", computeCalls === 1);
    check("(A2) cached result matches the prior poll", JSON.stringify(d2) === JSON.stringify(d1));

    // Uncommitted edit — no git ref/index changes, so the cheap HEAD re-read alone can't see it. Within
    // the TTL, that's exactly the accepted bounded-staleness tradeoff: served stale, zero walks paid.
    fs.writeFileSync(path.join(worktreePath, "README.md"), "# v1\nWIP uncommitted edit\n");
    const d3 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A3) uncommitted edit WITHIN the TTL: still zero walks", walkCalls === 1);
    check("(A3) uncommitted edit WITHIN the TTL: served stale (bounded staleness, by design)",
      !!d3 && JSON.stringify(d3) === JSON.stringify(d1));

    // Advance the clock past the TTL: the next poll must actually re-walk and pick up the edit.
    clock += PAST_TTL_MS;
    const d4 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A4) after the TTL elapses: a real walk runs", walkCalls === 2);
    check("(A4) after the TTL elapses: the uncommitted edit is now detected", computeCalls === 2);
    check("(A4) uncommitted edit is reflected in the diff", !!d4 && d4.patch.includes("WIP uncommitted edit"));
    check("(A4) flagged uncommitted", !!d4 && d4.uncommitted === true);

    // Immediately after that real walk, we're back inside a fresh TTL window (anchored to the walk that
    // just ran) — a repeat poll right now must again cost zero walks.
    const d5 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A5) repeat poll right after a real walk: zero walks again (TTL window refreshed)", walkCalls === 2);
    check("(A5) repeat poll right after a real walk: zero recomputes", computeCalls === 2);
    check("(A5) still the same content as (A4)", JSON.stringify(d5) === JSON.stringify(d4));

    // A committed WRITE — `commitInto` writes a new file THEN commits it. It's the WRITE the walk sees
    // (remove the `fs.writeFileSync` inside `commitInto` and (A7) below would fail — committing
    // already-fingerprinted content changes nothing the walk can observe, see (A10)). A linked worktree's
    // HEAD lives in its own per-worktree file, never `<repoPath>/.git/HEAD`, so the cheap canonical-HEAD
    // re-read can't see this either way — same as an uncommitted edit, it's bounded by the SAME TTL window,
    // not caught on the very next poll.
    commitInto(worktreePath, "feature.txt", "committed feature\n", "feat commit");
    const d6 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A6) a committed WRITE, still WITHIN the TTL: zero walks", walkCalls === 2);
    check("(A6) a committed WRITE, still WITHIN the TTL: served stale (same bound as an uncommitted edit)",
      !!d6 && JSON.stringify(d6) === JSON.stringify(d4));

    clock += PAST_TTL_MS;
    const d7 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A7) after the TTL elapses: a real walk runs and picks up the committed write", walkCalls === 3);
    check("(A7) after the TTL elapses: a real recompute runs", computeCalls === 3);
    check("(A7) new commit's file is in the diff", !!d7 && d7.patch.includes("feature.txt") && d7.patch.includes("committed feature"));
    check("(A7) prior uncommitted edit is still present too", !!d7 && d7.patch.includes("WIP uncommitted edit"));

    const d8 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A8) repeat poll right after that real walk: zero walks again (TTL window refreshed)", walkCalls === 3);
    check("(A8) repeat poll right after that real walk: zero recomputes", computeCalls === 3);
    check("(A8) still the same content as (A7)", JSON.stringify(d8) === JSON.stringify(d7));

    // The CANONICAL repo's own checked-out branch moving (e.g. another worker's PR landing on main) IS
    // caught immediately, even deep inside a freshly-refreshed TTL window — this is what the fast path's
    // cheap HEAD re-read actually guards, in contrast to (A6)'s committed-write case just above.
    commitInto(repo, "main-advance.txt", "unrelated change on the canonical repo's own branch\n", "advance main");
    const d9 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A9) the CANONICAL repo's own HEAD moving is caught immediately, TTL or not (a real walk runs)", walkCalls === 4);
    check("(A9) the CANONICAL repo's own HEAD moving forces an immediate recompute too", computeCalls === 4);

    // A commit that writes NO working-tree bytes is invisible to BOTH the walk and the HEAD re-read, at
    // ANY TTL — not specially, just because nothing in the working tree changed for the walk to find, which
    // is also exactly why workerDiff's own stage-1 diff (merge-base -> WORKING TREE) wouldn't change either.
    // Force a real walk (advance past the TTL) and confirm it finds nothing new, so no recompute even runs.
    clock += PAST_TTL_MS;
    execSync(`git commit -q --allow-empty -m "empty commit, no working-tree change"`, { cwd: worktreePath });
    const walksBeforeEmpty = walkCalls;
    const computesBeforeEmpty = computeCalls;
    const d10 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A10) a content-free commit: the post-TTL walk still runs (unconditional TTL policy)", walkCalls === walksBeforeEmpty + 1);
    check("(A10) a content-free commit: no working-tree bytes changed, so no recompute is needed", computeCalls === computesBeforeEmpty);
    check("(A10) a content-free commit: diff content is unchanged", !!d10 && JSON.stringify(d10) === JSON.stringify(d9));

    // The worker finishes and merges: the worktree is removed while the card may still be displaying the
    // last-served diff. The fast path MUST be bypassed the instant the worktree is gone — never serve the
    // stale live-worktree ("wt:") entry once there's nothing left to walk.
    const walksBeforeRemoval = walkCalls;
    const computesBeforeRemoval = computeCalls;
    await removeWorktree(repo, worktreePath);
    const d11 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep); // opts.worktreePath still names the now-gone dir
    check("(A11) worktree removed: no walk is attempted (there's nothing left to walk)", walkCalls === walksBeforeRemoval);
    check("(A11) worktree removed: the stale live-worktree cache entry is bypassed (a real recompute runs)",
      computeCalls === computesBeforeRemoval + 1);
    check("(A11) worktree removed: no longer flagged uncommitted (it's a committed-branch diff now)",
      !!d11 && !d11.uncommitted);

    await deleteBranch(repo, branch);
  }

  // ── CASE A2 — walks/minute at the REAL client poll cadence, before vs after. `reviewQueue.tsx` is the
  //    one call site with an actual `refetchInterval`: 8000ms (verified by grep — see the file header; NOT
  //    the ~2s this fix was originally, wrongly, modeled against). With no TTL every poll pays a walk; with
  //    the TTL fast path, a real walk only runs once the TTL has actually elapsed since the last one — a
  //    deterministic count, driven by a fake clock so this doesn't depend on real wall-clock time.
  {
    __resetWorkerDiffCacheForTest();
    let walkCalls = 0;
    const countingFingerprint = async (wt) => { walkCalls++; return fingerprintWorktree(wt); };
    let clock = 1_700_000_000_000;
    const dep = { fingerprint: countingFingerprint, now: () => clock };

    const { worktreePath, branch } = await createWorktree(repo, "projWDC", "cache-a2aa-4444");

    const POLL_INTERVAL_MS = 8_000; // reviewQueue.tsx's actual refetchInterval
    const POLL_COUNT = 30; // 30 polls * 8s = 240s of simulated time = 4 simulated minutes
    for (let i = 0; i < POLL_COUNT; i++) {
      await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
      clock += POLL_INTERVAL_MS;
    }
    // Before this fix, computeDiffCacheKey walked on EVERY poll (the walk WAS the cache key, unconditionally)
    // -> walksBefore === POLL_COUNT for this same simulated window, by construction of the prior code path.
    const simulatedMinutes = (POLL_COUNT * POLL_INTERVAL_MS) / 60_000;
    const walksBeforePerMin = POLL_COUNT / simulatedMinutes;
    const walksAfterPerMin = walkCalls / simulatedMinutes;
    check(`(A2-1) walks/min genuinely dropped under the TTL: before=${walksBeforePerMin}/min, after=${walksAfterPerMin}/min`,
      walkCalls > 0 && walkCalls < POLL_COUNT);
    console.log(`    -> measured at the REAL 8s poll cadence: ${walksBeforePerMin} walks/min/worker before this ` +
      `fix, ${walksAfterPerMin} walks/min/worker after (2 live workers on the same cadence: ` +
      `${walksBeforePerMin * 2} -> ${walksAfterPerMin * 2} walks/min). At this cadence the TTL's own multiplier ` +
      `is modest (~2x, not an order of magnitude) — the bigger real-world win is collapsing BURST mount ` +
      `traffic (Overview.tsx/ReviewPanel.tsx have no staleTime, so they refetch on every remount) down to one ` +
      `walk per TTL window, which this fake-clock model can't represent since it isn't driven by mount events.`);

    await removeWorktree(repo, worktreePath);
    await deleteBranch(repo, branch);
  }

  // ── CASE B — two branches never share a cache entry (no cross-worker leak).
  {
    __resetWorkerDiffCacheForTest();
    const wt1 = await createWorktree(repo, "projWDC", "cache-bbbb-2222");
    const wt2 = await createWorktree(repo, "projWDC", "cache-cccc-3333");
    fs.writeFileSync(path.join(wt1.worktreePath, "README.md"), "# v1\nfrom worker ONE\n");
    fs.writeFileSync(path.join(wt2.worktreePath, "README.md"), "# v1\nfrom worker TWO\n");

    const dOne = await getWorkerDiffCached(repo, { branch: wt1.branch, worktreePath: wt1.worktreePath });
    const dTwo = await getWorkerDiffCached(repo, { branch: wt2.branch, worktreePath: wt2.worktreePath });
    check("(B1) worker ONE's diff shows its own edit", !!dOne && dOne.patch.includes("from worker ONE"));
    check("(B1) worker ONE's diff does NOT leak worker TWO's edit", !!dOne && !dOne.patch.includes("from worker TWO"));
    check("(B2) worker TWO's diff shows its own edit", !!dTwo && dTwo.patch.includes("from worker TWO"));
    check("(B2) worker TWO's diff does NOT leak worker ONE's edit", !!dTwo && !dTwo.patch.includes("from worker ONE"));

    await removeWorktree(repo, wt1.worktreePath);
    await removeWorktree(repo, wt2.worktreePath);
    await deleteBranch(repo, wt1.branch);
    await deleteBranch(repo, wt2.branch);
  }

  // ── CASE C — the cache is bounded: it cannot grow without limit as branches come and go.
  {
    __resetWorkerDiffCacheForTest();
    const fastCompute = async () => ({ filesChanged: 0, insertions: 0, deletions: 0, patch: "" });
    const TOTAL = 550; // comfortably above the internal cap, without needing to know its exact value
    for (let i = 0; i < TOTAL; i++) {
      await getWorkerDiffCached(repo, { branch: `fake/evict-${i}`, worktreePath: null }, { compute: fastCompute });
    }
    const size = __workerDiffCacheSizeForTest();
    check("(C1) cache size is bounded well below the total insert count (eviction happened)", size > 0 && size < TOTAL);
  }
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — within the TTL a repeat poll performs zero stat walks, for both an uncommitted edit " +
    "and a committed working-tree write (bounded staleness by design); a content-free commit is invisible " +
    "to the walk at ANY TTL, correctly; the canonical repo's own HEAD moving is still caught immediately " +
    "regardless of the TTL window; the walk resumes once the TTL elapses and correctly detects what " +
    "changed meanwhile; the fast path is correctly bypassed the instant a worktree is removed; branches " +
    "never leak into each other; and the cache stays bounded."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
