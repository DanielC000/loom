# aaacafe4 — attribute a review worker's usage to the task it reviews, via a usage-only field

A review-only `worker_spawn` (`reviewOfWorkerSessionId`/`reviewOfTaskId`) is conventionally TASKLESS —
its own `taskId` is `null`. Before this card, the usage sampler's `sampleTaskId()` denormalized
`session.taskId` straight onto every `session_usage_samples` row, so a review worker's billed usage
always landed in `aggregateSessionUsage`'s `unattributed` bucket instead of the task it was reviewing,
under-counting that task's real cost.

`Session.reviewOfTaskId` closes this: stamped once at spawn (mirrors `reviewBaseSha`'s shape) with the
task id the review is OF, resolved from whichever form was used. The usage sampler's `sampleTaskId()`
falls back to it only when `session.taskId` is unset: `session.taskId ?? session.reviewOfTaskId ?? null`.

## Do not

- Do not default `taskId` itself from `reviewOfTaskId`/`reviewOfWorkerSessionId` at spawn. `taskId`
  binds a worker to the card — it takes the per-task one-live-worker mutex (`claimTaskWorktreeRefusal`,
  `sessions/service.ts`), moves the card to the active lane, and marks the session as the card's worker.
  A review spawn defaulting `taskId` this way would collide with the mutex the worker BEING REVIEWED
  already holds (the live-holder check would refuse the review spawn outright), or — if it somehow got
  past that — would wrongly re-attribute board ownership of a card to its reviewer instead of its author.
- Do not read `reviewOfTaskId` from any card/mutex/lane logic. It has exactly two readers: the
  usage sampler's `sampleTaskId()`, and (amended by card 9623e943, see
  `9623e943-card-policy-enforcement.md`) the read-only code-review evidence predicate for card
  policies (`Db.listReviewSessionsOfTask`). Any third reader needs its own amendment. It is deliberately excluded from `SESSION_ROW_FIELDS` (`worker_status`,
  `mcp/orchestration.ts`) and `SESSION_LIST_FIELDS` (`fleetView` full:true, `mcp/sessionView.ts`), same
  posture as `cutBaseSha`/`forcedPlain` — purely internal machinery, never a field an agent-facing view
  should carry.
- Do not expect retroactive attribution. Review-worker usage samples recorded before this field existed
  carry `task_id: NULL` on their `session_usage_samples` row with no persisted review-target to recover
  it from (confirmed: neither `reviewOfWorkerSessionId` nor `reviewOfTaskId` was persisted anywhere prior
  to this card — see the card's own investigation checkpoint). Those historical samples stay
  `unattributed` permanently; only samples recorded by a review worker spawned AFTER this ships get the
  correct `byTask` attribution.
- Do not add an index on `review_of_task_id`, and above all never a SCHEMA index on it: it is a migration-added
  column, and a SCHEMA index on a migration-added column crashes boot on an upgraded database. Since card 9623e943,
  `Db.listReviewSessionsOfTask` does query `sessions` by this column (`WHERE project_id = ? AND review_of_task_id = ?`),
  so each call is a scan of the project's sessions rows, with no index to help. That is accepted deliberately: it runs
  only for a card whose stored policy requires `code-review-report`, once per merge-phase evaluation (and once more at
  the pre-squash re-check), never on a hot path, and the sessions table is small. Revisit only with a measured cost,
  and then add the index through the migration function, never the SCHEMA block.

## Amendment (card 9623e943): carried across a reviewer's recycle

`recycleWorker` now carries `reviewOfTaskId` forward to the successor row, exactly as it already carried
`reviewBaseSha` (same worktree, same review target). Before this a recycled reviewer's successor had a null
`reviewOfTaskId`, so its `done` report was invisible to the card-policy code-review evidence (and its usage
fell back to `unattributed`). The field stays usage/policy-evidence only. The Do-not list above is amended in the same card: the reader count (two) and the full-scan note on the index bullet.

## Test methodology (moved here from `review-of-task-id-migration.mjs`'s own header)

The schema-upgrade guard for `review_of_task_id` mirrors `cut-base-sha-migration.mjs`'s discipline: a
`SESSION_ADDED_COLUMNS` migration is exactly the class that shipped a real P0 boot crash before (project
memory `verify-schema-change-against-upgraded-db`), because it was only ever tested against a FRESH DB —
`CREATE TABLE IF NOT EXISTS` no-ops on a table that already exists in its OLD shape, so a SCHEMA-level
statement referencing a migration-only column blows up with `SqliteError: no such column: ...` on any
real, already-upgraded install.

The test builds its legacy fixture from a genuinely BLANK database holding ONLY a hand-derived `sessions`
table — its CREATE TABLE SQL read straight off a reference DB's own `sqlite_master` (never hand-typed, so
it can't drift from the real schema) with just the one new column's definition line stripped out. Opening
THIS with the real `Db` class is what actually exercises `exec(SCHEMA)` running its full CREATE TABLE
statement against an EXISTING, column-less table (the `IF NOT EXISTS` no-op).

Full record: this file. Card `aaacafe4`.
