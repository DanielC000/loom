# d867e478 — an empty `vaultPath` is the legitimate "no vault bound" / explicit-unbind case, and must never reach `validateVaultPath`

## Narrative

`validateVaultPath` requires its `raw` argument to be non-empty before it is ever called — an empty
string is not an invalid vaultPath, it is the legitimate "no vault bound" state (a vault-less code
project) or an explicit unbind (clearing a previously-bound vault on `PATCH /api/projects/:id`, card
`9fe578b3`). Every call site guards this itself (`if (vaultPath) { ... validateVaultPath ... }`), so
`""` never gets routed through the absolute-path check in the first place — there is nothing to
reject.

The same distinction shows up on the read side, in `gateway/server.ts`'s `GET
/api/projects/:id/is-git-repo` and its use inside the `PATCH` unbind-refusal check: a project whose
`repoPath` and `vaultPath` happen to be equal is ambiguous on its face — it could be a genuine
vault-only project (`repoPath` was bound to the same folder as `vaultPath` at create time, per
`mcp/setup.ts`'s no-repo branch) where an unbind would leave nothing usable, or it could be a LEGACY
repo-bound project from before card `cdc3792d` (when the default was `vaultPath = repoPath`) that
genuinely has a real git repo underneath and can safely unbind its vault. `isGitRepo(p.repoPath)` is
the check that tells these two apart before the PATCH handler decides whether to refuse an unbind —
`repoPath === vaultPath` alone over-matches the legacy case, since it says nothing about whether a real
repo exists there.

## Do not

- Do not feed an empty/unset `vaultPath` into `validateVaultPath` — it will read as "not absolute" and
  reject a state that was never invalid in the first place. Guard the call with a truthiness check
  first, as every existing call site already does.
- Do not use `repoPath === vaultPath` alone to decide whether a project is vault-only (and therefore
  can't unbind without becoming unusable) — it over-matches a legacy repo-bound project. Pair it with
  `isGitRepo(repoPath)` to distinguish a genuine bare vault-only folder from a real repo that happens
  to share its path with the vault.

## Source

JSDoc comment above `validateVaultPath` in `packages/daemon/src/projects/vault-path.ts` (originally
line 19-20, part of the file's original introduction). Also cited in `gateway/server.ts` at the
`GET /api/projects/:id/is-git-repo` route comment and inside the `PATCH /api/projects/:id` unbind-
refusal check. Introduced by commit `ec22669e7` — see `docs/decisions/96c4b245-…md`'s Source note for
why that commit's subject line does not describe this diff; verify with `git show ec22669e7`, not the
subject alone.
