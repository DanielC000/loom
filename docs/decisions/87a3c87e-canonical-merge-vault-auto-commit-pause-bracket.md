# 87a3c87e — `mergeBranch`/`mergeBranchLocked` get the same vault auto-commit pause bracket `GitWriter` already holds

Found during the investigation on card `7673d096` (subdir-bound canonical lock key) — filed as its own
follow-up, out of scope there.

`GitWriter.commit`/`checkout`/`createBranch` (`git/writer.ts`) each wrap their canonical-index mutation in
`withVaultPauseLease`, which calls `pauseVaultAutoCommit(this.repoPath)` before the mutation and
`resumeVaultAutoCommit(this.repoPath, token)` in a `finally` — so `VaultVersioner`'s own debounced
auto-commit tick never races a `GitWriter` op's write to the same repo's working tree/index.

`mergeBranch`/`mergeBranchLocked` (`git/worktrees.ts`) never called `pauseVaultAutoCommit` at all —
confirmed by a repo-wide grep (zero matches for `pauseVaultAutoCommit`/`resumeVaultAutoCommit` in
`worktrees.ts` before this fix). This held for EVERY project, not just a subdir-bound one: a merge's own
`git merge --squash` + `git commit` sequence against the canonical repo could interleave with
`VaultVersioner`'s own tick on that same repo's working tree, with nothing pausing the latter.

## Fix

`mergeBranch` (the public entry point — `mergeBranchLocked` is private and only ever called from inside
it, so bracketing here covers both) now calls `pauseVaultAutoCommit(repoPath)` before entering
`withCanonicalIndexLock`, and `resumeVaultAutoCommit(repoPath, pauseToken)` in a `finally` that wraps the
lock call and the `RepoQuarantinedError` translation — so a throw out of the lock (including a quarantine
refusal) never leaves the lease held.

Same bracket added to `fastForwardCanonicalMain` (`git/batch-merge.ts`), the batch landing path's own
canonical mutation point (the `git merge --ff-only` that advances canonical main) — the per-candidate
cherry-pick landing itself happens in the batch WORKTREE, not the canonical repo, so that part needs no
bracket; only the fast-forward does.

## Do not

- Do not drop this pause/resume bracket from `mergeBranch`, or move the resume call out of the
  `finally` — a thrown `RepoQuarantinedError` (or any other throw out of `withCanonicalIndexLock`) must
  never leave the vault auto-commit pause lease held past this call.
- Do not add this bracket to `mergeBranchLocked` itself — it is private and only reachable through
  `mergeBranch`, which already holds it; a second bracket there would just double-pause/resume for no
  benefit.
- Do not skip `fastForwardCanonicalMain` in `batch-merge.ts` on the theory that batch landing is
  "worktree-scoped" — the cherry-pick/rebase steps are, but the fast-forward onto canonical main is not,
  and it is the one canonical-mutating call on that path.
- Do not treat this as a real lock — like `GitWriter`'s own lease (`@decision 614dfbef`), it only pauses
  `VaultVersioner`'s own commit tick; nothing else is blocked from touching the repo.
