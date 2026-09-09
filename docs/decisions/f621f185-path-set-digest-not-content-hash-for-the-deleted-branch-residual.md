# f621f185 — Why the deleted-branch residual verifies a PATH SET, not a content hash

## Narrative

`changedPathSetDigest` is a deterministic digest (sha256) over the SORTED set of paths changed between `base` and `ref` — newline-joined after sorting. It is the deleted-branch residual of `e076d2a2`'s content-reachability check: once a branch is deleted, there's no branch ref left for `branchContentLandedInCommit` to diff against, so this digest is what a stamped trailer records instead, for later re-verification from the landed commit alone.

### Why a path set and not a content hash

The obvious next move — hash the branch's changed (path, blob-sha) pairs and verify it later from `sha^..sha` alone (no branch ref needed) — was PROTOTYPED and FALSIFIED against real git before landing here. It breaks on an entirely HONEST merge: if main advances with a non-conflicting edit to a file the branch ALSO touches, the pre-image blob at that path differs between `mergeBase..branch` (recorded at merge time) and `sha^..sha` (recomputed later against main's ADVANCED tip) — and the post-image blob is a 3-way-merged blend, matching neither side's own post-image either. Both compares disagree on a commit that landed PERFECTLY correctly — fail-closed (safe) but silently flipping an honestly-merged task's board `merged` field to unverified, worse than the gap it closes on exactly the busiest files. Reproduced and confirmed dead before this function was written.

The touched PATH SET does not have this failure mode: a non-conflicting edit to a shared file does not change WHICH paths the squash's own diff touches, so it stays stable under concurrent main movement.

### The accepted tradeoff, and two false-negative routes

The tradeoff this accepts: two DIFFERENT branches that happen to touch the exact same set of paths would not be told apart by this check alone. Judged acceptable — the incident this card responds to (`fb1dbb2`) had completely disjoint path sets (`db.ts`/`gateway/server.ts` landed under a trailer claiming a `pty` change), which a path-set digest catches cleanly, and Loom's own "one logical change per task" doctrine makes two unrelated tasks sharing an identical touched-path set an unlikely coincidence.

A second, narrower false-negative (fails closed, safe): if main independently lands the IDENTICAL change to a path the branch also touches (same resulting content, not just a non-conflicting edit), that path drops OUT of the squash's own `sha^..sha` diff entirely, while it remains in a digest recorded from the branch's own PRE-landing diff. The two path sets then genuinely differ and the caller falls through to null/a redundant merge attempt. Rare, never unsafe.

### The far more reachable third route, and how it was actually closed

A THIRD, FAR MORE REACHABLE route to that exact same mismatch (card `756a2cd8`): main RENAMING a path the branch also edited — no identical bytes required, just a `git mv`. `git merge --squash`'s rename-following 3-way merge lands the branch's edit cleanly under the renamed path, so `sha^..sha` names the NEW path while a digest recorded from `mergeBase..branch` still names the OLD one. Same verdict as the identical-bytes case: fails closed, never unsafe, just a real degradation on the path that handles the majority of merges.

Both routes share ONE root cause — a digest recorded from the branch's PRE-landing diff instead of the LANDED range — closed by fixing that root cause: every fresh solo-squash commit whose trailer capture succeeds (see [[d62dad73-loom-worker-base-trailer-stamps-the-landed-base-not-the-fork-point]]) now stamps a digest equal to `sha^..sha`, same as the batched path's `batchHeadBefore..landedSha`. (Card `c862f14c` changed HOW that value is obtained on the solo path, not WHAT it is.)

Neither route can occur against a digest equal to the landed range: `sha^`/`batchHeadBefore` and `sha` are fixed, immutable commit objects once landed. Both routes remain real ONLY for a commit that predates this fix, or whose trailer capture failed — the caller sees the trailers simply ABSENT (not a wrong digest) and degrades to the weaker `trailer-only` tier, an honest omission.

Exported for `batch-merge.ts`'s per-branch PathSet stamp, computed over `batchHeadBefore..landedSha` — the branch's WHOLE contribution, never the tip commit's own `sha^` alone. The only shape proven safe against a rename-following cherry-pick.

`verifyPersistedPathSet` re-verifies a stamped digest from the landed commit alone — see [[756a2cd8-verifypersistedpathset-proves-file-set-not-content]] for what its `true` result does and doesn't prove.

## Do not

- Do not switch to a content-hash (path, blob-sha) digest for this residual — prototyped and falsified: it disagrees on an entirely honest merge whenever main independently, non-conflictingly edits a shared file after the branch was cut.
- Do not compute this digest from the branch's pre-landing diff (`mergeBase..branch`) — that's the root cause of both the identical-bytes and rename-following false-negative routes; compute from the LANDED range (`sha^..sha` or `batchHeadBefore..landedSha`) instead.
- Do not treat two branches sharing an identical touched-path set as something this check alone can distinguish — that's an accepted, deliberate tradeoff, not a gap to patch.

## Consequences

The deleted-branch residual verifies reliably against the landed range for every fresh commit, with two named, fail-closed (never unsafe) false-negative shapes that remain possible only pre-fix or on a failed best-effort trailer capture — both degrade to an honest "can't verify," never a wrong "verified."

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `changedPathSetDigest`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
