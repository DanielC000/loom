# 4ee527d1 — a deliberately-retired worker's pending wakes are cancelled, and a durable `worker_retired` marker blocks any later automatic resume

## Fix round (Code Review): the marker is EPOCH-scoped, not permanent

Round 1 (below) refused an automatic resume on `hasWorkerEventKind(id, "worker_retired")` alone — a
single bit, never cleared. The reviewer REPRODUCED a real consequence: a manager stops a worker, a human
then revives it from the UI (`allowSuperseded`), and the worker is live and working — but forever after it
is ineligible for EVERY automatic resume, because the old bit is still set. Its own `wake_me` fallbacks are
dropped, crash recovery (the wake door, `CrashRecoveryWatcher`, `recoverCrashOrphanedWorkers`) refuses it,
`resumeFleetOnBoot` counts it failed, and poll/event-trigger/webhook wakes all throw.

The fix: a second kind, `worker_retirement_lifted`, filed ONLY by `resume()`'s own `allowSuperseded`
branch. `Db.isWorkerRetirementActive(id)` replaces the bare `hasWorkerEventKind` check: a worker's
retirement is active only while the newest `worker_retired` for that session is newer — compared by the
never-reused `orchestration_events.seq`, never `ts`/rowid — than its newest `worker_retirement_lifted`. A
human/Lead `allowSuperseded` resume both passes the refusal and files the lift, re-arming every automatic
path for THIS epoch; a later fresh `worker_retired` (any of the 7 sites) closes the epoch again. The marker
itself is still never erased — only the epoch comparison changed.

Three more gaps closed in the same round:
- The human-only REST `/api/sessions/:id/stop` and `stopSession` (Platform Lead `session_stop` + companion
  `session_stop`) could stop a WORKER-role session without going through `retireWorkerSession`, so its due
  wake would still resurrect it. Ruling: a deliberate stop of a worker by a human, the Lead, or the
  companion IS a retirement — `retireWorkerSessionIfWorker` (a no-op for any non-worker target) routes both
  surfaces through the same chokepoint.
- Boot-reconcile Pass A's finalize of a landed-but-unfinalized worker called `finalizeMerge` directly,
  skipping the `retireWorkerSession` call every OTHER `finalizeMerge` caller makes immediately before it.
- Companion `session_resume` deliberately stays non-human (no `allowSuperseded`): a stopped worker is
  refused there too, by design — its tool description now tells the companion to point the owner at the
  app's own manual resume instead of claiming it can force the override itself.

## Background

`stopWorker`, `killAllWorkers`, the noChanges/noCommit auto-retire branch of `workerReport`, the hard-stop
inside `confirmWorkerMerge`'s solo Green path and `finishAlreadyMerged` (shared by the solo ALREADY_MERGED
finish and `mergeBatchTracked`'s per-landed-branch finalize), and `retireSiblingSessionsForTask`'s
zombie-sibling sweep all permanently end a worker session without ever cancelling its pending `wake_me`
wakes. `WakeService.tick` resumes ANY not-alive target unconditionally (`orchestration/wake.ts`), and
`SessionService.resume()` had no stopped/retired guard — so a worker stopped to free a concurrency slot
(the routine case: a manager `worker_stop`s a finished worker, then respawns a new one on the same
task/worktree) could be resurrected by its own due wake, possibly alongside its replacement on the same
kept worktree.

Only ONE existing path already got this right: `recycleWorker`'s pre-spawn-failure catch calls
`db.cancelWakesForSession` on the hard-killed predecessor (`@decision 08320d02`) — because there is no live
successor to reparent the wakes onto there. `recycleWorker`'s SUCCESS path is correct as-is for a different
reason: it `reparentWakes(workerSessionId, fresh.id)`s the predecessor's wakes onto the live successor
(sessions/service.ts, inside `recycleWorker`) — the right behavior, not a gap, and NOT touched by this
card.

## The fix

One helper, `retireWorkerSession(workerSessionId, reason)` (sessions/service.ts), called from exactly the
7 deliberate-retirement sites named above (never from `archiveOnExit`, which fires on every exit including
a crash and must never cancel a crashed worker's wake — a crashed worker's wake is the correct, intended
recovery path). It does two things atomically from the caller's perspective:
1. `db.cancelWakesForSession(workerSessionId)` — the existing hard-delete helper, reused rather than
   duplicated.
2. `db.appendEvent({ kind: "worker_retired", workerSessionId, detail: { reason, cancelledWakes } })` — the
   durable marker, mirroring `recycle_successor_retired`'s shape exactly.

