/**
 * The ONE place that decides whether a closed WebSocket should be retried, and how long to wait before
 * the next attempt. Every live socket in the app (`/ws/term`, `/ws/companion`, `/ws/fleet`) routes its
 * `onclose` through `handleSocketClose` below instead of carrying its own copy of the policy.
 *
 * @decision f8d2684d — never retry a 1008 close, and never attribute one to a revoked credential on a
 * reason this file does not recognise.
 *
 * @decision 04314fbc — route every `onclose` through `handleSocketClose` (all three branches supplied, so
 * no call site can collapse the two terminal kinds into one), and stop every retry loop the socket owns
 * on a terminal close, not just the reconnect one.
 *
 * Card 3c205fb5 made the daemon close a gateway token's open sockets with 1008 the moment that token is
 * revoked, paused, rotated or deleted. Two distinct 1008 producers exist and must NOT share one message:
 * a gateway token status change, where the whole browser's credential is dead and the app-wide banner is
 * the right surface; and a per-socket policy refusal (today a host shell asked for by a remote peer, card
 * 710a34fa), where the credential is fine and only THIS pane is refused. The close REASON is what
 * separates them — and both reason forms now come from `@loom/shared`, which the daemon builds its own
 * close with, so the two sides of that contract cannot drift.
 */
import {
  GATEWAY_TOKEN_CLOSE_CHANGES,
  parseGatewayTokenCloseReason,
  WS_CLOSE_POLICY_VIOLATION,
  type GatewayTokenCloseChange,
} from "@loom/shared";
import {
  noteGatewayTokenRevoked, probeHeldGatewayToken,
  type GatewayTokenChange, type HeldGatewayTokenProbe,
} from "./gatewayCredential";

/** Backoff bounds for every socket in the app: first retry after 1s, doubling, capped at 10s. */
export const SOCKET_RECONNECT_MIN_MS = 1000;
export const SOCKET_RECONNECT_MAX_MS = 10000;

/**
 * Re-exported so a socket client needs ONE import for the whole close policy, and so the app's own tests
 * can assert the code without reaching past this module. Both are DEFINED in `@loom/shared`, next to the
 * reason strings, because the daemon is what sends them.
 */
export { WS_CLOSE_POLICY_VIOLATION, GATEWAY_TOKEN_CLOSE_CHANGES };

/** What a close verdict tells a client to do next. `retry:false` is terminal — never schedule anything again. */
export type SocketCloseVerdict =
  /** An ordinary disconnect (daemon restart, laptop sleep, flaky link): keep the existing backoff loop. */
  | { retry: true }
  /** This browser's gateway token is no longer valid. The app-wide banner owns the re-entry; panes just say so. */
  | { retry: false; kind: "gateway-token"; change: GatewayTokenChange }
  /** This ONE socket is refused by a standing policy. `reason` is the daemon's own human-readable text. */
  | { retry: false; kind: "policy"; reason: string };

/**
 * Pure classification of a close event — no state touched, so it is directly unit-testable. Callers want
 * `handleSocketClose` instead; this is exported for the test and for a caller that must classify without
 * raising the lock.
 *
 * An unrecognised 1008 falls into the per-socket `policy` class: declining to retry is always right for
 * 1008, while claiming a revoked credential on a reason we do not recognise would be a false alarm.
 */
export function classifySocketClose(event: { code: number; reason?: string }): SocketCloseVerdict {
  if (event.code !== WS_CLOSE_POLICY_VIOLATION) return { retry: true };
  const change: GatewayTokenCloseChange | null = parseGatewayTokenCloseReason(event.reason);
  if (change) return { retry: false, kind: "gateway-token", change };
  return { retry: false, kind: "policy", reason: event.reason ?? "" };
}

