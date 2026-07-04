/**
 * Loom Companion — the ChatGateway subsystem: the platform-agnostic heart of the chat loop.
 *
 * It owns three things:
 *   1. a REGISTRY of ChannelAdapters (Telegram today; WhatsApp/Slack slot in unchanged);
 *   2. INBOUND routing — an adapter normalizes its platform update into an InboundMessage and calls
 *      `handleInbound`, which ALLOWLISTS by (channel, chatId) → the bound session and submits the body as
 *      a TURN via the EXISTING pty primitive (`SubmitTurn` = pty.enqueueStdin) — we do NOT re-implement
 *      turn submission (busy-gating / composer-defer / FIFO coalesce / rate-limit park all live there);
 *   3. OUTBOUND delivery — `deliverReply(sessionId, text)` sends the reply OUT on the ORIGINATING route of the
 *      session's IN-FLIGHT turn (a session may be reachable on several channels at once — in-app + Telegram).
 *      The route is resolved PURELY from the pty's per-turn origin (injected `originResolver`) — the pty pins
 *      it when the turn is formed (a companion inbound, or a proactive/heartbeat submit carrying the home
 *      route), and route-keyed coalescing guarantees each turn has EXACTLY ONE route. So a reply always goes
 *      back to the channel of the turn it answers — cross-delivery is impossible by construction. A turn with
 *      NO route delivers NOWHERE (`no-target`); it NEVER broadcasts and NEVER submits a turn (would loop back).
 *
 * SECURITY (owner standing rule): every inbound chat message is UNTRUSTED DATA / a prompt-injection vector.
 * Routing is BINDINGS-AUTHORITATIVE — any (channel, chatId) with no binding is rejected and never submitted;
 * a session may hold up to one binding PER channel, but the (channel, chatId) route stays globally unique so
 * inbound is never ambiguous. Ingested text is handed to the agent as a turn (data it reads), never
 * interpreted as an instruction to the gateway.
 */
