# 08c81809 — recover a manager/platform recycle settle loop lost to a restart mid-window

## Narrative

Follow-up to `e07b1b1a`'s own "Accepted gaps": `SessionService.settleRecycleHandoff` is a purely
in-memory `async` poll loop. A `daemon_restart` (or crash) while it is still polling loses it entirely,
and none of the three automatic resume paths (`resumeFleetOnBoot`, `recoverCrashOrphanedWorkers`,
`CrashRecoveryWatcher`) can ever revisit the lineage afterward — `resume()` refuses the predecessor
forever (`hasSuccessor`) and refuses a never-started successor forever too.

**Round 1** (`53ca3ab4`) shipped a single-phase `reconcileStrandedRecycleSettles`. Code Review (`a4c83fbc`)
found it unsound: its own test skipped three real `index.ts` boot steps that run BEFORE any reconcile,
hiding that its reparent moved ZERO rows on a real boot, that `engineSessionId` alone misclassified a
successor that captured an id then died before ready, and that its stranded banner was invisible once the
crash-path backstop archived the predecessor.

## Round 2 design

**Split into two phases.** `reconcileStrandedRecycleSettlesEarly` (`sessions/recycle-settle-reconcile.ts`)
is DB-only and runs in `index.ts` before `recoverStaleSessions`/`deriveCrashOrphanedWorkers` — the only
place a reparent can still see (and correct) the lineage before they snapshot it.
`SessionService.finishReconcilingRecycleSettles` runs later, once `SessionService`/`PtyHost` exist, for
the actual `resume()` attempts, archiving, and nudges.

`reparentAllChildren` (`db.ts`) is not gated on `process_state='live'` (unlike the live loop's own
`reparentLiveWorkers`) — that flag no longer reflects reality by boot time. `isDurablyResumable`
(`sessions/recycle-settle-reconcile.ts`) is a pure DB/filesystem replica of `resume()`'s own preconditions,
usable before `SessionService` exists. `reachedReadyAt` (nullable `sessions` column +
`PtyHostEvents.onReady`) is the durable counterpart to `PtyHost.hasReachedReady`, replacing
`engineSessionId` as the discriminator — a successor can capture an engine id and still die before ready.
Excluded from every agent-facing `Session` projection — internal only.

Three early-phase buckets: `recovered` (never ready + predecessor durably resumable — already unlinked +
reparented), `deferred` (durably ready + successor still linked — untouched, later phase verifies via a
real `resume()`), `stranded` (neither resumable — untouched). The later phase's `stampStranded` un-archives
the predecessor before stamping its `[loom:orphaned-fleet]` banner (the crash-path backstop already
archived it by then).

## Do not

- Do not run the reparent step after `recoverStaleSessions`/`deriveCrashOrphanedWorkers` — a later reparent
  is invisible to the crash-path derivation even via `reparentAllChildren`.
- Do not use `engineSessionId` as the "successor is fine" discriminator — use `reachedReadyAt`, AND only
  when the successor is still LINKED (round 5 — see below).
- Do not expose `reachedReadyAt` on any agent-facing `Session` projection.
- Do not touch the successor's lineage in the early phase before `isDurablyResumable` confirms the
  predecessor is a viable destination (NEVER RESURRECT).
- Do not clear the durable settle marker before every step that can throw has genuinely succeeded (round
  4/5 — see below).

## Accepted, narrow residuals

- The `deferred` FALLBACK path's own reparent (reached only when `resume(freshId)` fails and it falls
  through to recovering the predecessor instead — the `deferred` SUCCESS path does no reparent at all)
  runs AFTER `deriveCrashOrphanedWorkers` already ran — may miss these workers for THIS boot (requires a
  ready-latch + a later unpredicted resume failure; the DB ends up correct regardless).
- `recoverCrashOrphanedWorkers` gives a failed MANAGER resume no durable event/nudge — only a
  `console.log`. Separate defect, carded separately.
- `resume()` does not check `resumability`/`archivedAt` at all for an automatic caller — it refuses
  neither a `resumability:"dead"` row nor an archived one. That gap (card `5a56bb0a`) is separate and
  already carded — out of scope here, even though round 5's MAJOR (below) went through it.

## Round 3 — CRITICAL: a retired successor is now structurally excluded

