# 1d3f500e — A trailer lookup takes the LAST regex match in the commit body, never the first

## Narrative

`lastTrailerMatch` returns the LAST match of a trailer regex in `body`, never the first (Code Review `c00a136c`, card `1d3f500e`). The real trailer block a stamp lands sits at the END of a commit message, appended after any worker-authored text — on the BATCH path (`landBranchCommitsIndividually`, `git/batch-merge.ts`) that worker-authored body passes through **verbatim** before `Loom-Worker-Branch`/`-PathSet`/`-Base` are appended. A first-match `/^X:\s*(\S+)/m` regex would let a worker-authored line that merely starts with the same shape at column 0 pre-empt the real, machine-stamped trailer — the reviewer's own specimen: a future commit TO `batch-merge.ts` itself, whose body quotes an example `Loom-Worker-Base: <sha>` line at column 0, would shadow its own real trailer under the old code. Taking the last match instead makes the position in the message (not the first textual occurrence) the thing that resolves it, matching how a real trailer block is actually located.

`re` must carry the `m` flag and exactly one capture group (every `LOOM_WORKER_*_TRAILER` constant does); this builds a `g`-flagged variant to scan every match in `body` and keeps only the last one found.

## Do not

- Do not switch back to a first-match trailer lookup — a worker-authored commit body that happens to quote an example trailer line at column 0 (e.g. a commit to `batch-merge.ts` itself) would shadow the real, machine-stamped trailer.
- Do not pass a `re` without the `m` flag or with more than one capture group — the global-variant construction and the single-capture read both assume exactly that shape.

## Consequences

A worker-authored commit body that happens to contain a line shaped like a trailer no longer shadows the real, machine-stamped trailer that follows it — the actual position in the message, not the first textual occurrence, resolves the lookup.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `lastTrailerMatch`'s own doc comment (~line 2173), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
