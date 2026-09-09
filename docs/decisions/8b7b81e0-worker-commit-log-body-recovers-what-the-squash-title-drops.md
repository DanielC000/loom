# 8b7b81e0 — Recover a worker's own commit subjects into the squash BODY, never the trailers

## Narrative

A squash commit's SUBJECT is always the card title (never the worker's own commit messages — that convention is load-bearing, see `mergeBranchLocked`'s own doc), but until this card the worker's own per-commit messages were discarded entirely at the squash boundary. The incident that exposed this: a card titled for ONE file, a worker whose OWN commit correctly said it touched FIVE — and the squash kept the narrower title and threw the accurate message away, unrecoverable by `git log --grep` forever after (pathspec-only, which nobody reaches for).

`deriveWorkerCommitLogBody` recovers that information into the squash commit's BODY (a real git commit body — the paragraph between the subject and the `Loom-Worker-Branch:`/`Loom-Worker-PathSet:` trailers — not a new trailer; trailers are for single-token machine-readable facts, not prose), so it survives on main by construction instead of by a human remembering to write it in the card title. Returns `undefined` (caller omits the body entirely, byte-identical to pre-card behavior) when there is nothing worth adding: no non-merge commits found on the branch (any git error/timeout also degrades here — best-effort, never blocks the commit), or EXACTLY one commit whose subject already matches the squash `subject` (case/whitespace-insensitive) — the overwhelmingly common single-clean-commit case, where a body would be pure duplication.

`--no-merges` excludes the real merge commit `mergeMainIntoWorktree` leaves on the branch when it unions canonical main's tip in before the gate runs — that commit is main's own history replayed onto the branch, never the worker's own work, and including it would misattribute main's commit messages to this worker.

BOUNDED two ways, deliberately: `WORKER_COMMIT_LOG_MAX_ENTRIES` (a branch with dozens of WIP commits doesn't get a dozens-of-bullets body) and `WORKER_COMMIT_LOG_MAX_CHARS` (one very long commit message doesn't blow the body past what a `git log --oneline`-skimming human tolerates) — either cap truncates with a trailing count of what was omitted, so truncation is visible, never silent.

## Do not

- Do not add a new trailer for this information — trailers are for single-token machine-readable facts, not prose; the commit BODY is the correct place.
- Do not include the union-merge commit `mergeMainIntoWorktree` leaves on the branch — that's main's own history replayed, never the worker's own work.
- Do not truncate silently — either cap must leave a trailing count of what was omitted.
- Do not add a body when there is exactly one commit whose subject already matches the squash subject — that would be pure duplication.

## Consequences

A worker's own commit messages survive on main by construction (in the squash commit's body) instead of depending on a human remembering to fold that detail into the card title — closing the exact "narrower title, accurate message discarded" incident that motivated this card.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `deriveWorkerCommitLogBody`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