/**
 * Classify a close AND, for a gateway-token close, raise the app-wide revoked state so the banner (the
 * app's existing re-enter-token surface) appears once for the whole page rather than once per socket.
 * `note` is injectable for the unit test only — production callers pass nothing.
 *
 * Prefer `handleSocketClose`: this returns the verdict but leaves the schedule-or-stop decision with the
 * caller, which is how the two terminal kinds came to be collapsed at a call site (card 04314fbc).
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
 * The three mutually-exclusive things a socket client can do about a close. All three are REQUIRED: a
 * caller that only cared about "is it terminal" wrote `if (!onSocketClose(e).retry) { … }` and thereby
 * treated an unrecognised per-socket refusal as a revoked credential (CompanionChat did exactly that).
 * Naming each branch makes that collapse impossible to write by accident.
 */
export interface SocketCloseActions {
  /** Ordinary disconnect: schedule the next attempt (the caller owns its own position in the ladder). */
  retry: () => void;
  /** Terminal, app-wide: this browser's gateway token is dead. The banner owns re-entry; just say so. */
  tokenDead: (change: GatewayTokenChange) => void;
  /** Terminal, this socket only: a standing policy refused it. The credential is fine — no banner. */
  refused: (reason: string) => void;
}

/**
 * Classify a close, raise the app-wide revoked state when that is what happened, and run exactly ONE of
 * the caller's three branches. Returns the verdict too, for a caller that also wants to paint it.
 */
export function handleSocketClose(
  event: { code: number; reason?: string },
  actions: SocketCloseActions,
  note: (change: GatewayTokenChange) => void = noteGatewayTokenRevoked,
): SocketCloseVerdict {
  const verdict = onSocketClose(event, note);
  if (verdict.retry) actions.retry();
  else if (verdict.kind === "gateway-token") actions.tokenDead(verdict.change);
  else actions.refused(verdict.reason);
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

/** A retry loop that holds at most one pending attempt and can be stopped for good. */
export interface RetryLoop {
  /** Arm `attempt` after the next delay on the ladder. A no-op once `stop()` has been called. */
  schedule: (attempt: () => void) => void;
  /** An attempt succeeded — the ladder restarts from the minimum. */
  reset: () => void;
  /**
   * Cancel the pending attempt WITHOUT refusing future ones — unlike `stop()`, this is not permanent.
   * @decision 04314fbc round 2 — `onopen` re-seeds directly; without disarming first, a retry armed by a
   * failure from BEFORE the drop fires later and runs a second, concurrent seed. See socketReconnect.mjs.
   */
  disarm: () => void;
  /** Cancel the pending attempt and refuse every future one. Permanent, by design. */
  stop: () => void;
  /** True once `stop()` has been called. */
  stopped: () => boolean;
  /** The delay the pending attempt was armed with, or `null` when nothing is armed. Diagnostic/test. */
  pendingDelay: () => number | null;
}

/**
 * A retry loop for a repeatable side effect a socket owns BESIDE its own reconnect — today the fleet
 * provider's two seed fetches. It exists because such a loop has to end when the socket's close was
 * TERMINAL: a seed fetch failing because the credential is dead will fail identically forever.
 *
 * @decision 04314fbc — a terminal close must stop every retry loop the socket owns, and such a loop must
 * ride the shared capped ladder; a fixed-interval `setTimeout` that nothing clears is a 1 Hz
 * guaranteed-401 loop that drains the daemon's shared failed-auth budget and 429s other remote callers.
 *
 * Timers are injectable so the unit test drives it without real time; production passes nothing.
 */
export function createRetryLoop(deps: {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  backoff?: { next: () => number; reset: () => void };
} = {}): RetryLoop {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const backoff = deps.backoff ?? createReconnectBackoff();
  let handle: unknown = null;
  let armedDelay: number | null = null;
  let dead = false;
  const disarm = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
    armedDelay = null;
  };
  return {
    schedule: (attempt) => {
      if (dead) return;
      disarm(); // one pending attempt at a time — a second schedule replaces it, never stacks
      const delay = backoff.next();
      armedDelay = delay;
      handle = setTimer(() => { handle = null; armedDelay = null; attempt(); }, delay);
    },
    reset: () => { backoff.reset(); },
    disarm,
    stop: () => { dead = true; disarm(); },
    stopped: () => dead,
    pendingDelay: () => armedDelay,
  };
}

