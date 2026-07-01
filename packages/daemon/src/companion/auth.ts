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
 *                   chatId) match already proves the single owner; authorize. (An explicitly-allowlisted
 *                   sender is also accepted, for a future pairing-granted DM.) UNCHANGED single-owner path.
 *   • GROUP scope — a shared chat. REQUIRE an identified `sender.id` that is on this binding's per-binding
 *                   allowlist. A MISSING sender = HARD REJECT (an unidentifiable speaker in a shared chat
 *                   can never be authorized); an identified-but-unlisted member = REJECT.
 */
import type { SessionBinding } from "./types.js";

/** The injected sender-authorization decision (pure; no db knowledge in the gateway). */
export interface CompanionAuth {
  /** True iff `sender` may drive `binding`'s companion session (see the scope rules above). */
  isSenderAuthorized(binding: SessionBinding, sender?: { id?: string }): boolean;
}

/** The narrow db surface the db-backed impl needs — the per-binding group allowlist existence check. */
export interface AllowlistReader {
  isSenderAllowed(sessionId: string, channel: string, senderId: string): boolean;
}

/**
 * The DEFAULT auth (used when the ChatGateway is constructed without one — keeps existing/test
 * `new ChatGateway(submit, [...])` constructions green): authorizes a DM binding (the single-owner
 * route-match path) and REJECTS any group binding (no allowlist to consult ⇒ can't identify a
 * shared-chat speaker ⇒ deny). The safe, db-free default.
 */
export function allowIfDmMatch(): CompanionAuth {
  return {
    isSenderAuthorized(binding) {
      return binding.scope !== "group";
    },
  };
}

/**
 * The production db-backed auth: DM binding ⇒ authorized (single owner); GROUP binding ⇒ authorized only
 * when an identified `sender.id` is on the binding's per-binding allowlist (`db.isSenderAllowed`). A
 * missing sender on a group binding is rejected before the db is even consulted.
 */
export function createDbCompanionAuth(db: AllowlistReader): CompanionAuth {
  return {
    isSenderAuthorized(binding, sender) {
      if (binding.scope !== "group") return true; // DM / single-owner: route match is the proof.
      const senderId = sender?.id;
      if (!senderId) return false;                 // group + no identifiable speaker ⇒ HARD reject.
      return db.isSenderAllowed(binding.sessionId, binding.channel, senderId);
    },
  };
}
