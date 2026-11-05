// Pure + cache helpers for the `/ws/fleet` orchestration-event push (card 670b2081).
//
// The shared react-query cache holds orchestration events under four key families (two spellings each of
// "one manager's timeline" and "these kinds, fleet-wide"). A pushed `event` frame is the SAME row the REST
// route returns, so patching it into a cached list is just the list-shape REST would have produced with
// one more row — no new data model. Kept free of JSX/DOM so the list math is unit-testable
// (test/orchEvents.mjs); FleetSocketProvider.tsx is the only runtime caller.
import type { OrchestrationEvent } from "@loom/shared";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Mirrors the daemon's `listRecentEventsByKinds` default LIMIT (db.ts): a by-kinds list is newest-first and
 * capped, so a prepended row must push the oldest off rather than grow the list past what REST returns.
 */
export const EVENTS_BY_KIND_LIMIT = 500;

export type OrchEventKeyClass =
  | { family: "manager"; managerId: string }
  | { family: "kinds"; kinds: string[] };

/** Classifies a react-query key as one of the event-list families, or `null` for every other query. */
export function classifyOrchEventKey(key: readonly unknown[]): OrchEventKeyClass | null {
  const root = key[0];
  if ((root === "orchEvents" || root === "orchestrationEvents") && typeof key[1] === "string") {
    return { family: "manager", managerId: key[1] };
  }
  if ((root === "orchEventsByKind" || root === "orchestrationEventsByKinds") && key.length > 1) {
    const kinds = key.slice(1).filter((k): k is string => typeof k === "string");
    return kinds.length === key.length - 1 ? { family: "kinds", kinds } : null;
  }
  return null;
}

/**
 * Applies one pushed event to a cached list, returning a NEW array — or the SAME reference when the row is
 * already present (dedupe by `id`, which is what makes a resync replay and a live frame idempotent).
 * A manager timeline is chronological (REST: `ORDER BY ts, rowid`), so the new row appends; a by-kinds list
 * is newest-first and capped, so it prepends and trims.
 */
export function applyEventToList(list: OrchestrationEvent[], evt: OrchestrationEvent, order: "append" | "prepend"): OrchestrationEvent[] {
  if (list.some((e) => e.id === evt.id)) return list;
  if (order === "append") return [...list, evt];
  const next = [evt, ...list];
  return next.length > EVENTS_BY_KIND_LIMIT ? next.slice(0, EVENTS_BY_KIND_LIMIT) : next;
}

const isEventQuery = (q: { queryKey: readonly unknown[] }) => classifyOrchEventKey(q.queryKey) !== null;

/**
 * Patch one pushed event into every cached event list it belongs to. A query with no data yet is skipped
 * (its own mount fetch will read the row). A query that is MID-FETCH is never restarted (that would cancel
 * the read client-side while the GET still runs to completion on the daemon, and on a busy manager the list
 * might never settle): the frame is QUEUED per query and applied once that fetch settles. An in-flight
 * response may predate the frame, so applying it afterwards is what makes it land; if the response already
 * contains the row, the id dedupe makes the replay a no-op.
 */
export function applyOrchEvent(qc: QueryClient, evt: OrchestrationEvent): void {
  for (const q of qc.getQueryCache().findAll({ predicate: isEventQuery })) {
    const cls = classifyOrchEventKey(q.queryKey);
    if (!cls) continue;
    if (cls.family === "manager" ? cls.managerId !== evt.managerSessionId : !cls.kinds.includes(evt.kind)) continue;
    applyToQuery(qc, q.queryKey, q.queryHash, cls.family === "manager" ? "append" : "prepend", evt);
  }
}

function applyToQuery(qc: QueryClient, queryKey: readonly unknown[], hash: string, order: "append" | "prepend", evt: OrchestrationEvent): void {
  const q = qc.getQueryCache().find({ queryKey, exact: true });
  if (!q || q.state.data === undefined) return;
  if (q.state.fetchStatus === "fetching") {
    queueUntilSettled(qc, queryKey, hash, order, evt);
    return;
  }
  qc.setQueryData<OrchestrationEvent[]>(queryKey, (prev) => (prev ? applyEventToList(prev, evt, order) : prev));
}

type Waiter = { frames: { order: "append" | "prepend"; evt: OrchestrationEvent }[]; unsubscribe: () => void };
const waiters = new WeakMap<QueryClient, Map<string, Waiter>>();

function queueUntilSettled(qc: QueryClient, queryKey: readonly unknown[], hash: string, order: "append" | "prepend", evt: OrchestrationEvent): void {
  let byHash = waiters.get(qc);
  if (!byHash) { byHash = new Map(); waiters.set(qc, byHash); }
  const existing = byHash.get(hash);
  if (existing) { existing.frames.push({ order, evt }); return; }
  const waiter: Waiter = { frames: [{ order, evt }], unsubscribe: () => {} };
  byHash.set(hash, waiter);
  waiter.unsubscribe = qc.getQueryCache().subscribe((ev) => {
    if (ev.query.queryHash !== hash) return;
    if (ev.type === "removed") { waiter.unsubscribe(); byHash!.delete(hash); return; }
    if (ev.type !== "updated" || ev.query.state.fetchStatus === "fetching") return;
    waiter.unsubscribe();
    byHash!.delete(hash);
    // Re-enters per frame: if a refetch started meanwhile it re-queues, otherwise it patches.
    for (const f of waiter.frames) applyToQuery(qc, queryKey, hash, f.order, f.evt);
  });
}

/** Re-read every event list (mounted ones refetch now; unmounted ones are marked stale for their next mount). */
export function invalidateOrchEventQueries(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ predicate: isEventQuery });
}

/**
 * True when any event list's last read FAILED and nothing is re-reading it now. Failure is detected from the
 * query state, never the promise: `invalidateQueries` → `refetchQueries` swallows fetch errors unless
 * `throwOnError` is set, so the promise resolves on a failed resync.
 */
export function hasFailedOrchEventQuery(qc: QueryClient): boolean {
  // ACTIVE queries only: `invalidateQueries` refetches just those, so an unmounted list left in error state
  // would read as failed forever and re-arm the retry on every attempt (a poll by another name).
  return qc.getQueryCache().findAll({ predicate: isEventQuery }).some((q) => q.isActive() && q.state.status === "error" && q.state.fetchStatus === "idle");
}

/**
 * The event feed's seed: re-read every event list, then — like the session/status seeds — retry on the
 * shared stoppable ladder while any list is still in error state. `isCurrent` voids a resync a later
 * close/open (or disposal) superseded; `onSettled` runs after each attempt (the provider replays its buffer
 * there); `again` is what a retry re-enters (the provider's own start step, which re-arms its buffer).
 */
export function resyncOrchEvents(
  qc: QueryClient,
  deps: { retry: { schedule: (fn: () => void) => void; reset: () => void; stopped: () => boolean }; isCurrent: () => boolean; onSettled: () => void; again: () => void },
): void {
  invalidateOrchEventQueries(qc)
    .catch(() => {})
    .finally(() => {
      if (!deps.isCurrent()) return;
      deps.onSettled();
      if (hasFailedOrchEventQuery(qc)) { if (!deps.retry.stopped()) deps.retry.schedule(deps.again); }
      else deps.retry.reset();
    });
}
