# 907b9f50 — Catch a worker's forgotten commit at the source, before `done` reaches review

## Narrative

`precheckWorkerDone` is a `worker_report(done)` pre-check (board card `907b9f50`): it catches a worker that forgot to commit AT THE SOURCE, before its task is moved to review. The merge gate only ever sees COMMITTED work on the assigned branch, so a "done" report with uncommitted work (or 0 commits) used to sail all the way to review and bounce back a round-trip later — this surfaces it immediately, to the worker session that can still fix it without a round-trip.

Three outcomes:
- DIRTY working tree (real uncommitted/untracked changes, `.claude/` noise ignored) → `{uncommitted:true, files}` ⇒ the caller REFUSES the done and keeps the task in_progress so the worker commits and re-reports.
- CLEAN but the assigned branch is 0 commits ahead of `base` → `{zeroAhead:true}` ⇒ the caller WARNS only — a genuine no-op task can legitimately report done, so this is never a hard refusal.
- Otherwise (clean + ahead, the normal path) → all-false, `aheadCount` set to the verified count ⇒ the done proceeds unchanged. The caller separately refuses a `report.noChanges:true` claim against this verified-positive `aheadCount` (see board card `6b605d15`), but that check lives in the caller, not here — this function only ever reports the git-verified facts.

FAILS SAFE: every git op is bounded by the same block-timeout + `withTimeout` guard as the other helpers, and ANY error/timeout/parse-failure degrades to `{uncommitted:false, zeroAhead:false}` (ALLOW) — a flaky git call must NEVER wedge a worker on a legitimate done (mirrors `detectStrandedWork`). This is INDEPENDENT of — and composes with — the divergent-branch stranded backstop at the merge gate. The git seam is injectable (`BoundedGitDeps`) so a test can prove both the detection and the fail-safe bound.

## Do not

- Do not let this function's own failure block a legitimate `done` — a flaky/timed-out git call must degrade to the ALLOW result, never to a refusal.
- Do not fold the `report.noChanges:true` vs verified-`aheadCount` contradiction check into this function — that check (card `6b605d15`) belongs in the caller; this function only reports git-verified facts.

## Consequences

A worker that forgets to commit finds out immediately, from its own `done` report, instead of discovering it only after the round-trip through review — at the cost of one extra bounded git read per `done` report.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `precheckWorkerDone`'s own doc comment (~line 1386), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
