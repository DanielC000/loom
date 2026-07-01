/**
 * Loom Companion — the ChatGateway subsystem: the platform-agnostic heart of the chat loop.
 *
 * It owns three things:
 *   1. a REGISTRY of ChannelAdapters (Telegram today; WhatsApp/Slack slot in unchanged);
 *   2. INBOUND routing — an adapter normalizes its platform update into an InboundMessage and calls
 *      `handleInbound`, which ALLOWLISTS by (channel, chatId) → the bound session and submits the body as
 *      a TURN via the EXISTING pty primitive (`SubmitTurn` = pty.enqueueStdin) — we do NOT re-implement
 *      turn submission (busy-gating / composer-defer / FIFO coalesce / rate-limit park all live there);
 *   3. OUTBOUND delivery — `deliverReply(sessionId, text)` resolves the session's bound adapter + chat id
 *      and sends the reply OUT. It NEVER submits a turn (that would loop the reply back into the agent).
 *
 * SECURITY (owner standing rule): every inbound chat message is UNTRUSTED DATA / a prompt-injection vector.
 * The spike allowlists to a SINGLE binding designed in — any (channel, chatId) with no binding is rejected
 * and never submitted. Ingested text is handed to the agent as a turn (data it reads), never interpreted as
 * an instruction to the gateway. The binding map is the seam the identity/auth card (5e574ca9) extends.
 */
import type {
  ChannelAdapter,
  DeliverResult,
  InboundMessage,
  InboundResult,
  SessionBinding,
  SubmitTurn,
} from "./types.js";

/**
 * Split `text` into chunks no longer than `max` chars, preferring a newline then a whitespace boundary so
 * a reply splits somewhere sensible; falls back to a hard cut when there is no boundary in range. Every
 * returned chunk is guaranteed ≤ `max`.
 */
