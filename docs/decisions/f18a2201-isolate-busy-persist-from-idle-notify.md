# f18a2201 — isolate the busy DB write from the manager idle-notification it also drives

Follow-up to `72c58b1c` (Code Review 8dff4990). `72c58b1c` made `PtyHost.persistBusy` swallow an
`events.onBusy` failure on the PtyHost side of the boundary (correct: a throw there could double-spawn
webhook sessions). But `events.onBusy`'s real implementation — `index.ts`'s `onBusy` callback — ran
`db.setBusy(sessionId, busy)` and the manager-notify (`notifyManagerOfIdleWorker`/
`purgeStaleIdleNudgeForReengagedWorker`) as two unguarded, sequential statements. A `db.setBusy` throw
(e.g. a transient SQLITE_BUSY) would propagate out of the whole callback and skip the notify entirely —
for a TASKLESS worker, that notify is its ONLY idle coverage (`idle-watcher.ts` has no periodic fallback
for a taskless worker), so a single transient DB error there could silently strand a manager forever.

## The fix

Extracted the callback's body into `SessionService.handleBusyEdge(sessionId, busy)` (`sessions/
service.ts`), with `db.setBusy` wrapped in its own try/catch (logged, never rethrown) — the notify/purge
call always runs after it, regardless of whether the write succeeded. `index.ts`'s `onBusy` now just
delegates: `onBusy: (sessionId, busy) => sessions.handleBusyEdge(sessionId, busy)`.

Extracting this (rather than inlining the try/catch directly in index.ts) makes it possible to drive the
REAL logic from a test — `index.ts` is a top-level boot script with side effects at import, not an
importable unit — instead of a hand-maintained copy of the wiring that can drift from the real file
unnoticed (the trap `test/idle-worker-nudge-race.mjs` was in before this card: its own header comment
said it "mirrors index.ts's ACTUAL onBusy wiring byte-for-byte", a second copy of logic that stays green
even if the real wiring changes underneath it). That test now calls `sessions.handleBusyEdge` directly
instead of keeping its own copy.

A DB write left stale by a failed `db.setBusy` here is NOT healed by this method — that's
`PtyHost.reconcile()`'s job (its own periodic re-persist-on-mismatch, card `f18a2201` item 2, tracked via
`Live`/`CodexLive`'s `busyPersistDirty` flag). This method's only job is to make sure the manager
notification is never silently dropped as a side effect of that unrelated DB failure.

## Do not

- Do not inline `db.setBusy` + the notify/purge calls back into `index.ts`'s `onBusy` callback — keeping
  them in `SessionService.handleBusyEdge` is what makes this logic unit-testable without booting the
  whole daemon.
- Do not let a future caller add logic between the DB write and the notify/purge calls without keeping
  the DB write's try/catch around ONLY the write — widening the try/catch to also swallow a notify/purge
  failure would hide a different bug.
- Do not treat this method as responsible for healing a stale DB column — that's `PtyHost.reconcile()`'s
  job; this method only guarantees the notification still fires.
- Do not revert `test/idle-worker-nudge-race.mjs`'s `events.onBusy` back to its own hand-copied mirror of
  this wiring — call `sessions.handleBusyEdge` so the test exercises the real function.