/**
 * How many times ONE refusal episode may re-ask after an `"unknown"` probe. An `unknown` means nothing
 * was learned (the request never landed, or an intermediary answered), so asking again is legitimate —
 * but an unbounded re-ask is itself the loop this whole mechanism exists to bound, and each ask spends
 * the daemon's shared failed-auth budget too. Past the cap the episode gives up on LEARNING and the
 * socket keeps its pre-existing unbounded retry: noisy and self-healing beats locking a live page on a
 * refusal nobody ever observed.
 */
export const REFUSAL_EPISODE_MAX_UNKNOWN = 3;

/**
 * One run of never-opened socket failures — a refusal EPISODE — and the single held-credential probe it
 * is allowed. `check` is called from the close handler on every attempt; at most one probe is ever in
 * flight, and the episode settles as soon as it has an answer worth keeping.
 */
export interface RefusalEpisode {
  /** Ask once for this episode. `onDead` runs iff the daemon REFUSED the credential this browser holds. */
  check: (onDead: () => void) => void;
  /** A socket opened: the episode is over, so the next run of failures gets its own probe. */
  reset: () => void;
  /** True once this episode will ask no more (answered, or out of `unknown` re-asks). Diagnostic/test. */
  settled: () => boolean;
}

/**
 * The bound on a guaranteed-401 reconnect ladder, shared by every socket client that has one.
 *
 * A remote page holding a DEAD gateway token retries an upgrade that can only ever 401, at the 10s cap,
 * for as long as the tab is open — and a rejected WS upgrade spends the trusted proxy's ONE shared
 * `PROXY_FAILED_AUTH_PER_MIN` bucket, so a few mounted panes 429 unrelated remote callers. The close
 * event cannot tell that apart from a restarting daemon (see `probeHeldGatewayToken`), so the episode
 * asks over HTTP, once, and only a real refusal stops the ladder.
 *
 * `probe` is injectable for the unit test only; production callers pass nothing.
 *
 * @decision a6d7bf36 — the stop must be paired with a re-attach path that does not require a page
 * reload (`lib/useCredentialReattach`): capping this loop without one turns "noisy but self-healing"
 * into "silently dead until the user reloads", which is strictly worse than the loop it removes.
 */
export function createRefusalEpisode(
  probe: () => Promise<HeldGatewayTokenProbe> = probeHeldGatewayToken,
  maxUnknown: number = REFUSAL_EPISODE_MAX_UNKNOWN,
): RefusalEpisode {
  let inFlight = false;
  let settled = false;
  let unknowns = 0;
  // The EPISODE's identity. `reset()` ends one run of failures and starts another, but it cannot cancel
  // a probe already in flight — so each `check` captures the generation it asked under and a result from
  // a superseded one is dropped on arrival. Without this fence a probe issued before a successful open
  // lands on the NEW episode: an `invalid` from the dead credential stops a ladder that just worked, and
  // an `unknown`/`valid` silently spends the new episode's one question or settles it unasked.
  let generation = 0;
  return {
    check: (onDead) => {
      if (inFlight || settled) return;
      inFlight = true;
      const asked = generation;
      void probe().then(
        (outcome) => {
          if (asked !== generation) return; // superseded by a reset() while this was in flight
          inFlight = false;
          if (outcome === "invalid") { settled = true; onDead(); return; }
          // "unknown" learned nothing, so the episode may ask again — a bounded number of times.
          if (outcome === "unknown") { unknowns += 1; if (unknowns >= maxUnknown) settled = true; return; }
          settled = true; // "valid" / "none": the credential is not what is wrong, so stop asking
        },
        () => {
          if (asked !== generation) return;
          // The probe swallows its own failures, so a rejection here is unexpected — settle rather than
          // let an unexpectedly-throwing probe become a second unbounded loop.
          inFlight = false;
          settled = true;
        },
      );
    },
    reset: () => { generation += 1; inFlight = false; settled = false; unknowns = 0; },
    settled: () => settled,
  };
}
