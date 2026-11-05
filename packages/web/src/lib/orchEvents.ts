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
 * (its own mount fetch will read the row). A query that is MID-FETCH is restarted instead of patched: an
 * in-flight response may predate this event, and `setQueryData` would be overwritten by it when it lands —
 * invalidating restarts the read, which then includes the row.
 */
export function applyOrchEvent(qc: QueryClient, evt: OrchestrationEvent): void {
  for (const q of qc.getQueryCache().findAll({ predicate: isEventQuery })) {
    const cls = classifyOrchEventKey(q.queryKey);
    if (!cls) continue;
    if (cls.family === "manager" ? cls.managerId !== evt.managerSessionId : !cls.kinds.includes(evt.kind)) continue;
    if (q.state.data === undefined) continue;
    if (q.state.fetchStatus === "fetching") {
      void qc.invalidateQueries({ queryKey: q.queryKey, exact: true });
      continue;
    }
    qc.setQueryData<OrchestrationEvent[]>(q.queryKey, (prev) => (prev ? applyEventToList(prev, evt, cls.family === "manager" ? "append" : "prepend") : prev));
  }
}

/** Re-read every event list (mounted ones refetch now; unmounted ones are marked stale for their next mount). */
export function invalidateOrchEventQueries(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ predicate: isEventQuery });
}
