/**
 * Loom Companion — the channel-adapter CONTRACT + the platform-agnostic normalized message shape.
 *
 * A ChannelAdapter is the ONLY thing that knows a given chat platform's wire format. It normalizes every
 * inbound platform update into an InboundMessage and pushes it to the ChatGateway; and it sends outbound
 * text back to a chat id. New channels (WhatsApp, Slack, …) slot in by implementing this interface — the
 * gateway never learns a platform's shape.
 *
 * Clean-room: the adapter → normalized-message split is modelled on OpenClaw/Hermes' Channel-Adapter
 * normalization pattern (learned, not copied).
 */

/** A non-text payload carried by an inbound update (Phase 1 carries the SHAPE; ingestion is a later card). */
export interface InboundAttachment {
  /** Coarse kind — "photo" | "document" | "audio" | "video" | … (adapter-defined, free-form). */
  type: string;
  /** A fetchable URL or platform file id, when the platform exposes one. */
  url?: string;
  fileName?: string;
  mimeType?: string;
}

/** A platform-agnostic inbound message — every adapter normalizes its wire update into THIS. */
export interface InboundMessage {
  /** The source channel's name — matches the originating ChannelAdapter.name (e.g. "telegram"). */
  channel: string;
  /** The originating chat id, always a string (a numeric platform id is stringified for stable compare). */
  chatId: string;
  /** The message body text (may be empty when the update is attachment-only). */
  body: string;
  /** The sender, when the platform identifies them (all optional — some channels are chat-scoped only). */
  sender?: { id?: string; username?: string; displayName?: string };
  /** Non-text payloads carried by the update. */
  attachments?: InboundAttachment[];
  /** Free-form channel-specific extras (message id, timestamp, reply-to, …) — opaque to the gateway. */
  metadata?: Record<string, unknown>;
}

/** The gateway's inbound entrypoint, handed to each adapter so it can push normalized messages up. */
export type InboundHandler = (msg: InboundMessage) => void;

/**
 * A chat channel — the pluggable transport. The gateway owns a registry of these; each is started/stopped
 * with the daemon. `send` is the OUTBOUND leg (chat_reply → adapter.send); inbound flows the other way,
 * via the InboundHandler the adapter was constructed with.
 */
export interface ChannelAdapter {
  /** Stable channel name — the key in the gateway registry and the `channel` on every InboundMessage. */
  readonly name: string;
  /**
   * The platform's max single-message length in chars, when it has a hard cap (Telegram: 4096). The
   * gateway chunks outbound replies to this so a long reply never throws; undefined ⇒ no chunking.
   */
  readonly maxMessageLength?: number;
  /** Begin receiving (e.g. start long-polling). Fire-and-forget; must not throw synchronously. */
  start(): void;
  /** Stop receiving and release resources (best-effort on shutdown). */
  stop(): Promise<void>;
  /** OUTBOUND: send `text` to `chatId` on this channel. */
  send(chatId: string, text: string): Promise<void>;
}

/**
 * An originating chat ROUTE — WHICH chat on WHICH channel a turn came from (companion inbound) or is
 * addressed to (proactive/heartbeat home). Threaded per-turn through the pty host so an agent's chat_reply
 * resolves DAEMON-side to the exact route of the turn it is answering — never a shared/guessed channel.
 */
export interface CompanionRoute {
  channel: string;
  chatId: string;
}

/**
 * A RECURRING companion reminder (Companion Memory & Reminders Design, Surface 2 s3) — a named cron job
 * that fires a proactive turn into its OWN companion session, generalizing the single heartbeat
 * cadence+prompt to N independently-scheduled, independently-routed reminders. Row shape of the
 * `companion_reminders` table (db.ts); `route` reuses THIS module's CompanionRoute (never a new type) so
 * a fired reminder's chat_reply carries the exact same shape the heartbeat's home route and a wake's
 * captured route already use.
 */
export interface CompanionReminder {
  id: string;
  /** The companion session this reminder targets — its OWN long-lived session (never a fresh spawn). */
  sessionId: string;
  /** 5-field cron expression (validated + next-fire computed via orchestration/cron.ts, like Schedule). */
  cron: string;
  /** The framed proactive prompt text fired into the session on each due tick. */
  prompt: string;
  /** Human-facing name (management/REST — not yet wired by this card), or null. */
  label: string | null;
  /** SERVER-DERIVED chat route to carry on fire, or null (a fired reminder then has nowhere to chat_reply). */
  route: CompanionRoute | null;
  /** A disabled reminder is skipped by the watcher without being deleted. */
  enabled: boolean;
  /** ISO; anchors the FIRST-fire computation (nextFireAt(cron, createdAt)) before any real fire exists. */
  createdAt: string;
}

