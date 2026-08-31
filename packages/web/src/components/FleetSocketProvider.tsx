import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerFleetMessage, SessionListItem } from "@loom/shared";
import { api, orchStatusQuery } from "../lib/api";
import { applyFleetDelta } from "../lib/fleetSocket";

/**
 * C4 of the WS delta-push umbrella (1efde4ba) — the payoff card. Owns ONE app-wide `/ws/fleet` socket
 * (mounted once at the root, beside QueryClientProvider — see main.tsx) that keeps the shared
 * `["allSessions"]` react-query cache live, replacing what used to be ~14 per-page `refetchInterval`
 * polls of `GET /api/sessions`.
 *
 * C6 adds the SECOND feed to this SAME socket (never a second socket, never a second provider): the
 * orchestration-`status` change-feed C5 emits on every `OrchestrationControl.pause()/resume()`, which
 * replaces the `/api/orchestration/status` polls that used to run at 2s (MissionControl) and 4s
 * (Sidebar). Both feeds share one connection, one seed-on-(re)connect step, and one disconnected-only
 * fallback timer — so "connected implies nothing polls" is a property of the lifecycle itself rather
 * than of two independent things that have to stay in agreement.
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

/**
 * The `status` payload, DERIVED from the wire union rather than restated — so if C5's message shape ever
 * changes, this fails at compile time instead of silently writing a stale shape into the cache. It is
 * structurally identical to what `GET /api/orchestration/status` (api.orchestrationStatus) returns, which
 * is what makes the socket delta and the HTTP seed interchangeable writers of the same cache.
 */
type OrchestrationStatus = Omit<Extract<ServerFleetMessage, { t: "status" }>, "t">;

/**
 * The ONE cache key holding the `/api/orchestration/status` payload, taken from the shared
 * `orchStatusQuery` factory rather than restated here — so this feed and its three consumers (Sidebar,
 * MissionControl, Schedules) structurally cannot drift on it.
 *
 * C6 shipped with TWO keys here (`["orchStatus"]` and Schedules' own `["orchestrationStatus"]`) and wrote
 * both, because unifying them touched a consumer and belonged in its own change. That change is
 * d90b30d8: all three now spread the factory, so the second write had nothing left to reach and is gone.
 */
