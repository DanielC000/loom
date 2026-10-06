# a018fb5a — vault auto-commit treats any descendant of WORKTREES_DIR as operational

## Narrative

Residual from `cc684616`'s own narrative (worker `8a4d3d91` refuted the lead's premise; Code Review
`ad21ff1f`, 2026-10-07): `isOperationalVaultDir` (`vault/versioner.ts`) refuses a `vaultPath` that IS
`WORKTREES_DIR`/`LOOM_HOME`, or an ANCESTOR of either (or carries their content markers), but — before this
card — never a path merely nested INSIDE one. `cc684616` closed part of that gap for a vault inside a
linked worktree of a REGISTERED repo, via `checkCodeRepoCollision`'s common-dir widening. Two shapes still
fell through with no refusal at all:

- **(a)** a vault inside a worktree whose repo is no longer in `codeRepoGuard`'s snapshot — hard-deleted,
  or never registered — so there is nothing in the snapshot for `checkCodeRepoCollision` to collide
  against.
- **(b)** a vault in a non-git directory directly under `WORKTREES_DIR` (e.g. `WORKTREES_DIR/<projectId>`
  before a real worktree has been created there). It carries neither of `isOperationalVaultDir`'s two
  content markers (`loom.db`, a `worktrees/` subdir), so `commitVault` would lazily `git init` it and
  `git add -A` would go on to record worker worktrees nested under it as embedded gitlinks.

**Fix.** A new, vault-side-only predicate, `isDescendantOfWorktreesDir` (`vault/versioner.ts`), is true for
any path strictly nested inside `WORKTREES_DIR` (never equal — equality is already covered by
`isLoomHomeOrAncestor`). `isOperationalVaultDir` now checks it alongside the existing
`isLoomHomeOrAncestor`/content-marker checks, so both (a) and (b) above are refused as `operational-dir`
before `checkCodeRepoCollision` is ever reached.

**Deliberately NOT folded into `isLoomHomeOrAncestor`.** That function is the shared path-relation half
used by BOTH this file's own `isOperationalVaultDir` AND `git/writer.ts`'s `GitWriter` guard (`@decision
f9360c84`). A registered project's own `repoPath` is never itself a path under `WORKTREES_DIR` (a worktree
is a worker's own working copy, never the project's registered `repoPath`), so `GitWriter` has no
comparable use case for a descendant-of-`WORKTREES_DIR` check, and widening the SHARED predicate risks
regressing `GitWriter`'s own proven semantics for no real benefit. `isDescendantOfWorktreesDir` is a
separate, additive function reused only by this file's own `isOperationalVaultDir`.

**GitWriter's semantics are unchanged.** `git/writer-worktree-guard.mjs` (or whichever test(s) exercise
`GitWriter`'s own operational-dir refusal) was re-run unmodified and stays green — nothing in `GitWriter`
calls `isDescendantOfWorktreesDir` or is otherwise touched by this card.

**Evaluation order, and the refusal reason this changes.** Every real caller
(`commitVault`/`flushSync`/`startVaultVersioners`'s boot loop) already checks `isOperationalVaultDir`
BEFORE `checkCodeRepoCollision` — unchanged by this card. Because `isOperationalVaultDir` now also catches
a vault nested inside a worker worktree of a STILL-REGISTERED repo (the shape `cc684616`'s own test (16)
covers), that case is now refused at the EARLIER operational-dir check instead of falling through to the
collision guard — its refusal reason changes from `blockedReason: "code-repo-collision"` to no
`blockedReason` at all (`committed: false`, operational-dir path). `cc684616`'s test (16) was updated to
assert the new (now correct, "operational-dir wins") reason; its own narrative there ("not
`operational-dir`") is accordingly superseded by this card, not re-litigated.

## Do not

- Do not fold `isDescendantOfWorktreesDir` into `isLoomHomeOrAncestor` — that predicate is shared with
  `GitWriter`'s guard (`@decision f9360c84`) and must keep exactly its current ancestor-or-equal semantics.
- Do not treat `dir === WORKTREES_DIR` as a match in `isDescendantOfWorktreesDir` — equality is already
  covered by `isLoomHomeOrAncestor`, reached first in `isOperationalVaultDir`; duplicating it here would
  just be redundant, not wrong, but keep the two predicates' scopes disjoint and legible.
- Do not read `cc684616`'s test (16) as still describing today's behavior for a vault inside a
  still-registered repo's worker worktree — that case is now refused via `operational-dir`, not
  `code-repo-collision`; the test itself was updated here, and its surrounding comment should be read as
  historical narrative for how the bug was characterized at the time, not current behavior.

## Source

Card `a018fb5a`. Code: `packages/daemon/src/vault/versioner.ts` (`isDescendantOfWorktreesDir`,
`isOperationalVaultDir`). Tests: `vault-operational-worktrees-descendant.mjs` (new),
`vault-commit-code-repo-guard.mjs` (test (16) updated). Related: `docs/decisions/cc684616-vault-worktree-common-dir-collision.md`,
`docs/decisions/f9360c84-refuse-operational-dirs-in-vault-git-target-and-reserved-home-git-writers.md`.
