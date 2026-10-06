# cc684616 — vault auto-commit refuses a vault inside a linked worktree of a registered code repo

## Narrative

Residual from the a09b81a0 Code Review (finding 4): a vault placed inside a user-created LINKED WORKTREE
of a registered code repo resolved the versioner's `commitPath` to the worktree's own root, which
`checkCodeRepoCollision` (`vault/versioner.ts`) never recognized as colliding with that same project's
registered `repoPath` (the MAIN checkout). Verified with real git: `commitVault` returned `committed:true`
and an unrelated, genuinely uncommitted code file sitting elsewhere in the same worktree was swept into
that same commit.

**Root cause.** `canonicalRepoLockKey` (`git/repo-lock.ts`) keys on the git TOPLEVEL
(`resolveGitToplevelSync` — @decision 7673d096, never changed by this card). A linked worktree's own
`.git` is a FILE, so its toplevel is the worktree's OWN root; a main checkout's `.git` is a real
directory, so its toplevel is itself. These are two different canonical directories for the SAME
underlying physical repo, and two independent checks in `checkCodeRepoCollision` missed it as a result:
- `isRecognizedVaultRoot`'s self-exclusion test: the entry's own `vaultPath` (inside the worktree) is
  at-or-under `key` (the worktree's toplevel), but its own code candidate (`repoPath`, the MAIN checkout)
  is NOT toplevel-at-or-under that same `key` — so the entry wrongly VOUCHES for the worktree as a
  recognized vault root, exempting it before the per-candidate loop ever runs.
- The per-candidate collision loop itself: `repoPath`'s toplevel key (the main checkout) is also not
  at-or-under the worktree's own toplevel key, for the identical reason.
Both had to be fixed — fixing only one left the other still missing the collision (confirmed by hand-
tracing both against the repro's concrete path values before implementing, and PINNED empirically per the
split negative control below).

**Split negative control (Code Review `ad21ff1f`, answering the reviewer's question with evidence).**
Reverted ONLY `isRecognizedVaultRoot`'s common-dir OR-clause (keeping the per-candidate loop's fix) —
`vault-commit-code-repo-guard.mjs`'s (15)/(15b)/(15c)/(16) all FAIL, 9 failed assertions, byte-identical to
the full pre-fix revert. Restored, then reverted ONLY the per-candidate loop's common-dir OR-clause
(keeping `isRecognizedVaultRoot`'s fix) — the SAME four tests FAIL, the SAME 9 assertions, again
byte-identical. Both sites independently reproduce the complete bug for every scenario this card tests:
in each of (15)/(15b)/(15c)/(16), the colliding candidate IS the vault-owning entry's own `repoPath`, so
`isRecognizedVaultRoot`'s self-exclusion test is always reached FIRST and (reverted to toplevel-only)
always wrongly vouches, short-circuiting before the loop ever runs — independent of whether the loop
itself is fixed. And when `isRecognizedVaultRoot` IS fixed (so the loop is actually reached), the loop's
OWN toplevel-only check independently fails to match, for the identical toplevel-vs-common-dir reason.
Neither revert reddens nothing; the claim is pinned by the existing scenarios, no new one was needed.

**Fix.** A new, purely ADDITIVE canonicalization key, `canonicalCommonDirKey` (`vault/versioner.ts`),
canonicalizes by git COMMON-DIR identity instead of toplevel — any worktree of the same physical repo
resolves to the SAME key. It reuses the existing, unmodified `resolveGitMainCheckoutRootSync`
(`git/repo-lock.ts`, already follows a linked worktree's `.git` FILE indirection back to its main checkout
root for an unrelated caller), normalized for win32 casing the same way `canonicalRepoLockKey` is; `null`
means "not inside a git repo at all", never a wildcard match. `collidesByToplevelOrCommonDir` combines it
with the existing `isCanonicallyAtOrUnder` toplevel check (OR, not replace) and is used at BOTH sites:
`isRecognizedVaultRoot`'s `ownCodeAtRisk` test, and `checkCodeRepoCollision`'s own per-candidate loop.

**Cost: hoisted, not per-candidate (Code Review `ad21ff1f`).** `canonicalCommonDirKey(commitPath)` —
commitPath's OWN common-dir key — is INVARIANT across one `checkCodeRepoCollision` call, but the first
cut of this fix recomputed it inside `collidesByToplevelOrCommonDir` on every per-candidate iteration.
Each resolution is a synchronous `realpathSync.native` + ancestor walk; a registered `repoPath` entry on
an unreachable UNC/SMB share blocks for the share's own OS-level timeout, and `flushSync` pays this cost
inside its graceful-shutdown budget (@decision 816f0056) — so paying it once per candidate instead of once
per call multiplies that risk by the registered-project count for no reason. Fixed: `checkCodeRepoCollision`
computes `keyCommon` ONCE and threads it into both `isRecognizedVaultRoot` and the per-candidate loop;
`collidesByToplevelOrCommonDir` takes `keyCommon` as an already-resolved parameter instead of re-deriving
it from a raw path. The CANDIDATE's own common-dir key stays computed per-candidate (it legitimately
differs each iteration) and stays LAZY — only when the cheap toplevel check misses first — unchanged from
the original cut. Behavior is byte-identical; this is a cost fix only.

**No-op for every existing non-worktree scenario.** For an ordinary repo (`.git` is a real directory, no
indirection), `resolveGitMainCheckoutRootSync` returns the exact same value `resolveGitToplevelSync`
already does, so `canonicalCommonDirKey` equals the existing toplevel key exactly. The shared-Obsidian-
vault exemption (a09b81a0 round 3), the monorepo-subdir catch (a09b81a0 round 2), and the accepted
nested-gitlink false-positive trade-off (a09b81a0 round 2 Minor) are all unaffected — verified by the full
existing `vault-commit-code-repo-guard.mjs` suite staying green, including the (14)/(14b)/(14c) KNOWN-HOLE
tripwires (untouched, still pinning today's known-wrong third-party-vouching behavior — not this card's
concern), and by a real-DB classification diff (every one of the owner's real registered projects with a
`vaultPath`, run through the same `resolveVaultRepoContext` → `checkCodeRepoCollision`/
`isRecognizedVaultRoot`/`isCommitPathMergeEligible` classification on main vs. this branch) showing zero
changed classifications.

**Evaluation order is unchanged.** `isOperationalVaultDir` (Loom's own `LOOM_HOME`/`WORKTREES_DIR`
refusal) is checked by every real caller (`commitVault`, `flushSync`, `startVaultVersioners`'s boot loop)
BEFORE `checkCodeRepoCollision` is ever reached — this card does not touch that ordering, or
`isOperationalVaultDir` itself, at all. At the time of THIS card, `isOperationalVaultDir` caught a
vaultPath that IS, or is an ANCESTOR of, `LOOM_HOME`/`WORKTREES_DIR` (or carries their content markers) —
but NOT a vaultPath merely located somewhere INSIDE one specific worker worktree UNDER `WORKTREES_DIR` (a
descendant, not an ancestor); that shape fell through to `checkCodeRepoCollision`, which this card made
correctly refuse it as a collision instead of silently missing it, exactly like any other user-created
worktree of a registered repo.

**Superseded by card `a018fb5a`.** `isOperationalVaultDir` now ALSO catches any descendant of
`WORKTREES_DIR` directly (see that card's own record) — so a vault inside a worker worktree of a
STILL-REGISTERED repo (this card's own test (16) shape) is refused at the EARLIER operational-dir check
today, not by the collision guard this card added. This card's own fix is still load-bearing for the
case `a018fb5a` does NOT cover: a vault colliding with a registered repo via a linked worktree OUTSIDE
`WORKTREES_DIR` (e.g. a user-created worktree elsewhere on disk) still reaches, and is refused by, this
card's common-dir widening of `checkCodeRepoCollision`.

**`isCommitPathMergeEligible` is unchanged.** The new worktree-collision case is refused by
`checkCodeRepoCollision` outright, before the auto-committer ever reaches the lock-taking step — there is
no new lock/merge-eligibility interaction to design for.

## Do not

- Do not widen or touch `canonicalRepoLockKey`/`resolveGitToplevelSync` (`git/repo-lock.ts`) to close this
  — they are governed by `@decision 7673d096` and must stay toplevel-only. `canonicalCommonDirKey` is a
  SEPARATE, additive key for exactly this reason.
- Do not drop the existing toplevel `isCanonicallyAtOrUnder` check at either call site when adding the
  common-dir OR-clause — the common-dir check alone does not catch the monorepo-subdir shape where a
  candidate has its own distinct `.git` nested under `commitPath` (a genuinely separate repo, a different
  common-dir identity) but is still textually nested — that shape is caught only by the toplevel rule.
- Do not fix only one of `isRecognizedVaultRoot`'s self-exclusion test or `checkCodeRepoCollision`'s
  per-candidate loop — both independently miss the linked-worktree shape; fixing one alone leaves the
  other still exempting or missing it.
- Do not add a per-candidate git-toplevel subprocess probe to close this — `canonicalCommonDirKey` reuses
  the existing synchronous, subprocess-free `resolveGitMainCheckoutRootSync`, preserving the same cost
  posture `checkCodeRepoCollision`/`flushSync` already rely on (see `@decision a09b81a0`'s round-2 section
  on why a per-candidate git-toplevel probe was rejected there too).
- Do not read this fix as closing the a09b81a0 KNOWN HOLE (third-party vault-root vouching, tracked by
  card `7c1d6dbf`) — it is unrelated; the (14)/(14b)/(14c) tripwires in `vault-commit-code-repo-guard.mjs`
  must stay pinned to today's known-wrong behavior exactly as a09b81a0 round 4 left them.

## Source

Card `cc684616`. Code: `packages/daemon/src/vault/versioner.ts` (`canonicalCommonDirKey`,
`collidesByToplevelOrCommonDir`, `isRecognizedVaultRoot`, `checkCodeRepoCollision`),
`packages/daemon/src/git/repo-lock.ts` (`resolveGitMainCheckoutRootSync`, reused — not modified). Tests:
`vault-commit-code-repo-guard.mjs`. Related: `docs/decisions/a09b81a0-vault-commit-code-repo-guard.md`,
`docs/decisions/7673d096-sync-toplevel-walk-for-the-canonical-lock-key.md`.