const ORCH_STATUS_QUERY_KEY = orchStatusQuery().queryKey;

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
    let statusSeedRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackPollTimer: ReturnType<typeof setInterval> | undefined;
    let backoff = RECONNECT_MIN_MS;
    // While a seed fetch is in flight, inbound deltas are buffered (in wire order) instead of patching the
    // cache directly, then replayed onto the seed once it lands — see the seed() comment below.
    let seeding = false;
    let buffered: ServerFleetMessage[] = [];
    // The status feed carries a FULL SNAPSHOT per message, not a delta, so it needs no replay buffer — but
    // it still has the seed race, in the opposite direction: a `status` frame that lands while the seed
    // fetch is in flight is NEWER than the response that fetch will return (an HTTP read reflects state at
    // request time). Applying the seed on top would silently revert the UI to the pre-mutation state and
    // leave it wrong until the NEXT pause/resume. So we hold on to the frame that won and put it back.
    //
    // It holds the FRAME, not a boolean, because the seed's cache write is now react-query's rather than
    // ours: by the time seedStatus's promise resolves the older response has ALREADY been committed, so
    // "discard the stale seed" means re-writing the winning frame, not skipping a write of our own.
    let statusSeeding = false;
    let statusDeltaDuringSeed: OrchestrationStatus | null = null;
    // False until the socket has opened once. The FIRST seed may share the consumers' own cold-load fetch
    // (see seedStatus); every seed after a DROP must be a real HTTP read.
    let reconnecting = false;

    const writeStatus = (s: OrchestrationStatus) => {
      qc.setQueryData<OrchestrationStatus>(ORCH_STATUS_QUERY_KEY, s);
    };

    const stopFallbackPoll = () => {
      if (fallbackPollTimer) { clearInterval(fallbackPollTimer); fallbackPollTimer = undefined; }
    };
    const startFallbackPoll = () => {
      if (fallbackPollTimer || disposed) return;
      log("fallback: slow-polling /api/sessions + /api/orchestration/status while disconnected");
      // ONE timer drives BOTH feeds' fallback, so the status fallback structurally cannot outlive the
      // session one: stopFallbackPoll() on open kills both, or neither. A second timer here would be the
      // exact regression this card exists to prevent — a fallback still polling while connected silently
      // re-adds the load, and every screen still looks correct.
      fallbackPollTimer = setInterval(() => {
        api.allSessions()
          .then((rows) => { if (!disposed) qc.setQueryData<SessionListItem[]>(["allSessions"], rows); })
          .catch((err) => log("fallback poll failed, will retry", err));
        api.orchestrationStatus()
          .then((s) => { if (!disposed) writeStatus(s); })
          .catch((err) => log("status fallback poll failed, will retry", err));
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

    // Cold-load seed + reconnect resync for the status feed. The server sends only `hello` on connect (no
    // opening `status` frame — see gateway/server.ts's /ws/fleet handler), and a reconnect can follow an
    // arbitrary gap, so this HTTP read is what makes a change-ONLY feed complete. It stays precisely
    // because it is not a poll: it fires once per (re)connect, never on a timer.
    //
    // It goes through the SHARED react-query entry (fetchQuery on the factory) rather than calling the
    // endpoint directly, and that is what makes the COLD load cost one request instead of two — measured
    // on the C6 spec, cold-load `seed` 2 -> 1. Calling the endpoint directly, as this used to, is a fetch
    // site OUTSIDE react-query and so can never dedupe with the consumers, however the keys are arranged.
    //
    // Two mechanisms can do the collapse, and it is worth knowing which: locally the socket opens while the
    // consumers' mount fetch is still IN FLIGHT (so react-query hands back that promise), but only by
    // 0.9-9.6ms measured — a race, not an ordering guarantee. What actually makes it deterministic is the
    // factory's staleTime covering the other order; see ORCH_STATUS_STALE_MS in lib/api.ts for the
    // measurement and the forced-inversion control behind that claim.
    //
    // `force` (every seed after a DROP) overrides that staleTime to 0. A reconnect can follow an arbitrary
    // gap, so a cached value is exactly what must not be trusted there — and there is no concurrent mount
    // fetch to share at that point anyway, since no consumer remounts on a reconnect.
    const seedStatus = (force: boolean) => {
      statusSeeding = true;
      statusDeltaDuringSeed = null;
      // `retry: false` preserves this seed's original failure shape — fail fast, then the bounded retry
      // below — instead of stacking react-query's default 3 internal retries underneath it.
      qc.fetchQuery({ ...orchStatusQuery(), retry: false, ...(force ? { staleTime: 0 } : {}) })
        .then((s) => {
          if (disposed) return;
          statusSeeding = false;
          // fetchQuery has already written `s` into the shared entry, so a frame that won mid-flight has
          // to be put BACK on top of it rather than merely left alone.
          const won = statusDeltaDuringSeed;
          statusDeltaDuringSeed = null;
          if (won) { log("status seed superseded by a live delta, restoring the delta"); writeStatus(won); return; }
          log(`seeded status (${s.pausedScopes.length} paused scope(s))`);
        })
        .catch((err) => {
          if (disposed) return;
          log("status seed fetch failed, retrying", err);
          // Retry forces a real read: a failed seed means nothing trustworthy landed in the shared entry.
          statusSeedRetryTimer = setTimeout(() => seedStatus(true), RECONNECT_MIN_MS);
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
        seedStatus(reconnecting);
        reconnecting = true;
      };
      socket.onmessage = (e) => {
        if (disposed || typeof e.data !== "string") return;
        let msg: ServerFleetMessage;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === "status") {
          // Full snapshot — applied directly, no reducer and no replay buffer. If the seed is still in
          // flight, keep this frame so the older seed response gets overwritten by it again once it lands
          // (react-query commits that response itself — see seedStatus).
          const frame = { pausedScopes: msg.pausedScopes, schedulerEnabled: msg.schedulerEnabled };
          if (statusSeeding) statusDeltaDuringSeed = frame;
          writeStatus(frame);
          return;
        }
        if (msg.t !== "session:upsert" && msg.t !== "session:remove") return; // hello / event (event is C7)
        if (seeding) { buffered.push(msg); return; }
        qc.setQueryData<SessionListItem[]>(["allSessions"], (prev) => applyFleetDelta(prev ?? [], msg));
      };
      socket.onclose = () => {
        if (disposed) return;
        ws = null;
        seeding = false;
        buffered = [];
        statusSeeding = false;
        statusDeltaDuringSeed = null;
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
      clearTimeout(statusSeedRetryTimer);
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