/**
 * Submit inbound text as a TURN into a live session — the EXISTING PTY primitive (pty.enqueueStdin),
 * injected so the gateway stays free of the pty host. `route` is the ORIGINATING (channel, chatId): the pty
 * pins it to the formed turn so chat_reply delivers back there. Returns the primitive's contract:
 *   { delivered:true }               → submitted immediately as a turn
 *   { delivered:false, position:N }  → HELD in the session's FIFO (busy/not-ready) — still accepted
 *   { delivered:false }              → session not alive (DEAD) — nothing queued
 */
export type SubmitTurn = (sessionId: string, text: string, route?: CompanionRoute) => { delivered: boolean; position?: number };

/** The OUTBOUND delivery result — STRUCTURED across every failure mode (never throws out of chat_reply).
 *  `no-target` = the in-flight turn had NO reply-to route (a turn that wasn't formed from a companion
 *  inbound / proactive-home submit) ⇒ chat_reply delivers NOWHERE (never broadcasts, never guesses). */
export type DeliverResult =
  | { delivered: true; chunks: number }
  | { delivered: false; reason: "unknown-session" | "no-adapter" | "send-failed" | "no-target" };

/** The result of routing one inbound message. */
export type InboundResult =
  | { accepted: true; sessionId: string; queued: boolean; position?: number }
  | { accepted: false; reason: "no-text" | "chat-not-allowlisted" }
  // The (channel, chatId) binding matched, but the SENDER is not authorized for it (Companion authz
  // layer): a GROUP-scoped binding with a missing or unlisted sender.id. Rejected BEFORE any turn is
  // submitted — the load-bearing deny path for the multi-user (shared-chat) case.
  | { accepted: false; reason: "sender-not-authorized" }
  | { accepted: false; reason: "session-dead"; sessionId: string; acked: boolean }
  // The submit primitive THREW (e.g. pty.write racing a dying session, or a fail-loud M1/M2 guard). The
  // gateway contains it — a racy inbound must NEVER crash the daemon via an unhandled rejection.
  | { accepted: false; reason: "submit-failed"; sessionId: string; acked: boolean }
  // A DM-PAIRING code redeemed successfully (Companion DM-pairing). NOT a turn (no submit — the code text
  // never reaches the agent): the redeemer's AUTHENTICATED chat.id was bound to `sessionId` ('paired-dm')
  // or their authenticated sender.id was added to a group binding's allowlist ('paired-sender'). `acked`
  // reports whether the "paired" confirmation reached the chat. A FAILED redemption never returns these —
  // it falls through to the SAME silent reject as any unallowlisted inbound (no pairing oracle).
  | { accepted: false; reason: "paired-dm"; sessionId: string; acked: boolean }
  | { accepted: false; reason: "paired-sender"; sessionId: string; acked: boolean };

/**
 * A session↔chat binding (spike scope: seeded from env as a SINGLE binding). Models WHICH chat on WHICH
 * channel is wired to WHICH companion session. Kept as a small in-memory map so the routing abstraction is
 * clean and the identity-binding/auth card (5e574ca9) can extend it — NO persistence / pairing / multi-user
 * auth here.
 */
export interface SessionBinding {
  readonly sessionId: string;
  readonly channel: string;
  readonly chatId: string;
  /**
   * The AUTHORIZATION scope (Companion authz layer). Selects the rule handleInbound applies after the
   * (channel, chatId) route match, via the injected CompanionAuth (companion/auth.ts):
   *   • "dm"    — a private 1:1 chat: the route match alone proves the single owner ⇒ authorized (the
   *               single-owner spike path, UNCHANGED). • "group" — a shared chat: authorized ONLY when
   *               the inbound carries a `sender.id` on this binding's per-binding allowlist; a missing
   *               or unlisted sender is HARD-rejected. The db-backed CompanionBinding carries the same
   *               field; a binding minted without it defaults to the safe single-owner "dm".
   */
  readonly scope: "dm" | "group";
}
