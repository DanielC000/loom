# 4763432b — Batch landing order is sorted oldest-author-date-first, not caller-supplied order

## Context

Landing order was previously whatever order the caller happened to pass `candidates` in. Once a batch's
commits land via cherry-pick (each candidate's own commits, individually — card `6801c0a1`), main's own
commit history reads non-chronologically under that arbitrary order: cherry-picking always produces
monotonically-increasing COMMITTER dates, but each candidate's own AUTHOR dates can be older or newer than
another candidate's depending only on which order the caller happened to list them in.

## Decision

`assembleBatchBranches` sorts `candidates` by each branch's own earliest AUTHOR date (ascending — oldest
work first, `sortCandidatesByEarliestAuthorDate`), measured against the batch worktree's HEAD as it stood
BEFORE any candidate landed — always the un-mutated starting point, never re-derived per candidate, so
every branch's earliest-date is measured against the same reference regardless of where it ends up in the
sorted order. A candidate whose date can't be resolved sorts LAST; ties (including two unresolved
candidates) keep their ORIGINAL relative order via an explicit index tie-break, never relying on
`Array.prototype.sort`'s stability alone to document that guarantee at the call site.

**Honest limit:** this guarantees "branches land oldest-first", never "commits are chronological" —
branches are worked in parallel, so two branches' own author-date RANGES can overlap, and keeping each
branch's commits contiguous (a hard invariant the landing step relies on) makes strict global
chronological ordering impossible whenever they do.

## Do not

- Do not reorder commits WITHIN a branch to chase closer chronological ordering — only branches are
  reordered relative to each other; a branch's own commits always stay contiguous and in their original
  order.
- Do not assume `Array.prototype.sort`'s stability alone is a documented guarantee for the tie-break — the
  sort uses an explicit original-index tie-break instead.

## Consequences

Main's commit history reads oldest-branch-first across a batch instead of in arbitrary caller order,
though two overlapping branches' commits can still interleave non-chronologically in the strict sense —
a known, accepted limit, not a bug to chase further.

## Source

JSDoc comment in `packages/daemon/src/git/batch-merge.ts`, above `assembleBatchBranches` and
`sortCandidatesByEarliestAuthorDate`, as of this worktree's HEAD before this extraction. Wrapped source
lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
