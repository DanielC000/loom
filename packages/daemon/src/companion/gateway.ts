/**
 * Loom Companion gateway core (Phase 0 spike) — the transport-agnostic heart of the chat loop,
 * deliberately decoupled from grammY's network so it is hermetically testable (tests inject a fake
 * transport + call handleInboundUpdate directly; no live Telegram).
 *
 * The TWO directions are NOT the same primitive:
 *   - INBOUND (chat → agent): `handleInboundUpdate` normalizes a channel update, ALLOWLIST-checks the
 *     chat id, then submits the message text as a TURN into the bound companion session via the EXISTING
 *     PTY submit primitive (pty.enqueueStdin, injected as `submitTurn`). We do NOT re-implement turn
 *     submission — that primitive already owns busy-gating, composer-defer, FIFO coalesce and the
 *     rate-limit park.
 *   - OUTBOUND (agent → chat): `deliverReply` takes the agent's `chat_reply(text)` and sends it BACK OUT
 *     to the chat bound to the session via an INJECTABLE transport. It must NEVER submit a turn (that
 *     would loop the reply back into the agent). This mirrors `worker_report`: the agent emits a clean
 *     payload, the gateway delivers it — NOT TUI scraping.
 *
 * SECURITY (owner standing rule): every inbound chat message is UNTRUSTED DATA / a prompt-injection
 * vector. The spike allowlists to a SINGLE chat id designed in — any other chat id is rejected/ignored,
 * never submitted. Ingested text is handed to the agent as a turn (data it reads), never interpreted as
 * an instruction to the gateway.
 *
 * Clean-room: the channel-adapter → normalized-message shape is modelled on OpenClaw/Hermes; no code is
 * copied from them.
 */

/** A platform-agnostic inbound message, normalized from a raw channel update. */
export interface NormalizedMessage {
  /** The originating chat id, always a string (a numeric Telegram id is stringified for stable compare). */
  chatId: string;
  /** The message text. */
  text: string;
}

/**
 * The OUTBOUND transport: send `text` to `chatId`. Injected — the real one wraps grammY's
 * `bot.api.sendMessage`; tests inject a fake that records calls (no live network).
 */
export interface ChatTransport {
  send(chatId: string, text: string): Promise<void>;
}

/**
 * Submit inbound text as a TURN into a live session — the EXISTING PTY primitive (`pty.enqueueStdin`),
 * injected so the core stays free of the pty host. Returns the primitive's `{delivered, position?}`.
 */
export type SubmitTurn = (sessionId: string, text: string) => { delivered: boolean; position?: number };

/** Companion configuration (spike scope) — all three are required for the adapter to run. */
export interface CompanionConfig {
  /** Telegram bot token — its PRESENCE is what turns the adapter ON (default OFF; see readCompanionConfig). */
  botToken: string;
  /** The SINGLE allowlisted chat id (spike). Any other chat id is rejected. */
  allowedChatId: string;
  /** The bound companion session id — an EXISTING live manager/worker session (Phase 0 adds no new role). */
  sessionId: string;
}

/** The result of handling an inbound update. */
export type InboundResult =
  | { accepted: true; delivered: boolean; position?: number }
  | { accepted: false; reason: "no-text" | "chat-not-allowlisted" };

/**
 * Normalize a Telegram Bot API update into a NormalizedMessage, or null if it carries no usable text.
 * We read ONLY `message.chat.id` + `message.text` — everything else (edits, callbacks, media captions,
 * channel posts) is ignored for the spike. Defensive against a malformed/partial update shape.
 */
export function normalizeTelegramUpdate(update: unknown): NormalizedMessage | null {
  const message = (update as { message?: { chat?: { id?: unknown }; text?: unknown } } | null)?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if ((typeof chatId !== "number" && typeof chatId !== "string") || typeof text !== "string" || text.length === 0) {
    return null;
  }
  return { chatId: String(chatId), text };
}

export class CompanionGateway {
  constructor(
    private readonly cfg: CompanionConfig,
    private readonly submitTurn: SubmitTurn,
    private readonly transport: ChatTransport,
  ) {}

  /**
   * INBOUND. Allowlist-check the chat id, then submit the message text as a turn into the bound session.
   * A foreign chat id is REJECTED and NEVER submitted — the load-bearing allowlist (untrusted input).
   */
  handleInboundUpdate(update: unknown): InboundResult {
    const msg = normalizeTelegramUpdate(update);
    if (!msg) return { accepted: false, reason: "no-text" };
    // Allowlist: string compare so a numeric Telegram chat id and a string-configured id still match.
    if (msg.chatId !== this.cfg.allowedChatId) return { accepted: false, reason: "chat-not-allowlisted" };
    const { delivered, position } = this.submitTurn(this.cfg.sessionId, msg.text);
    return { accepted: true, delivered, position };
  }

  /**
   * OUTBOUND. Deliver the agent's `chat_reply(text)` back OUT to the chat bound to `sessionId`. Mirrors
   * worker_report — this is NOT a turn submission (that would loop back into the agent). Rejects a reply
   * from any session other than the bound companion (spike: one session ↔ one chat).
   */
  async deliverReply(sessionId: string, text: string): Promise<{ delivered: boolean; reason?: string }> {
    if (sessionId !== this.cfg.sessionId) return { delivered: false, reason: "unknown-session" };
    await this.transport.send(this.cfg.allowedChatId, text);
    return { delivered: true };
  }
}

/**
 * Read the companion config from env (spike scope). Returns null when the bot token is UNSET → the
 * adapter stays OFF and the daemon is byte-identical to today. When the token IS set but the chat id or
 * bound session id is missing, warn and stay off (a half-configured companion is a no-op, not a crash).
 */
export function readCompanionConfig(env: NodeJS.ProcessEnv): CompanionConfig | null {
  const botToken = env.LOOM_COMPANION_BOT_TOKEN?.trim();
  const allowedChatId = env.LOOM_COMPANION_CHAT_ID?.trim();
  const sessionId = env.LOOM_COMPANION_SESSION_ID?.trim();
  if (!botToken) return null; // OFF by default — the whole adapter never starts.
  if (!allowedChatId || !sessionId) {
    // eslint-disable-next-line no-console
    console.warn(
      "[companion] LOOM_COMPANION_BOT_TOKEN is set but LOOM_COMPANION_CHAT_ID and/or " +
        "LOOM_COMPANION_SESSION_ID are missing — companion NOT started.",
    );
    return null;
  }
  return { botToken, allowedChatId, sessionId };
}
