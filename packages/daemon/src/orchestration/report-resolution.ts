import type { OrchestrationEvent } from "@loom/shared";

/**
 * Event kinds that genuinely CLOSE a standing `worker_report(done|blocked)` — i.e. actually move the
 * manager past "this worker needs my review", not merely "some worker-keyed row landed after it."
 *
 * Card db05e657 (DoD-1..3): this used to be a SHARED ALLOWLIST feeding two independently-written
 * predicates — `worker_list`'s own `reportedState`/`awaitingReview` projection (`mcp/orchestration.ts`)
 * and the boot-time crash/restart-recovery notice's `awaitingReview` derivation
 * (`orchestration/crash-orphaned-workers.ts`, card 959a5fb7) — and the two disagreed on two inputs, each
 * pinned by its own tests. {@link deriveAwaitingReview} below is now the ONE predicate BOTH consumers call;
 * they can no longer independently decide "resolved" in different ways. The two former divergences, and
 * the ruling that closed each:
 *   - **`blocked` reports**: RULED to count exactly like `done` (mcp/orchestration.ts's pre-existing
 *     answer). A worker that reported `blocked` stopped and asked its manager for something — it is the
 *     worker that most needs to be seen, not the one a restart notice should stay silent about. See
 *     `test/worker-reported-state.mjs` and `test/crash-orphaned-workers.mjs` for the pinned case.
 *   - **`merge_rejected`**: RULED to NOT resolve a report, in either caller. It is an event kind — never a
 *     `worker_report` status — fired by the merge/gate machinery itself, not by any action directed at the
 *     worker; treating it as a resolution assumes a follow-up (a redirect telling the worker what to fix)
 *     that may never have actually been sent. A genuine follow-up already resolves the report through its
 *     OWN allowlisted event (`message_worker`/`redirect_worker`); a bare `merge_rejected` with no such
 *     follow-up is exactly the "worker silently un-flagged, nobody actually told it anything" shape this
 *     allowlist exists to prevent. This OVERTURNED `crash-orphaned-workers.ts`'s old early-break-on-
 *     `merge_rejected` special case (and the test pinning it) — `worker_list`'s answer is the one that
 *     survived, not a new third answer.
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
 * A THIRD site reads a related-but-narrower shape and deliberately does NOT call {@link deriveAwaitingReview}
 * or this allowlist: `SessionService.classifyIdleWorker`'s `ackedSince` local (sessions/service.ts) — it
 * answers "has this worker's report been directly acknowledged", for STRANDED-worker detection, not "is a
 * manager still awaiting review". Two real differences, not an oversight: it also treats `progress` as a
 * reportable status (this allowlist's callers only ever care about `done`/`blocked`), and its ack check is
 * a 2-kind subset (`message_worker`/`redirect_worker` only) — no `merge_done`/`recycle_begin`/`stop_worker`,
 * since a worker that's about to be merged/recycled/stopped isn't the "still working, still stranded" case
 * this classifier is asking about. Don't fold it into `deriveAwaitingReview` — it is a genuinely different
 * question — but a change to what "resolves" a report here is worth a glance at that site too.
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

export interface AwaitingReviewResult {
  /** The worker's most recent `worker_report` status, but ONLY when it's still genuinely awaiting review
   * — null whenever `awaitingReview` is false (no report, a non-done/blocked status, or already resolved),
   * so a non-null value always means "waiting on my review right now" (mirrors the old `reportedState`
   * field's contract in `mcp/orchestration.ts`, unchanged by this card). */
  reportedState: "done" | "blocked" | null;
  awaitingReview: boolean;
  /** The report event `reportedState` describes (present iff `reportedState` is non-null) — returned so a
   * caller needing its `ts`/`detail` (e.g. `mcp/orchestration.ts`'s `staleReport`, keyed on
   * `managerTurnSeqAtReport`) doesn't have to re-scan `events` for it. */
  reportEvent: OrchestrationEvent | null;
}

/**
 * THE unified predicate (card db05e657) — see this file's header doc above for the two rulings
 * (`blocked` counts like `done`; `merge_rejected` never resolves) that let `worker_list`'s
 * `reportedProjection` (`mcp/orchestration.ts`) and the crash/restart notice's `deriveCrashOrphanedWorkers`
 * (`orchestration/crash-orphaned-workers.ts`) both call this SAME function instead of each running its own
 * separately-written scan. Given one worker's chronological `orchestration_events`, answers exactly one
 * question: is a manager still genuinely waiting on this worker's last done/blocked report?
 *
 * No `opts` param: after the two rulings above, the two callers have no remaining intentional delta to
 * express — if a future caller needs one, add it as an explicit named option here rather than
 * reimplementing this scan (see the header doc's whole point).
 */
export function deriveAwaitingReview(events: readonly OrchestrationEvent[]): AwaitingReviewResult {
  let lastReportIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "worker_report") { lastReportIdx = i; break; }
  }
  if (lastReportIdx === -1) return { reportedState: null, awaitingReview: false, reportEvent: null };
  const reportEvent = events[lastReportIdx]!;
  const status = reportEvent.detail?.status as string | undefined;
  if (status !== "done" && status !== "blocked") return { reportedState: null, awaitingReview: false, reportEvent: null };
  const resolvedSince = events.slice(lastReportIdx + 1).some((e) => REPORT_RESOLVED_EVENT_KINDS.has(e.kind));
  if (resolvedSince) return { reportedState: null, awaitingReview: false, reportEvent: null };
  return { reportedState: status, awaitingReview: true, reportEvent };
}
