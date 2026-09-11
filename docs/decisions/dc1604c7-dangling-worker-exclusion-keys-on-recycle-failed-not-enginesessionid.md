# dc1604c7 — the never-started dangling-worker exclusion keys on `recycle_failed`, not `engineSessionId`

## Narrative

Code Reviewer finding on card `08320d02`: after a `recycleWorker` pre-spawn throw archives the fresh
(never-started) successor row, that row drops off `db.listWorkers` (the live rail) but re-enters MCP
`worker_list` through `SessionService.getDanglingWorkers`'s own `processState:"dangling"` pool — it has a
branch, a worktreePath that still exists (reused from the predecessor), and an unmerged task, so it
qualifies as a candidate. A session id that never had a process gets presented to the manager as "a
stopped worker holding unmerged work" it never held.

**First attempt (rejected): exclude a candidate whose `engineSessionId IS NULL`.** `engineSessionId` is
captured only by the SessionStart hook, and a never-started successor never reaches `pty.spawn`, so it
never gets one — this reading looked sound at first pass. Lead review killed it with a structural
counter-example: `pty/host.ts`'s spawn-armed readiness fallback (`READY_FALLBACK_MS`, the
`readyFallbackTimer` set at spawn) calls `markReady` if SessionStart never arrives at all — and
`markReady` delivers the kickoff via `submit()` regardless (`scheduleKickoffGuarantee`, card `0050a17e`).
So a REAL worker whose SessionStart hook itself failed — the engine genuinely spawned, ran turns, and can
commit real work — still ends up with `engineSessionId` permanently null. Filtering on that field alone
would have hidden exactly that worker's genuinely-dangling branch from the manager, the opposite of this
card's own goal.

**What ships instead: exclude a candidate whose id appears in a `recycle_failed` event's
`workerSessionId`.** `recycle_failed` (card `08320d02`) is appended exclusively inside the synchronous
try/catch that wraps `recycleWorker`'s own `pty.spawn` call — nowhere else — so its presence for a given
id is direct evidence that id's process was never created, independent of `engineSessionId`/SessionStart
entirely. Read via `db.listWorkerSessionIdsWithEventKind(["recycle_failed"])`, the same indexed-query
pattern fleetView's `archivedUnreported` category already uses (`idx_orch_events_kind`).

**Coverage checked, not assumed — no other pre-spawn-failure catch can produce this same shape.**
`reconcileFailedSpawn` (the shared "flip to exited + set lastError" helper) is called from ~14 sites, but
only the three recycle catches (`recycleWorker`/`recycleManager`/`recyclePlatformLead`) additionally
`archiveSession()` the failed row — every other caller (`spawnWorker`'s first-spawn catch, the ~8
resume-path catches) leaves its row exited but un-archived, so it never becomes a candidate for
`getDanglingWorkers` at all (`listArchivedWorkersInProject` requires `archived_at IS NOT NULL`).
`recycleManager`/`recyclePlatformLead`'s own `recycle_failed` events are moot for this function too — they
name a manager/platform-lead row, and `listArchivedWorkersInProject` filters `role = 'worker'`. So
`recycleWorker`'s catch is the only route that can leave an archived, worker-role, never-started row in
the candidate pool, and it is exactly what this check catches.

**Regression pin:** `worker-list-dangling.mjs` scenario (I) proves the exclusion fires off a real
`recycle_failed` event (not `engineSessionId`); scenario (J) is the standing guard against reverting to
the rejected reading — an `engineSessionId:null` worker with a real commit and no `recycle_failed` event
must still appear as dangling.

## Do not

- Do not filter `getDanglingWorkers`'s candidates on `engineSessionId IS NULL` — a real worker recovered
  by `pty/host.ts`'s spawn-armed readiness fallback (SessionStart missed, engine still ran) has a null
  `engineSessionId` forever despite having genuinely committed work; that reading was reviewed and
  rejected for exactly this false-exclusion risk.
- Do not assume `recycle_failed` alone needs a role or archived-state guard here — `recycleManager`/
  `recyclePlatformLead`'s own `recycle_failed` events can never collide with this worker-scoped query
  (`listArchivedWorkersInProject` already filters `role = 'worker'`), and no other pre-spawn-failure catch
  archives its row, so nothing else can reach this candidate pool in this shape.
- Do not drop `worker-list-dangling.mjs`'s scenario (J) — it is the only thing pinning this exclusion
  against silently regressing back to the rejected `engineSessionId` reading.

## Source

Condensed and reworded, not verbatim. Inline comment in `packages/daemon/src/sessions/service.ts`
(`getDanglingWorkers`, the `neverStartedRecycleSuccessorIds` computation, anchored `@decision dc1604c7`).
`packages/daemon/src/pty/host.ts`: `READY_FALLBACK_MS`/`readyFallbackTimer` (the spawn-armed readiness
fallback) and `markReady` (the kickoff-delivery path it triggers). `packages/daemon/test/
worker-list-dangling.mjs`: scenarios (I) and (J).
