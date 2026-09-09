# 6ee48e4d — `findLandedSquashCommit`'s re-task guard, and aggregating the pre-fix trailer notice per pass

## Narrative

`findLandedSquashCommit` finds the SQUASH-merge commit for `branch` reachable from `base`, identified by the deterministic `Loom-Worker-Branch: <branch>` trailer `mergeBranch` writes. This REPLACES the `Merge branch '<branch>'` grep and `isBranchMerged` under squash, where the worker branch is NOT in main's ancestry.

RE-TASK GUARD (data-loss safety): the trailer lives in main's history FOREVER, so a branch RE-CUT onto a prior squash (the SAME task re-spawned) carries a HISTORICAL trailer while holding NEW live work. To avoid treating such a live worker as a landed orphan (deleting its worktree), when the branch ref STILL EXISTS this confirms the trailer commit is NOT an ancestor of the branch tip: a genuine orphan DIVERGES from it (merge-base ≠ the squash); a re-cut branch DESCENDS FROM it (merge-base == the squash). Tested via merge-base equality — `--is-ancestor`'s exit-1 raw misreads are avoided.

VERIFIED by TWO DIFFERENT MEANS with two different strengths — see [[e076d2a2-content-reachability-check-verifies-not-just-the-trailer-claim]] for the branch-present content check, and [[f621f185-path-set-digest-not-content-hash-for-the-deleted-branch-residual]] for the branch-gone path-set check. A commit predating either fix degrades to the pre-`f621f185` trailer-presence-only answer (logged, never silent).

FAILS SAFE: ANY error/timeout, or the verification disagreeing, returns `null` (NOT-landed). A false `null` costs Pass A keeping the worktree; a false landed sha is the exact silent-data-loss bug both cards exist to close.

`onPreFixTrailerNotice`, when supplied, REPLACES the branch-gone-pre-pathset `console.info` with a callback — for a caller invoking this in a loop (boot-reconcile Pass A's fallback path) that wants to aggregate the notice ONCE PER PASS instead of flooding the log per call.

## `scanMergedCommitMap` — the batch-friendly sibling, and truncated-vs-empty

`scanMergedCommitMap` is one bounded `git log` pass over `base`'s history, extracting every commit's `Loom-Worker-Branch:` trailer (plus `Loom-Worker-PathSet`/`Loom-Worker-Base`) into a `branch -> {sha, date, pathSetDigest, baseSha}` map — the batch-friendly sibling of `findLandedSquashCommit`'s single-branch `--grep`. ONE map per repo (cached) gives an O(1) read per task instead of one subprocess per task. First occurrence per branch wins (reverse-chronological = MOST RECENT).

ALSO reports whether the scan was TRUNCATED (`MergedCommitScan.truncated`) — the discriminator Pass A needs to tell "never landed" (complete scan, genuine miss) apart from "might have landed outside the window" (truncated, inconclusive) — two states that used to share one signature (an empty `Map.get`). Detected from data already computed: `git log -n LIMIT` returns AT MOST `LIMIT` commits, so EXACTLY `LIMIT` non-blank records means more history may exist. Counts EVERY record seen, not just trailer matches — counting only hits would never reach the limit, falsely reporting "complete" on a truncated scan. FAILS SAFE: any error returns an EMPTY map with `truncated:true`.

The no-PathSet-trailer count is logged ONCE PER SCAN, not per lookup — `getTaskMergedInfo` runs per task on every polled board read, and per-lookup logging would flood the daemon log. See [[52e978ad-merged-verification-mode-three-different-guarantees-not-interchangeable]] for the `"trailer-only"` breakdown this count can't itself distinguish.

## `findLandedSquashCommitViaMap` — the batch-primitive sibling, and `scanComplete`

Exists for boot-reconcile Pass A, which used to call `findLandedSquashCommit` once PER historical worker session — thousands of sequential spawns per boot. Instead looks `branch` up against the shared cached map. A HIT resolves via `resolveMergedCommitMapHit` — the SAME re-task-guard + verification `findLandedSquashCommit` applies (NOT weaker). A MISS returns `{hit:false, scanComplete}`: `scanComplete:true` (full history read) makes the miss AUTHORITATIVE; `scanComplete:false` (truncated or errored) means inconclusive, and a caller needing the full-history guarantee MUST fall back to `findLandedSquashCommit` directly.

## Do not

- Do not skip the re-task guard's ancestry check — a re-spawned task's live new work would be misdetected as an orphaned landed squash and its worktree deleted.
- Do not use `--is-ancestor` for the ancestry check — its exit-1 raw output misreads here; use merge-base equality.
- Do not resolve any ambiguity (error, timeout, disagreement) to a landed sha — always fail safe to `null`.
- Do not flood the log with a per-call notice in a loop caller — use `onPreFixTrailerNotice` to aggregate once per pass.
- Do not treat an empty-map or `findLandedSquashCommitViaMap` miss as authoritative without checking `truncated`/`scanComplete` first — fall back to `findLandedSquashCommit` when it's inconclusive.
- Do not count only trailer-matching records when detecting truncation — count every record seen, or a truncated scan can falsely report "complete".
- Do not log the no-PathSet-trailer count per lookup — log it once per scan.

## Consequences

A re-spawned task's live worktree is protected from being misdetected as a landed orphan, and boot-reconcile's Pass A can aggregate its pre-fix-trailer notices once per pass instead of flooding the log per row.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `findLandedSquashCommit`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
