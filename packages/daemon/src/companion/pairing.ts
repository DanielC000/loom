/**
 * Loom Companion — the DM-PAIRING coordinator (SECURITY-CRITICAL enrollment over the authz layer).
 *
 * An owner-minted, single-use, short-TTL code lets a NEW chat/sender enroll into the EXISTING binding /
 * allowlist records without hand-entering numeric ids. This module is the thin decision seam the
 * ChatGateway calls at its two would-reject points; it is injected the same way CompanionAuth is, so the
 * gateway stays db-UNAWARE and tests can supply a fake or the no-op.
 *
 * SECURITY invariants (mirrored from the card):
 *   • The bound id ALWAYS comes from the AUTHENTICATED inbound metadata (channel/chatId/sender.id) — a
 *     redeemer can only ever enroll their OWN identity, never a body-supplied one.
 *   • The code text NEVER reaches submitTurn: redemption returns on BOTH success and failure; only a body
 *     that is NOT code-shaped falls through to the normal reject.
 *   • No pairing oracle: every failure (wrong/expired/consumed/locked-out/mismatch) is the SAME silent
 *     reject as any unallowlisted inbound — the gateway maps it to `chat-not-allowlisted` /
 *     `sender-not-authorized`, never "bad code".
 *   • Rate-limit / lockout is keyed per (channel, sender.id); while locked the store rejects without even
 *     loading a code. The atomic grant+consume (and the counter mutations) all live in the db txn.
 *   • A `dm-bind` grant requires the inbound's `chatIsDirect === true` (card db49891d) — a `dm` binding
 *     authorizes by route-match ALONE (auth.ts), so redeeming one from a group/supergroup chat would admit
 *     every member of that chat as the session's single owner. `false` or omitted (a channel that can't
 *     report chat type) fails CLOSED, same no-oracle reject as any other invalid attempt.
 */
import type { SessionBinding } from "./types.js";
import { isConfirmedDirectChat } from "./types.js";
import type { PairingRedeemResult } from "../db.js";
import { parsePairingCode } from "../keys/hash.js";

export type PairingGrantType = "dm-bind" | "group-sender";

/** One redemption attempt, built from an inbound message's AUTHENTICATED metadata + its body. */
export interface RedeemAttempt {
  /** Which grant this call-site is trying to redeem (the no-binding path → dm-bind; the sender-not-
   *  authorized path → group-sender). */
  grantType: PairingGrantType;
  channel: string;
  chatId: string;
  /** The authenticated sender id (Telegram from.id). Absent ⇒ nothing to bind/key ⇒ not redeemable. */
  senderId?: string;
  /** The raw message body — parsed ONLY as a pairing code (id+secret); never used as an identity source. */
  body: string;
  /** The inbound's own InboundMessage.chatIsDirect (types.ts) — only an explicit `true` (the channel
   *  CONFIRMS a private 1:1 chat) makes a `dm-bind` attempt eligible; `false` or omitted refuses (see
   *  the grantType==="dm-bind" gate below). Irrelevant to `group-sender` (already scoped to an existing
   *  group binding). */
  chatIsDirect?: boolean;
  /** The session the code's own `session_id` MUST equal, when supplied (card 98ac6687) — the db layer
   *  checks this for EITHER grant type whenever it's present, skipping the check only when omitted. For
   *  group-sender: the matched EXISTING group binding's session id (a code for session A must not grant
   *  into group B). For dm-bind (no existing binding yet): the REDEEMING GATEWAY's own session id (a code
   *  minted for session A must not bind session A into a DIFFERENT companion's chat). */
  bindingSessionId?: string;
}

/** The coordinator's decision. `not-a-code` ⇒ the gateway continues to its normal reject; `rejected` ⇒
 *  the same silent reject (a code WAS shaped but did not redeem); the success variants carry what the
 *  gateway needs to live-sync + ack. */
export type RedeemResult =
  | { outcome: "not-a-code" }
  | { outcome: "rejected" }
  | { outcome: "bound"; binding: SessionBinding }
  | { outcome: "sender-added"; sessionId: string };

/** The pure decision surface injected into the ChatGateway (mirrors CompanionAuth). */
export interface CompanionPairing {
  redeem(attempt: RedeemAttempt): RedeemResult;
}

