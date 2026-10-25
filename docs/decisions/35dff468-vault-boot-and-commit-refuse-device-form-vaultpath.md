# 35dff468 — refuse a network/device-form vaultPath at every act-on-a-stored-vaultPath site, not just create/update

Card `35dff468`. `f45821a2` (now on main) deliberately makes `validateVaultPath` PASS an NT-namespace /
device / UNC form (`isUnsafeToCanonicalize`), so that the more specific device-form refusal in
`checkVaultRepoTripleContainment` (via `canonicalizeForContainment`) fires at every create/update write
site instead. But that containment check runs ONLY on create/update — never again later — so a
PRE-EXISTING project row already carrying one of these forms (one that bypassed creation-time validation,
the same way the drive-less-rooted `/tmp` row did before `b709113e`) was still handed straight to
`resolveVaultRepoContext`/`commitVault`'s own git discovery by every site that later reads and ACTS ON
that stored `vaultPath`, with no safety check of its own.

## Decision

A genuine UNC (or other device-form) vault path is **not** a legitimate configuration to carry through
any of these sites. `checkVaultRepoTripleContainment` already refuses ANY unsafe-to-canonicalize
vaultPath unconditionally at create/update time — even for a vault-only project with NO code repo at
all, because the check compares `vaultPath` against `repoPath`, and for a vault-only project `repoPath`
**is** `vaultPath` itself, so the self-comparison still fails and still refuses. That means this family
can never be CREATED today, under any project shape — so a stored row carrying one is always a legacy
row that predates the guard (or a hand-edited DB), never a live, supported configuration. Treat it
exactly like the other members of this family: skip it, loudly, before any git call.

## Where this fires

Two sites act on a project's stored `vaultPath` without ever running the write-time containment check,
found by grepping for `resolveVaultRepoContext(` / `commitVault(` / `boundedVaultGit(` callers in
`vault/versioner.ts` and their own callers:

1. **`startVaultVersioners`'s boot loop** (`vault/versioner.ts`) — the site named by the card. Fixed by
   adding an `isUnsafeToCanonicalize` check right after the existing `validateVaultPath` check, named and
   logged exactly like that sibling check, skipping (`continue`) before `resolveVaultRepoContext` ever
   runs.
2. **`commitVault`** (`vault/versioner.ts`) — the actual git-init/commit chokepoint, called directly with
   a project's raw, stored `vaultPath` by every `vault/writer.ts` write (`writeVaultFile`/
   `createVaultFile`/`deleteVaultFile`, reached from the human REST vault-write route, the operator MCP
   surface, the core `vault_write` tool gated by the `vaultWrite` profile key, and the elevated platform
   MCP surface) — none of which re-validate `vaultPath`'s format before calling it. A legacy row with a
   device-form `vaultPath` reaches this function's own unpinned git discovery (`boundedVaultGit`) with no
   check at all before this fix. Fixed by adding the same `isUnsafeToCanonicalize` check as the first
   refusal in `commitVault`, right after the existing `isOperationalVaultDir` refusal, returning
   `{ committed: false }` with a loud warning — the same shape every other `commitVault` refusal uses.

`resolveVaultGitTarget` (the companion `git-push` capability's target resolver) was considered and left
unchanged: it is read-only (never mutates, never `git init`s — see its own doc), and any device-form
`vaultPath` it's handed fails its `fs.existsSync` check or its own `checkIsRepo()` probe long before a
mutating call could ever be reached, so there is no commit/init to refuse there specifically. It inherits
no new risk from this gap.

## Do not

- Do not treat a UNC vaultPath as a carve-out from `isUnsafeToCanonicalize` at any of these sites — see
  "Decision" above for why it is never a legitimate configuration, not even for a vault-only project.
- Do not rely on `validateVaultPath` to catch this family — it deliberately lets it through (`f45821a2`);
  the refusal must come from `isUnsafeToCanonicalize` itself, checked explicitly at each site that acts on
  a stored `vaultPath` without going through `checkVaultRepoTripleContainment` first.
- Do not add this check inside `resolveVaultRepoContext` as a replacement for the boot loop's own named
  check — the boot loop's warning names the project id/name, which `resolveVaultRepoContext` has no
  access to; keep the project-identifying warning at the boot loop, and the path-identifying warning at
  `commitVault`.
