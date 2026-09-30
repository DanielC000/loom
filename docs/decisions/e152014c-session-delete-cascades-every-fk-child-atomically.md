# e152014c — session delete cascades every FK-to-sessions(id) child atomically; companion chat history goes with it

## Narrative

`deleteSession`, `deleteProject` and `deleteAgent` (`packages/daemon/src/db.ts`) each ran their own
partial, hand-maintained list of per-session cleanup deletes with no surrounding transaction. Querying
`pragma foreign_key_list` across the real schema turned up eight columns with an enforced FK to
`sessions(id)`: `wakes.session_id`, `companion_reminders.session_id`, `companion_messages.session_id`,
`companion_conversations.session_id`, `questions.session_id`, `poll_jobs.session_id`,
`event_triggers.target_session_id` and `webhook_endpoints.target_session_id`. All three delete paths
were missing `companion_messages`/`companion_conversations`/`poll_jobs` entirely, and never nulled
`event_triggers.target_session_id` / `webhook_endpoints.target_session_id`. Deleting an archived
companion session with any chat history threw `SQLITE_CONSTRAINT_FOREIGNKEY` after wakes, reminders,
grants and questions had already been deleted (a half-applied delete, since `deleteSession` ran with no
transaction), and a project or agent that ever hosted such a companion could never be deleted at all.

The fix adds one shared, transaction-safe helper, `cascadeSessionForeignKeyChildren(sessionId)`, called
by all three delete paths, and wraps `deleteSession` in its own transaction (`deleteProject`/`deleteAgent`
were already transactional). The helper treats the eight columns as two shapes:

- A plain `session_id` column on wakes/companion_reminders/companion_messages/companion_conversations/
  questions means the row is OWNED by that session — cascade-**delete** it.
- A `target_session_id`-shaped column — `event_triggers.target_session_id`,
  `webhook_endpoints.target_session_id`, and `poll_jobs.session_id` (which predates the
  `target_session_id` naming convention but is functionally identical — see `reparentPollJobTargets`'s
  own doc, and note `reparentEventTriggerTargets`/`reparentPollJobTargets`/`reparentWebhookTargets` already
  treat all three as one family, moving them onto a recycle successor rather than clearing them) — is a
  standing, human-configured row that merely WAKES this session. Session delete **nulls** the reference
  instead of deleting the row, so the poll job / trigger / webhook endpoint survives, inert, rather than
  silently vanishing a config the human set up (a webhook endpoint's `path` in particular may be
  registered with an external provider — deleting the row out from under that registration would be far
  more disruptive than leaving it inert with no wake target).

`companion_capability_grants.session_id` carries no enforced FK (see its own schema doc) but is cascaded
by the same helper anyway, via the existing `deleteCompanionCapabilityGrantsForSession` — a recycled
session id must never inherit a stale grant.

### The DoD-4 decision: companion history is deleted with the session

The natural reading of "delete session" is that a companion session's own chat log dies with it —
`companion_messages`/`companion_conversations` are per-session conversation data, not a standing config
that merely targets the session (unlike poll_jobs/event_triggers/webhook_endpoints). They are
cascade-**deleted**, not preserved or reparented. There is no soft-delete/archive path for session
deletion in the first place (this is the permanent Archive-tab Delete, not `archiveSession`), so there is
no way to delete a session's row while keeping its chat history addressable — deleting the row is already
a hard, irreversible choice the human made, and the chat history has no meaning once its owning session is
gone.

## Do not

- Do not delete `poll_jobs`/`event_triggers`/`webhook_endpoints` rows wholesale when their target session
  is deleted — null the target reference (`session_id`/`target_session_id`) instead. These are standing,
  human-configured rows independent of the session's lifetime (mirrored by the fact that a recycle moves
  the same columns onto a successor rather than clearing them); deleting them would silently destroy a
  user's polling/trigger/webhook configuration as a side effect of an unrelated session cleanup.
- Do not treat `poll_jobs.session_id` as belonging to the "cascade-delete" group just because its column
  is literally named `session_id` rather than `target_session_id` — the naming is historical
  (`poll_jobs` predates the `target_session_id` convention), not semantic. Check `reparentPollJobTargets`'s
  own doc before assuming otherwise.
- Do not add a table with an FK to `sessions(id)` without adding it to BOTH
  `cascadeSessionForeignKeyChildren` (`db.ts`) AND the `expected` list in
  `test/session-delete-fk-cascade.mjs`'s `pragma foreign_key_list` enumeration — that test fails loudly
  specifically to catch this drift; updating only one half defeats it.
- Do not reintroduce a second, independently-maintained per-session cleanup list in `deleteProject` or
  `deleteAgent` — both must keep calling the one shared helper.
- Do not wrap `deleteSession`'s cascade in anything other than `this.db.transaction(...)` — a partial
  apply on a mid-cascade failure is the exact bug this card fixes.

## Source

`packages/daemon/src/db.ts` — `cascadeSessionForeignKeyChildren`, `deleteSession`, `deleteProject`,
`deleteAgent`. Regression test: `packages/daemon/test/session-delete-fk-cascade.mjs`.
