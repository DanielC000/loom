# bf11ac3f — kill-confirm `commitVault`'s add/commit on a merge-eligible vault, without dropping VAULT_GIT_SAFETY_CONFIG

## Background

`commitVault` (`vault/versioner.ts`) is the one shared path behind the auto-commit tick, the shutdown
flush's own sibling writes, and every UI/REST/`vault_write` write. When the vault's confirmed governing
root canonically EQUALS a different registered project's own `repoPath` — the shared-vault shape
`a09b81a0`'s round 3 exempts from the code-repo-collision refusal — `isCommitPathMergeEligible` makes
`commitVault` take the SAME `withCanonicalIndexLock` a real `mergeBranchLocked`/`GitWriter` write on that
repo would take.

But the add/commit calls inside that lock ran on a plain `withTimeout` (`boundedVaultGitAtConfirmedRoot`),
not the kill-confirmed `killableCanonicalRaw` path `24c0bdba` already requires for every OTHER mutating
canonical call. `withTimeout` settles independent of the real git child — so on a timeout, the lock
released (and quarantine was never raised) while an orphaned `git add .`/`git commit` could still be
mutating the SAME index a queued real merge was about to touch. Investigated and confirmed reachable
(read-only) before any edit — see the worker_report on card `bf11ac3f` for the full path-by-path audit.

## Decision

Extend `killableCanonicalRaw`/`spawnCanonicalGitTree` (`git/bounded.ts`) with an additive, per-call
`extraConfigArgs?: string[]` parameter (mirrors `boundedSimpleGit`'s existing `extraUnsafe` precedent,
card `00a6cdd6`) — omitted by every existing caller, byte-identical argv. `commitVault`'s merge-eligible
branch now routes its `git add .` and `git commit` calls through `killableCanonicalRaw` with
`extraConfigArgs: VAULT_GIT_SAFETY_ARGS`, so the hooksPath/fsmonitor/gpgsign/safe.bareRepository
neutralisation survives the switch. On `treeDeathUnconfirmed`, it calls the SAME `enterMergeQuarantine`
every other canonical-mutating call site uses, keyed on `vaultPath` — so the quarantine shows up in the
same list/clear surface as any other quarantine, no new store. Scoped ONLY to the merge-eligible branch:
an ordinary, non-merge-eligible vault has nothing in Loom's own merge machinery to race, so it keeps the
original plain-`withTimeout` path unchanged.

Ordering (the lock must not release while the child may be alive): `killableCanonicalRaw`'s own promise
does not settle until `withTimeoutKillingChild` resolves — confirmed-dead (PATH-1) or give-up (PATH-2,
tagged unconfirmed) — and the `catch` that raises the quarantine runs, and completes, strictly BEFORE
`runCommitSequence`'s own promise rejects, which is strictly before `withCanonicalIndexLock`'s `run`
settles and the next queued caller's `guarded()` (which re-checks quarantine) can run. This is a plain
await-chain inside one `withCanonicalIndexLock` callback, not a race — Node's single JS thread makes the
ordering structural, not probabilistic.

## Do not

- Do not fold `extraConfigArgs` into `CANONICAL_GIT_CONFIG_ARGS` itself — it is per-call-class config
  (vault-specific hooksPath/fsmonitor/gpgsign/safe.bareRepository neutralisation), and folding it in would
  silently widen it onto every other `killableCanonicalRaw`/`canonicalGit` caller (worktrees.ts,
  batch-merge.ts, writer.ts), none of which want it.
- Do not route the NON-merge-eligible branch's add/commit through `killableCanonicalRaw` — an ordinary
  vault that is not also a registered project's own `repoPath` has no real merge/GitWriter op to race, so
  the extra kill-confirm machinery buys nothing there; keep it on the original plain-`withTimeout` path.
- Do not quarantine on a plain (non-`treeDeathUnconfirmed`) failure here — mirror every other
  `enterMergeQuarantine` call site's own gate exactly; an ordinary git failure (e.g. a real identity error)
  is not an unconfirmed kill and must not quarantine the repo.
- Do not hand-roll a second tree-kill primitive inside `vault/versioner.ts` — `git/bounded.ts`'s own module
  doc was written specifically to stop that proliferation (six independent copies before it existed); reuse
  `killableCanonicalRaw` via the additive param instead.
- Do not drop the `mergeEligible` hoist — re-querying `isCommitPathMergeEligible` separately for the
  add/commit branch and the outer lock decision risks the two disagreeing within the SAME `commitVault`
  call if the live provider's snapshot changes mid-call; hoisting once per call closes that, while still
  re-consulting fresh on the next call.
