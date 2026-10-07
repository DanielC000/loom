# 87a3c87e — `mergeBranch`/`mergeBranchLocked` get the same vault auto-commit pause bracket `GitWriter` already holds

Found during the investigation on card `7673d096` (subdir-bound canonical lock key) — filed as its own
follow-up, out of scope there.

`GitWriter.commit`/`checkout`/`createBranch` (`git/writer.ts`) each wrap their canonical-index mutation in
`withVaultPauseLease`, which calls `pauseVaultAutoCommit(this.repoPath)` before the mutation and
`resumeVaultAutoCommit(this.repoPath, token)` in a `finally` — so `VaultVersioner`'s own debounced
auto-commit tick skips a tick that STARTS while the lease is held. **Correction (card `a7de9d88`): this is
weaker than "never races."** The lease is advisory and checked, not a lock — a tick whose own check already
ran (and saw "not paused") a moment before `GitWriter` raises the lease has no way to see it; see "Does not
cover" below for what this bracket, by itself, leaves open.

`mergeBranch`/`mergeBranchLocked` (`git/worktrees.ts`) never called `pauseVaultAutoCommit` at all —
confirmed by a repo-wide grep (zero matches for `pauseVaultAutoCommit`/`resumeVaultAutoCommit` in
`worktrees.ts` before this fix). This held for EVERY project, not just a subdir-bound one: a merge's own
`git merge --squash` + `git commit` sequence against the canonical repo could interleave with
`VaultVersioner`'s own tick on that same repo's working tree, with nothing pausing the latter.

## Fix

`mergeBranch` (the public entry point — `mergeBranchLocked` is private and only ever called from inside
it, so bracketing here covers both) called `pauseVaultAutoCommit(repoPath)` before entering
`withCanonicalIndexLock`, and `resumeVaultAutoCommit(repoPath, pauseToken)` in a `finally` that wrapped the
lock call and the `RepoQuarantinedError` translation — so a throw out of the lock (including a quarantine
refusal) never left the lease held. **Superseded by card `6e6b342d`:** the pause/resume bracket now lives
INSIDE the lock's own callback (taken at admission, resumed in that callback's own `finally`), never
before `withCanonicalIndexLock` is admitted — see that card's record for why and for the admission-timing
gap this closes.

Same bracket added to `fastForwardCanonicalMain` (`git/batch-merge.ts`), the batch landing path's own
canonical mutation point (the `git merge --ff-only` that advances canonical main) — the per-candidate
cherry-pick landing itself happens in the batch WORKTREE, not the canonical repo, so that part needs no
bracket; only the fast-forward does. Also moved inside the lock by `6e6b342d`.

## Does not cover (added by card `a7de9d88`'s Code Review)

This bracket alone — an advisory lease, checked once by the caller before it ever starts its own
add+commit work — narrows the race window but does not close it. Three real gaps, found in review:

- **Tick TOCTOU.** `VaultVersioner`'s own debounce tick checks the lease once, then runs `commitVault`
  (seconds of real work: `git add -A` + `git commit`). If the tick's own check passes at `t0` and a merge
  pauses and stages its squash at `t0+ε`, the tick's `git add`/`git commit` can sweep the merge's
  staged-but-uncommitted squash into a `loom: auto-commit`. **CLOSED** — not by this bracket, but by card
  `a09b81a0` round 3's separate, independent fix: `commitVault` now takes the SAME canonical index lock a
  real merge takes, around its ENTIRE add+commit sequence, whenever its commitPath is merge-eligible — so
  the tick's own git-mutating work and a merge's squash+commit can no longer interleave at all, regardless
  of lease timing. Proven (both RED-without and GREEN-with) in
  `packages/daemon/test/vault-tick-merge-toctou.mjs`.
- **Direct `commitVault` callers.** `vault/writer.ts`'s three UI-write functions (reached by REST/the
  Setup operator/the Platform Lead/the core `vault_write` MCP tool) call `commitVault` directly and never
  checked the lease at all pre-`a09b81a0`. **CLOSED** by the same `a09b81a0` fix — the canonical-lock wrap
  and (round 4) the in-sequence lease check both live inside `commitVault`'s own `runCommitSequence`, the
  one place every caller converges, so a direct writer call gets the identical protection. Covered by the
  same test above (its vault/writer.ts scenario).
- **Single-token clobber.** A lease held by one op can be silently cleared by a different op's own
  `resumeVaultAutoCommit` call before the first op's own mutation finishes. NOT closed here — **CLOSED by
  sibling card `6e6b342d`** (the lease is now a multi-holder SET, taken inside the canonical lock; see that
  card's record — this was a lease-bookkeeping honesty fix, not a correctness bug, since the canonical
  lock already made real mutation-interleaving impossible wherever this lease could matter at all).

See `docs/decisions/a09b81a0-vault-commit-code-repo-guard.md`'s "Round 4: the pause-lease check's
placement" section for the full design of what actually closes the first two gaps.

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
