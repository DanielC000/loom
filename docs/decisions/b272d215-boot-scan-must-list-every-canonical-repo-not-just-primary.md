# b272d215 — the boot-time canonical-index residue scan's input list must name EVERY canonical repo, not just each project's primary `repoPath`

## Narrative

The set of paths the boot-time canonical-index residue scan checks must name every canonical repo a real
merge can land on — not just each project's PRIMARY `repoPath`. A multi-repo project's SECONDARY registry
repos (`project.repos`, multi-repo epic `49136451`) are just as reachable by `mergeBranchLocked` (it
merges against them directly), and omitting them from this scan's input isn't merely a gap in coverage: it
makes `describeMergeDangerLatchAtBoot` treat an unscanned secondary repo as CLEAN, printing a false
all-clear over a repo that could actually be holding a dead squash's stage. The list is built de-duped
(two projects can register the same path) and is deliberately kept in sync with the sibling enumeration at
`sessions/service.ts`'s branch-ref sweep (`[project.repoPath, ...project.repos.map((r) => r.path)]`) — two
independent enumerations of "this project's canonical repos" that must never disagree.

## Do not

- Do not build this scan's input list from each project's `repoPath` alone — a multi-repo project's
  secondary registry repos are just as reachable by a real merge and must be included.
- Do not let this enumeration drift from `sessions/service.ts`'s own branch-ref sweep — the two lists
  independently answer "what are this project's canonical repos" and must agree, or one of them will be
  silently wrong about which repos are actually covered.

## Consequences

`describeMergeDangerLatchAtBoot`'s all-clear for a secondary registry repo can be trusted: the scan that
feeds it was asked to cover that repo, not merely the project's primary one.

## Source

Inline comment in `packages/daemon/src/index.ts`, immediately before the canonical-repo-paths collection
loop feeding the boot-time residue scan, as of this worktree's HEAD before this extraction. Wrapped source
lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
