# d62dad73 — `Loom-Worker-Base:` stamps the LANDED base, never the branch's pre-landing fork point

## Narrative

The `Loom-Worker-Base:` trailer (card `d62dad73` phase 2) records the explicit base a landed commit's path-set digest was computed against.

On a BATCHED landing, the tip commit stamps this alongside `Loom-Worker-PathSet` to record the batch tip as it stood immediately before this branch's own cherry-picks began (`batchHeadBefore` in `landBranchCommitsIndividually`, `git/batch-merge.ts`) — a real commit in the LANDED history, equal to the FIRST cherry-picked commit's own `sha^`, since that first commit lands directly onto it. It is NOT equal to the TIP's own `sha^` once a branch contributes more than one commit — the tip's `sha^` is then the branch's own PREVIOUS cherry-picked commit, not `batchHeadBefore` — which is exactly why this trailer exists: without it, verification would have nothing but the tip's own too-narrow `sha^` to fall back to.

A SOLO squash merge (`mergeBranchLocked`) stamps this too — originally (card `756a2cd8`) as a follow-up amend once the squash commit's real sha existed; since card `c862f14c`, computed from the STAGED index before the single commit lands (see `stagedPathSetDigest`), which that card's own DoD proves yields the identical value the amend used to.

### The bug this fixed: fork point vs. landed base

Its digest is NOT computed against `merge-base(HEAD, branch)` — an earlier version of this code was, and that was the bug: `merge-base(HEAD, branch)` is the branch's PRE-landing fork point, and `sha^` (the LANDED base) coincides with it ONLY for an UP-TO-DATE branch (main hasn't advanced past the branch's own fork point at squash time). When main HAS advanced, the two diverge — the same rename-following divergence this card's batch investigation found (main renames a file the branch also edits; the squash lands cleanly under the renamed path while a digest computed from the branch's own pre-landing diff still names the original path) — and a genuinely landed commit could read as unverified (fails closed, never a false green, but still a real degradation on the path that handles the MAJORITY of merges).

Fixed by stamping from the LANDED range instead: the base is `sha^` — canonical HEAD as it stands immediately before the squash commit lands — read as plain `HEAD` one step BEFORE the commit (card `c862f14c`; previously re-derived as `preAmendSha^` one step after), so it's trivially and unconditionally identical to what `verifyPersistedPathSet`'s own `sha^` fallback already recomputes. (Solo lands exactly one commit, so unlike the batched case above, this trailer is redundant with the default `sha^` fallback by construction — it's stamped anyway to keep the two paths structurally uniform and the base explicit rather than implicit.)

`verifyPersistedPathSet` prefers this trailer's value when present and falls back to `sha^` when absent — backward compatible by construction: every pre-`756a2cd8` solo-squash and pre-phase-2 batched commit lacks this trailer and keeps the exact `sha^`-based behavior it always had.

### Batch implementation sequencing, and the reproduction that proves it

On a batched landing (`landBranchCommitsIndividually`, `git/batch-merge.ts`), the tip commit lands WITHOUT
either trailer first (so its real sha exists), the digest is computed via `changedPathSetDigest` against
that real sha and `batchHeadBefore`, then BOTH trailers are added via `git commit --amend` (which
preserves the original author/date by default — verified empirically, not assumed).

The rename-following divergence above was reproduced directly: a clean (`cherry-pick` exit 0, no merge
markers) rename on the receiving side — main renames a file the branch also edits (`git mv shared.txt
shared-renamed.txt`), then a cherry-pick of the branch's edit to `shared.txt` lands cleanly as an edit to
`shared-renamed.txt` (git's rename-following 3-way merge). The original branch's own `mergeBase..branchTip`
diff says `shared.txt`; the landed `batchHeadBefore..landedSha` diff says `shared-renamed.txt` — genuinely
different digests for the identical logical change, with no conflict involved. `test/batch-merge-robustness.mjs` case
(7e) keeps this exact scenario as a permanent regression guard: the landed-range digest verifies GREEN
there, in precisely the case where a pre-landing digest would have gone red.

This trailer describes WHAT LANDED, never what the branch originally touched — a future reader who diffs
a branch's history against it and finds a mismatch is seeing expected rename-following behavior, not a
bug. `batchHeadBefore` stays reachable from HEAD forever once the batch fast-forwards (a fast-forward
never rewrites history). The rename-following case began as this card's own flagged, untested assumption,
later confirmed real by direct investigation.

## Do not

- Do not compute this digest against `merge-base(HEAD, branch)` — that's the branch's pre-landing fork point, which diverges from the landed base once main has advanced past it (the rename-following case), degrading a genuinely landed commit to unverified.
- Do not assume the batched tip's own `sha^` is a valid substitute for `batchHeadBefore` once a branch contributes more than one commit — it isn't; that's exactly why this trailer is stamped.

## Consequences

A landed commit's path-set digest is verifiable against its true landed base in both the solo and batched cases, closing a real (fail-closed, but still a degradation) divergence that affected the majority of merges once main had advanced past a branch's fork point.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `LOOM_WORKER_BASE_TRAILER`'s own doc comment (~line 2167), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
