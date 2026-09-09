# c4355598 — the terminal-lane pending-Request warning is additive-only and can never block the move

## Narrative

`updateProjectTask`'s terminal-lane pending-Request warning is computed alongside the column-move guard,
since both need the SAME resolved `cols` for the SAME `patch.columnKey` — never a second `resolveConfig`
call. It is additive-only (see `PendingRequestWarning`'s own doc) — this never rejects the patch, so it
must be computed strictly AFTER the unknown-column reject returns, never instead of it. It's keyed by
`owned.id` (not the raw `taskId`, which may be an 8-char prefix) so `listQuestionsForTask`'s own
prefix-tolerant match has a full id to compare against, matching every other caller of that method.

Code Review follow-up: this runs BEFORE the `db.updateTask` write, so a throw here (a future widening of
`listQuestionsForTask` — a JOIN, a throw-on-missing) would otherwise kill the WRITE, not merely the
warning — silently converting an advisory into a blocker, which is exactly what this card's hard
constraint ("must NEVER block") forbids. A `try`/`catch` makes that true BY CONSTRUCTION rather than by
audit: a failure here drops the WARNING only, never the write. It's logged (not swallowed) so a broken
advisory is still visible — mirrors `persistDeferredStateBestEffort`'s own best-effort catch.

## Do not

- Do not let the pending-Request-warning lookup run unguarded — wrap it in `try`/`catch` so a future
  widening of `listQuestionsForTask` can only ever kill the warning, never the write it rides alongside.
- Do not swallow that catch silently — log it, so a broken advisory stays visible instead of quietly
  going dark.

## Source

Inline comment in `packages/daemon/src/mcp/tasks.ts` (`updateProjectTask`, lines 1197-1209 as of this
tranche's HEAD).
