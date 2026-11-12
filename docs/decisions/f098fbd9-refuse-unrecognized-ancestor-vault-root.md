# f098fbd9 — the auto-committer refuses a vault whose git toplevel is an unrecognized ancestor repo

Card `f098fbd9`, from the delta review of `5ba4412d`. `5ba4412d`'s containment check only knows the project's REGISTERED repos. A vault under an UNREGISTERED ancestor git repo (a dotfiles repo at `~`, `LOOM_HOME` inside a repo) still resolved, via `resolveVaultRepoContext`'s `git rev-parse --show-toplevel`, to that ancestor, and the auto-committer then ran `git add` over the whole ancestor repo. Nothing at commit time compared the resolved `commitPath` to anything.

## The decision

`VaultVersioner` refuses to commit when its resolved `commitPath` is canonically different from its own `vaultPath` (an ancestor) AND `isRecognizedVaultRoot(commitPath)` is false (`isUnrecognizedAncestorRoot`, `vault/versioner.ts`). `isRecognizedVaultRoot` is the `7c1d6dbf` predicate (equality against the human-only `sharedVaultRoots` list, plus its own-toplevel rule); no second signal was added. A vault that IS its own toplevel (or has no repo yet) is unaffected.

Checked at all three places that stage at `commitPath`: `startVaultVersioners` (boot: no watcher is started for a refused vault, so nothing watches e.g. a home dir), `VaultVersioner.commit()` (every tick, live) and `flushSync()` (raw `git add -A` at shutdown). Each logs one warning and files one `vault_autocommit_refused_code_repo` event per (vault, root, source) per process; the event detail carries `reason:"unrecognized-ancestor-root"` (no new event kind). An unwired provider fails open, like `checkCodeRepoCollision`.

## Refusal, not pathspec scoping

Refusal is fail-closed and simple. A pathspec-scoped `git add <subfolder>` would still `git commit` in the ancestor repo (landing on its branch, racing its index, committing whatever else is pre-staged there) and would need every one of the three raw call sites reworked. No concrete need for it appeared: the owner's real shared Obsidian Vault keeps committing through its `sharedVaultRoots` entry.

## Ordering

`index.ts` runs `seedSharedVaultRootsOnce` (after `setCodeRepoGuardProvider`) before `startVaultVersioners`, so a fresh boot never refuses the first commits of the seeded shared vault. `vault-commit-ancestor-root-refusal.mjs` pins that order by source-text scan.

## Do not

- Do not add a second "is this ancestor OK" signal (layout, project count, an `.obsidian` marker); reuse `isRecognizedVaultRoot` only.
- Do not move the seed after `startVaultVersioners`, or the provider registration after either.
- Do not drop the `flushSync` or the boot check on the theory that `commit()` covers them; each stages at `commitPath` independently.
- Do not turn a boot-time refusal into a permanent state: the check is re-run live on every `commit()`, so a Settings edit applies without a restart for a vault that did start. A vault skipped at boot (never watched) needs a daemon restart after the list is edited.
