# c24dfd28 — a vaultPath may not equal or lie inside ANOTHER project's repo

`checkVaultRepoTripleContainment` used to compare a project's `vaultPath` only against its OWN `repoPath`/`repos`. A vaultPath pointed at another project's code repo was accepted on create and update, and the vault auto-committer then committed into that repo.

## The rule

- `vaultPath` may not EQUAL or lie INSIDE any other project's `repoPath` / `repos[]` path (`checkVaultForeignRepoContainment`, `projects/vault-path.ts`, run from inside the shared triple check via `opts.foreign`).
- Exempt ONLY a foreign repo whose git TOPLEVEL is a listed shared vault root (`isSharedVaultRoot`, the 7c1d6dbf predicate — the ONLY exemption signal) AND whose own path is canonically at-or-under that toplevel. Same rule as `isRecognizedVaultRoot` (vault/versioner.ts): a listed SUBFOLDER never vouches, and a planted `core.worktree` that makes a repo report a listed root it does not sit under does not exempt it. The refusal message names that toplevel and points at Settings → Platform → Shared vault roots.
- Skipped when the effective vaultPath canonically EQUALS the project's own stored vaultPath (the web Save always resends it, so every rename of a nested-vault project would otherwise be refused until its root is listed). A CHANGED nested vaultPath is still judged. Applied in the shared context (`foreignRepoContext` carries `storedVaultPath`), not per surface.
- There is NO reserved-home write exemption: no real path needed one (a reserved home's vault is its own dir, never another project's repo, and re-asserting its stored vault is skipped by the rule above). Reserved homes' repo paths are simply not foreign territory.
- Archived projects' repo paths COUNT as foreign. Reserved homes' repo paths do NOT (they are Loom-operational dirs inside LOOM_HOME; the auto-committer's operational-dir guard covers them).
- The project's own paths are excluded (`Db.listForeignRepoPaths(excludeProjectId)`; on create the new id is not yet in the DB).
- Only equals/inside is refused. A vault that merely CONTAINS a foreign repo is not (the own-repo check keeps that direction for the project's own repo).
- The vault-only relocation case is covered with no special code: the relocation target is the effective `vaultPath`, which goes through the same check.
- Every create/update surface builds the context with `foreignRepoContext(db, projectId)` (`projects/foreign-repos.ts`): REST create (`projects/create-input.ts`), REST PATCH, platform create/update, setup create (code AND vault-only branch — the vault-only branch used to run no triple check at all) and update, manager `project_update` (`sessions/service.ts`). `vault-path-foreign-repo.mjs` section 6 pins that every call passes `foreign:`.

## Do not

- Do not add a second exemption signal (layout inference such as "another vault lives there"); 7c1d6dbf removed exactly that.
- Do not exempt on the raw foreign `repoPath` (a listed subfolder must not pass) or on a toplevel the repo does not sit under.
- Do not exclude archived projects' repos or include reserved homes' repos.
- Do not make `foreign` required-but-defaulted inside the check; a surface that omits it silently loses the check, which is why the source scan exists.
- `project_init` (both routers) never runs the shared check: its target is a fresh dir under the workspace base, so a collision is near-impossible. Out of scope here.

The reverse direction (a repo being WRITTEN that swallows another project's EXISTING vault) is closed by `4b2ef44d-repo-path-may-not-contain-another-projects-vault.md`; the runtime backstop remains `checkCodeRepoCollision`.

Residual: the check is path containment + one `git rev-parse --show-toplevel` per colliding foreign path; a vault-only foreign project's plain notes folder counts as a "repo path" like any other (that is what makes the unlisted shared-vault layout refused).
