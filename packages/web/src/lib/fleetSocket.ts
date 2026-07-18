// Pure reducer for the `/ws/fleet` session delta-push feed (C4 of the WS delta-push umbrella 1efde4ba).
// Kept JSX/browser-free so it's unit-testable without a socket or DOM — FleetSocketProvider.tsx is the
// only runtime consumer, applying it to the shared ["allSessions"] react-query cache on every inbound
// ServerFleetMessage. Mirrors listAllSessions' `ORDER BY s.last_activity DESC` so patched consumers never
// see rows jump relative to what a fresh REST fetch would have returned.
import type { ServerFleetMessage, SessionListItem } from "@loom/shared";

/**
 * Applies one `ServerFleetMessage` to a cached `SessionListItem[]`, returning a NEW array (never mutates
 * `sessions`). `session:upsert` replaces the row with a matching `id` or inserts it, then re-sorts by
 * `lastActivity` DESC; `session:remove` drops the row by `id` (a no-op, same-reference return, if the id
 * isn't present). Any other message kind (`hello`, `status`, `event`) is ignored — events are a later card.
 */
export function applyFleetDelta(sessions: SessionListItem[], msg: ServerFleetMessage): SessionListItem[] {
  if (msg.t === "session:upsert") {
    const idx = sessions.findIndex((s) => s.id === msg.session.id);
    const next = idx === -1 ? [...sessions, msg.session] : sessions.map((s, i) => (i === idx ? msg.session : s));
    return sortByLastActivityDesc(next);
  }
  if (msg.t === "session:remove") {
    if (!sessions.some((s) => s.id === msg.id)) return sessions;
    return sessions.filter((s) => s.id !== msg.id);
  }
  return sessions;
}

function sortByLastActivityDesc(sessions: SessionListItem[]): SessionListItem[] {
  return [...sessions].sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0));
}