import type {
  ChannelAdapter,
  CompanionRoute,
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
  /**
   * MULTI-CHANNEL routing map: session id → its bindings, up to ONE per channel (in-app + Telegram
   * coexist). Keyed by session so deliverReply/unbind are O(1) by session; the per-(channel,chatId) route
   * stays globally unique (the db route index), so bindingForInbound still resolves to exactly one binding.
   */
  private readonly bindingsBySession = new Map<string, SessionBinding[]>();

  /**
   * @param submitTurn  the injected pty turn-submit primitive (kept db-free — see SubmitTurn).
   * @param bindings    the initial session↔chat bindings (loaded from the db by the factory).
   * @param auth        the injected sender-authorization decision (Companion authz layer). Defaults to
   *                    the db-free allow-if-DM-match impl so existing `new ChatGateway(submit, [...])`
   *                    constructions stay green; the daemon injects the db-backed impl.
   * @param pairing     the injected DM-pairing coordinator (Companion DM-pairing). Defaults to the no-op
   *                    (redemption never fires ⇒ every existing construction is byte-identical); the daemon
   *                    injects the db-backed impl.
   * @param originResolver  the injected PER-TURN ORIGIN resolver (multi-channel reply routing). Given a
   *                    sessionId, returns the {channel, chatId} the session's IN-FLIGHT turn originated from
   *                    (the pty host pins it when the turn is formed — from a companion inbound, or a
   *                    proactive/heartbeat submit carrying the home route), or null. deliverReply targets
   *                    EXACTLY this route — so a reply always goes back to the channel of the turn it answers,
   *                    never a shared/guessed channel and never cross-delivered under interleaved inbounds.
   *                    Defaults to undefined (⇒ no target ⇒ deliverReply returns `no-target`); the daemon
   *                    injects `(sid) => pty.getActiveTurnOrigin(sid)`.
   */
  constructor(
    private readonly submitTurn: SubmitTurn,
    bindings: SessionBinding[] = [],
    private readonly auth: CompanionAuth = allowIfDmMatch(),
    private readonly pairing: CompanionPairing = noPairing(),
    private readonly originResolver: ((sessionId: string) => CompanionRoute | null) | undefined = undefined,
  ) {
    for (const b of bindings) this.addBinding(b);
  }

  /** Register a channel adapter under its `name` (later channels register the same way — no core change). */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Seed / replace a session↔chat binding — keeps the live in-memory routing map in sync with a durable
   *  db write (the admin REST POST calls this so a new/edited binding takes effect with no restart). A
   *  binding on a NEW channel is ADDED alongside the session's others; a re-bind of the SAME channel
   *  replaces that channel's entry in place (mirrors the db upsert on (session_id, channel)). */
  bind(binding: SessionBinding): void {
    this.addBinding(binding);
  }

  /** Remove ALL of a session's bindings from the live routing map, or (when `channel` is given) only that
   *  ONE channel's entry — leaving the session's other channel bindings routing unaffected (mirrors
   *  deleteCompanionBinding's per-channel delete). If removing that entry empties the array, the session
   *  key is dropped too (matches the all-bindings teardown). The admin REST DELETE calls this so a
   *  revoked binding stops routing immediately — no stale in-memory binding until restart. */
  unbind(sessionId: string, channel?: string): void {
    if (channel === undefined) {
      this.bindingsBySession.delete(sessionId);
      return;
    }
    const arr = this.bindingsBySession.get(sessionId);
    if (!arr) return;
    const next = arr.filter((b) => b.channel !== channel);
    if (next.length === 0) this.bindingsBySession.delete(sessionId);
    else this.bindingsBySession.set(sessionId, next);
  }

  /** Insert-or-replace a binding into the session's array, one entry per channel (the (session, channel)
   *  upsert semantics, in memory). */
  private addBinding(binding: SessionBinding): void {
    const arr = this.bindingsBySession.get(binding.sessionId);
    if (!arr) {
      this.bindingsBySession.set(binding.sessionId, [binding]);
      return;
    }
    const i = arr.findIndex((b) => b.channel === binding.channel);
    if (i >= 0) arr[i] = binding;
    else arr.push(binding);
  }

  /** Resolve the ONE binding for an inbound (channel, chatId). The db route index is UNIQUE per
   *  (channel, chat_id), so at most one binding across ALL sessions matches — no inbound ambiguity. */
  private bindingForInbound(channel: string, chatId: string): SessionBinding | undefined {
    for (const arr of this.bindingsBySession.values()) {
      for (const b of arr) {
        if (b.channel === channel && b.chatId === chatId) return b;
      }
    }
    return undefined;
  }

  /** Read-only: a session's current bindings (a COPY — never the live array), one per bound channel.
   *  Empty for a session with no bindings. Used by cross-channel MIRRORING (e.g. echoing a web-chat turn
   *  out to the session's other bound channels) to enumerate "the channels this session is ALREADY bound
   *  to" from the SAME routing map handleInbound/bind/unbind maintain — never a separate lookup that could
   *  reach an unbound chat id. */
  bindingsForSession(sessionId: string): SessionBinding[] {
    return (this.bindingsBySession.get(sessionId) ?? []).slice();
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
      // Submit WITH the originating route {channel, chatId}: the pty pins it to the formed turn so the
      // agent's chat_reply resolves back to THIS chat (multi-channel routing). The route is the AUTHENTICATED
      // inbound's own (channel, chatId) — never a body-supplied one.
      submit = this.submitTurn(binding.sessionId, msg.body, { channel: msg.channel, chatId: msg.chatId });
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
   * OUTBOUND. Route the agent's chat_reply(text) back OUT for `sessionId`. `replyTarget` picks the ONE
   * channel (single binding, else the proactive home) — never a broadcast, never a cross-wire. NEVER submits
   * a turn (that would loop back in). Chunks a long reply to the adapter's max length so it can't throw on a
   * platform cap. Returns a STRUCTURED result on every failure (unknown session / no adapter / send threw) —
   * the chat_reply MCP handler stays symmetric.
   */
  async deliverReply(sessionId: string, text: string): Promise<DeliverResult> {
    // PURELY per-turn-route: the target is the ORIGINATING route of the session's in-flight turn (the pty
    // pinned it when the turn was formed). NO binding-based / home fallback and NO broadcast — a turn with no
    // reply-to route (not formed from a companion inbound / proactive-home submit) delivers NOWHERE. This is
    // what makes cross-delivery impossible by construction: the reply can only go where the turn came from.
    const target = this.replyTarget(sessionId);
    if (!target) return { delivered: false, reason: "no-target" };
    const result = await this.sendVia(target.channel, target.chatId, text);
    if (!result.delivered) return result.reason === "no-adapter" ? { delivered: false, reason: "no-adapter" } : { delivered: false, reason: "send-failed" };
    return { delivered: true, chunks: result.chunks };
  }

  /**
   * OUTBOUND MIRROR primitive: send a plain, non-reply message to an EXPLICIT (channel, chatId) — never
   * resolved from a turn's origin (unlike deliverReply/replyTarget). Callers pass a route already known to
   * be one of a session's bound channels (see bindingsForSession) — this method does no binding lookup of
   * its own and does not care WHICH session the route belongs to. It NEVER calls submitTurn and never
   * touches inbound routing (bindingForInbound/handleInbound), so it structurally cannot form a turn or
   * loop a mirrored message back in. Used to echo a web-chat turn out to the session's other bound
   * channels (e.g. Telegram) with a disclaimer — the caller composes that text; this just sends it.
   */
  async sendToChannel(channel: string, chatId: string, text: string): Promise<DeliverResult> {
    const result = await this.sendVia(channel, chatId, text);
    if (!result.delivered) return result.reason === "no-adapter" ? { delivered: false, reason: "no-adapter" } : { delivered: false, reason: "send-failed" };
    return { delivered: true, chunks: result.chunks };
  }

  /** Shared outbound send: chunk to the adapter's max length and send every part, in order. Contains a
   *  throw (never propagates) — the only failure modes are "no adapter registered for this channel" and
   *  "the adapter's send threw". Pure outbound: never calls submitTurn, never consults inbound routing. */
  private async sendVia(channel: string, chatId: string, text: string): Promise<{ delivered: true; chunks: number } | { delivered: false; reason: "no-adapter" | "send-failed" }> {
    const adapter = this.adapters.get(channel);
    if (!adapter) return { delivered: false, reason: "no-adapter" };
    const parts = adapter.maxMessageLength ? chunkText(text, adapter.maxMessageLength) : [text];
    try {
      for (const part of parts) await adapter.send(chatId, part);
      return { delivered: true, chunks: parts.length };
    } catch (err) {
      this.debug(`sendVia send failed for ${channel}/${chatId}: ${describeError(err)}`);
      return { delivered: false, reason: "send-failed" };
    }
  }

  /**
   * The reply target for `sessionId`: the ORIGINATING route of its IN-FLIGHT turn, via the injected
   * originResolver (pty.getActiveTurnOrigin). null ⇒ no reply-to route for this turn ⇒ deliverReply delivers
   * nowhere (`no-target`). A throwing resolver degrades to null (never breaks a reply path). This is the
   * SOLE reply-target source — no binding/home guessing — so an interleaved cross-route inbound can never
   * redirect an in-flight turn's reply (the route is pinned per-turn in the pty, not read from a shared field).
   */
  private replyTarget(sessionId: string): CompanionRoute | null {
    try { return this.originResolver?.(sessionId) ?? null; } catch { return null; }
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
