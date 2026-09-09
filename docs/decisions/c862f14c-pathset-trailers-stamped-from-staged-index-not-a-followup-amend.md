# c862f14c — Stamp path-set trailers from the STAGED index, never a follow-up amend, and never move HEAD between

## Narrative

`mergeBranchLocked` stamps `Loom-Worker-Base` + `Loom-Worker-PathSet` into the commit message itself, from the STAGED index, instead of a follow-up `git commit --amend` (the pre-fix shape this replaces — the amend caused three problems: an orphan window, doubled hooks, and a `commit-msg` hook's own trailer work getting silently discarded because the amend rebuilds the message from an in-memory JS string). `base` = canonical `HEAD` as it stands RIGHT NOW, immediately before the squash lands — identical to the old `preAmendSha^` (a commit's parent IS whatever `HEAD` was before it was made), just read one step earlier. `digest` is computed from the CURRENTLY-STAGED index via `stagedPathSetDigest`, proven byte-identical (DoD-1) to what `changedPathSetDigest` would compute from `sha^..sha` after the commit: a commit's tree IS the index it was made from, and its parent IS whatever `HEAD` was before it — so the staged-vs-HEAD diff and the landed `sha^..sha` diff are the SAME two tree objects, not merely usually-equal ones.

## Load-bearing adjacency — a proviso of the proof, not just today's code shape

No git call may land between this capture and the single `git commit` that could move canonical `HEAD` or mutate the index — doing so would break the tree-identity the proof rests on. Do not insert one. Best-effort, matching the old amend's own posture: a failure here just omits both trailers (the commit still lands, degrading to the existing `trailer-only` tier) rather than failing an otherwise-successful merge.

## Re-reading HEAD unconditionally after the commit (Code Review follow-up, mirroring card `756a2cd8`)

`withTimeout` (`git/bounded.ts`) settles independent of the git child it wraps — on expiry it rejects and walks away while the child is left alone, still mutating — so the commit could land ON DISK while its own `withTimeout` call times out and control falls through to the catch below. So HEAD is re-read UNCONDITIONALLY rather than trusting a value captured before the call — mirrors `landBranchCommitsIndividually`'s own post-loop read (`git/batch-merge.ts`): read once, unconditionally, and fail LOUD (`ok:false`) if that read itself fails, rather than returning a value that might no longer be what HEAD actually points at.

## Do not

- Do not revert to a follow-up `git commit --amend` for these trailers — it caused an orphan window, doubled hooks, and silent discard of a `commit-msg` hook's own trailer work.
- Do not insert any git call between the base/digest capture and the single `git commit` — that would break the tree-identity the byte-identical-digest proof rests on.
- Do not trust a HEAD sha captured before the commit call as the final result — always re-read it unconditionally afterward, since a timed-out `withTimeout` can leave the child still mutating on disk.

## Consequences

The path-set trailers land in the same commit as the squash itself, closing the orphan window and hook-doubling problems the old amend-based approach had, while the digest proof's adjacency requirement means this code region must never grow an intervening git call.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`, `mergeBranchLocked`'s path-set-trailer stamping block and its post-commit HEAD re-read, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*`/`//` comment markers stripped, no wording changed.