Code Review round 3 (`6f1db3d9`) reproduced a CRITICAL: a retired successor (`unlinkAndArchiveDeadRecycleSuccessor`,
archived + `resumability:"dead"`) was still resumed by `resumeFleetOnBoot`/`recoverCrashOrphanedWorkers`
from their own pre-restart/pre-crash snapshots — two live managers on one lineage. Fixed: both functions
accept `opts.excludeRetiredIds` and filter it, reporting a distinct `retiredSkipped` count. Also fixed:
`finalizeRecovery` now re-mints the dead successor's unresolved durable queue onto the predecessor BEFORE
archiving it (mirroring the live recovery path); and the early phase stopped clearing the durable marker
early — it stays set until the LATER phase resolves the row.

## Round 4 — hardening: the exclusion is instance-level, not opt-in

Code Review round 4 (`21f6476a`): the round-3 fix was correct but unpinned/fragile. Fixed: a new
crash-path scenario (I) gives M2 a real transcript so the filter is a genuine discriminator; the exclusion
moved onto a `SessionService` instance field (`retiredRecycleSuccessorIds`), populated by
`finalizeRecovery` and consulted UNCONDITIONALLY by both resume paths — `opts.excludeRetiredIds` is now
only an override, and index.ts no longer passes it; `finalizeRecovery`'s marker-clear moved from its FIRST
statement to its LAST (only on success), with the retirement itself recorded before either throwable step
(scenario J pins this via a scoped `carryPendingToSuccessor` prototype monkeypatch); codex's `bootReady`
`onReady` fire (and claude's `markReady` one) got wrapped in try/catch; scenario (A) got a real
two-step-sequence delivery assertion; the requester's own resume got the same exclusion.

## Round 5 — MAJOR: round 4's "keep the marker set on throw" reopened a resurrection path

Code Review round 5 (`c3ec1519`) reproduced a MAJOR via a 3-boot probe: in the `early.deferred` loop, once
`resume(predecessor)` succeeds and the successor is unlinked, a LATER throw inside `finalizeRecovery`
(round 4's own fix) left the durable marker set. `reachedReadyAt` never clears, so the NEXT boot's early
phase re-classified the SAME row as `deferred` AGAIN and called `resume(freshId)` DIRECTLY — bypassing the
brand-new process's empty `retiredRecycleSuccessorIds`. If the successor's transcript had since become
available, that resume could genuinely succeed, resurrecting it alongside the already-resumed predecessor.

**Fix:** `deferred` now additionally requires the successor still be LINKED (`fresh.recycledFrom ===
predecessorId`) — once a prior boot has unlinked it, the predecessor was already chosen as the owner, and
the row routes through `recovered`/`stranded` instead, regardless of `reachedReadyAt`. Pinned by a new
3-boot scenario (K) mirroring the reviewer's own repro. Also fixed this round: two stale doc-drift
comments calling `excludeRetiredIds` "the structural fix"; a requester-exclusion path that double-counted
into both `retiredSkipped` and `failed`; and a vacuous "first-write-only" codex test assertion (replaced
with a direct double-call of `setReachedReady`) plus a new pin that an `onReady` throw can't skip kickoff
delivery.

## Source

`db.ts`: `recycle_settle_pending_for`, `reached_ready_at`, `setReachedReady` (first-write-only, round 3).
`sessions/recycle-settle-reconcile.ts`: the early phase, `isDurablyResumable`, the `stillLinked` gate
(round 5). `sessions/service.ts`: `finishReconcilingRecycleSettles`, `finalizeRecovery`,
`retiredRecycleSuccessorIds` (round 4), `resumeFleetOnBoot`/`recoverCrashOrphanedWorkers`. `sessions/boot-
backstop.ts`: `runBootRecoveryPrefix` (round 3). `pty/host.ts`: `onReady`/`markReady`, codex `bootReady`'s
own `onReady` fire (round 3), both try/catch-wrapped (round 4). `index.ts`: both call sites, real boot
order. `shared/src/types.ts`: `recycle_fleet_stranded_across_restart`, `Session.reachedReadyAt`. Tests:
`recycle-settle-lost-to-restart.mjs` (scenarios A-K), `codex-bootready-stamps-reached-ready.mjs`. Full
trace + every Code Review round's findings: card `08c81809`'s own body.
