import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerFleetMessage, SessionListItem } from "@loom/shared";
import { api, orchStatusQuery } from "../lib/api";
import { applyFleetDelta } from "../lib/fleetSocket";
import { noteRemoteSocketRefusal, socketAuth } from "../lib/gatewayCredential";
import { createReconnectBackoff, createRefusalEpisode, createRetryLoop, handleSocketClose } from "../lib/socketReconnect";
import { useCredentialReattachNonce } from "../lib/useCredentialReattach";

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
  // Card a6d7bf36 — the RE-ATTACH signal, in this effect's deps so an unlock tears the whole lifecycle
  // down and rebuilds it: a fresh socket, fresh seed loops, a fresh backoff. That is what revives this
  // feed after a TERMINAL close (card f8d2684d made the reconnect permanent-stop, so before this a
  // pasted token left the page on its 10s polling fallback until the user reloaded), and what makes the
  // bounded ladder below safe to add.
  const reattachNonce = useCredentialReattachNonce();

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackPollTimer: ReturnType<typeof setInterval> | undefined;
    const backoff = createReconnectBackoff();
    // Each seed owns a STOPPABLE retry loop on the same capped ladder as the reconnect, not a bare 1s
    // setTimeout: a seed that is failing because the credential just died fails identically forever, and
    // the terminal-close branch below stops both for good — see the decision note on that branch.
    const seedRetry = createRetryLoop();
    const statusSeedRetry = createRetryLoop();
    const stopSeedRetries = () => { seedRetry.stop(); statusSeedRetry.stop(); };
    // Card a6d7bf36 — the ONE held-credential probe this run of failures is allowed. A remote page whose
    // gateway token has died never gets a 1008 here either (the upgrade 401s, so there is no socket to
    // close and the browser reports a bare 1006), so this socket's own reconnect would otherwise retry a
    // guaranteed 401 forever at the 10s cap, spending the trusted proxy's shared failed-auth budget.
    const refusalEpisode = createRefusalEpisode();
    let retriesStopped = false;
    // Card 97dd97e5 — scoped to the whole effect, not one `connect()`: once any attempt has opened, a
    // later close is an ordinary disconnect, never a missing credential. Mirrors CompanionChat's own
    // `everOpened` (card 093981dd/d56b12d8).
    let everOpened = false;
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
          seedRetry.reset();
          qc.setQueryData<SessionListItem[]>(["allSessions"], replayed);
          log(`seeded ${replayed.length} session(s)`);
        })
        .catch((err) => {
          if (disposed || seedRetry.stopped()) return;
          log("seed fetch failed, retrying", err);
          seedRetry.schedule(seed);
        });
    };

    // Cold-load seed + reconnect resync for the status feed. The server sends only `hello` on connect (no
    // opening `status` frame — see gateway/server.ts's /ws/fleet handler), and a reconnect can follow an
    // arbitrary gap, so this HTTP read is what makes a change-ONLY feed complete. It stays precisely
    // because it is not a poll: it fires once per (re)connect, never on a timer.
    //
    // @decision sha:a1a89b72 — goes through the SHARED react-query factory (fetchQuery), never a direct
    // endpoint call, so a cold load costs ONE request instead of two; calling the endpoint directly can't
    // dedupe with the consumers' own mount fetch.
    //
    // What actually makes it deterministic is the factory's staleTime covering the other order; see
    // ORCH_STATUS_STALE_MS in lib/api.ts for the measurement and the forced-inversion control behind that
    // claim.
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
          statusSeedRetry.reset();
          // fetchQuery has already written `s` into the shared entry, so a frame that won mid-flight has
          // to be put BACK on top of it rather than merely left alone.
          const won = statusDeltaDuringSeed;
          statusDeltaDuringSeed = null;
          if (won) { log("status seed superseded by a live delta, restoring the delta"); writeStatus(won); return; }
          log(`seeded status (${s.pausedScopes.length} paused scope(s))`);
        })
        .catch((err) => {
          if (disposed || statusSeedRetry.stopped()) return;
          log("status seed fetch failed, retrying", err);
          // Retry forces a real read: a failed seed means nothing trustworthy landed in the shared entry.
          statusSeedRetry.schedule(() => seedStatus(true));
        });
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      // Card 4cbbc343: behind a trusted reverse proxy /ws/fleet needs the gateway token (double-subprotocol); loopback unchanged.
      const auth = socketAuth("fleet", null);
      const socket = auth.protocols ? new WebSocket(`${proto}//${location.host}/ws/fleet`, auth.protocols) : new WebSocket(`${proto}//${location.host}/ws/fleet`);
      ws = socket;

      socket.onopen = () => {
        if (disposed) return;
        everOpened = true;
        backoff.reset();
        refusalEpisode.reset(); // this run of failures is over; a later one gets its own probe
        stopFallbackPoll();
        // @decision 04314fbc round 2 — disarm, never stop: a retry armed by a failure from BEFORE this
        // drop (the seed fetch, independent of the socket) must not fire later and run a second,
        // concurrent seed under the fresh one below. The loop still has to work on a LATER failure.
        seedRetry.disarm();
        statusSeedRetry.disarm();
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
      socket.onclose = (e) => {
        if (disposed) return;
        ws = null;
        seeding = false;
        buffered = [];
        statusSeeding = false;
        statusDeltaDuringSeed = null;
        // Card f8d2684d: a 1008 close is TERMINAL — classified FIRST (shared policy, lib/socketReconnect).
        //
        // @decision 04314fbc — a terminal close must also stop the two SEED retry loops, not only the
        // reconnect: a seed in flight when the credential died 401s, and an unstopped loop then retries
        // that guaranteed 401 at 1 Hz forever behind an already-raised banner.
        //
        // What deliberately KEEPS running is the 10s fallback poll: that is this provider's existing
        // disconnected behaviour, and its own 401 is what holds the gateway banner up. The two are not
        // the same trade — the fallback is one bounded request per 10s per feed, where the seed loops
        // together ran at ~120/min and drained the trusted-proxy listener's ONE shared failed-auth
        // bucket (PROXY_FAILED_AUTH_PER_MIN), 429ing unrelated remote callers.
        // `banner` is false for a per-socket policy refusal (today unreachable on /ws/fleet, but the
        // `refused` branch must still be supplied — see handleSocketClose's contract): that close is not
        // a credential change, so there is no gateway banner to point at.
        const terminal = (what: string, banner: boolean) => {
          stopSeedRetries();
          log(`disconnected by policy (${what}) — not reconnecting, seed retries stopped` + (banner ? "; see the gateway banner" : ""));
          startFallbackPoll();
        };
        /**
         * Card a6d7bf36 — the held credential came back REFUSED from the episode probe, so this socket's
         * handshake will 401 identically forever. Same disposition as a 1008 terminal close, reached by a
         * different route: stop reconnecting and stop the seed loops, but KEEP the fallback poll (its own
         * 401 is what holds the gateway banner up — the trade card 04314fbc already settled above).
         *
         * Safe to stop only because the probe raised the gateway lock, whose CLEARING bumps the re-attach
         * nonce in this provider's deps and rebuilds the whole lifecycle.
         */
        const stopForRefusal = () => {
          if (disposed || retriesStopped) return;
          retriesStopped = true;
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
          stopSeedRetries();
          log("the gateway token this browser holds was refused — not reconnecting; see the gateway banner");
          startFallbackPoll();
        };
        /**
         * Card 97dd97e5 — a REMOTE origin holding NO gateway token at all. `noteRemoteSocketRefusal`
         * has just raised the lock, and there is nothing to probe: with no credential the upgrade can
         * only ever 401, so this is terminal on the first never-opened close rather than after an
         * episode's worth of asking (mirrors CompanionChat's `stopForNoToken`, card d56b12d8).
         *
         * Safe to stop for the same reason `stopForRefusal` is: the gateway lock it just raised puts the
         * banner's paste field on screen, and that lock's CLEARING bumps `reattachNonce` in this
         * provider's deps and rebuilds the whole lifecycle.
         */
        const stopForNoToken = () => {
          if (disposed || retriesStopped) return;
          retriesStopped = true;
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
          stopSeedRetries();
          log("no gateway token held by this browser — not reconnecting; see the gateway banner");
          startFallbackPoll();
        };
        handleSocketClose(e, {
          retry: () => {
            if (retriesStopped) { startFallbackPoll(); return; }
            log("disconnected — falling back to polling and reconnecting");
            startFallbackPoll();
            // Card 97dd97e5 — the token-LESS arm must run before the probe is ever asked: with no
            // credential held there is nothing for `refusalEpisode.check` to learn (a token-less probe
            // settles as `"none"`), and asking anyway just re-arms this ladder forever at the 10s cap.
            if (noteRemoteSocketRefusal(everOpened)) { stopForNoToken(); return; }
            refusalEpisode.check(stopForRefusal);
            reconnectTimer = setTimeout(connect, backoff.next());
          },
          tokenDead: (change) => terminal(`gateway token ${change}`, true),
          refused: (reason) => terminal(reason || "close 1008", false),
        });
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
      stopSeedRetries();
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
  }, [qc, reattachNonce]);

  return null;
}
