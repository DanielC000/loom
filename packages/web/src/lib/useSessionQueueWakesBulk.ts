import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Shared parent-level bulk queue/wakes reads. Overview's ProjectTerminals grid and the Terminals page
// each render one TerminalCard per live session, and every card independently polled its own /queue
// (3s) + /wakes (15s) — 2×N round-trips per poll window (perf profile 2026-07-16 finding #4). ONE bulk
// query per page, keyed by the page's session-id set, replaces that: SessionQueue/SessionWakes read
// pre-fetched data via a prop instead of running their own per-card useQuery when a caller supplies one.
export function useSessionQueuesBulk(ids: string[]) {
  return useQuery({
    queryKey: ["queues-bulk", ids],
    queryFn: () => api.sessionQueuesBulk(ids),
    refetchInterval: 3000,
  });
}

export function useSessionWakesBulk(ids: string[]) {
  return useQuery({
    queryKey: ["wakes-bulk", ids],
    queryFn: () => api.sessionWakesBulk(ids),
    refetchInterval: 15000,
  });
}

// A queue-drawer mutation (delete/edit/reorder) or a wake cancel needs the bulk query re-fetched right
// away rather than waiting out the poll interval — invalidate by KEY PREFIX so it hits every bulk query
// on the page regardless of its exact id-list.
export function useInvalidateSessionQueueWakesBulk() {
  const qc = useQueryClient();
  return {
    invalidateQueues: () => qc.invalidateQueries({ queryKey: ["queues-bulk"] }),
    invalidateWakes: () => qc.invalidateQueries({ queryKey: ["wakes-bulk"] }),
  };
}
