# 0c90ebe4 — `manager_crash_resume_failed` is filed per manager, never batched like `fleet_resume_failed`

## Narrative

Card 0c90ebe4: `recoverCrashOrphanedWorkers` (boot-time crash recovery, mutually exclusive with
`resumeFleetOnBoot`) had no durable trace at all when a manager could not be resumed — the only signal
was a `console.warn`, the least-read surface in the daemon. `resumeFleetOnBoot`'s own `fleet_resume_failed`
event looked like an obvious reuse candidate, but its documented contract does not fit: it requires
filing under "the RESTART REQUESTER... a manager or platform-Lead session that always exists" (the
session that called `daemon_restart`), and it is filed as exactly ONE aggregate event per restart, never
one per failed session — because a single deliberate restart can affect many sessions across many
projects, all scoped under that one requester's project, and per-session events would flood
attention-push's `IMMEDIATE_BURST_CAP` for no benefit.

A genuine crash boot has neither property. Nobody requested it, so there is no `reqId`-shaped party to
file under. And `recoverCrashOrphanedWorkers` iterates a `byManager` map where each failed manager can
belong to a DIFFERENT project — there is no single scope to aggregate under. `attention-push.ts`'s
`classify()` derives an alert's project scope via `db.getSession(e.managerSessionId)?.projectId`;
batching cross-project failures under one id (there is no `reqId`-shaped party to hold them) would
misattribute the alert to the wrong project, or require inventing a party that doesn't exist.

The resolution: file `manager_crash_resume_failed` under the FAILED MANAGER's own id, once per failed
manager. That id still resolves — the manager's DB row exists even though its pty/resume attempt failed,
the exact property `reqId` relies on for `fleet_resume_failed` — so `classify()`'s existing per-event
project-scoping lookup works unchanged, with no attention-push scoping changes needed. Per-manager (not
batched) filing is not a fresh burst-cap risk either: it is the established precedent this same pipeline
already uses for `session_recovery_abandoned` and `worker_exited_without_report`.

`detail` carries `{ workerCount, workers: [{ workerSessionId, taskId, reportedState, awaitingReview }] }`
— only that manager's own stranded workers. Unlike `fleet_resume_failed`'s deliberate cross-project
`detail` (a documented exception to the identity-isolation rule, because its one recipient — the platform
Lead — is the one party with cross-project reach), this event carries NO cross-project identity: every
field describes sessions under the SAME project as `managerSessionId` itself, so it never needs the
isolation reasoning `fleet_resume_failed`'s own doc cites (card `5a9a963b`).

Consumer: `attention-push.ts`'s `classify()` maps it to `"worker-crashed"`, the same alert class as
`fleet_resume_failed` and `session_recovery_abandoned` — the human-facing owner in the shipped
(non-`LOOM_DEV`) product, where the manager itself has no live pty left to receive a direct nudge and no
platform-role session may exist to receive a Lead-only notice.

## Do not

- Do not batch `manager_crash_resume_failed` into one aggregate event per boot — file it once per failed
  manager, under that manager's own `managerSessionId`.
- Do not put cross-project identity in its `detail` — every field must describe sessions under the same
  project as the event's own `managerSessionId`. If a future change needs cross-project identity here,
  revisit the isolation reasoning `fleet_resume_failed` documents (card `5a9a963b`) first.
- Do not reuse `fleet_resume_failed` for this path — its contract assumes a `reqId`-shaped restart
  requester that a genuine crash boot does not have.

## The `appendEvent` call itself must be try/catch'd (Code Review S1)

The first cut of this card left `this.db.appendEvent(...)` unguarded inside the
`for (const [managerId, workers] of byManager)` loop in `recoverCrashOrphanedWorkers`. Code Review traced
at source (not reproduced) that a throw there escapes the method — there is no surrounding try — and then
escapes the boot call site in `index.ts` too, landing in `main().catch` → `process.exit(1)`. Two
consequences: every LATER manager in `byManager` never gets its own resume attempt (the loop never
reaches them), and a non-75 exit stops `daemon:stable`'s supervisor from relaunching automatically.

The `fleet_resume_failed`-reuse reasoning that justified everything else about this event does not
transfer to this specific point: that call sits AFTER its own loop in `resumeFleetOnBoot`, so a throw
there can't cut off any later iteration. Every OTHER write inside `recoverCrashOrphanedWorkers`'s
`byManager` loop is already guarded — `resumeOne`'s own default implementation has a try, and every
`enqueueDurableNudge` call in this same method is wrapped in its own try/catch. This `appendEvent` call
needed the same treatment and didn't get it.

**Fix:** wrapped the `appendEvent` call in try/catch, logging `[crash-recovery] appendEvent(manager_crash_resume_failed) failed for <id>: <message>` on failure and continuing — mirrors the loop's existing nudge guards exactly. An audit write must never block recovery of the rest of the fleet.

## Do not (2)

- Do not leave `manager_crash_resume_failed`'s `appendEvent` call unguarded — a throw there must never be
  able to abort resume attempts for the REST of `byManager`, or crash the boot process outright.

## Source

New kind added by card `0c90ebe4`. Doc comment in `packages/shared/src/types.ts`, immediately below the
`fleet_resume_failed` kind. The try/catch guard: `packages/daemon/src/sessions/service.ts`,
`recoverCrashOrphanedWorkers`'s `byManager` loop.