`SessionService.resume()` gained a new refusal, immediately alongside the existing
`recycle_successor_retired` check: `if (!opts.allowSuperseded && this.db.hasWorkerEventKind(session.id,
"worker_retired")) throw ...`. This protects every automatic caller that routes through `resume()` with no
options — `WakeService.tick`, `PollService`, `EventTriggerService`, `CrashRecoveryWatcher`, and
`resumeFleetOnBoot` — for free, with no change needed in any of those files. The human-only manual
`/resume` REST endpoint still passes `allowSuperseded: true` as a one-time escape hatch, identical to the
recycle-successor case.

## Do not

- Do not cancel a worker's wakes from `archiveOnExit` — it fires for a crash too, and a crashed worker's
  wake is its correct, intended auto-recovery path (verified: `WakeService.tick`'s claim-first delete plus
  the existing `wake_dropped` catch already bounds a doomed wake to one attempt, not a retry loop — the
  eager cancel in `retireWorkerSession` is for immediate cleanup/no wasted fire attempt, not to close an
  unbounded-retry hazard that didn't exist).
- Do not touch `recycleWorker`'s SUCCESS-path predecessor stop — its wakes are correctly REPARENTED onto
  the live successor (`reparentWakes`), never cancelled, and the predecessor must never be marked
  `worker_retired` (it has a live successor; marking it retired would be wrong and is also unnecessary,
  since nothing automatic would ever try to resume a row with a live successor — `hasSuccessor` already
  refuses that in `resume()`).
- Do not fold `recycleWorker`'s pre-spawn-failure catch (the existing `cancelWakesForSession` call,
  `@decision 08320d02`) into `retireWorkerSession` — left as-is, out of this card's approved 7 sites, to
  avoid scope creep; it already does the one thing that matters (cancel wakes) and marking that row
  `worker_retired` on top would be inert anyway (it's archived + unlinked, nothing automatic will ever try
  to resume it by id).
- Do not add `worker_retired` to `EVENT_TRIGGER_EVENT_KINDS`, `GATE_HISTORY_KINDS`,
  `ORCH_ACTIVITY_KINDS`, or `REPORT_RESOLVED_EVENT_KINDS` without a fresh case. It is an audit-only
  retirement marker, exactly like `recycle_successor_retired` (itself in none of the four):
  - Not `EVENT_TRIGGER_EVENT_KINDS` — not a user-automation-worthy signal, same class as
    `recycle_failed`/`codex_auto_commit`/`merge_cancelled`, all deliberately excluded there.
  - Not `GATE_HISTORY_KINDS` — unrelated to a gate run.
  - Not `ORCH_ACTIVITY_KINDS` — that list proves the MANAGER is back at the wheel producing genuine new
    work; the noCommit/noChanges auto-retire site fires `worker_retired` from the WORKER's own
    `worker_report(done)` call, not manager activity, so this kind fails that test for at least one of its
    7 call sites and must not join the list for any of them.
  - Not `REPORT_RESOLVED_EVENT_KINDS` — every one of the 7 call sites already fires its own
    pre-existing resolving kind alongside it (`stop_worker` for worker_stop/killAllWorkers/the auto-retire
    branch, `recycle_begin` for recycleWorker, `merge_done` for confirmWorkerMerge/finishAlreadyMerged), so
    adding this one too would be redundant everywhere it matters. `retireSiblingSessionsForTask`'s
    zombie-sibling sweep is the one site with no pre-existing resolving event, but a stray sibling retired
    there has essentially never filed its own `worker_report` in the first place (it's cut off before ever
    finishing) — not a case this card's DoD covers; a real gap there (if one is ever found) is a separate
    card, not a reason to add this kind to that list.
- Do not key the new resume() refusal on `archivedAt`/`resumability` alone, or on `lastError` text —
  `@decision 5a56bb0a`'s own "Do not" list already rules both out for the identical reason (self-heals
  wrongly / fragile); this card's marker follows the same discipline.
- Do not compare `worker_retired`/`worker_retirement_lifted` by `ts` or rowid — `ts` can collide at
  millisecond resolution and sqlite's rowid is reused on delete; only `orchestration_events.seq` (the
  never-reused counter) gives a safe total order for the epoch comparison.
- Do not file `worker_retirement_lifted` from anywhere but `resume()`'s own `allowSuperseded` branch, and
  only when `isWorkerRetirementActive` was already true — an unconditional file on every `allowSuperseded`
  resume would add a dead write for every OTHER `allowSuperseded` caller (hasSuccessor's own recycled-
  session path, etc.) that has nothing to do with a worker retirement.
- Do not route `session_resume` (companion/capabilities.ts) through `allowSuperseded` to "fix" the refusal
  for a stopped worker — it deliberately stays non-human; see the Fix round section above.
