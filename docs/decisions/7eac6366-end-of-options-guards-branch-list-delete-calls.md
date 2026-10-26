# 7eac6366 — `--end-of-options` guards every `git branch --list`/`-D` call's bare name token

## Narrative

Phase 2 of `65b2b002` (`docs/decisions/65b2b002-end-of-options-guards-the-diff-range-token.md`), which fixed
`changedPathsBetween`/`changedPathStatusesBetween`'s `${base}..${ref}` range token but explicitly carded this
same argument-injection CLASS out of its own scope for `git branch --list ${branch}` / `git branch -D ${branch}`
(see that record's "Do not" section) — different git calls, different argv shape, deliberately deferred to a
separate card so that fix stayed minimal. Today every `branch` argument at these call sites is the caller's own
known worker branch name (`loom/<taskId>`), never trailer- or otherwise attacker-derived, so this is
defense-in-depth against the bug class, not a fix for a currently-exploitable path.

**The mechanism (measured on real git 2.47.0, temp repos):** `git branch --list [<pattern>...]` and
`git branch -D [-r] <branchname>...` are both followed by a variable-length, still-option-parsed tail — git
keeps scanning every subsequent argv token for a recognized flag rather than treating the whole tail as pure
positional data. A `branch` value shaped like a real flag (`--merged`, `-f`, `-r`, …) is therefore **re-entered
into option parsing** instead of staying a literal name:
- `git branch --list --merged` (no fix) does not list a pattern literally named `"--merged"` — it is consumed
  as the `--merged` (vs HEAD) filter flag, and since the default branch is trivially merged into itself, this
  prints non-empty output. A caller reading "non-empty ⇒ branch exists" (`branchExistsInRepo`, `isBranchMerged`,
  the `branchPresent` gate in `findLandedSquashCommit`/`findIntroducingSquashCommit`/
  `resolveMergedCommitMapHitList`) gets a **false positive**: it believes a branch named `"--merged"` exists
  when it does not, anywhere in the repo.
- `git branch -D -f` (no fix, and no further token) fails with `"fatal: branch name required"` — `-f` is
  consumed as `-D`'s own force flag, not a name, so a REAL branch literally named `"-f"` is never touched and
  silently **survives** the delete. `deleteBranch`'s own catch only special-cases a `"not found"` message; any
  other failure is warned and still returns `true` (the generic "could not delete… warn + return true" tail),
  so the caller is told the delete is fine while the ref is untouched.
- The SAME skip happens inside `deleteBranches`' BATCHED call (`git branch -D real1 -f real2`): git exits `0`
  having genuinely deleted `real1`/`real2` while swallowing `"-f"` as the force flag — the code's own comment
  ("git's own exit code 0 means every named branch in THIS chunk is gone") is violated for that one entry, and
  it is still pushed into the `deleted` array as if it were removed.

`--merged <value>`'s own REQUIRED-argument slot is a different, already-safe shape: git's option parser grabs
the literal next argv token unconditionally as that flag's value (MEASURED: `git branch --merged -D --list
feat1` resolves `-D` as a revision to `rev-parse`, not as a flag — `"fatal: malformed object name -D"`) — so
`base`/`mainlineBranch` positioned there never needed this fix, and placing `--end-of-options` immediately
before THAT slot instead actively breaks the call (`--merged --end-of-options --list` consumes
`--end-of-options` itself as the merged-against revision).

**Placement rule (measured, the one way that works for every shape):** `--end-of-options` must sit immediately
before the bare name token itself — right after `--list`/`-D`, never before them. Placed before `--list`
(`git branch --end-of-options --list feat1`), git treats `--list` ITSELF as the (invalid) branch name instead
(`"fatal: '--list' is not a valid branch name"`). Placed correctly, both the ordinary case (`git branch --list
--end-of-options feat1` lists it) and the malicious case (`git branch --list --end-of-options -D` matches
nothing, deletes nothing) behave exactly as intended, and a BATCH call takes exactly one `--end-of-options`
before the whole trailing name list (`git branch -D --end-of-options real1 -f real2` genuinely deletes all
three, confirmed).

## Call sites fixed (`git/worktrees.ts`)

All nine bare-branch-after-`--list`/`-D` sites in this file, each anchored `@decision 7eac6366` at the site:
1. `createWorktree`'s branch-exists probe (`boundedLockedRaw(["branch", "--list", …])`).
2. `deleteBranch`'s non-CAS delete path (`["branch", "-D", …])`).
3. `branchExistsInRepo`.
4. `deleteBranches`' batched delete (`--end-of-options` before the whole `...chunk]` spread).
5. `isBranchMerged` — only the `--list` slot; its `--merged <base>` slot is untouched (see "Do not").
6. `branchExists` (the `workerDiff` on-demand HTTP sibling of `branchExistsInRepo`).
7. `findLandedSquashCommit`'s `branchPresent` gate.
8. `findIntroducingSquashCommit`'s attribution-only existence check.
9. `resolveMergedCommitMapHitList`'s `branchPresent` gate (the merged-commit-map twin of site 7).

**Deliberately NOT touched:** `listMergedLoomBranches`'s `["branch", "--list", "loom/*", "--merged",
mainlineBranch, …]` — the token right after `--list` here is the hardcoded literal `"loom/*"`, never
caller-supplied, and `mainlineBranch` sits in the already-safe `--merged`-value slot (see above); there is no
bare attacker-reachable token in this call at all.

## Known gaps (flagged by Code Review, carded separately — not fixed here)

This card's fix, and its own "Do not" scoping below, cover ONLY the `git branch --list`/`-D` class: a bare
name token sitting in a slot git keeps re-parsing for flags. Code Review on this card's commit found several
MORE sites in `git/worktrees.ts` that pass a bare, potentially-attacker-shapeable token to a DIFFERENT git
subcommand, each its own argument-injection shape, none fixed by `--end-of-options` the way this card's sites
are:
- `createWorktree`'s own `git worktree add <path> <branch>` call (~line 1310) — `--end-of-options` does NOT
  help here (unverified exactly why, by this card); the reviewer's framing is that this site needs entry-point
  name validation instead, not an argv-ending flag.
- Several `git log <base> ...` / `git rev-parse <ref>` calls taking a bare `base`/`ref` positional (~lines
  7666, 7838, 7940, 7987, 8592).
None of these were touched by this card — they are a different subcommand, a different fix shape, and a
different investigation, left to the manager's own follow-up card.

## Do not

- Do not read this record's fix, or its "Consequences" section below, as a claim that every `git.raw` call
  site in `packages/daemon/src/**` is now safe against a bare option-shaped token — see "Known gaps" above;
  this card is scoped to the `--list`/`-D` class only.
- Do not place `--end-of-options` before `--list`/`-D` themselves — measured that git then treats `--list` (or
  the first positional after `-D`) as the invalid branch name instead of ending option parsing where intended.
- Do not add `--end-of-options` to the `--merged <value>` slot (`isBranchMerged`'s `base`, or
  `listMergedLoomBranches`'s `mainlineBranch`) — that slot's value is always consumed literally regardless of
  shape (measured), and `--end-of-options` placed immediately before it is itself swallowed as the value,
  breaking the call.
- Do not widen this to the `refs/heads/${branch}^{commit}`-prefixed `rev-parse`/`rev-list` sites elsewhere in
  `git/worktrees.ts`/`git/batch-merge.ts`/`sessions/service.ts` — a token that literally starts with
  `"refs/heads/"` can never be option-shaped (it can't begin with `-`), so there is nothing for
  `--end-of-options` to guard there.
- Do not touch `sessions/service.ts`'s `createProjectBranch`/`checkoutProjectBranch` git calls
  (`check-ref-format --branch`, `for-each-ref`) — that whole path already validates the branch name via
  `unsafeBranchNameReason` BEFORE any git call runs (`checkoutProjectBranch`'s shared entry point, round 10 of
  `2a6a292a`), so an option-shaped name never reaches those calls in the first place. A different, already-
  closed guard, not this card's class.
- Do not treat a passing regression test here as validating the `--merged`-value slot too — that slot was
  never broken and this card's test file does not exercise it as an attack surface.

## Consequences

Every current and future caller of `branchExistsInRepo`/`deleteBranch`/`deleteBranches`/`isBranchMerged`/
`findLandedSquashCommit`/`findIntroducingSquashCommit`/`resolveMergedCommitMapHitList` is protected against an
option-shaped branch name being re-entered into git's own option parser, at zero behavioral cost to a
well-formed branch name (every ordinary case, including a batched delete mixing several ordinary names,
confirmed byte-identical in outcome). `branch` itself remains the caller's own known value at every site today
— this closes the bug CLASS defensively, it does not newly validate `branch`'s provenance.

## Source

Investigated and fixed by a worker dispatch under card `7eac6366` (defense-in-depth follow-up to `65b2b002`).
Every claim above (the false-positive existence reads, the silent solo-delete skip, the silent batch-delete
skip-with-false-credit, and the exact placement rule) was reproduced directly on real git 2.47.0 in throwaway
temp repos before any source edit, then again against the fix; see
`packages/daemon/test/branch-list-delete-argv-injection.mjs` for the regression coverage.
