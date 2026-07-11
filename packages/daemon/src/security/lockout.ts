/**
 * A generic sliding-window failed-attempt lockout — the shared primitive behind BOTH the companion
 * DM-pairing rate-limit (companion/pairing.ts + db.ts's `companion_pairing_attempts`, keyed on
 * (channel, senderId)) and the access-story remote-gateway auth-failure lockout (Phase C, card 6bc02f50 —
 * gateway/remote-rate-limit.ts + db.ts's `gateway_auth_attempts`, keyed on ip). Pure + db/fs-free so both
 * call sites share the SAME algorithm (generalized, not forked) and it's unit-testable without SQLite.
 */

export interface LockoutState {
  attempts: number;
  windowStart: number;
  lockedUntil: number | null;
}

export interface LockoutPolicy {
  /** Failed attempts within `windowMs` that trigger a lockout. */
  maxAttempts: number;
  /** The sliding window for counting failed attempts (ms). */
  windowMs: number;
  /** How long a lockout lasts once triggered (ms). */
  lockoutMs: number;
}

/** Is `state` currently locked out at `nowMs`? An absent state is never locked. */
export function isLockedOut(state: LockoutState | undefined, nowMs: number): boolean {
  return state?.lockedUntil != null && nowMs < state.lockedUntil;
}

/**
 * Compute the NEXT state after one more failure. A window that has elapsed (or an expired lock) resets to
 * strike 1; otherwise the strike count carries forward. Locks out once `attempts` reaches
 * `policy.maxAttempts`. Pure — the caller persists the returned state (db.ts's recordPairingFailure /
 * recordGatewayAuthFailure both just INSERT-OR-UPDATE this value).
 */
export function computeFailureUpdate(existing: LockoutState | undefined, nowMs: number, policy: LockoutPolicy): LockoutState {
  const lockedUntil = existing?.lockedUntil ?? null;
  const windowStartPrev = existing?.windowStart;
  let attempts: number;
  let windowStart: number;
  if (!existing || (lockedUntil != null && nowMs >= lockedUntil) || (windowStartPrev != null && nowMs - windowStartPrev > policy.windowMs)) {
    attempts = 1; windowStart = nowMs; // fresh window (first strike, expired lock, or elapsed window)
  } else {
    attempts = existing.attempts + 1; windowStart = windowStartPrev ?? nowMs;
  }
  const newLockedUntil = attempts >= policy.maxAttempts ? nowMs + policy.lockoutMs : null;
  return { attempts, windowStart, lockedUntil: newLockedUntil };
}
