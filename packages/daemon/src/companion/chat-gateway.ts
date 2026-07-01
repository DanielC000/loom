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
import { allowIfDmMatch, type CompanionAuth } from "./auth.js";
import { noPairing, type CompanionPairing } from "./pairing.js";

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

  /**
   * @param submitTurn  the injected pty turn-submit primitive (kept db-free — see SubmitTurn).
   * @param bindings    the initial session↔chat bindings (loaded from the db by the factory).
   * @param auth        the injected sender-authorization decision (Companion authz layer). Defaults to
   *                    the db-free allow-if-DM-match impl so existing `new ChatGateway(submit, [...])`
   *                    constructions stay green; the daemon injects the db-backed impl.
   * @param pairing     the injected DM-pairing coordinator (Companion DM-pairing). Defaults to the no-op
   *                    (redemption never fires ⇒ every existing construction is byte-identical); the daemon
   *                    injects the db-backed impl.
   * @param homeResolver  the injected proactive HOME-channel resolver (card 9488951e). Returns the
   *                    configured companion home {channel, chatId} or null. Used by deliverReply as a
   *                    FALLBACK when a session has NO binding (a proactive/heartbeat turn still reaches the
   *                    owner). Defaults to undefined (no fallback ⇒ every existing construction is
   *                    byte-identical); the daemon injects `() => db.getCompanionHome()`.
   */
  constructor(
    private readonly submitTurn: SubmitTurn,
    bindings: SessionBinding[] = [],
    private readonly auth: CompanionAuth = allowIfDmMatch(),
    private readonly pairing: CompanionPairing = noPairing(),
    private readonly homeResolver: (() => { channel: string; chatId: string } | null) | undefined = undefined,
  ) {
    for (const b of bindings) this.bindingsBySession.set(b.sessionId, b);
  }

  /** Register a channel adapter under its `name` (later channels register the same way — no core change). */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Seed / replace a session↔chat binding — keeps the live in-memory routing map in sync with a durable
   *  db write (the admin REST POST calls this so a new/edited binding takes effect with no restart). */
  bind(binding: SessionBinding): void {
    this.bindingsBySession.set(binding.sessionId, binding);
  }

  /** Remove a session's binding from the live routing map (the admin REST DELETE calls this alongside the
   *  db delete, so a revoked route stops routing immediately — no stale in-memory binding until restart). */
  unbind(sessionId: string): void {
    this.bindingsBySession.delete(sessionId);
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
      // Companion DM-pairing: BEFORE rejecting an unbound chat, attempt a `dm-bind` redemption from the
      // body. The bound id is the AUTHENTICATED chat.id (never a body-supplied one). On success the code
      // text NEVER reaches submitTurn — we bind + live-sync + ack "paired" and return here. On ANY failure
      // (incl. a code-shaped body that doesn't redeem) we fall through to the SAME silent reject below.
      const red = this.pairing.redeem({ grantType: "dm-bind", channel: msg.channel, chatId: msg.chatId, senderId: msg.sender?.id, body: msg.body });
      if (red.outcome === "bound") {
        this.bind(red.binding); // live-sync the routing map so this chat routes immediately (no restart)
        const acked = await this.tryAck(red.binding, PAIRED_ACK);
        this.debug(`inbound PAIRED (dm-bind): chat now bound (channel=${msg.channel} chat=${msg.chatId} session=${red.binding.sessionId})`);
        return { accepted: false, reason: "paired-dm", sessionId: red.binding.sessionId, acked };
      }
      this.debug(`inbound REJECTED: chat not allowlisted (channel=${msg.channel} chat=${msg.chatId})`);
      return { accepted: false, reason: "chat-not-allowlisted" };
    }
    // Per-binding SENDER authz (Companion authz layer) — the load-bearing deny gate. Placed IMMEDIATELY
    // after the route match and BEFORE submitTurn, so an unauthorized sender PROVABLY never reaches turn
    // submission. DM: authorized by the route match (single owner). GROUP: requires an allowlisted
    // sender.id; a missing/unlisted sender is rejected here.
    if (!this.auth.isSenderAuthorized(binding, msg.sender)) {
      // Companion DM-pairing: BEFORE rejecting an unauthorized sender on a matched (group) binding, attempt
      // a `group-sender` redemption. The added id is the AUTHENTICATED sender.id, and the code MUST be
      // scoped to THIS binding's session (enforced in the db txn) — a code for session A can't grant into
      // group B. On success the code text never reaches submitTurn; on failure we fall through to the SAME
      // silent reject below.
      const red = this.pairing.redeem({ grantType: "group-sender", channel: msg.channel, chatId: msg.chatId, senderId: msg.sender?.id, body: msg.body, bindingSessionId: binding.sessionId });
      if (red.outcome === "sender-added") {
        const acked = await this.tryAck(binding, PAIRED_ACK);
        this.debug(`inbound PAIRED (group-sender): sender allowlisted (channel=${msg.channel} chat=${msg.chatId} session=${binding.sessionId})`);
        return { accepted: false, reason: "paired-sender", sessionId: binding.sessionId, acked };
      }
      this.debug(
        `inbound REJECTED: sender not authorized (channel=${msg.channel} chat=${msg.chatId} ` +
          `scope=${binding.scope} sender=${msg.sender?.id ?? "none"})`,
      );
      return { accepted: false, reason: "sender-not-authorized" };
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
    // Binding WINS when present (inbound-reply routing unchanged). With NO binding, FALL BACK to the
    // configured companion HOME (card 9488951e) so a PROACTIVE/heartbeat turn on an unbound session still
    // reaches the owner. No binding + no home ⇒ unknown-session (byte-identical to the pre-fallback path).
    const binding = this.bindingsBySession.get(sessionId);
    const target = binding
      ? { channel: binding.channel, chatId: binding.chatId }
      : this.resolveHome();
    if (!target) return { delivered: false, reason: "unknown-session" };
    const adapter = this.adapters.get(target.channel);
    if (!adapter) return { delivered: false, reason: "no-adapter" };
    const parts = adapter.maxMessageLength ? chunkText(text, adapter.maxMessageLength) : [text];
    try {
      for (const part of parts) await adapter.send(target.chatId, part);
      return { delivered: true, chunks: parts.length };
    } catch (err) {
      this.debug(`deliverReply send failed for ${sessionId}: ${describeError(err)}`);
      return { delivered: false, reason: "send-failed" };
    }
  }

  /** The configured companion home {channel, chatId} or null — the proactive deliverReply fallback.
   *  A throwing resolver degrades to null (never breaks a reply path). */
  private resolveHome(): { channel: string; chatId: string } | null {
    try { return this.homeResolver?.() ?? null; } catch { return null; }
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

/** The confirmation sent back to a chat on a successful pairing. Deliberately generic — a failed
 *  redemption NEVER acks (it is indistinguishable from any unallowlisted inbound: no pairing oracle). */
const PAIRED_ACK = "✅ Paired — you can now message me here.";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
