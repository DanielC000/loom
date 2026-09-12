# 55d40cfd — `parked_manager_workers_unresumed`: the durable record for a parked manager's failed workers

## Narrative

Code Review follow-up F2 (card `55d40cfd`, from `3e22a9c3`'s review of `0c90ebe4`) found the one
remaining crash-path gap with no durable record: in `recoverCrashOrphanedWorkers`, when a manager resumes
successfully but is PARKED (rate-limited — the `isParked` check, read before the manager's own resume
attempt), the per-manager loop `continue`s at `if (managerParked) continue;` right after the per-worker
loop, skipping the summary nudge entirely to honor the park. Any of that manager's workers that failed to
resume in that same per-worker loop were, until this card, recorded only in the in-memory `failed[]`
return value and a single boot `console.log` line (`index.ts`'s sole call site) — both gone the instant
the process moves on. `0c90ebe4` already closed the analogous gap for a manager whose OWN resume fails
(`manager_crash_resume_failed`); this is that same fix for the manager-resumed-but-parked case.

`manager_crash_resume_failed` was not reusable as-is: its own doc states plainly that its `reason` field
is the MANAGER's own resume-failure message, "never per-worker, since a manager whose OWN resume fails
never individually attempts its workers." Here the opposite holds — the manager's resume SUCCEEDED, so
every one of its workers WAS individually attempted via `normalizeResumeOneResult(resumeOne(...))`, and
each failure carries its own independent reason. Reusing the existing kind would mean either dropping
per-worker reasons (a regression from what's already captured in-loop) or overloading one kind with two
incompatible `detail` shapes depending on which branch fired — worse for any future reader/consumer than
a distinct, correctly-named sibling kind.

`parked_manager_workers_unresumed` is filed PER PARKED MANAGER, under that manager's own
`managerSessionId` — same never-cross-project, per-manager (not batched) discipline as
`manager_crash_resume_failed` (see `0c90ebe4`'s own record). `detail` carries:
```
{ workerCount: number, workers: { workerSessionId, taskId, reportedState, awaitingReview, reason }[] }
```
— only the workers from THIS manager's own set that failed to resume (never the ones that succeeded).
`reason` is each worker's own resume-failure message, already allowlist-sanitized and bounded via
`normalizeResumeOneResult`/`RESUME_KNOWN_SAFE_REASONS` (`resume-nudge.ts`) — the same redaction boundary
every other resume-failure event in this family relies on, so no unsanitized host path or uuid can reach
this durable row either.

Deliberately audit-only: no nudge accompanies this event. Sending one would push a turn into the parked
manager's cap — exactly what the park exists to prevent, and exactly the invariant the card's DoD calls
out ("respect the park … never push a held turn into a parked manager's cap"). When `workers` is empty
(the manager was parked but every one of its workers resumed cleanly), the event is not emitted at all —
there is nothing to record.

Deliberately excluded from `EVENT_TRIGGER_EVENT_KINDS` — same precedent as `engine_session_rotated`/
`discovery_block_injection`: an audit-only kind with no live decision that should follow from a single
occurrence isn't a fit for user-configured event-trigger automation.

## Do not

- Do not send a nudge (to the manager, or anyone else) alongside `parked_manager_workers_unresumed` — that
  would push a turn into a parked manager's cap. This kind is a durable record only.
- Do not add `parked_manager_workers_unresumed` to `EVENT_TRIGGER_EVENT_KINDS` without a fresh case for it
  — it's audit-only by design, same as `engine_session_rotated`/`discovery_block_injection`.
- Do not reuse `manager_crash_resume_failed` for this path — its `reason` field is documented as the
  MANAGER's own resume-failure message and assumes the manager's workers were never individually
  attempted; both assumptions are false on this path.
- Do not batch this across managers — file it once per parked manager with unresumed workers, mirroring
  `manager_crash_resume_failed`'s own per-manager filing (see `0c90ebe4`'s record for why).
- Do not emit this event when a parked manager's `workers` list is empty or all resumed cleanly.

## Source

New kind added by card `55d40cfd`. Doc comment in `packages/shared/src/types.ts`, immediately below
`manager_crash_resume_failed`. Emission site: `packages/daemon/src/sessions/service.ts`,
`recoverCrashOrphanedWorkers`, at the `if (managerParked) continue;` branch.
