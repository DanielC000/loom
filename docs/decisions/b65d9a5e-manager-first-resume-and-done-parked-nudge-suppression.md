# sha:b65d9a5e — `recoverCrashOrphanedWorkers`: manager-first resume order, and which recovered sessions get nudged

## Narrative

Commit `b65d9a5e9d` ("fix(orchestration): recover crash-orphaned workers — boot-reconcile re-parents resumable workers to their live manager") is the original design of `recoverCrashOrphanedWorkers`'s resume ordering and nudge-suppression rules.

**Manager-first ordering.** Each candidate's MANAGER is resumed first (`resume()` no-ops if already alive). A worker whose manager can't be resumed (dead transcript, gone worktree, superseded) is left UNTOUCHED in its clean exited/archived state, rather than half-resumed into an orphan with no live parent to see it. Once the manager is live, resuming the worker itself un-archives it via the SAME `db.restoreSession()` side effect `resume()` already performs — `listWorkers` (what `worker_list` reads) filters only `archived_at IS NULL`, so that IS the whole "re-parent": `parentSessionId` was never touched or needed rewriting.

**Per-worker nudge suppression.** A worker already reported `done` (at the time of this commit; see `959a5fb7`'s own record for the later `awaitingReview` refinement) is recovered for VISIBILITY (it reappears in `worker_list` so the manager notices it's awaiting merge review) but does NOT get the "continue your task" nudge — it isn't mid-work. Every other recovered worker gets the same "worktree WIP intact, continue" nudge `resumeFleetOnBoot` sends. A PARKED (rate-limited) manager or worker is resumed live (so the rate-limit watcher can recover it in its own time) but its nudge is WITHHELD — mirrors `resumeFleetOnBoot`'s `isParked`/`skippedParked` handling; a crash must never push a held turn back into a usage-limit cap.

**Per-manager summary nudge.** Each affected (non-parked) manager gets ONE summary nudge naming how many of its candidate workers were recovered (and how many of those are awaiting review, and how many couldn't be resumed at all) — sent even when EVERY candidate worker failed to resume, so the manager (already silently resumed with no other signal) still learns a crash happened and its workers didn't come back, rather than sitting there with no orientation at all.

## Do not

- Do not resume a worker before its manager — an un-archived worker with no live manager is an orphan nothing will notice.
- Do not send the generic continue-nudge to a `done`/awaiting-review worker, and do not send ANY nudge (worker or manager summary) to a session honoring an active rate-limit park.
- Do not skip the per-manager summary nudge even when every candidate worker failed to resume — silence there is indistinguishable from nothing having happened.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: originally lines ~1420-1436 at commit `b65d9a5e9d`; as of this tranche's HEAD (tranche 14) the same narrative spans lines 4831-4836 and 4838-4859 (reworded/extended in place across several later commits — `a7cde03ae3`, `8bf8f8c2` — for the `awaitingReview`/blocked-vs-done refinements those introduced; see `959a5fb7` and `db05e657` for those). No board card ever named this original design; sourced by sha per `docs/extraction-program.md`'s `sha:` grammar.
