# 52e978ad — `MergedVerificationMode`: three verification tiers, NOT interchangeable guarantees

## Narrative

`MergedVerificationMode` names which verification mode produced a `MergedCommitInfo` answer. Same field, same shape, but the three values are NOT the same guarantee — a caller must not treat them interchangeably:

- `"content"` — the branch ref was still LIVE; verified by an actual byte-for-byte diff of the branch's own changed paths between the candidate commit and the branch tip (`branchContentLandedInCommit`). The STRONGEST guarantee this file produces.
- `"pathset"` — the branch was already gone; verified from the landed commit's OWN ancestry against its persisted `Loom-Worker-PathSet` trailer (`verifyPersistedPathSet`). Survives `git gc` indefinitely, but only proves the SAME SET OF FILES landed, not the same CONTENT. Weaker than `"content"`; do not render it with the same confidence.
- `"trailer-only"` — the branch was gone AND the landed commit carries no `Loom-Worker-PathSet` trailer. TWO causes produce this, indistinguishable from this field alone: (1) pre-`f621f185` legacy history, or (2) a best-effort `Loom-Worker-Base`/`Loom-Worker-PathSet` stamp that failed to land (rare; logged at the stamp site itself — see `mergeBranchLocked` for the solo path, `landBranchCommitsIndividually` in `git/batch-merge.ts` for the batched one). As of card `9198c7a4`, a BATCHED landing's tip commit stamps those trailers from its ENTIRE contribution (`batchHeadBefore..landedSha`, not just `sha^..sha`), same as a solo squash — no longer omitted by design. The answer rests on `Loom-Worker-Branch:` trailer PRESENCE alone — no content or path check at all. The WEAKEST of the three; render this qualified, not as a second confident tick.

`MergedCommitInfo.verification` itself is `undefined` when unknown/not computed by a caller (e.g. a persisted cache row written before this field existed) — NEVER read absence as either "verified" or "unverified", just "no signal either way".

## `getTaskMergedInfo` — the real caller, keyed on trailer not title

`getTaskMergedInfo` resolves whether `taskId` is merged + shipped on `repoPath`'s main line. Resolves the task's DETERMINISTIC branch (`loom/<taskKey(taskId)>`) and looks it up in the cached merged-commit map — keyed by the `Loom-Worker-Branch:` trailer, rather than by TITLE TEXT: a card's title can be edited after merge, or coerced through `toConventionalSubject`, while the trailer never drifts. Applies the SAME re-task ancestry guard as `findLandedSquashCommit` for the rare case the branch ref still exists.

Returns `null` when no landed trailer is found FOR ANY REASON: genuinely never merged, landed outside the scan window, a re-task in progress, or any git error (fail-safe). Treat `null` as "not proven merged (within this window)", NEVER as an authoritative "never merged" — this exists specifically to replace stale-handoff claims with ground truth, and a false-confident `null` would just move the same failure elsewhere.

The returned `MergedCommitInfo.verification` names WHICH means actually answered — a caller that only reads `sha`/`date` can no longer tell a byte-verified `"content"` landing apart from a weaker `"pathset"`/`"trailer-only"` one; a caller that cares about the strength of the guarantee must read it. `scanMergedCommitMap` keys on the trailer alone (NOT the subject — a prior read of an incident's `merged:{sha}` false positive as a "subject match" doesn't hold up against this code).

## Do not

- Do not treat `"pathset"` or `"trailer-only"` with the same confidence as `"content"` — they prove progressively weaker claims (same file set; then only trailer presence).
- Do not collapse the two causes of `"trailer-only"` (legacy history vs. a failed stamp) into one narrative without evidence — this field alone cannot distinguish them.
- Do not read an absent `verification` field as either verified or unverified — it means no signal was computed at all.
- Do not treat `getTaskMergedInfo`'s `null` as authoritative "never merged" — it also covers landed-outside-window, a re-task in progress, and any git error.
- Do not key merge detection on the card's TITLE — a title can be edited or coerced after merge; the `Loom-Worker-Branch:` trailer never drifts.

## Consequences

A consumer of `MergedCommitInfo` (e.g. a board's "merged" display) can render three visibly different confidence levels instead of one flat "verified" claim that would overstate the weaker two tiers.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `MergedVerificationMode`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
