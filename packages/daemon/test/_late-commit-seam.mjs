// SHARED TEST HELPER (card 6b8822d2, Delta review round 2 item 3) — used by merge-confirm-inert-skip-pin.mjs,
// merge-confirm-reuse-head-rule.mjs, and merge-gate-interval.mjs's (P) scenario.
//
// A `soloMergeGitFactory` seam that writes a "late" commit from WITHIN `mergeBranchLocked`'s own first real
// git call (`resolveBranchTip`'s exact `for-each-ref` lookup, the fresh squash-target tip read) — the exact instant
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
      // @decision 56c10535 — the squash-target resolve now goes through resolveBranchTip's exact
      // `for-each-ref` lookup (never a bare/DWIM-prone rev-parse); match THAT call shape, or this hook
      // silently never fires.
      if (!fired && Array.isArray(args) && args[0] === "for-each-ref" && args[args.length - 1] === `refs/heads/${branch}`) {
        fired = true;
        writeLate();
      }
      return real.raw(args);
    },
  });
}

// @decision 56c10535 (Round 3, item 2) — SHARED TEST HELPER for `merge-confirm-branch-tip-unresolvable.mjs`:
// a `soloMergeGitFactory` seam that makes mergeBranchLocked's OWN squash-target `for-each-ref` lookup
// (the exact same call site `lateCommitBeforeSquashTarget` above hooks) come back EMPTY — simulating a
// genuinely-unresolvable branch tip WITHOUT actually deleting the branch or touching anything else
// `confirmWorkerMerge`'s own earlier preconditions read, since this seam is only ever wired into the ONE
// `deps.gitFactory` mergeBranch/mergeBranchLocked itself threads through (`this.soloMergeGitFactory`),
// never confirmWorkerMerge's own earlier, separately-constructed git reads. Every OTHER call (including
// every OTHER for-each-ref lookup) passes through to real git unchanged. Deliberately NOT one-shot (unlike
// `fired` above) — a persistently-missing branch fails EVERY read of it, not just the first.
export function squashTargetUnresolvable(branch) {
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      if (Array.isArray(args) && args[0] === "for-each-ref" && args[args.length - 1] === `refs/heads/${branch}`) {
        return ""; // empty output ⇒ resolveBranchTip's own exact-refname filter finds nothing ⇒ null
      }
      const { boundedSimpleGit } = await import("../dist/git/bounded.js");
      const { nonInteractiveEnv } = await import("../dist/git/writer.js");
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return real.raw(args);
    },
  });
}
