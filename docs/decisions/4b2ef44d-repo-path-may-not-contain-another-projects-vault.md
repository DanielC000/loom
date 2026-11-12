# 4b2ef44d — a repoPath / repos[] entry may not equal or contain ANOTHER project's vault

The symmetric half of `c24dfd28-vault-path-may-not-alias-another-projects-repo.md`. A repo written (create, repoPath rebind, repos[] edit) at a directory that equals or contains another project's existing vaultPath would make that project's vault auto-committer commit into this repo's tree. Before this card only the runtime backstop (`checkCodeRepoCollision`) caught it.

## The rule

- `checkRepoForeignVaultContainment` (`projects/vault-path.ts`) runs from inside `checkVaultRepoTripleContainment` whenever `opts.foreign` is passed, for the primary `repoPath` and every `repos[]` entry, INCLUDING when the written project binds no vault of its own. One shared check, so every surface that already passes `foreign: foreignRepoContext(...)` (REST create + PATCH, platform create/update, setup create/update, manager `project_update`) gets it with no per-surface code.
- Foreign vaults come from `Db.listForeignVaultPaths` (live + archived, reserved homes excluded, the written project excluded), carried on the same `ForeignRepoContext` as `vaultPaths`.
- Same exemption as c24dfd28, applied to the repo being WRITTEN: its git toplevel must be a listed shared vault root (`isSharedVaultRoot`) AND the repo path canonically at-or-under that toplevel. Never the raw path, never a second signal.
- A repo path canonically equal to one the project already stores (`storedRepoPaths`, primary + repos[]) is skipped, mirroring the unchanged-vault skip, so a rename resave is never refused. A CHANGED or newly added path is judged.

## Do not

- Do not add a layout-inference exemption (e.g. "the contained vault's root is a git repo").
- Do not exempt on a listed SUBFOLDER or a toplevel the repo does not sit under.
- Do not re-judge a stored, unchanged repo path.
- Do not hand-roll this per surface; extend the shared triple check.
