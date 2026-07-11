/**
 * Companion Trust Window (Companion Capability & Permission-Lever Framework — Companion→Platform-Lead
 * epic, Card 0). Today every high-risk companion ACT commits ONLY through a per-action `OwnerConfirmStore`
 * round-trip (attestation.ts Primitive C) — every single call. This module replaces that DEFAULT with
 * "verify once, then low friction": an explicit owner checkpoint (a completed Primitive-C confirm) ARMS a
 * session-scoped trust window; while it's WARM, an ordinary act may flow without its own confirm round-trip
 * (the shared friction helper, companion/capabilities.ts, is what actually branches on `isWarm` — this
 * module is just the window itself).
 *
 * Mirrors `OwnerConfirmStore`'s own shape (attestation.ts): module-scoped, one instance per router,
 * IN-MEMORY ONLY (lost on a daemon restart is a FAIL-SAFE — a lost window just forces a fresh re-arm, never
 * a wrongly-extended one) and an INJECTABLE clock (`now`) so TTL/cap are unit-testable with a fake clock —
 * no real waits.
 *
 * State stored is deliberately minimal: `{armedAt, lastActiveAt}` per key — NEVER a secret, NEVER a
 * capability/scope/grant. This gates FRICTION ONLY; it can never widen or substitute for scope enforcement,
 * which stays exactly where it already is (the belt-and-suspenders per-project checks in capabilities.ts).
 */
import type { CompanionRoute } from "@loom/shared";

/** Idle TTL — refreshed by `touch()` on every authorized Tier-A act. A window with no activity for this
 *  long goes cold (isWarm ⇒ false) and the next act must re-arm via a fresh step-up. */
export const TRUST_WINDOW_IDLE_TTL_MS = 15 * 60_000;

/** Absolute cap — the hard maximum lifetime of a window from its `arm()` time, regardless of activity.
 *  Prevents an indefinitely-refreshed window from never re-verifying the owner is still present. */
export const TRUST_WINDOW_ABSOLUTE_CAP_MS = 8 * 60 * 60_000;

/**
 * Identifies ONE trust window. `sessionId` + `route` mirror `OwnerConfirmStore`'s own `proposalKey` keying
 * exactly. `senderId` is the Companion Trust Window's own addition (Framework Card 0): for a GROUP-scope
 * route it is the authenticated sender id of the acting member (mirrors {@link VoicePrefRoute}'s own
 * group-only senderId rule) — REQUIRED there so one group member's arm/confirm can never warm another
 * member's window. For a DM route `senderId` is always omitted/null: the route itself already identifies
 * the single owner, exactly like `OwnerConfirmStore`'s own DM keying needs no sender.
 */
export interface TrustWindowKey {
  sessionId: string;
  route: CompanionRoute | null;
  senderId?: string | null;
}

// ASCII Unit Separator (mirrors voice-prefs.ts's own ROUTE_KEY_SEP) — none of sessionId/channel/chatId/
// senderId can ever contain it, so the joined string key can never collide across distinct identities.
const KEY_SEP = "\x1f";

/** `sessionId` is ALWAYS the key's first segment (see `closeAllForSession`, which relies on this prefix
 *  to bulk-evict every window for a session regardless of its route/sender). */
function windowKey(key: TrustWindowKey): string {
  const routePart = key.route ? `${key.route.channel}:${key.route.chatId}` : "";
  return `${key.sessionId}${KEY_SEP}${routePart}${KEY_SEP}${key.senderId ?? ""}`;
}

function sessionPrefix(sessionId: string): string {
  return `${sessionId}${KEY_SEP}`;
}

interface WindowState {
  armedAt: number;
  lastActiveAt: number;
}

/**
 * The trust-window store. `arm`/`touch`/`isWarm`/`close` are the only mutators — the shared friction helper
 * (companion/capabilities.ts) is the ONLY caller that should ever invoke them from a lever; a lever itself
 * never touches this directly (mirrors how a lever never touches `OwnerConfirmStore` directly either, only
 * through `ctx.attest`).
 */
export class CompanionTrustWindow {
  private readonly windows = new Map<string, WindowState>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Open (or refresh) a window: an explicit owner checkpoint just happened (a completed Primitive-C
   *  confirm). Resets BOTH `armedAt` and `lastActiveAt` to now — a re-arm is a fresh window, not an
   *  extension of the old one, so the absolute cap restarts too. */
  arm(key: TrustWindowKey): void {
    const t = this.now();
    this.windows.set(windowKey(key), { armedAt: t, lastActiveAt: t });
  }

  /** Refresh `lastActiveAt` on an ALREADY-armed window (an ordinary authorized act just flowed through
   *  it) — a no-op if the window doesn't exist (there is nothing to extend; the caller must `arm` first).
   *  Does NOT reset `armedAt` — the absolute cap is measured from the original arm, never pushed out by
   *  activity. */
  touch(key: TrustWindowKey): void {
    const k = windowKey(key);
    const state = this.windows.get(k);
    if (!state) return;
    state.lastActiveAt = this.now();
  }

  /** True iff a window is armed AND within the idle TTL (since `lastActiveAt`) AND within the absolute cap
   *  (since `armedAt`) — false for a window that never existed. An expired window is evicted here
   *  (opportunistic cleanup) so a caller never needs a separate sweep and the map never grows unbounded on
   *  cold windows. */
  isWarm(key: TrustWindowKey): boolean {
    const k = windowKey(key);
    const state = this.windows.get(k);
    if (!state) return false;
    const t = this.now();
    const warm = (t - state.lastActiveAt) <= TRUST_WINDOW_IDLE_TTL_MS && (t - state.armedAt) <= TRUST_WINDOW_ABSOLUTE_CAP_MS;
    if (!warm) this.windows.delete(k);
    return warm;
  }

  /** Revoke ONE window (an owner `/lock`, or the caller already knows the exact route/sender to close). */
  close(key: TrustWindowKey): void {
    this.windows.delete(windowKey(key));
  }

  /** Revoke EVERY window for a session, across every route/sender — the bulk close paths (session
   *  recycle/unbind, a binding/allowlist change, a re-pair) that know only the session id, not which
   *  specific route(s)/sender(s) happen to hold a live window. */
  closeAllForSession(sessionId: string): void {
    const prefix = sessionPrefix(sessionId);
    for (const k of this.windows.keys()) {
      if (k.startsWith(prefix)) this.windows.delete(k);
    }
  }
}
