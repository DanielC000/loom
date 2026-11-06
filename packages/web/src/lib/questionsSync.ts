// Cache helpers for the `/ws/fleet` Request-inbox change signal (card 55de3b68). The frame is CONTENTLESS
// (`{t:"questions"}`), so unlike the orchestration-event feed there is nothing to patch in: the only correct
// reaction is to re-read the REST route (the source of truth). Kept free of JSX/DOM so it is unit-testable
// (test/questionsSync.mjs); FleetSocketProvider.tsx is the only runtime caller.
import type { QueryClient } from "@tanstack/react-query";

/**
 * The inbox LIST cache keys — `["openQuestions"]` and its `["openQuestions","history"]` variant: exactly what the
 * removed `refetchInterval` polls kept fresh. The single-row detail query (`["question", id]`) was never polled,
 * so it is deliberately NOT touched here: re-reading it on a signal would refresh a modal underneath the user
 * (the notice-dismiss modal loses its button the moment the row leaves the list).
 */
export const isQuestionsQuery = (q: { queryKey: readonly unknown[] }): boolean => q.queryKey[0] === "openQuestions";

const isFetching = (qc: QueryClient) =>
  qc.getQueryCache().findAll({ predicate: isQuestionsQuery }).some((q) => q.state.fetchStatus === "fetching");

/** Resolves once no inbox read is in flight (immediately when none is). */
const settled = (qc: QueryClient): Promise<void> =>
  new Promise((resolve) => {
    if (!isFetching(qc)) return resolve();
    const unsubscribe = qc.getQueryCache().subscribe(() => {
      if (isFetching(qc)) return;
      unsubscribe();
      resolve();
    });
  });

/** Re-read every inbox query (mounted ones refetch now; unmounted ones are marked stale for their next mount). */
export function invalidateQuestionQueries(qc: QueryClient): Promise<void> {
  // cancelRefetch:false — never abort a read that is already running (it would keep running on the daemon
  // anyway); a signal that lands mid-read is handled by signalQuestionsChanged's dirty re-read instead.
  return qc.invalidateQueries({ predicate: isQuestionsQuery }, { cancelRefetch: false });
}

const pending = new WeakMap<QueryClient, () => void>();

/**
 * A `{t:"questions"}` frame arrived. If no inbox read is in flight, re-read now. If one IS in flight, its
 * response may predate the change the frame announces, so it is not trusted: remember the signal and re-read
 * ONCE after the in-flight read settles (any number of frames meanwhile collapse into that one re-read).
 */
export function signalQuestionsChanged(qc: QueryClient): void {
  if (!isFetching(qc)) { void invalidateQuestionQueries(qc).catch(() => {}); return; }
  if (pending.has(qc)) return;
  const unsubscribe = qc.getQueryCache().subscribe(() => {
    if (isFetching(qc)) return;
    unsubscribe();
    pending.delete(qc);
    void invalidateQuestionQueries(qc).catch(() => {});
  });
  pending.set(qc, unsubscribe);
}

/** Drops a queued signal (the socket closed / the provider unmounted — the reconnect re-reads anyway). */
export function cancelPendingQuestionsSignal(qc: QueryClient): void {
  pending.get(qc)?.();
  pending.delete(qc);
}

/**
 * True when an ACTIVE inbox query's last read FAILED and nothing is re-reading it. Detected from query state,
 * never the promise (`invalidateQueries` swallows fetch errors). Active only, so an unmounted errored query
 * can't re-arm the retry forever.
 */
export function hasFailedQuestionQuery(qc: QueryClient): boolean {
  return qc.getQueryCache().findAll({ predicate: isQuestionsQuery }).some((q) => q.isActive() && q.state.status === "error" && q.state.fetchStatus === "idle");
}

/**
 * The inbox feed's seed: on EVERY (re)open re-read every inbox query once (a change-only feed cannot replay
 * what happened while the socket was down), then retry on the shared stoppable ladder while any list is still
 * in error state. `isCurrent` voids an attempt a later close/open superseded; `again` re-enters the start step.
 */
export function resyncQuestions(
  qc: QueryClient,
  deps: { retry: { schedule: (fn: () => void) => void; reset: () => void; stopped: () => boolean }; isCurrent: () => boolean; again: () => void },
): void {
  // A read already in flight at open may have run on the server BEFORE the socket was registered for signals,
  // so a change committed in that gap is never announced and joining that read would leave the inbox stale with
  // no poll to heal it. Same dirty path as signalQuestionsChanged: wait for it to settle, THEN re-read once.
  // (cancelRefetch:true is not an option — react-query only cancels a read that already has data, so on first
  // load it would still join.)
  settled(qc)
    .then(() => invalidateQuestionQueries(qc))
    .catch(() => {})
    .finally(() => {
      if (!deps.isCurrent()) return;
      if (hasFailedQuestionQuery(qc)) { if (!deps.retry.stopped()) deps.retry.schedule(deps.again); }
      else deps.retry.reset();
    });
}
