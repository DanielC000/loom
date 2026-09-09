# 591906ae — Recover a batched branch's NON-TIP commit subjects, which the tip-only review fields miss

## Narrative

`ownTipSubject`/`ownTipSubjectConventional` (`SessionService.reviewWorkerMerge`) answer for the branch's TIP commit only — but `merge_batch` (`git/batch-merge.ts`) lands EVERY commit on a batched branch verbatim (a rebase/cherry-pick, never a squash: a 3-commit branch puts 3 commits on main), so a bad subject on a NON-tip commit reaches mainline invisibly to those two fields alone.

`deriveOwnNonTipCommitSubjects` recovers the branch's own non-tip commit subjects — `<mergeBase>..<branch>`, oldest-first, `--no-merges` for the same reason `deriveWorkerCommitLogBody` excludes them (a union-merge replaying main's own history onto the branch is never the worker's own commit) — with the LAST entry (the tip, already covered by `ownTipSubject`) dropped so this never duplicates that field.

Returns `undefined` (field omitted entirely by the caller) whenever there is nothing to add beyond the tip: no commits at all, or exactly one (the overwhelmingly common single-commit branch, where the tip IS the whole contribution) — deliberately, so a single-commit branch's review result stays byte-identical to before this card rather than getting noisier. Bounded by the SAME `WORKER_COMMIT_LOG_MAX_ENTRIES`/`WORKER_COMMIT_LOG_MAX_CHARS` caps `deriveWorkerCommitLogBody` already uses (one shared pair of knobs, not a second pair to drift out of sync) — `truncated:true` says so explicitly rather than silently dropping the tail. Best-effort: any git error/timeout degrades to `undefined`, exactly like every other advisory field on this review.

## Do not

- Do not rely on `ownTipSubject` alone to catch a bad subject on a batched branch — it only ever sees the tip commit, and `merge_batch` lands every commit verbatim.
- Do not introduce a second pair of truncation-bound constants — reuse `WORKER_COMMIT_LOG_MAX_ENTRIES`/`WORKER_COMMIT_LOG_MAX_CHARS` to avoid drift.
- Do not silently drop truncated entries — set `truncated:true` explicitly.
- Do not include the tip commit in this field's output — it duplicates `ownTipSubject`.

## Consequences

A manager reviewing a batched multi-commit branch can see every non-tip commit's subject, not just the tip's, closing the gap where a bad subject on a non-tip commit would reach mainline invisibly.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `deriveOwnNonTipCommitSubjects`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
