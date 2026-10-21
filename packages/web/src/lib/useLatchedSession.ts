import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "./api";

// The live session row for an id, LATCHED to the last one that resolved (card 525c8ad9 review round 2).
//
// `listAllSessions` drops ARCHIVED rows, and a session is archived the moment it exits — which includes
// the moment a successful merge hard-stops the worker whose review you are reading. Without a latch the
// row simply disappears mid-interaction and every surface derived from it re-derives itself from
// nothing: the node's own chrome, the frame's heading, and — worst — which branch a page chooses to
// render, which remounts the surface under it and discards whatever was typed into it.
//
// @decision 525c8ad9 — a review surface must not lose its result banner or a typed note because the
// session it is about ended; latch the row rather than branching on its presence.
//
// ⛔ The latch alone is NOT the answer, and shipping it alone was a bug. A latched row keeps the
// `processState` and `busy` it had when it was last live, so a merged-and-archived worker went on
// claiming to be live: a busy pill that could stick forever, an enabled Stop, and a mounted composer,
// all pointed at a session that had ended. The by-id ARCHIVED lookup below is what resolves a dropped
// row to its REAL state — the same `archivedSessionById` call SessionView already makes for the same
// reason. The latch is now only a transient cover for the window between the two.
//
// Both reads use the SHARED cache entries (["allSessions"], ["archivedSessionById", id]), so wherever
// a page is already making them this costs no extra request.
export function useLatchedSession(sessionId: string): SessionListItem | undefined {
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, enabled: !!sessionId });
  const live = (sessions.data ?? []).find((s) => s.id === sessionId);

  // Only once the live feed has ANSWERED without this row — `!sessions.data` would fire the lookup on
  // every first paint, for a session that is about to resolve as perfectly live.
  const archived = useQuery({
    queryKey: ["archivedSessionById", sessionId], queryFn: () => api.archivedSessionById(sessionId),
    refetchInterval: 15000,
    enabled: !!sessionId && !!sessions.data && !live,
  });

  // Keyed by the id it was latched FOR, so navigating to a different session never shows the previous
  // one's identity while the new row resolves — the latch is per-address, not a global "last seen".
  //
  // Written during render on purpose: the value is derived from the query data this same render read,
  // so the write is idempotent and a discarded render can only re-latch the same row. A state+effect
  // version would instead paint one frame of the UNLATCHED value, which is the exact frame this hook
  // exists to prevent.
  const latched = useRef<{ id: string; row: SessionListItem } | null>(null);
  if (live) latched.current = { id: sessionId, row: live };
  else if (latched.current && latched.current.id !== sessionId) latched.current = null;

  // Precedence is a FRESHNESS order, not a convenience order: the live row, then the row's real
  // archived state, and only then the stale copy — which is served solely to keep the node drawn while
  // the lookup is in flight, and is the one of the three that can be wrong about liveness.
  return live ?? archived.data ?? (latched.current?.id === sessionId ? latched.current.row : undefined);
}