/** The narrow db surface the db-backed coordinator needs (the atomic redemption txn). */
export interface PairingStore {
  redeemPairingCode(input: {
    codeId: string; secret: string; channel: string; senderId: string; chatId: string;
    expectedGrantType: PairingGrantType; bindingSessionId?: string;
    maxAttempts: number; windowMs: number; lockoutMs: number;
  }, nowMs: number): PairingRedeemResult;
}

/** Rate-limit / lockout + clock policy for the db-backed coordinator (all overridable for tests). */
export interface PairingPolicy {
  /** Injectable clock (epoch ms) — TTL + lockout are advanced by a fake clock in tests, no sleeps. */
  now: () => number;
  /** Failed attempts within `windowMs` that trigger a lockout. Default 5. */
  maxAttempts?: number;
  /** The sliding window for counting failed attempts (ms). Default 10 min. */
  windowMs?: number;
  /** How long a lockout lasts once triggered (ms). Default 15 min. */
  lockoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_LOCKOUT_MS = 15 * 60_000;

/**
 * The no-op pairing used when the ChatGateway is constructed WITHOUT one (keeps every existing
 * construction byte-identical — no redemption ever fires; every body is `not-a-code` and falls straight
 * through to the normal reject).
 */
export function noPairing(): CompanionPairing {
  return { redeem: () => ({ outcome: "not-a-code" }) };
}

/**
 * The production db-backed coordinator. Parses the body as a pairing code (cheap prefix check — a
 * non-code body never touches the db, so it can't be rate-limited by ordinary chatter), then delegates the
 * whole atomic verify+grant+consume+rate-limit to `db.redeemPairingCode`.
 */
export function createDbCompanionPairing(db: PairingStore, policy: PairingPolicy): CompanionPairing {
  const now = policy.now;
  const maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = policy.windowMs ?? DEFAULT_WINDOW_MS;
  const lockoutMs = policy.lockoutMs ?? DEFAULT_LOCKOUT_MS;
  return {
    redeem(a) {
      // No authenticated sender ⇒ no id to bind or to key the rate-limit on ⇒ not redeemable. Fall through.
      if (!a.senderId) return { outcome: "not-a-code" };
      // SECURITY (card db49891d): a dm-bind grant must never be minted from a chat the channel hasn't
      // CONFIRMED private — a `dm` binding authorizes by route-match alone, so binding a group/supergroup
      // chat as "dm" would admit every member as the session's single owner. `isConfirmedDirectChat`
      // requires an explicit `true`; `false` or omitted (unknown) fails CLOSED, same as the no-sender case
      // above — the store is never even touched, so this can't be rate-limited or probed like a real
      // wrong-code guess. Shared verbatim with auth.ts's dm-scope authorization gate (card b4f124d8) so
      // the write side (mint) and read side (authorize) can't drift apart on what counts as "confirmed".
      if (a.grantType === "dm-bind" && !isConfirmedDirectChat(a.chatIsDirect)) return { outcome: "not-a-code" };
      // Only a plausibly-a-code body is a redemption candidate — everything else is normal chatter that
      // must NOT touch the pairing store (and so can't consume a rate-limit budget by accident).
      const parsed = parsePairingCode(a.body.trim());
      if (!parsed) return { outcome: "not-a-code" };
      const res = db.redeemPairingCode({
        codeId: parsed.id, secret: parsed.secret,
        channel: a.channel, senderId: a.senderId, chatId: a.chatId,
        expectedGrantType: a.grantType, bindingSessionId: a.bindingSessionId,
        maxAttempts, windowMs, lockoutMs,
      }, now());
      if (res.outcome === "bound") {
        // flaggedNonPrivate threaded through (card 7578dea2) — carried explicitly so the live routing map
        // never has to reason about an omitted field vs. a known value. NOT always false: upsertCompanionBinding
        // now computes it from isLikelyGroupTelegramChatId (card 61e33b99), so a dm-bind redemption whose
        // chatId is a negative Telegram id (e.g. an upstream chatIsDirect misreport) is flagged here too.
        return { outcome: "bound", binding: { sessionId: res.sessionId, channel: res.channel, chatId: res.chatId, scope: res.scope, flaggedNonPrivate: res.flaggedNonPrivate } };
      }
      if (res.outcome === "sender-added") return { outcome: "sender-added", sessionId: res.sessionId };
      return { outcome: "rejected" };
    },
  };
}
