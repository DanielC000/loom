# 509716cc — Bound `vault/versioner.ts`'s plumbing git calls (`VAULT_GIT_OP_TIMEOUT_MS`)

## Narrative

`VAULT_GIT_OP_TIMEOUT_MS` (15,000ms) is the per-git-op ceiling for the three bounded call sites in this module: `resolveVaultRepoContext`'s `checkIsRepo`/`revparse`, `VaultVersioner.start()`'s `checkIsRepo`/`init`, and `gitTrackedTopLevelNames`'s `ls-files` — all reachable from `startVaultVersioners`, which is AWAITED at boot (`index.ts`, ahead of `sessions.resumeFleetOnBoot`). A hang on any of these previously blocked the whole daemon's post-restart fleet resume, invisibly (HTTP stays up — `app.listen` runs earlier).

Same value and same convention as `GIT_OP_TIMEOUT_MS` (`git/worktrees.ts`) and `GIT_LOCAL_TIMEOUT_MS` (`git/writer.ts`) — a local plumbing op is normally sub-second, so this is generous headroom, but bounded so a wedged child (a repo on a busy/locked disk) can't hang the caller forever.

Not imported FROM those modules: neither exports its bounding helpers, and `git/writer.ts` already imports FROM this module (`recordGitPushOutcome`, `pauseVaultAutoCommit`, …) — importing back would be circular. `git/writer.ts` itself already carries its own independent copy of the identical block-timeout + race pattern rather than importing `git/worktrees.ts`'s, so this module doing the same is the established convention, not a new mechanism.

A bound on either of `resolveVaultRepoContext`'s two calls (`checkIsRepo`/`revparse`) lands in the same `.catch(() => false/"")` the pre-existing git-error path already used, so a hung repo degrades exactly like a non-repo/no-toplevel one does — "no governing repo, commit at the vault folder itself" — never a hang.

## Obsidian-Git detection: by marker, not by subfolder-vs-root

`resolveVaultRepoContext` detects an Obsidian-Git-managed repo (where a real external auto-committer already owns history, so Loom must back off) by the presence of the `.obsidian/plugins/obsidian-git` marker directory under the repo root — NOT by "subfolder ≠ root", the OLD, WRONG proxy that backed off for EVERY subfolder, including subfolders of an ordinary plain repo with no Obsidian Git plugin at all. The marker is deterministic (exists iff the Obsidian Git plugin — the thing that actually creates the external committer — is installed for that vault) and is one cheap `fs.existsSync`, preferred over a commit-message heuristic (fragile: depends on the user's message template, reads empty on a fresh repo, false positive/negative).

## A fourth site: `checkVaultPushStatus` — bound the same way, but awaited UNCONDITIONALLY at boot

`checkVaultPushStatus` (task f48ee77d's read-only push-status visibility check) shares `boundedVaultGit`/`VAULT_GIT_OP_TIMEOUT_MS` with the three sites above, but its call pattern is distinct and worth naming on its own: `index.ts` unconditionally awaits it (via `logVaultPushStatus`) at boot, ~27 lines before `sessions.resumeFleetOnBoot` — the same boot-hang exposure the three sites above exist to prevent, reached through a fourth path added later. The wrapping `try/catch` at that boot call site catches a THROW, never a HANG, so a timeout inside `checkVaultPushStatus` must itself land in the SAME catch every other git error in this function already does, returning `null` ("status unknown") — exactly like today's no-upstream/malformed-count paths — rather than ever surfacing as an unhandled hang at boot.

## Do not

- Do not leave a new plumbing-tier git call in this module unbounded — route it through `boundedVaultGit` with `VAULT_GIT_OP_TIMEOUT_MS` (or thread a `VaultGitDeps` override) so a wedged child can't re-open the boot-hang this constant exists to prevent.
- Do not import the sibling `GIT_OP_TIMEOUT_MS`/`GIT_LOCAL_TIMEOUT_MS` constants directly — `git/writer.ts` already imports from this module, so importing back would be circular; keep the independent copy.
- Do not detect Obsidian-Git management by "subfolder ≠ root" — that backs off for every subfolder of any plain repo, not just an Obsidian-Git-managed one. Use the `.obsidian/plugins/obsidian-git` marker.
- Do not let `checkVaultPushStatus` (or any future boot-awaited read in this module) degrade a timeout into anything but the same `null`/"status unknown" fail-safe path — an unhandled hang there reopens the exact boot-stall this bound exists to prevent, since `index.ts` awaits it unconditionally before `resumeFleetOnBoot`.
