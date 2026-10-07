# d9512de7 — file `recycle_fleet_resolved` after a halted lineage's successor recovers across a restart

## The bug

`db4b778c` fixed the two LIVE ready branches (`settleRecycleHandoff`, `watchHaltedRecycleSuccessor`) that
could reach `return` after an unresolved `recycle_fleet_unresolved` alert had fired, without ever filing
the matching `recycle_fleet_resolved`. Neither branch, however, survives a daemon restart — both are
in-memory `async` loops, and `watchHaltedRecycleSuccessor` is armed from exactly one call site
(`recycleManager`'s HALT branch, fired once at halt time) that is never re-armed at boot.

The boot-restart path was never enumerated for this same gap. Investigation (card d9512de7) traced every
exit of `reconcileHaltedRecycleSuccessorsEarly`/`finishReconcilingHaltedRecycleSuccessors`
(`sessions/halted-recycle-reconcile.ts`, `sessions/service.ts`), `resumeFleetOnBoot`,
`recoverCrashOrphanedWorkers`, the shared `resume()`, and `PtyHost.markReady`, and found none of them file
`recycle_fleet_resolved` for a halted lineage whose successor is durably resumable. The early phase's own
`isDurablyResumable(fresh)` branch explicitly defers resuming the successor to "the ordinary
resumeFleetOnBoot/crash-recovery paths" — none of which have any recycle-fleet-alert awareness at all. A
human alerted "unresolved" before the restart could never hear "resolved" after it, even though the
successor genuinely came back — for the one shape this card actually closes.

That shape, precisely: a successor that was LIVE (or starting) at the moment of the restart, resumed by
`resumeFleetOnBoot`/`recoverCrashOrphanedWorkers`, and reaching ready within the observer's own bound
(`RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS`, ~55s) — the same bound that produces the `reason:"timeout"`
unresolved-alert shape. A successor that had already EXITED before the restart (the
`reason:"halted-waiting-crash-recovery"` alert shape) is a NAMED RESIDUAL, not covered here: neither boot
path resumes it — `liveFleetResumeSet` filters `processState === "live"`, and `recoverStaleSessions` only
takes rows already `live`/`starting`, so an already-exited successor is invisible to both. Only
`CrashRecoveryWatcher` revives that successor, and its first tick lands at ≥60s (`crashRecoveryWatchMs`,
a `setInterval` with no immediate tick) — after this card's observer has already given up. For that shape
the alert stays open exactly as it did before this card; the follow-up is carded at `49107314`
("fix(sessions): resolve a halted alert when crash recovery revives the successor").

## The fix

`reconcileHaltedRecycleSuccessorsEarly`'s `isDurablyResumable(fresh)` branch now additionally checks
`openUnresolvedRecycleFleetAlert(db, predecessorId, fresh.id)` before its `continue`; when it matches, the
pair is recorded in a new `HaltedRecycleEarlyResult.pendingResolution` bucket instead of being silently
dropped. `finishReconcilingHaltedRecycleSuccessors` arms one `waitForHaltedSuccessorReadyThenResolve`
observer per entry — bounded, fire-and-forget, reusing `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS`/
`_POLL_MS` rather than new constants — that polls `pty.hasReachedReady(freshId)` and files exactly one
`recycle_fleet_resolved` the instant it observes readiness, provided the alert is still open at that
moment. If the successor never reaches ready within the bound, it logs once and leaves the alert open —
it never fabricates a resolution it didn't observe.

The LEAD's ruling deliberately rejected two weaker designs: (1) resolving the alert directly from the
early, DB-only pass on `isDurablyResumable` alone — a filesystem check at boot-scan time is not the same
as the successor actually reaching ready again; and (2) calling `this.resume(freshId)` from the reconcile
pass itself and filing resolved on that call succeeding (the shape the non-halted `08c81809` precedent
uses) — `resumeFleetOnBoot`/`recoverCrashOrphanedWorkers` already resume the successor, and a second
resume call from a third boot path would add ordering coupling for no benefit, even though `resume()` is
idempotent on an already-alive pty.

## Do not

- Do not file `recycle_fleet_resolved` from `reconcileHaltedRecycleSuccessorsEarly`/
  `finishReconcilingHaltedRecycleSuccessors` directly, or call `this.resume(freshId)` from either of
  them — a durable, boot-scan-time `isDurablyResumable` check is not confirmation the successor actually
  reached ready again this boot, and `resumeFleetOnBoot`/`recoverCrashOrphanedWorkers` already own
  resuming it; a second resume call from a third boot path adds ordering coupling for no benefit.
- Do not call `cancelStaleEscalationQuestions` from `waitForHaltedSuccessorReadyThenResolve` — mirrors
  `db4b778c`'s own reasoning for omitting it from `watchHaltedRecycleSuccessor`'s ready branch: this
  predecessor is the same kind of never-superseded halted manager, so there is nothing safe to assume
  about why a pending question exists.
- Do not let `waitForHaltedSuccessorReadyThenResolve` stop, reclaim, or otherwise touch the predecessor or
  successor beyond filing the resolved event — `f1969787` forbids stopping a halted predecessor
  unconditionally, and this observer has no reclaim authority at all.
- Do not drop either stand-down check. The `recycle_ownership_transfer_resolved` check (mirrors
  `b59d11f6`) is required because a live `recycle_reattempt` can resolve the lineage during the observer's
  wait window, spawning its own `settleRecycleHandoff` that will file its own `recycle_fleet_resolved` —
  without this check the observer can race it and double-file. The `openUnresolvedRecycleFleetAlert`
  re-check every tick is required because another path (a reclaim, or the stand-down case above) can
  resolve the pair before this observer ever sees readiness.
- Do not add a new timeout/poll constant for this observer — reuse
  `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS`/`RECYCLE_SUCCESSOR_SETTLE_POLL_MS`.
- Do not re-arm the full `watchHaltedRecycleSuccessor` loop at boot to close this gap — the "never
  re-armed after a restart" residual is an accepted, recorded decision (`f1969787`/`91ac2b79`); this fix
  is a narrower, purpose-built observer, not a resurrection of the live watch loop.
- Do not skip unref'ing the observer's own poll timer — an unref'd timer is required so a pending,
  never-settling wait can't hold the daemon process open.

## Verification

`test/recycle-fleet-resolved-after-halted-boot-reconcile.mjs` drives the real boot-reconcile functions
against a simulated restart (closing and reopening the same on-disk `Db`, mirroring
`recycle-manager-halted-successor-dies.mjs`'s own technique): an unresolved alert is filed by the live
watch before the simulated restart, then the successor is resumed via the real `resumeFleetOnBoot`/
`recoverCrashOrphanedWorkers` paths and reaches ready again, asserting exactly one `recycle_fleet_resolved`
event. Siblings assert no resolved event when the successor never reaches ready within the bound, when no
unresolved alert was ever filed before the restart, and that the observer stands down with no duplicate
when another path (a manual `recycle_ownership_transfer_resolved`/`recycle_fleet_resolved` injection)
resolves the pair first.
