/**
 * The ONE place that decides whether a closed WebSocket should be retried, and how long to wait before
 * the next attempt. Every live socket in the app (`/ws/term`, `/ws/companion`, `/ws/fleet`) routes its
 * `onclose` through `onSocketClose` below instead of carrying its own copy of the policy.
 *
 * @decision f8d2684d — never retry a 1008 close, and never attribute one to a revoked credential on a
 * reason this file does not recognise.
 *
 * Card 3c205fb5 made the daemon close a gateway token's open sockets with 1008 the moment that token is
 * revoked, paused, rotated or deleted. Two distinct 1008 producers exist and must NOT share one message
 * (`gateway/server.ts`): a gateway token status change (`"gateway token revoked|paused|rotated|deleted"`),
 * where the whole browser's credential is dead and the app-wide banner is the right surface; and a
 * per-socket policy refusal (today `"host shell terminals are loopback-only"`, card 710a34fa), where the
 * credential is fine and only THIS pane is refused. The close REASON is what separates them, so it is
 * matched explicitly rather than inferred from the code alone.
 */
import { noteGatewayTokenRevoked, type GatewayTokenChange } from "./gatewayCredential";

/** Backoff bounds for every socket in the app: first retry after 1s, doubling, capped at 10s. */
export const SOCKET_RECONNECT_MIN_MS = 1000;
export const SOCKET_RECONNECT_MAX_MS = 10000;

/** WebSocket close code 1008 — "policy violation". The only code this app treats as terminal. */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

/** The reasons `GatewayTokenSocketRegistry.closeAll` sends, one per gateway-token status change. */
const GATEWAY_TOKEN_CLOSE_REASON = /^gateway token (revoked|paused|rotated|deleted)$/;

/** What `onSocketClose` tells a client to do next. `retry:false` is terminal — never schedule another attempt. */
export type SocketCloseVerdict =
  /** An ordinary disconnect (daemon restart, laptop sleep, flaky link): keep the existing backoff loop. */
  | { retry: true }
  /** This browser's gateway token is no longer valid. The app-wide banner owns the re-entry; panes just say so. */
  | { retry: false; kind: "gateway-token"; change: GatewayTokenChange }
  /** This ONE socket is refused by a standing policy. `reason` is the daemon's own human-readable text. */
  | { retry: false; kind: "policy"; reason: string };

/**
 * Pure classification of a close event — no state touched, so it is directly unit-testable. Callers want
 * `onSocketClose` instead; this is exported for the test and for a caller that must classify without
 * raising the lock.
 *
 * An unrecognised 1008 falls into the per-socket `policy` class: declining to retry is always right for
 * 1008, while claiming a revoked credential on a reason we do not recognise would be a false alarm.
 */
export function classifySocketClose(event: { code: number; reason?: string }): SocketCloseVerdict {
  if (event.code !== WS_CLOSE_POLICY_VIOLATION) return { retry: true };
  const change = GATEWAY_TOKEN_CLOSE_REASON.exec(event.reason ?? "")?.[1];
  if (change) return { retry: false, kind: "gateway-token", change: change as GatewayTokenChange };
  return { retry: false, kind: "policy", reason: event.reason ?? "" };
}

/**
 * Classify a close AND, for a gateway-token close, raise the app-wide revoked state so the banner (the
 * app's existing re-enter-token surface) appears once for the whole page rather than once per socket.
 * `note` is injectable for the unit test only — production callers pass nothing.
 *
 * Call this FIRST in an `onclose` handler, before any "did it ever open?" credential inference: a 1008
 * arrives on a socket that opened and streamed happily, so those branches would otherwise mis-read it
 * as an ordinary mid-session disconnect.
 */
export function onSocketClose(
  event: { code: number; reason?: string },
  note: (change: GatewayTokenChange) => void = noteGatewayTokenRevoked,
): SocketCloseVerdict {
  const verdict = classifySocketClose(event);
  if (verdict.retry === false && verdict.kind === "gateway-token") note(verdict.change);
  return verdict;
}

/**
 * The capped exponential ladder, as a tiny object so each socket owns its own position in it without
 * also owning the constants. `next()` returns the delay to wait NOW and then doubles; `reset()` is called
 * on a successful open so a long-lived socket that drops later starts over at the minimum.
 */
export function createReconnectBackoff(
  minMs: number = SOCKET_RECONNECT_MIN_MS,
  maxMs: number = SOCKET_RECONNECT_MAX_MS,
): { next: () => number; reset: () => void } {
  let delay = minMs;
  return {
    next: () => {
      const current = delay;
      delay = Math.min(delay * 2, maxMs);
      return current;
    },
    reset: () => { delay = minMs; },
  };
}
