# 509716cc — Bound `vault/versioner.ts`'s plumbing git calls (`VAULT_GIT_OP_TIMEOUT_MS`)

## Narrative

`VAULT_GIT_OP_TIMEOUT_MS` (15,000ms) is the per-git-op ceiling for the three bounded call sites in this module: `resolveVaultRepoContext`'s `checkIsRepo`/`revparse`, `VaultVersioner.start()`'s `checkIsRepo`/`init`, and `gitTrackedTopLevelNames`'s `ls-files` — all reachable from `startVaultVersioners`, which is AWAITED at boot (`index.ts`, ahead of `sessions.resumeFleetOnBoot`). A hang on any of these previously blocked the whole daemon's post-restart fleet resume, invisibly (HTTP stays up — `app.listen` runs earlier).

Same value and same convention as `GIT_OP_TIMEOUT_MS` (`git/worktrees.ts`) and `GIT_LOCAL_TIMEOUT_MS` (`git/writer.ts`) — a local plumbing op is normally sub-second, so this is generous headroom, but bounded so a wedged child (a repo on a busy/locked disk) can't hang the caller forever.

Not imported FROM those modules: neither exports its bounding helpers, and `git/writer.ts` already imports FROM this module (`recordGitPushOutcome`, `pauseVaultAutoCommit`, …) — importing back would be circular. `git/writer.ts` itself already carries its own independent copy of the identical block-timeout + race pattern rather than importing `git/worktrees.ts`'s, so this module doing the same is the established convention, not a new mechanism.

## Do not

- Do not leave a new plumbing-tier git call in this module unbounded — route it through `boundedVaultGit` with `VAULT_GIT_OP_TIMEOUT_MS` (or thread a `VaultGitDeps` override) so a wedged child can't re-open the boot-hang this constant exists to prevent.
- Do not import the sibling `GIT_OP_TIMEOUT_MS`/`GIT_LOCAL_TIMEOUT_MS` constants directly — `git/writer.ts` already imports from this module, so importing back would be circular; keep the independent copy.
