/**
 * Loom Companion — the PER-BINDING SENDER-LEVEL authorization seam (Companion authz layer, Phase 1).
 *
 * The core security decision of the chat loop: given a binding whose (channel, chatId) route already
 * matched an inbound message, is the SPEAKER authorized to drive that companion session? Injected into
 * the ChatGateway as a pure interface (mirrors how SubmitTurn is injected) so the gateway stays
 * db-UNAWARE and tests can supply a fake. The db-backed impl wraps `db.isSenderAllowed(...)`.
 *
 * SECURITY: every inbound chat message is UNTRUSTED DATA / a prompt-injection vector and the companion
 * agent has tool access, so the deny path is load-bearing. The rule is deliberately crisp + fail-safe:
 *   • DM scope    — a private 1:1 chat. A Telegram private chatId IS the user id, so the (channel,
 *                   chatId) match already proves the single owner IFF the inbound's own `chatIsDirect`
 *                   confirms it (card b4f124d8) — see `isConfirmedDirectChat` below. A `dm` binding
 *                   minted BEFORE card db49891d's write-side fix, or hand-bound by a human, could still
 *                   name a group/supergroup chatId; without this check the route match alone would admit
 *                   every member of that chat as the session's single owner.
 *   • GROUP scope — a shared chat. REQUIRE an identified `sender.id` that is on this binding's per-binding
 *                   allowlist. A MISSING sender = HARD REJECT (an unidentifiable speaker in a shared chat
 *                   can never be authorized); an identified-but-unlisted member = REJECT. `chatIsDirect` is
 *                   irrelevant here — a group binding never claims single-owner trust in the first place.
 */
import type { SessionBinding } from "./types.js";
import { isConfirmedDirectChat } from "./types.js";

/** The injected sender-authorization decision (pure; no db knowledge in the gateway). */
export interface CompanionAuth {
  /** True iff `sender` may drive `binding`'s companion session (see the scope rules above).
   *  `chatIsDirect` is the inbound's own InboundMessage.chatIsDirect (types.ts) — REQUIRED for a `dm`
   *  binding to authorize (see `isConfirmedDirectChat`); irrelevant for a `group` binding. */
  isSenderAuthorized(binding: SessionBinding, sender?: { id?: string }, chatIsDirect?: boolean): boolean;
}

/** The narrow db surface the db-backed impl needs — the per-binding group allowlist existence check. */
export interface AllowlistReader {
  isSenderAllowed(sessionId: string, channel: string, senderId: string): boolean;
}

/**
 * The DEFAULT auth (used when the ChatGateway is constructed without one — keeps existing/test
 * `new ChatGateway(submit, [...])` constructions green): authorizes a DM binding whose inbound confirms a
 * private chat (the single-owner route-match path, gated by `isConfirmedDirectChat` — card b4f124d8) and
 * REJECTS any group binding (no allowlist to consult ⇒ can't identify a shared-chat speaker ⇒ deny). The
 * safe, db-free default.
 */
export function allowIfDmMatch(): CompanionAuth {
  return {
    isSenderAuthorized(binding, _sender, chatIsDirect) {
      if (binding.scope === "group") return false;
      return isConfirmedDirectChat(chatIsDirect);
    },
  };
}

/**
 * The production db-backed auth: DM binding ⇒ authorized when the inbound CONFIRMS a private chat
 * (`isConfirmedDirectChat` — card b4f124d8; the route-match-alone shortcut is no longer enough, since a
 * `dm`-scope binding can still name a group/supergroup chatId); GROUP binding ⇒ authorized only when an
 * identified `sender.id` is on the binding's per-binding allowlist (`db.isSenderAllowed`). A missing
 * sender on a group binding is rejected before the db is even consulted.
 */
export function createDbCompanionAuth(db: AllowlistReader): CompanionAuth {
  return {
    isSenderAuthorized(binding, sender, chatIsDirect) {
      if (binding.scope !== "group") return isConfirmedDirectChat(chatIsDirect); // DM: route match + confirmed-private chat.
      const senderId = sender?.id;
      if (!senderId) return false;                 // group + no identifiable speaker ⇒ HARD reject.
      return db.isSenderAllowed(binding.sessionId, binding.channel, senderId);
    },
  };
}
