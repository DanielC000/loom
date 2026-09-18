# 9f7f2b50 — `DURABLE_AUDIT_EVENT_KINDS`: which orchestration events must outlive a session/agent

## The problem

`deleteAgent` and `deleteProject` both `DELETE FROM orchestration_events WHERE manager_session_id = ?
OR worker_session_id = ?` per cascaded session — indiscriminately, regardless of what the event records.
`deleteSession` does NOT delete events at all (`orchestration_events` has no FK on either session-id
column) — it orphans them instead, which is a different failure: the row survives but
`listOrchestrationEventsBounded`/`listGateEvents`'s project-derivation join (session → task fallback)
resolves to `NULL` once the session row is gone, so an event with neither a live session nor a `taskId`
becomes permanently unfindable by any project-scoped read while still physically present.

## The classification principle

An event is **durable audit** iff its evidentiary value is realized *after* the episode it describes ends
— read later, by someone who wasn't watching live, to answer "what happened" (a security/compliance
action, an irreversible outcome, or an incident this codebase's own doc comments say previously "left no
trace"). It is **session-scoped bookkeeping** iff its only real readers are live-fleet watchers that need
it strictly during the episode (nudge/dedupe/backoff state, poll/schedule/wake mechanics) — once the
session/agent is gone, nothing of record is lost by its disappearing.

## The classification (46 of 79 `OrchestrationEventKind` members)

Derived by reading every kind's own doc comment in `packages/shared/src/types.ts` plus the four existing
kind-groupings (`GATE_HISTORY_KINDS`, `EVENT_TRIGGER_EVENT_KINDS`, `ORCH_ACTIVITY_KINDS`,
`REPORT_RESOLVED_EVENT_KINDS`) as corroborating signal (several kinds already self-describe as
"audit-only").

- **Security / trust-boundary:** `credential_revoked`, `manager_manage`, `deploy`, `worker_gate`,
  `discovery_block_injection`, `engine_session_rotated`, `codex_auto_commit`.
- **Cross-board / cross-project escalation trail** (the event is the audit LINK to another durable
  record; losing it breaks traceability even though the target task survives): `platform_escalate`,
  `escalation_triaged`, `audit_finding`, `workspace_audit_suggestion`, `cross_project_message`,
  `assistant_relay_message`, `session_message`.
- **Gate / merge history** (feeds the Gates page; the historical record of what happened to code):
  `build_gate`, `build_gate_retry_attempt`, `build_gate_retry`, `build_gate_single_file_retry`,
  `merge_request`, `merge_done`, `merge_rejected`, `merge_cancelled`, `batch_merge_forfeited`,
  `kill_switch`.
- **Incident / forensic record** (each one's own comment says it previously left no trace, or is the
  only record of an abnormal outcome): `session_died`, `session_recovery_abandoned`,
  `worker_report_undelivered`, `worker_exited_without_report`, `manager_exited_with_live_workers`,
  `fleet_resume_failed`, `manager_crash_resume_failed`, `parked_manager_workers_unresumed`,
  `rate_limit_bailed`, `usage_latch_cleared`, `session_message_gave_up`, `paste_length_loss`,
  `paste_tripwire_give_up`, `prompt_mismatch_unresolved`, `repeated_tool_call`,
  `codex_submit_unconfirmed`, `codex_boot_stuck`, `codex_unsupported_capability`,
  `companion_zero_reply_detected`.
- **Owner-interaction records** (ruled durable by the manager, `gen 345`: each is a record of an
  *owner* interaction — a decision asked for, an escalation crossing a board boundary, the owner's own
  brake being released; low volume, provenance is the whole value): `question_asked`,
  `request_escalated`, `task_held_cleared`.

Everything else (the remaining 33 kinds — `worker_report` among them, ruled bookkeeping by the manager:
its content is a worker's *claim*, not a trust-boundary action, and it's the highest-volume kind in the
whole enum) is session-scoped bookkeeping, cascaded as before.

## The mechanism

1. `deleteAgent`'s cascade excludes `DURABLE_AUDIT_EVENT_KINDS` from its `DELETE` — the row survives with
   a now-dangling session id, the same shape `deleteSession` already produces (see above).
2. `appendEvent` stamps `detail.projectId` at write time for these kinds (skipped when the caller already
   set one, e.g. `credential_revoked`'s existing `af08f7e8` stamp), deriving it from the session's
   `project_id` or, failing that, the task's — the same lookup the read-side join already does, just done
   proactively. `listOrchestrationEventsBounded` and `listGateEvents` fall back to
   `json_extract(detail_json,'$.projectId')` after session/task both fail to resolve.
3. `deleteProject` stays a full purge, deliberately, including durable kinds — a project delete makes
   every row under it unfindable by construction on every project-scoped read (there is no project left
   to scope to), so retaining them would be pure unbounded growth with zero possible reader, and would
   also be the answer to the "what bounds the table now" question: durable rows still die with their
   project, just not with a narrower agent/session delete.

## Do not

- Do not backfill `detail.projectId` onto rows written before this change — a row old enough to need it
  has, by construction, already lost the session/task that could have supplied it. Declined deliberately,
  not an oversight: those rows stay unfindable by project-scoped reads forever.
- Do not add a kind to `DURABLE_AUDIT_EVENT_KINDS` without updating this record's classification list —
  the reasoning here is what a later reader needs to judge a new kind consistently, not just the set
  membership.
- Do not read `deleteProject`'s continued full purge as an unexamined default — it is a deliberate policy
  call (see "the mechanism", point 3), not a gap.
