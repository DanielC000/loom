// SHARED TEST HELPER (card 6b8822d2, Delta review round 2 item 3) — used by merge-confirm-inert-skip-pin.mjs,
// merge-confirm-reuse-head-rule.mjs, and merge-gate-interval.mjs's (P) scenario.
//
// A `soloMergeGitFactory` seam that writes a "late" commit from WITHIN `mergeBranchLocked`'s own first real
// git call (`rev-parse --verify <branch>^{commit}`, the fresh squash-target tip read) — the exact instant
// that function already owns the per-repo lock, since `mergeBranch` acquires it before `mergeBranchLocked`'s
// body ever runs.
//
// Holding the lock from the TEST instead (the old shape, before card 6b8822d2) would now also queue
// `confirmWorkerMerge`'s combined admission-time probe lock — ALL THREE canonical-dirt probes
// (detectCanonicalStagedDirt / detectCanonicalDirtyOverlap / detectCanonicalUntrackedOverlap share ONE
// `withCanonicalIndexLock` acquisition, not just the staged one) — behind it, which none of these scenarios
// intend to exercise.
//
// `../dist/git/bounded.js` is imported LAZILY, inside `raw`'s own async body (never at this module's top
// level, and never inside the factory itself): that module transitively reaches `paths.js`'s module-scope
// `LOOM_HOME` constant (bounded.js → merge-quarantine.js → paths.js), which freezes whatever
// `process.env.LOOM_HOME` holds AT IMPORT TIME. Every caller of this helper sets `process.env.LOOM_HOME` to
// a throwaway temp dir before its own real work begins, but a caller that imported this module STATICALLY
// (hoisted before its own `LOOM_HOME` assignment ever runs) would otherwise resolve that chain too early
// and freeze the real, ambient home. Deferring the import into `raw` — called well after every real caller
// has already set `LOOM_HOME` — removes this hazard regardless of how a caller imports this file.
// @decision 6b8822d2 — the FACTORY itself must stay SYNCHRONOUS and return its `{raw}` object directly,
// never a Promise: `BoundedGitDeps.gitFactory`'s own type is `(repoPath, blockTimeoutMs) =>
// Pick<SimpleGit,"raw">`, and `boundedMergeGit` calls it with a bare `makeGit(repoPath, timeoutMs)` — no
// `await` — so an async factory would hand back a Promise with no `.raw` method, throwing on the very first
// real call. Only `raw` itself (already async, matching simple-git's own signature) may be async.
export function lateCommitBeforeSquashTarget(branch, writeLate) {
  let fired = false;
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const { boundedSimpleGit } = await import("../dist/git/bounded.js");
      const { nonInteractiveEnv } = await import("../dist/git/writer.js");
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      if (!fired && Array.isArray(args) && args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `${branch}^{commit}`) {
        fired = true;
        writeLate();
      }
      return real.raw(args);
    },
  });
}
