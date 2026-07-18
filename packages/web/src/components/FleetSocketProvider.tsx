import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerFleetMessage, SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { applyFleetDelta } from "../lib/fleetSocket";

/**
 * C4 of the WS delta-push umbrella (1efde4ba) — the payoff card. Owns ONE app-wide `/ws/fleet` socket
 * (mounted once at the root, beside QueryClientProvider — see main.tsx) that keeps the shared
 * `["allSessions"]` react-query cache live, replacing what used to be ~14 per-page `refetchInterval`
 * polls of `GET /api/sessions`.
 *
 * Lifecycle mirrors CompanionChat's WS discipline (open/close/reconnect with capped exponential backoff),
 * plus two things unique to a shared cache:
 *  - Seed-then-patch: on every (re)connect we re-fetch `GET /api/sessions` as the seed (a WS reconnect can
 *    follow an arbitrary gap, e.g. a laptop sleep) and buffer any deltas that land WHILE that fetch is in
 *    flight, applying them after the seed lands — closes the seed↔first-delta race idempotently.
 *  - Disconnected fallback: while the socket is down, a slow poll keeps the cache from going stale until
 *    the next reconnect's re-seed takes over.
 *
 * Renders nothing — it's a side-effect-only sibling, not a context provider (no consumer reads anything
 * off it directly; they all just `useQuery(["allSessions"])` as before and this keeps that cache warm).
 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const FALLBACK_POLL_MS = 10000;

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.debug("[fleet-ws]", ...args);
}

export function FleetSocketProvider() {
  const qc = useQueryClient();

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let seedRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackPollTimer: ReturnType<typeof setInterval> | undefined;
    let backoff = RECONNECT_MIN_MS;
    // While a seed fetch is in flight, inbound deltas are buffered (in wire order) instead of patching the
    // cache directly, then replayed onto the seed once it lands — see the seed() comment below.
    let seeding = false;
    let buffered: ServerFleetMessage[] = [];

    const stopFallbackPoll = () => {
      if (fallbackPollTimer) { clearInterval(fallbackPollTimer); fallbackPollTimer = undefined; }
    };
    const startFallbackPoll = () => {
      if (fallbackPollTimer || disposed) return;
      log("fallback: slow-polling /api/sessions while disconnected");
      fallbackPollTimer = setInterval(() => {
        api.allSessions()
          .then((rows) => { if (!disposed) qc.setQueryData<SessionListItem[]>(["allSessions"], rows); })
          .catch((err) => log("fallback poll failed, will retry", err));
      }, FALLBACK_POLL_MS);
    };

    // Re-seeds the cache from a fresh REST fetch, buffering any deltas that arrive mid-fetch and replaying
    // them onto the seed once it resolves — so a delta that races the seed is never lost or double-applied
    // (session:upsert/remove are both idempotent replays).
    const seed = () => {
      seeding = true;
      buffered = [];
      api.allSessions()
        .then((rows) => {
          if (disposed) return;
          const replayed = buffered.reduce(applyFleetDelta, rows);
          buffered = [];
          seeding = false;
          qc.setQueryData<SessionListItem[]>(["allSessions"], replayed);
          log(`seeded ${replayed.length} session(s)`);
        })
        .catch((err) => {
          if (disposed) return;
          log("seed fetch failed, retrying", err);
          seedRetryTimer = setTimeout(seed, RECONNECT_MIN_MS);
        });
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${proto}//${location.host}/ws/fleet`);
      ws = socket;

      socket.onopen = () => {
        if (disposed) return;
        backoff = RECONNECT_MIN_MS;
        stopFallbackPoll();
        log("connected");
        seed();
      };
      socket.onmessage = (e) => {
        if (disposed || typeof e.data !== "string") return;
        let msg: ServerFleetMessage;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t !== "session:upsert" && msg.t !== "session:remove") return; // hello/status/event — a later card
        if (seeding) { buffered.push(msg); return; }
        qc.setQueryData<SessionListItem[]>(["allSessions"], (prev) => applyFleetDelta(prev ?? [], msg));
      };
      socket.onclose = () => {
        if (disposed) return;
        ws = null;
        seeding = false;
        buffered = [];
        log("disconnected — falling back to polling and reconnecting");
        startFallbackPoll();
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      };
      // onerror is followed by onclose; let onclose own the fallback/reconnect so we don't double-schedule.
    };

    // Disconnected from the moment the effect starts (the socket hasn't opened yet), so the fallback poll
    // covers the initial handshake window too, not just a later drop.
    startFallbackPoll();
    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(seedRetryTimer);
      stopFallbackPoll();
      const socket = ws;
      ws = null;
      if (socket) {
        if (socket.readyState === socket.CONNECTING) {
          // Don't act on a socket abandoned mid-handshake (a spurious close log otherwise) — detach
          // handlers so no late frame lands on the closing socket.
          socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
        }
        socket.close();
      }
    };
  }, [qc]);

  return null;
}
