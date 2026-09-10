# e41dbb58 — `GitWriter` write ops admitted through the canonical index lock

## Narrative

`checkout`, `createBranch`, and `commit` on `GitWriter` all mutate the project repo's SAME canonical
working tree/index that `mergeBranchLocked` (`git/worktrees.ts`) squash-merges against. Before this
card, a `commit()` interleaved with an in-progress merge could land the merge's own staged squash under
the caller's commit message, with no `Loom-Worker-Branch` trailer — see `test/merge-writer-index-lock.mjs`
for the reproduction. `createBranch` had a related failure mode: landing mid-merge (after
`mergeBranchLocked` staged its squash but before its own `git commit` ran) would commit the squash onto
the freshly-created branch instead of the mainline — the mainline branch silently never receives the
work, while `mergeBranchLocked` still reports `{ok:true, sha, subject}` pointing at a sha unreachable
from the branch it thinks it merged onto.

All three methods are now admitted through `withCanonicalIndexLock`, so a checkout/createBranch/commit
call queues behind an in-flight merge (or vice versa) instead of racing it. This method never runs while
a merge already holds the lock, because nothing on the merge path calls into `GitWriter` — so there is
no deadlock risk between the two.

## Do not

- Do not call `git add -A` / `git commit` / `git checkout` / `git checkout -b` against the canonical
  repo from `GitWriter` without holding `withCanonicalIndexLock` — an interleaved squash-merge can
  silently land under the wrong message, or on the wrong branch, with no thrown error.
