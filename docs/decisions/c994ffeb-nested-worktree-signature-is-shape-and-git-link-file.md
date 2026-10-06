# c994ffeb — a repo-axis dir's real children are identified by SHAPE + `.git`-FILE, never "any `.git` entry"

`createWorktree`'s cut-time collision backstop (REVERSE direction: a primary task's worktree dir may
already BE a repo-axis dir holding real nested task worktrees, which the ordinary "exists with no `.git`
link → half-removed orphan → rename aside" branch would otherwise mistake for a genuine orphan and
destroy the distinction between) needs to tell a real repo-axis dir apart from a genuine half-removed
orphan.

## The drift

The first cut of this backstop (commit 367d53f6) used `hasNestedWorktreeChild`: "does `dirPath` hold at
least one child DIRECTORY that itself has a `.git` entry?" Code Review on that commit found this
over-matches: a half-removed PRIMARY orphan that happens to contain a real nested `git clone` (e.g. a
worker's own `<dir>/ref-clone` reference checkout) or a submodule-style `.git` also has a child directory
with a `.git` entry — neither is a repo-axis dir, both are ordinary content a half-removed orphan can
legitimately hold. The old check refused the cut PERMANENTLY instead of renaming the orphan aside (the
correct, pre-this-card behavior), and the thrown error wrongly asserted "a registered repoKey of this
same name must be renamed" when no such repoKey necessarily existed at all.

## The fix

`findNestedWorktreeLikeChild` narrows the match on BOTH axes a real repo-axis dir's children actually
have and a nested clone/submodule does not:
- the child's NAME must match `TASK_KEY_SHAPE_RE` (12 hex chars) — a repo-axis dir's real children are
  always named by `taskKey`, never an arbitrary nested-repo directory name.
- the child's `.git` entry must be a FILE (a worktree LINK — `git worktree add`'s own `gitdir: ...`
  pointer), never a directory — a nested `git clone`/submodule's own `.git` is always a directory.

It returns the matching child's NAME (so the caller's error describes what was actually found) or `null`,
rather than a bare boolean — the caller's error message never asserts a specific repoKey exists.

## Do not

- Do not go back to "any child directory with a `.git` entry" as the signature — it over-matches a
  half-removed orphan that happens to hold a real nested clone or submodule, refusing a cut that should
  instead be renamed aside.
- Do not drop either half of the narrowing (name-shape AND `.git`-is-a-FILE) — either alone still
  over-matches: a taskKey-shaped directory could still be an ordinary nested clone (shape alone isn't
  enough), and a `.git`-FILE child with an arbitrary name is exactly what a genuine stray worktree
  reference inside a half-removed orphan could also look like (the FILE check alone isn't enough either).
- Do not word the resulting error as if a specific repoKey is known to exist/collide — describe the
  nested child that was actually found; asserting a repoKey "must be renamed" when none may exist at all
  is misleading to whoever reads the refusal.

## Source

Card `c994ffeb`. Code Review of commit `367d53f6` (finding 1 of that review; finding 2,
`reclaimWedgedWorktreePathForSpawn` bypassing the reverse check, is tracked separately). Tests:
`packages/daemon/test/repokey-taskkey-collision.mjs`.
