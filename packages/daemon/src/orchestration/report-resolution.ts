import type { OrchestrationEvent } from "@loom/shared";

/**
 * Event kinds that genuinely CLOSE a standing `worker_report(done|blocked)` — i.e. actually move the
 * manager past "this worker needs my review", not merely "some worker-keyed row landed after it."
 *
 * SHARED ALLOWLIST, not a shared predicate — read that distinction carefully before trusting this as more
 * than it is. Two independent consumers read this SAME set: `worker_list`'s own `reportedState`/
 * `awaitingReview` projection (`mcp/orchestration.ts`) and the boot-time crash/restart-recovery notice's
 * `awaitingReview` derivation (`orchestration/crash-orphaned-workers.ts`, card 959a5fb7 — filed after
 * that notice claimed an ALREADY-CONSUMED report was "awaiting your review/merge" purely because a report
 * event existed, not because anyone was actually still waiting on it). Sharing this set means the two can
 * never diverge on WHICH EVENTS COUNT AS RESOLVING. It does NOT mean the two agree on the full predicate —
 * each still runs its OWN separately-written scan around this allowlist, and as of card 959a5fb7's review
 * round they deliberately (or at least knowingly) diverge on two inputs, each pinned by its own tests:
 *   - **`blocked` reports**: `mcp/orchestration.ts`'s projection treats `done` and `blocked` alike
 *     (`status !== "done" && status !== "blocked"` short-circuits) — a blocked report can be
 *     `awaitingReview:true` (see `test/worker-reported-state.mjs`). `deriveCrashOrphanedWorkers` only
 *     ever sets `reportedDone`/`awaitingReview` true for `status === "done"` — a `blocked` report is
 *     currently NEVER counted as awaiting review by the crash/restart notice, and (a real, PRE-EXISTING
 *     gap, not introduced by 959a5fb7 — tracked separately, not fixed here) that same blocked worker still
 *     gets the ordinary "continue your task" nudge instead of one reflecting that it's actually stuck.
 *   - **`merge_rejected`**: `deriveCrashOrphanedWorkers` treats a `merge_rejected` AFTER a done report as
 *     SUPERSEDING it (an early `break` — the worker is back to mid-fix, not awaiting review).
 *     `worker_list`'s projection has no such carve-out — `merge_rejected` isn't in this allowlist, so by
 *     itself it does NOT resolve `awaitingReview` there. `test/crash-orphaned-workers.mjs` and
 *     `test/worker-reported-state.mjs` pin these two opposite answers for the same underlying shape,
 *     deliberately — see each file's own case for why. Do not assume reading this constant is enough to
 *     predict either consumer's actual `awaitingReview` value; read the consumer's own scan too.
 *
 * An ALLOWLIST, not a denylist, and deliberately so (card 6641c3ab): `orchestration_events.
 * worker_session_id` is reused across this codebase as a generic "subject of this event" column by
 * plenty of things that are NOT a review being resolved — `merge_request` (reviewWorkerMerge, fired at
 * REVIEW-START, before any merge decision is even made — this is what actually caused the bug: a manager
 * merely looking at a worker's diff via `worker_merge` cleared `awaitingReview` before
 * `worker_merge_confirm` was ever called), `merge_rejected`/`merge_cancelled` (a decision was made, but
 * not the "merged" the doc promises clears this), `worker_stuck` (a watchdog advisory), crash-recovery
 * triggers, etc. A denylist would have to name every one of those AND every future one — missing just
 * one silently reintroduces this exact bug, which is how `merge_request` did, undetected, before this
 * card. An allowlist fails in the SAFE direction for `worker_list`'s ORIGINAL consumer: a kind missing
 * from this set just means a manager looks at a worker that didn't actually need looking at
 * (self-correcting the instant they look), never a finished worker sitting unnoticed indefinitely (the
 * bug that consumer's card fixed). **That safety argument does NOT automatically carry over to the
 * crash/restart-notice consumer added by card 959a5fb7** — there, a kind missing from this set drives a
 * NUDGE decision too, not just a notice count: a worker whose report was actually consumed by a kind this
 * set doesn't yet know about reads as `awaitingReview:true`, which means it is BOTH mis-announced as
 * "awaiting your review/merge" AND denied the ordinary continue-nudge, at exactly the moment (a restart)
 * a manager is least equipped to notice the gap itself. Adding a new resolving event kind here should be
 * checked against BOTH consumers' actual failure directions, not just the original one.
 *
 * `message_worker`/`redirect_worker` are a PROXY for the doc's actual stated condition ("resumes a
 * turn"), not the thing itself — Loom records the SEND here, not a confirmed turn resumption. Right in
 * the common case, but a message that gets durably queued and then PARKED (never delivered — see memory
 * `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`) breaks the proxy: the worker never
 * actually resumed, yet this would still read as resolved. Known, accepted gap — building
 * parked-message detection into this projection is out of scope here.
 *
 * `stop_worker`/`recycle_begin` narrow race (card 959a5fb7 review round, accepted): if a report is
 * "resolved" by one of these — the manager stopped/recycled the worker — but the daemon dies before that
 * worker session actually exits, `deriveCrashOrphanedWorkers` now reads `awaitingReview:false` and the
 * worker gets the ordinary "continue your assigned task" nudge, where before this card it would have
 * gotten silence (reportedDone withheld the nudge unconditionally). This ADDS a nudge to a worker that
 * may be on its way out, never a resurrection of a session that's actually gone — `resume()`'s own
 * liveness re-check is what would actually stop a genuinely-dead session from receiving anything. Accepted
 * as a strict improvement over the prior silent-parking behavior, not a new risk.
 */
export const REPORT_RESOLVED_EVENT_KINDS: ReadonlySet<OrchestrationEvent["kind"]> = new Set<OrchestrationEvent["kind"]>([
  "merge_done", "message_worker", "redirect_worker", "recycle_begin", "stop_worker",
]);
