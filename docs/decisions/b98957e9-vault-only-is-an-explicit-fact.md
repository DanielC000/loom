# b98957e9 — vault-only-ness is an explicit, stored `Project.vaultOnly` fact, never inferred

## Narrative

Before this card, "is this project vault-only" was inferred at every check site from
`repoPath === vaultPath && !isGitRepo(repoPath)` (see `docs/decisions/d867e478-…md`, now superseded on
this point). That heuristic was unsound in two concrete, reachable ways:

- `VaultVersioner.start()` git-inits a bare vault folder the first time it's opened. From that moment
  on `isGitRepo(repoPath)` is `true` for a genuine vault-only project, so `checkVaultPathUpdate`'s
  "cannot unbind a vault-only project's vault" refusal silently stops firing — probed directly: unbind
  on such a project returned `ok:true, value: ""`.
- `isGitRepo` (via `simple-git`'s `checkIsRepo()`) is `true` for ANY path inside a working tree, not just
  a repo root. A vault-only folder that is itself a subfolder of a separate notes repo (a layout the
  project owner actually uses — see the evidence note below) reads as `isGitRepo:true` from day one,
  misclassifying it as an ordinary repo-bound project immediately, not just after some later git-init.

Both failure directions were confirmed against a real, non-synthetic snapshot of the owner's own
production DB (a copy of `~/.loom/backups/auto/…db`, read-only, never the live DB): project `f1676cb4`
"P&C Oslo Case Study" is a live, active, non-archived project whose `vaultPath` is a subfolder of the
Obsidian vault equal to its own `repoPath` — exactly the nested-vault-only shape above. Project
`5af9020b` "OSS Contributions" is the mirror-image case: `repoPath === vaultPath` pointing at a real
`GitHub\oss-contrib` checkout — a legacy project from before card `cdc3792d` made the vault optional
(back when the default was `vaultPath = repoPath`), not a true vault-only project at all.

`vaultOnly` fixes this by moving the classification to the ONE place it is unambiguous: project
*creation*. Every creation surface already knows, by construction, whether it is binding a real
`repoPath` or minting a vault-only folder (`repoPath` and `vaultPath` set to the same value with no
separate repo involved) — so each one now stamps `vaultOnly` directly instead of leaving it to be
re-derived later from path equality and a live git check.

## Legacy backfill (asymmetric risk, not a coin flip)

Existing rows predate the column and must be backfilled once, at the moment `vault_only` is
ALTER-added (`Db.migrateProjects` → `backfillVaultOnlyOnce`, never re-run once the column exists). The
rule is `vault_only = 1` wherever `repo_path = vault_path` and non-empty — raw equality, since stored
paths are already expanded/absolute.

This rule is deliberately the SAFE direction, not a symmetric guess, because the two misclassification
directions have very different costs:

- Backfilling a TRUE vault-only legacy project to `vaultOnly:false` is the dangerous direction: once its
  folder is (or becomes) a git repo, `checkVaultRepoTripleContainment` would see its own `repoPath` as
  "aliasing a code repo" and refuse every future `project_update` touching `vaultPath`/`repoPath`/
  `repos` for that project — a hard, confusing lockout with no connection to whatever the user actually
  tried to change.
- Backfilling a legacy ALIASED CODE project (the `5af9020b` shape) to `vaultOnly:true` only costs it the
  new inability to unbind its vault to `""` — annoying, recoverable, and no worse than today's existing
  (already-buggy) exemption behavior for that same row.

So every legacy row with `repoPath === vaultPath` is backfilled to `vaultOnly:true`, accepting that a
small number of legacy aliased-code rows (one identified in the owner's own data: `5af9020b` "OSS
Contributions", carded on `b98957e9` itself rather than fixed by hand) carry the pre-existing
misclassification forward rather than having it silently "fixed" by a migration that could just as
easily brick a real vault-only project instead.

## Write-once, with one real exception

`vaultOnly` is set once at creation and is never recomputed by an ordinary vaultPath-only edit. The one
place it DOES change post-creation: a `repoPath` rebind (the only two surfaces that can ever change an
existing project's `repoPath` are the human REST `PATCH /api/projects/:id` and the elevated Platform
Lead's `project_update` — `checkRepoRebind`'s only two callers) that leaves the EFFECTIVE post-patch
`repoPath`/`vaultPath` no longer canonically equal clears a `true` flag to `false` in the SAME write.
This only ever fires in the "becomes false" direction — never the reverse, since an ordinary code
project setting `vaultPath === repoPath` later is exactly the alias bug `docs/decisions/
5ba4412d-…md` blocks, not a legitimate promotion to vault-only.

## Do not

- Do not reintroduce `repoPath === vaultPath && !isGitRepo(repoPath)` (or any live re-derivation) as a
  vault-only test anywhere — read the stored `Project.vaultOnly` fact instead.
- Do not auto-mutate any legacy row's `vaultPath` as part of the backfill migration — the backfill only
  ever sets the new `vault_only` column; it never touches `vault_path`/`repo_path`.
- Do not let `vaultOnly` ever flip `false → true` as a side effect of an update — only project creation
  may set it `true`; an update may only ever clear it to `false` (on a `repoPath` rebind that makes the
  pair diverge).
- Do not run `backfillVaultOnlyOnce` on every boot — it must run exactly once, inside the branch where
  `migrateProjects` discovers the column is missing and ALTER-adds it.

## Source

`packages/shared/src/types.ts` (`Project.vaultOnly`), `packages/daemon/src/db.ts` (`vault_only` column,
`migrateProjects`/`backfillVaultOnlyOnce`), `packages/daemon/src/projects/vault-path.ts`
(`checkVaultPathUpdate`, `checkVaultRepoTripleContainment`'s `pairingIsIntentional` callers). Related:
`docs/decisions/d867e478-…md` (superseded on the inference method), `docs/decisions/
5ba4412d-…md` (the alias bug this must not reopen).
