# f349f5cb — unlink a recycle successor whose process dies before SessionStart, gated on hasReachedReady, never bare engineSessionId

## Narrative

Follow-up to `4be56c33`: that fix unlinks a failed recycle successor's `recycled_from` only inside the
three recycle methods' own synchronous pre-spawn-throw catch blocks. A recycle whose `pty.spawn` RETURNS
(no throw) but whose process then dies before SessionStart leaves the SAME stray link — the catch already
ran and returned. The predecessor stays permanently `hasSuccessor()===true` ("stuck superseded": a
retried recycle refused, crash-recovery skipped forever) even though its "successor" never ran a turn.

**Fix:** `SessionService.reconcileNeverStartedRecycleSuccessor(sessionId, intended)`, called from
`index.ts`'s `onExit` for every exited session — a no-op unless `recycledFrom` is set and no
`engineSessionId` was ever captured.

**Why `engineSessionId IS NULL` is not sufficient — `dc1604c7`'s own rejection reason.**
`READY_FALLBACK_MS`/`readyFallbackTimer` can deliver the kickoff and run real turns even though
SessionStart never lands (`markReady`/`scheduleKickoffGuarantee`, card `0050a17e`), leaving
`engineSessionId` null on a genuinely-active successor.

**Why `hasFirstTurnStarted` ALONE is ALSO insufficient — a second instance of the same bug class.** An
earlier version gated on `hasFirstTurnStarted` (the `UserPromptSubmit` hook) — Code Review caught that
this hook rides the SAME engine-hook relay `dc1604c7` already showed can be LOST even when a real turn
ran, so `false` is not proof nothing happened, only that the relay didn't confirm it. **Ships instead:**
`PtyHost.hasReachedReady(sessionId)`, the PRIMARY gate — whether `markReady` (claude)/the boot-ready
composite (codex) ever latched. `ready`/`bootReady` are PtyHost's OWN in-process state, never an external
hook, so `false` proves no kickoff text was EVER written to stdin. `hasFirstTurnStarted` + a recorded
`worker_report` stay as EXTRA, cheap gates on top.

**Double-recycle race (Code Review, verified against source): a session mid-recycling ITSELF must never
be reconciled.** `recycleWorker` hard-kills its predecessor synchronously and WAITS (~5s) for the real
exit before inserting the fresh successor. If that predecessor (B) is itself a never-started successor of
an earlier recycle (A→B), B's real `onExit` fires before C can be inserted **in the common case — B dies
within that ~5s window.** (If not, `recycleWorker` proceeds and inserts C anyway; B's later real exit then
finds `hasSuccessor(B)` already true, covered by the second guard below.) Either way, reconciling B
mid-attempt would sever B→A while C is the live continuation (`A | B→C`, A wrongly un-superseded). **Fix:**
`recycleTeardownInFlight` (`Set<string>`), marked on `workerSessionId` from before the hard-kill until the
call settles (its `finally`) — skip entirely while a session's id is in it. `recycleManager`/
`recyclePlatformLead` need no marker: both `insertSession(fresh)` BEFORE touching the old pty (a
*deferred* stop, seconds later), so `hasSuccessor(sessionId)` — checked unconditionally — is already true
by the time either old session exits: a second, independent guard, since a session with its own successor
is a legitimate chain-continuation, never a dead end.

**Accepted, timing-dependent gap — not fixed here.** If C's own spawn attempt then THROWS while B died
WITHIN the ~5s window, B's skipped onExit was its ONLY chance — the catch never touches B's own
`recycled_from` (only C's) — so A stays superseded by a dead-end B. Recoverable via a manual
`worker_recycle(B)`. NOT universal: B exiting only AFTER the call has settled reconciles normally then —
`hasSuccessor(B)` already reflects the real outcome (linked on success, unlinked on failure).

**`dc1604c7` interaction checked, not assumed:** `getDanglingWorkers` excludes any `recycle_failed`
regardless of producer. This path only records one when `hasReachedReady` is false (plus the extra
gates), so an excluded successor never had a kickoff delivered — correct, not a regression. `dc1604c7`
itself carries a section naming this as its second producer.

**Scope: the lineage LINK only, for all roles (worker/manager/platform) — never fleet recovery.** The
manager/platform consequence (nothing live, fleet stranded on the dead successor, no reverse reparent) is
real but deferred to card `e07b1b1a`. This fix only corrects `hasSuccessor()` so a stuck predecessor
becomes resumable; it does **not** recover a stranded fleet (live workers are reparented onto the
successor at spawn time, so resuming the unstuck predecessor brings nothing back).

## Do not

- Do not gate on bare `engineSessionId IS NULL`, or `hasFirstTurnStarted` alone — both ride a relay that
  can be lost even when a real turn ran. Gate on `hasReachedReady` first.
- Do not drop `recycleTeardownInFlight` or the `hasSuccessor(sessionId)` guard — either alone is
  insufficient: `recycleWorker`'s predecessor needs the marker; `recycleManager`/`recyclePlatformLead`'s
  predecessors are protected by `hasSuccessor` alone.
- Do not fold this into `reconcileFailedSpawn` — shared with `resume()` on a genuine `gen>=1` successor
  (see `4be56c33`'s own "Do not"); this method is scoped to `onExit`, never a resume-time failure.
- Do not claim this recovers a manager/platform's stranded fleet — that gap is card `e07b1b1a`.

## Source

`packages/daemon/src/sessions/service.ts`: `reconcileNeverStartedRecycleSuccessor` +
`recycleTeardownInFlight` (`@decision f349f5cb`). `packages/daemon/src/pty/host.ts`:
`PtyHost.hasReachedReady` (`@decision f349f5cb`). `packages/daemon/src/index.ts`: the `onExit` call site.
Tests: `recycle-successor-dies-before-session-start.mjs` (incl. (A2), real-PtyHost `hasReachedReady:true`),
`recycle-successor-double-recycle-chain.mjs`, `recycle-successor-onexit-wiring.mjs`.
