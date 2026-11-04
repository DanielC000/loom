# b5f01208 — check the ledger before spawning git in `tryWorkerTipLedgerBranchFallback`

From card `03f85c8e`'s Code Review: that card removed the trailers-off skip in the gateway's lazy
ship-state backfill (`GET /api/tasks/:id`), so trailers-off cards now run `resolveMergedInfo` on every
read, not just once at landing. The review noted that `tryWorkerTipLedgerBranchFallback`
(`git/worktrees.ts`) spawned a `git branch --list` subprocess unconditionally, before ever consulting the
cheap, DB-only `hasAnyForBranch` pre-check — paying one git spawn per read for a branch the ledger has
never recorded a landing for, which on a trailers-off project is now the COMMON case (every never-merged
card, on every poll).

`hasAnyForBranch(branch)` is true iff this (project, repoKey) scope has at least one row — solo
(`mainline_landed_commits`, `worker_landed_tip IS NOT NULL`) or batch (`batch_landed_worker_tips`) — keyed
to this worker branch. Both of `tryWorkerTipLedgerBranchFallback`'s two downstream paths are provably
`null` whenever that's false:

- The tip-keyed `tryWorkerTipLedgerFallback` (present-branch path) already calls `hasAnyForBranch` itself,
  first thing, before its own `rev-parse` — so it was already returning `null` here, just after paying for
  the now-pointless `branch --list` spawn that chose it.
- The branch-only `lookupGoneBranchLedgerSha` (gone-branch path) calls `ledger.lookupLandedForBranch`
  (`Db.getLandedCommitByWorkerBranch`), which queries the EXACT SAME two tables with the EXACT SAME
  `worker_branch` match — the same predicate as `hasAnyForBranch`, just "most recent row" instead of
  "any row exists". A `hasAnyForBranch` miss means this lookup also returns `null`.

So the `git branch --list` call exists only to choose between two paths that both return `null` on a
ledger miss — the choice itself is moot before it's made. Moving the `hasAnyForBranch` check to the top of
`tryWorkerTipLedgerBranchFallback`, before `boundedGit` is ever constructed, saves that one git spawn per
read for the never-merged population, with identical behavior for a branch the ledger actually knows
about (present-branch tip-keyed resolution and gone-branch resolution both unchanged).

## Do not

- Do not move `hasAnyForBranch`'s check to AFTER the `branch --list` spawn, or re-derive branch presence
  before checking it — the whole point is a zero-ledger-rows branch pays no git spawn at all, not merely a
  cheaper one.
- Do not assume `lookupGoneBranchLedgerSha`'s `lookupLandedForBranch` can return non-null when
  `hasAnyForBranch` is false — they query the identical two tables under the identical `worker_branch`
  match; a future change to either must keep that invariant, or this short-circuit becomes unsound.
- Do not read the `branch --list` call as serving any purpose beyond choosing between the tip-keyed and
  branch-only paths — it is not relied on for any other present-vs-gone distinction in this function.

Related: `docs/decisions/e8d4fdc3-trailers-off-already-merged-fallback-via-a-separate-ledger.md` (round 2,
where `tryWorkerTipLedgerFallback`'s own `hasAnyForBranch` pre-check was introduced).
