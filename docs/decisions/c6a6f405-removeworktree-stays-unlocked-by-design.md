# c6a6f405 — `removeWorktree` deliberately does not take the canonical index lock

## Narrative

`removeWorktree` is UNLOCKED BY DESIGN, not an oversight (board card `c6a6f405` item 2 — filed as a reviewer QUESTION, not a data-loss finding, and left that way). `git worktree remove -f -f` plus the trailing `prune` mutate the SAME shared `.git/worktrees/` admin state that `createWorktree` takes `withCanonicalIndexLock` for (card `2fcd5eae`'s "prune → branch --list → add is a multi-step read-modify-write" rationale) — but `removeWorktree` does NOT take that lock, and runs concurrently with spawns (`finalizeMerge`, boot-reconcile Pass B, the wedge sweep). This is judged safe today because git's own `locked`/`initializing` admin marker makes a concurrent `prune` SKIP an in-flight `add` BY DESIGN — the realistic overlap this function can actually race against.

The lock is NOT RE-ENTRANT: `removeWorktree`'s one caller (`SessionService`'s worktree-GC path) never holds it, and `finalizeMerge` only calls `removeWorktree` AFTER `mergeBranch` has fully released the lock — but a FUTURE caller invoking `removeWorktree` from inside an already-held `withCanonicalIndexLock` block would DEADLOCK.

## Do not

- Do not wrap `removeWorktree` in `withCanonicalIndexLock` reflexively "to be safe" — the lock is not re-entrant, and a caller that already holds it would deadlock.
- Before adding any new caller of `removeWorktree`, confirm it does not already hold `withCanonicalIndexLock`, or give `removeWorktree` (and its callers) an actual re-entrancy story first.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `removeWorktree`'s own doc comment (~line 1472, the "UNLOCKED BY DESIGN" / re-entrancy paragraphs), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed. The re-entrancy warning stays inline at the source too, compressed, as a class-A guard.
