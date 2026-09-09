# ab1d1129 — an empty-string session-id sentinel must be normalized to NULL before COALESCE, or it wins wrongly

## Narrative

Card ab1d1129: several event emitters stamp `""` (never `NULL` — `manager_session_id` is NOT NULL, so `""` is their only option when no real session id is available) rather than omitting the field. Plain `COALESCE` treats `""` as present and picks it over a real id in the other field, so the session join in `listOrchestrationEventsBounded` misses the session entirely, and the row's project comes back NULL — invisible to every project-scoped read.

Two independent fallbacks, both additive (they only ever fill in a NULL, never override a value the OLD query already produced):
1. `NULLIF` normalizes `""` to NULL before `COALESCE` chooses between worker/manager, restoring the intended prefer-worker-else-manager fallback — without touching which id wins when BOTH are real (a separate, deliberate attribution choice, left untouched). Recovers `cross_project_message`/`assistant_relay_message`'s routine BOARDED-delivery case (a real sending manager session, no live target worker session).
2. When NEITHER session field is resolvable at all (a REST-origin/actorless emitter — e.g. `task_held_cleared`/`escalation_triaged` writing `""` with no session in scope to fall back to — see memory note `empty-session-sentinel-hides-events-from-scoped-reads`), fall back to the ALREADY-JOINED task's own `project_id`: a task belongs to exactly one project by construction (`tasks.project_id NOT NULL`), so this is an unambiguous, safe source of truth, never a guess.

This does NOT recover `session_message_delivered`, whose event carries no `taskId` at all in this shape — a real remaining gap, out of scope for this fix.

## Do not

- Do not `COALESCE` two session-id columns that can independently hold the `""` sentinel without `NULLIF`-normalizing first — `""` is treated as present and wins over a real id in the other column.
- Do not assume this fix also recovers `session_message_delivered` — that event carries no `taskId`, so the task-fallback path can't reach it; that gap remains.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listOrchestrationEventsBounded`'s session-join fallback): lines 5944-5961, as of this tranche's HEAD.
