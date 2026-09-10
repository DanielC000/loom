# 2eb78eb2 — Detect an already-landed commit's empty stage EXPLICITLY, before the manual commit that would otherwise fail opaquely

## Context

`cherry-pick --no-commit` never errors when its patch is already fully applied — it just leaves the index
unchanged. The `mergeBase === branchTip` check in `landBranchCommitsIndividually`
(`git/batch-merge.ts`) only catches a WHOLE branch already landed; it says nothing about ONE redundant
commit inside an otherwise-new multi-commit branch (e.g. two branches that cherry-picked the same fix
independently).

Left undetected, the manual `git commit` a few lines later runs against a clean index and can itself fail
on git's own "nothing to commit, working tree clean" — a real git failure, not a Loom bug — landing in
this function's generic commit-failure branch with an opaque "commit failed while landing commit
`<sha7>`: …". The branch's outcome doesn't change (it still drops, same fallback as always); only the
diagnosability does — a manager reading that opaque reason has no way to tell "redundant content" apart
from an actual Loom defect.

## Decision

Detect the empty stage explicitly, right after the cherry-pick and before the manual commit, via `git
diff --cached --name-only` (not `--quiet`). `--quiet` signals "nothing staged" via its EXIT CODE, which is
indistinguishable at this call site from any other command failure once it reaches simple-git's `.raw()`
rejection path; `--name-only` always exits 0 and reports emptiness through its OUTPUT instead, so
detecting "nothing staged" here needs no exit-code guessing.

## Do not

- Do not use `git diff --cached --quiet` to probe for an empty stage at this call site — its exit-code
  signal is indistinguishable from any other `.raw()` failure.
- Do not let a redundant commit's empty stage fall through to the manual `git commit` call — it fails
  there too, but with an opaque reason that can't be told apart from a real defect.

## Consequences

A branch dropped because one of its own commits was already redundantly present in the batch tree now
reports that specific reason, instead of an opaque git commit failure a manager can't distinguish from a
genuine bug.

## Source

Inline comment in `packages/daemon/src/git/batch-merge.ts`, `landBranchCommitsIndividually`'s empty-stage
probe, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing
paragraph, `//` comment markers stripped, no wording changed.