export function chunkText(text: string, max: number): string[] {
  if (max <= 0 || text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    // Ignore a boundary that lands absurdly early (would waste most of the budget); prefer a later space.
    if (cut < max * 0.5) {
      const space = window.lastIndexOf(" ");
      if (space >= max * 0.5) cut = space;
    }
    if (cut <= 0) {
      chunks.push(rest.slice(0, max)); // no usable boundary → hard cut, keep every char
      rest = rest.slice(max);
    } else {
      // Split AFTER the boundary char (keep it at the end of this chunk) so reassembly is byte-lossless —
      // a companion sends code/JSON/base64 where a dropped space or newline would silently corrupt output.
      // cut ≤ max-1, so cut+1 ≤ max: the chunk still fits the limit.
      chunks.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export class ChatGateway {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly bindingsBySession = new Map<string, SessionBinding>();

  constructor(private readonly submitTurn: SubmitTurn, bindings: SessionBinding[] = []) {
    for (const b of bindings) this.bindingsBySession.set(b.sessionId, b);
  }

  /** Register a channel adapter under its `name` (later channels register the same way — no core change). */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Seed / replace a session↔chat binding (spike: seeded once from env; the auth card extends this). */
  bind(binding: SessionBinding): void {
    this.bindingsBySession.set(binding.sessionId, binding);
  }

  private bindingForInbound(channel: string, chatId: string): SessionBinding | undefined {
    for (const b of this.bindingsBySession.values()) {
      if (b.channel === channel && b.chatId === chatId) return b;
    }
    return undefined;
  }

  /**
   * INBOUND. Allowlist by (channel, chatId) → the bound session, then submit the body as a TURN via the
   * EXISTING pty primitive. A foreign chat id (no binding) is REJECTED and never submitted (load-bearing
   * allowlist — untrusted input). A DEAD bound session gets an error ACK back to the chat instead of
   * vanishing silently. Every rejection / dead-session path is debug-logged.
   */
  async handleInbound(msg: InboundMessage): Promise<InboundResult> {
    if (!msg.body || msg.body.length === 0) {
      this.debug(`inbound ignored: no text (channel=${msg.channel} chat=${msg.chatId})`);
      return { accepted: false, reason: "no-text" };
    }
    const binding = this.bindingForInbound(msg.channel, msg.chatId);
    if (!binding) {
      this.debug(`inbound REJECTED: chat not allowlisted (channel=${msg.channel} chat=${msg.chatId})`);
      return { accepted: false, reason: "chat-not-allowlisted" };
    }
    let submit: { delivered: boolean; position?: number };
    try {
      submit = this.submitTurn(binding.sessionId, msg.body);
    } catch (err) {
      // The submit primitive (pty.enqueueStdin) can THROW: its fail-loud M1/M2 guards, or realistically
      // `submit()`'s pty.write() throwing when the bound session's pty dies in the window between the
      // alive-check and the write (a message arriving exactly as the session restarts/dies). handleInbound
      // is fire-and-forget from the adapter, so an escaping throw becomes an UNHANDLED REJECTION → the
      // daemon's global handler process.exit(1)s (and NOT with the supervisor's restart sentinel, so it
      // stays down). Contain it here: error-ack the chat + return a structured result.
      this.debug(`inbound submit THREW for ${binding.sessionId}: ${describeError(err)} (channel=${msg.channel} chat=${msg.chatId})`);
      const acked = await this.tryAck(
        binding,
        "⚠️ Sorry — I couldn't deliver your message right now. Please try again in a moment.",
      );
      return { accepted: false, reason: "submit-failed", sessionId: binding.sessionId, acked };
    }
    const { delivered, position } = submit;
    if (delivered) return { accepted: true, sessionId: binding.sessionId, queued: false };
    if (position !== undefined) {
      // Busy / not-ready → HELD in the session FIFO. Accepted; it drains when the session frees up.
      return { accepted: true, sessionId: binding.sessionId, queued: true, position };
    }
    // No position ⇒ the bound session is DEAD. Surface it: error-ack the chat + log (don't vanish silently).
    this.debug(`inbound to DEAD session ${binding.sessionId} (channel=${msg.channel} chat=${msg.chatId})`);
    const acked = await this.tryAck(
      binding,
      "⚠️ This companion session isn't currently running, so your message couldn't be delivered.",
    );
    return { accepted: false, reason: "session-dead", sessionId: binding.sessionId, acked };
  }

  /** Best-effort error ack back to a chat (swallows a send failure — an ack must never throw upward). */
  private async tryAck(binding: SessionBinding, text: string): Promise<boolean> {
    const adapter = this.adapters.get(binding.channel);
    if (!adapter) return false;
    try {
      await adapter.send(binding.chatId, text);
      return true;
    } catch (err) {
      this.debug(`ack send failed: ${describeError(err)}`);
      return false;
    }
  }

  /**
   * OUTBOUND. Route the agent's chat_reply(text) back OUT to the chat bound to `sessionId`. NEVER submits a
   * turn (that would loop back in). Chunks a long reply to the adapter's max length so it can't throw on a
   * platform cap. Returns a STRUCTURED result on every failure (unknown session / no adapter / send threw)
   * — the chat_reply MCP handler stays symmetric and never throws out.
   */
  async deliverReply(sessionId: string, text: string): Promise<DeliverResult> {
    const binding = this.bindingsBySession.get(sessionId);
    if (!binding) return { delivered: false, reason: "unknown-session" };
    const adapter = this.adapters.get(binding.channel);
    if (!adapter) return { delivered: false, reason: "no-adapter" };
    const parts = adapter.maxMessageLength ? chunkText(text, adapter.maxMessageLength) : [text];
    try {
      for (const part of parts) await adapter.send(binding.chatId, part);
      return { delivered: true, chunks: parts.length };
    } catch (err) {
      this.debug(`deliverReply send failed for ${sessionId}: ${describeError(err)}`);
      return { delivered: false, reason: "send-failed" };
    }
  }

  /** Start every registered adapter (called after the daemon's server is listening). */
  start(): void {
    for (const a of this.adapters.values()) a.start();
  }

  /** Stop every registered adapter (best-effort on shutdown — never blocks the exit). */
  async stop(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.stop().catch(() => { /* never block exit */ })));
  }

  private debug(msg: string): void {
    // OPT-IN only: this logs rejection/dead-session lines that interpolate UNTRUSTED channel/chatId, so a
    // burst of foreign inbound must not spam the logs by default. Set LOOM_COMPANION_DEBUG to enable.
    if (!process.env.LOOM_COMPANION_DEBUG) return;
    // eslint-disable-next-line no-console
    console.debug(`[companion] ${msg}`);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
