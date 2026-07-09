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
import { randomUUID } from "node:crypto";
import type { CompanionMessage } from "@loom/shared";
import type {
  ChannelAdapter,
  CompanionHistoryExport,
  CompanionHistoryReset,
  CompanionLivePush,
  CompanionMessageRecorder,
  CompanionRoute,
  CompanionSynthesizer,
  CompanionTranscriber,
  DeliverResult,
  InboundAttachment,
  InboundMessage,
  InboundResult,
  SessionBinding,
  SubmitTurn,
} from "./types.js";
import { allowIfDmMatch, type CompanionAuth } from "./auth.js";
import { noPairing, type CompanionPairing } from "./pairing.js";
import { inMemoryVoicePrefs, voicePrefRoute, type CompanionVoicePrefs } from "./voice-prefs.js";
import { parseCommand, commandHandler } from "./commands.js";

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
      // No usable boundary → hard cut at `max` code UNITS. A hard cut lands mid-string arbitrarily, so it
      // can split a surrogate pair (an astral emoji/char is two UTF-16 code units) into a lone leading
      // surrogate + a lone trailing surrogate in the NEXT chunk — each renders as U+FFFD (�). Back off one
      // unit so the pair stays intact and moves to the next chunk together (max > 1 always holds here:
      // chunkText's caller passes a real maxMessageLength, and max <= 0 already returned above).
      let hardCut = max;
      const leading = rest.charCodeAt(hardCut - 1);
      if (hardCut > 1 && leading >= 0xd800 && leading <= 0xdbff) hardCut -= 1;
      chunks.push(rest.slice(0, hardCut));
      rest = rest.slice(hardCut);
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
   * @param voicePrefs  the injected per-route VOICE preference store (Companion Voice epic, VOICE-P1 —
   *                    voice-prefs.ts). The "/lang"/"/voice" slash-command router (commands.ts) writes
   *                    through this; P2/P3 will read it at inbound/outbound time. Defaults to a real
   *                    in-memory store (not a no-op — see voice-prefs.ts) so existing bare
   *                    `new ChatGateway(submit, [...])` constructions stay green; the daemon injects the
   *                    db-backed store.
   * @param transcribe  the injected STT transcriber (Companion Voice epic, VOICE-P2 — companion/stt.ts).
   *                    Deferred from P1: default undefined ⇒ an inbound carrying an audio attachment is a
   *                    no-op (ignored, exactly like an empty text body) — every existing/test construction
   *                    stays byte-identical. The daemon injects the local faster-whisper transcriber.
   * @param synthesize  the injected TTS synthesizer (Companion Voice epic, VOICE-P3 — companion/tts.ts).
   *                    Default undefined ⇒ deliverReply's text path is UNCHANGED (no synth attempted, no
   *                    behavior difference) — every existing/test construction stays byte-identical. The
   *                    daemon injects the local kokoro-onnx synthesizer.
   * @param historyReset  the injected "fresh conversation" history-clear half of the "/new"/"/reset"
   *                    command (commands.ts) — see {@link CompanionHistoryReset}. The OTHER half (resetting
   *                    the agent's own context) needs no injection: this class already holds `submitTurn`.
   *                    Default undefined ⇒ resetConversation only does the context-reset half (every
   *                    existing/test construction stays byte-identical). The daemon injects a db+in-app
   *                    backed impl (factory.ts).
   * @param recorder    the injected CHAT HISTORY recorder (unified cross-channel chat, card 7d63e200) —
   *                    see {@link CompanionMessageRecorder}. Default undefined ⇒ no recording (every
   *                    existing/test construction stays byte-identical). The daemon injects a db-backed
   *                    impl that skips the in-app channel (already recorded via its own dedicated hooks).
   * @param reinjectPersona  the injected PERSONA reinject (companion-persona-after-clear card, generalized by
   *                    the standalone "/refresh" command to a live, NON-destructive upgrade path) — given a
   *                    sessionId, composes+enqueues that session's fresh-spawn-equivalent startup prompt
   *                    (base brief + name + memory recall) via a RAW pty enqueue, entirely OUTSIDE
   *                    `submitTurn`/`handleInbound` — so it is never recorded to chat history and never
   *                    pushed to a live web viewer (mirrors the resume-half memory-recall reinject in
   *                    sessions/service.ts). Returns whether a prompt was actually composed+enqueued (false
   *                    for a missing/non-assistant session) — both `resetConversation` ("/new"/"/reset") and
   *                    the standalone `refreshPersona` ("/refresh") read this to report an accurate ack.
   *                    Default undefined ⇒ resetConversation only does the /clear + history-clear halves, and
   *                    "/refresh" reports nothing to refresh (every existing/test construction stays
   *                    byte-identical). The daemon injects `(sid) => { const p =
   *                    sessions.composeCompanionReinjectPrompt(sid); if (p) pty.enqueueStdin(sid, p, "system");
   *                    return !!p; }` (index.ts).
   * @param livePush    the injected LIVE PUSH hook (Telegram live-chat push card) — see {@link
   *                    CompanionLivePush}. Default undefined ⇒ no live push (every existing/test construction
   *                    stays byte-identical). The daemon injects an impl that skips the in-app channel and
   *                    pushes to `deps.inApp` for every other channel (factory.ts).
   * @param historyExport  the injected CONVERSATION READER for the "/export" command (Companion Slash
   *                    Commands, card 9db7d09c) — see {@link CompanionHistoryExport}. Default undefined ⇒
   *                    "/export" reports it isn't available (every existing/test construction stays
   *                    byte-identical). The daemon injects a db-backed impl (factory.ts).
   */
  constructor(
    private readonly submitTurn: SubmitTurn,
    bindings: SessionBinding[] = [],
    private readonly auth: CompanionAuth = allowIfDmMatch(),
    private readonly pairing: CompanionPairing = noPairing(),
    private readonly originResolver: ((sessionId: string) => CompanionRoute | null) | undefined = undefined,
    private readonly voicePrefs: CompanionVoicePrefs = inMemoryVoicePrefs(),
    private readonly transcribe: CompanionTranscriber | undefined = undefined,
    private readonly synthesize: CompanionSynthesizer | undefined = undefined,
    private readonly historyReset: CompanionHistoryReset | undefined = undefined,
    private readonly recorder: CompanionMessageRecorder | undefined = undefined,
    private readonly reinjectPersona: ((sessionId: string) => boolean) | undefined = undefined,
    private readonly livePush: CompanionLivePush | undefined = undefined,
    private readonly historyExport: CompanionHistoryExport | undefined = undefined,
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
    // An audio-only inbound (Companion Voice epic, VOICE-P2) carries an empty body — it must NOT be
    // dropped here before it reaches the authz gates below (the load-bearing STT-behind-authz ordering).
    const audioAttachment = msg.attachments?.find((a) => a.type === "audio");
    if ((!msg.body || msg.body.length === 0) && !audioAttachment) {
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
    // AUDIO TRANSCRIPTION (Companion Voice epic, VOICE-P2). Runs STRICTLY after the route match + sender
    // authz above — an unallowlisted/foreign/unauthorized sender's voice note is rejected by one of the
    // two returns above and this code is NEVER reached: no download, no STT compute spent on untrusted
    // senders. `body` (not msg.body) is what the rest of this method acts on from here.
    let body = msg.body;
    if (audioAttachment && this.transcribe) {
      // The WHOLE audio pipeline is wrapped: `isReady()`/`voicePrefs.resolve()`/`transcribe()` are
      // documented never-throw, but an escaping throw here (like a submitTurn throw above) would escape
      // handleInbound — fire-and-forget from the adapter — as an UNHANDLED REJECTION → the daemon's global
      // handler exits (and NOT with the supervisor's restart sentinel, so it stays down). Contain it and
      // degrade to the SAME friendly ack every other STT failure mode uses.
      try {
        // Cheap readiness check FIRST — skips a wasted ≤20MB download when STT definitely isn't ready (cold
        // venv); a false result here also kicks background provisioning (see companion/stt.ts).
        if (!this.transcribe.isReady()) {
          const acked = await this.tryAck(binding, STT_UNAVAILABLE_ACK);
          this.debug(`inbound audio: STT not ready, skipped download (channel=${msg.channel} chat=${msg.chatId})`);
          return { accepted: false, reason: "transcribe-unavailable", sessionId: binding.sessionId, acked };
        }
        const download = await this.downloadAttachment(binding, audioAttachment);
        if (!download) {
          const acked = await this.tryAck(binding, STT_UNAVAILABLE_ACK);
          this.debug(`inbound audio: download failed/unsupported (channel=${msg.channel} chat=${msg.chatId})`);
          return { accepted: false, reason: "transcribe-unavailable", sessionId: binding.sessionId, acked };
        }
        try {
          const pref = this.voicePrefs.resolve(voicePrefRoute(binding, msg.sender));
          const transcript = await this.transcribe.transcribe({ filePath: download.filePath, langHint: pref.sttLang });
          if (!transcript || transcript.length === 0) {
            const acked = await this.tryAck(binding, STT_UNAVAILABLE_ACK);
            this.debug(`inbound audio: transcribe failed/empty (channel=${msg.channel} chat=${msg.chatId})`);
            return { accepted: false, reason: "transcribe-unavailable", sessionId: binding.sessionId, acked };
          }
          body = transcript; // untrusted DATA, handed to the agent as a turn just like typed text — never
                              // interpreted as an instruction to the gateway.
        } finally {
          await download.cleanup().catch(() => { /* best-effort — cleanup must never block/throw */ });
        }
      } catch (err) {
        this.debug(`inbound audio: transcription pipeline THREW: ${describeError(err)} (channel=${msg.channel} chat=${msg.chatId})`);
        const acked = await this.tryAck(binding, STT_UNAVAILABLE_ACK);
        return { accepted: false, reason: "transcribe-unavailable", sessionId: binding.sessionId, acked };
      }
    }
    // An audio attachment with no transcribe dep injected (default OFF) leaves `body` at msg.body's ""
    // — falls through here exactly like the pre-existing no-text path (audio is silently ignored, a no-op).
    if (!body || body.length === 0) {
      this.debug(`inbound ignored: no text after transcription (channel=${msg.channel} chat=${msg.chatId})`);
      return { accepted: false, reason: "no-text" };
    }
    // "/" SLASH-COMMAND intercept (Companion Voice epic, VOICE-P1 foundation — commands.ts). Runs AFTER
    // the route match + sender authz above, so an unallowlisted/foreign/unauthorized sender NEVER reaches
    // here (both reject paths above return first) — a command can only ever write a pref for an
    // ALREADY-AUTHORIZED route, gated exactly like text. A RECOGNIZED command (an entry in commands.ts'
    // handler map) NEVER becomes a turn — mirrors the redeemed-pairing-code path above. An unrecognized
    // "/word" (parsed but no handler) falls through unchanged to the normal submit path below.
    const parsed = parseCommand(body);
    const handler = parsed ? commandHandler(parsed.name) : undefined;
    if (parsed && handler) {
      const route = voicePrefRoute(binding, msg.sender);
      const { ack } = await handler(parsed.args, route, this.voicePrefs, {
        resetConversation: (sid) => this.resetConversation(sid),
        exportConversation: (sid) => this.exportConversation(sid),
        refreshPersona: (sid) => this.refreshPersona(sid),
      });
      // Every command ack is transport chrome EXCEPT "/new"/"/reset" — that ack IS the intentional
      // conversation-boundary marker (resetConversation's doc), so it alone is persisted, on EVERY channel.
      const isConversationBoundary = parsed.name === "new" || parsed.name === "reset";
      const acked = await this.tryAck(binding, ack, { record: isConversationBoundary });
      if (isConversationBoundary && acked) {
        // tryAck's record:true only persists it for an adapter that self-records on send (in-app); a
        // channel like Telegram never records inside `send`, so record it here too via the SAME generic
        // hook a real reply uses — a no-op for in-app (recordOutboundSafely's recorder skips that channel,
        // already recorded above) so this can never double-write.
        this.recordOutboundSafely(binding.sessionId, binding.channel, binding.chatId, ack);
      }
      this.debug(`inbound COMMAND /${parsed.name} (channel=${msg.channel} chat=${msg.chatId} session=${binding.sessionId})`);
      return { accepted: false, reason: "command", sessionId: binding.sessionId, command: parsed.name, acked };
    }
    let submit: { delivered: boolean; position?: number };
    try {
      // Submit WITH the originating route {channel, chatId}: the pty pins it to the formed turn so the
      // agent's chat_reply resolves back to THIS chat (multi-channel routing). The route is the AUTHENTICATED
      // inbound's own (channel, chatId) — never a body-supplied one.
      submit = this.submitTurn(binding.sessionId, body, { channel: msg.channel, chatId: msg.chatId });
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
    if (delivered) {
      // CHAT HISTORY record (unified cross-channel chat, card 7d63e200): only an ACCEPTED turn (delivered
      // now OR queued below) is a real user message — mirrors controller.ts's in-app-only recordInbound-
      // MessageSafely, generalized to every channel here. `body` is the FINAL submitted text (the STT
      // transcript for a voice note); `!!audioAttachment` tags a voice-note-originated turn.
      this.recordInboundSafely(binding.sessionId, msg.channel, msg.chatId, body, !!audioAttachment);
      return { accepted: true, sessionId: binding.sessionId, queued: false, submittedText: body };
    }
    if (position !== undefined) {
      // Busy / not-ready → HELD in the session FIFO. Accepted; it drains when the session frees up.
      this.recordInboundSafely(binding.sessionId, msg.channel, msg.chatId, body, !!audioAttachment);
      return { accepted: true, sessionId: binding.sessionId, queued: true, position, submittedText: body };
    }
    // No position ⇒ the bound session is DEAD. Surface it: error-ack the chat + log (don't vanish silently).
    this.debug(`inbound to DEAD session ${binding.sessionId} (channel=${msg.channel} chat=${msg.chatId})`);
    const acked = await this.tryAck(
      binding,
      "⚠️ This companion session isn't currently running, so your message couldn't be delivered.",
    );
    return { accepted: false, reason: "session-dead", sessionId: binding.sessionId, acked };
  }

  /**
   * The "/new"/"/reset" command's session-lifecycle side effect (commands.ts's `resetConversation` dep).
   * Two independent halves, in order:
   *   (a) CONTEXT RESET — inject "/clear" via the SAME `submitTurn` primitive every inbound turn uses. This
   *       needs no new dependency: `/clear` is `claude`'s own built-in slash command, intercepted CLIENT-SIDE
   *       in the real interactive session (Loom drives the real `claude` via node-pty — CLAUDE.md's
   *       load-bearing invariant) exactly like a human typing it — it never reaches the model, so it forms
   *       NO turn and produces NO reply. If the session is busy, this rides the SAME FIFO every other
   *       message does and fires once free; if the session is dead, submitTurn no-ops exactly like today's
   *       dead-session inbound path. No route is passed (a `/clear` never produces a chat_reply, so there is
   *       nothing for a route to target). A throwing submitTurn (e.g. pty.write racing a dying session) is
   *       contained here — mirrors handleInbound's own submit-failed containment — so a `/new` never crashes
   *       the inbound path that's running it.
   *   (b) PERSONA REINJECT — best-effort, via the optional injected `reinjectPersona` (undefined ⇒ no-op:
   *       e.g. a non-assistant gateway, or a test that doesn't inject one). Enqueued via a RAW pty primitive
   *       immediately after (a)'s `/clear` enqueue, in the SAME synchronous flow — both ride the same
   *       per-session pty FIFO queue, so `/clear`'s queue slot always precedes this one (FIFO), and `/clear`
   *       submits as turn-kind "agent" while this reinjects as the "system" kind, so a drain can
   *       never mash the two into one turn (kinds never coalesce together — see pty/host.ts). Without this,
   *       `/clear` wipes the companion's ONE persona turn (baked in only at fresh spawn) along with the rest
   *       of the conversation, leaving a blank, identity-less agent — see composeCompanionReinjectPrompt.
   *   (c) HISTORY CLEAR — best-effort, via the optional injected `historyReset` (undefined ⇒ no-op: e.g. a
   *       Telegram-only gateway, or a test that doesn't inject one). Clears whatever durable chat-history
   *       record exists for `sessionId` and pushes a live "cleared" notice to an attached web viewer.
   * Runs BEFORE the command's ack is sent (see handleInbound) — the persisted history is already empty and
   * any live viewer already cleared by the time the ack is recorded+pushed as the first message of the new,
   * empty conversation. Never throws.
   */
  private async resetConversation(sessionId: string): Promise<void> {
    try {
      this.submitTurn(sessionId, "/clear");
    } catch (err) {
      this.debug(`resetConversation: /clear submit failed for ${sessionId}: ${describeError(err)}`);
    }
    this.refreshPersona(sessionId);
    if (!this.historyReset) return;
    try {
      await this.historyReset.clear(sessionId);
    } catch (err) {
      this.debug(`resetConversation: history clear failed for ${sessionId}: ${describeError(err)}`);
    }
  }

  /**
   * The standalone "/refresh" command's dep (commands.ts's `refreshPersona`) — a live, NON-destructive
   * persona/memory upgrade with NO "/clear" and NO history reset: unlike `resetConversation`'s (b) half
   * above, this is the WHOLE effect, so a companion can pick up an agent-definition edit (persona brief,
   * given name, or its current pinned/recallable memory) mid-conversation without losing any context.
   * Reuses the exact same injected {@link reinjectPersona} side-channel (composes the fresh-spawn-equivalent
   * prompt off the agent's CURRENT row, never a stale cache — see composeCompanionReinjectPrompt — and
   * raw-enqueues it as a "system"-kind turn, bypassing chat-history recording + live-viewer rendering exactly
   * like the "/new" half does). Returns whether a prompt was actually composed+enqueued, so the caller can
   * ack accurately: false for a missing/non-assistant session, a throwing injected impl, or no injected
   * `reinjectPersona` at all (e.g. a test construction that doesn't inject one) — every case degrades to "no
   * effect", never a crash. NOTE (capability/MCP-surface upgrades — persona's harder sibling): this can ONLY
   * refresh the composed startup-prompt text (persona brief + name + memory recall); a companion's MCP
   * server set / tool allowlist is fixed in the `claude` process's own argv at spawn and cannot be changed on
   * a live pty — that half needs a conversation-preserving STOP + `--resume <engineSessionId>` respawn
   * (tracked separately; not implemented here — see the design note).
   */
  private refreshPersona(sessionId: string): boolean {
    if (!this.reinjectPersona) return false;
    try {
      return this.reinjectPersona(sessionId);
    } catch (err) {
      this.debug(`refreshPersona: reinject failed for ${sessionId}: ${describeError(err)}`);
      return false;
    }
  }

  /** The "/export" command's data source (commands.ts's `exportConversation` dep) — the current (open)
   *  conversation's messages, via the injected {@link historyExport}. `undefined` ⇒ no reader configured
   *  (e.g. a test construction that doesn't inject one); a throwing reader degrades to an empty list — an
   *  export must never crash the inbound path that's running it. */
  private exportConversation(sessionId: string): CompanionMessage[] {
    if (!this.historyExport) return [];
    try {
      return this.historyExport.read(sessionId);
    } catch (err) {
      this.debug(`exportConversation: history read failed for ${sessionId}: ${describeError(err)}`);
      return [];
    }
  }

  /** Best-effort inbound chat-history record for an ACCEPTED turn (unified cross-channel chat, card
   *  7d63e200) — generalizes controller.ts's in-app-only recordInboundMessageSafely to every channel the
   *  gateway routes. The injected recorder decides which channels to actually persist (the daemon's real
   *  impl skips in-app — see {@link CompanionMessageRecorder}). ADDITIONALLY (live-push card) pushes the
   *  SAME turn, under the SAME id, to any connected in-app web client via the injected `livePush` — so an
   *  open CompanionChat panel sees a Telegram message pop up without a reload; the real impl likewise skips
   *  in-app (that channel already renders live via its own dedicated path). Never throws: a history-record
   *  or live-push failure must never break the inbound path it's mirroring. */
  private recordInboundSafely(sessionId: string, channel: string, chatId: string, text: string, viaVoice: boolean): void {
    if (!this.recorder && !this.livePush) return;
    const id = randomUUID();
    if (this.recorder) {
      try {
        this.recorder.record(sessionId, channel, chatId, "user", text, viaVoice, id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[companion] inbound history record failed: ${describeError(err)}`);
      }
    }
    this.pushLiveSafely(sessionId, channel, "user", text, viaVoice, id);
  }

  /** Best-effort outbound chat-history record for a delivered/voiced reply (unified cross-channel chat,
   *  card 7d63e200) — generalizes in-app.ts's own outbound record hook to every channel; see
   *  {@link recordInboundSafely} / {@link CompanionMessageRecorder}. ADDITIONALLY live-pushes the reply —
   *  see {@link recordInboundSafely}'s live-push note. Never throws. */
  private recordOutboundSafely(sessionId: string, channel: string, chatId: string, text: string): void {
    if (!this.recorder && !this.livePush) return;
    const id = randomUUID();
    if (this.recorder) {
      try {
        this.recorder.record(sessionId, channel, chatId, "companion", text, false, id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[companion] outbound history record failed: ${describeError(err)}`);
      }
    }
    this.pushLiveSafely(sessionId, channel, "companion", text, false, id);
  }

  /** Shared live-push containment (live-push card): a push failure must NEVER break the record/inbound/
   *  reply path it's mirroring — contained exactly like {@link recordInboundSafely}/{@link
   *  recordOutboundSafely}'s own recorder try/catch. No-op when no `livePush` is injected. */
  private pushLiveSafely(sessionId: string, channel: string, author: "user" | "companion", text: string, viaVoice: boolean, id: string): void {
    if (!this.livePush) return;
    try {
      this.livePush.push(sessionId, { id, channel, author, text, viaVoice });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[companion] live cross-channel push failed: ${describeError(err)}`);
    }
  }

  /**
   * Best-effort ack back to a chat (swallows a send failure — an ack must never throw upward). An ack is
   * TRANSPORT CHROME, not conversation — `opts.record` defaults to `false` so it is never persisted as
   * companion chat history (matches Telegram's `send`, which never records; see the ChannelAdapter.send
   * doc). Pass `{ record: true }` only for the "/new"/"/reset" conversation-boundary marker (handleInbound's
   * command branch), which IS an intentional history row.
   *
   * Chunks a long ack to the adapter's max length exactly like `sendVia` (a slash-command ack — e.g.
   * `/export`/`/help` — can exceed a platform cap like Telegram's 4096 chars just as easily as a real
   * reply). No `maxMessageLength` (in-app) ⇒ `chunkText` is never invoked, so this is byte-identical for
   * in-app and for any ack that already fits in one chunk.
   */
  private async tryAck(binding: SessionBinding, text: string, opts?: { record?: boolean }): Promise<boolean> {
    const adapter = this.adapters.get(binding.channel);
    if (!adapter) return false;
    const parts = adapter.maxMessageLength ? chunkText(text, adapter.maxMessageLength) : [text];
    try {
      for (const part of parts) {
        await adapter.send(binding.chatId, part, { record: opts?.record === true });
      }
      return true;
    } catch (err) {
      this.debug(`ack send failed: ${describeError(err)}`);
      return false;
    }
  }

  /** Best-effort attachment download via the binding's adapter (Companion Voice epic, VOICE-P2) — contains
   *  a throw (never propagates) so a download failure degrades to "unavailable", exactly like a send
   *  failure. Returns null when the adapter doesn't implement downloadAttachment (e.g. in-app) or on ANY
   *  failure (network, size cap, timeout — see telegram.ts). */
  private async downloadAttachment(
    binding: SessionBinding,
    attachment: InboundAttachment,
  ): Promise<{ filePath: string; cleanup: () => Promise<void> } | null> {
    const adapter = this.adapters.get(binding.channel);
    if (!adapter?.downloadAttachment) return null;
    try {
      return (await adapter.downloadAttachment(attachment)) ?? null;
    } catch (err) {
      this.debug(`attachment download failed: ${describeError(err)}`);
      return null;
    }
  }

  /**
   * OUTBOUND. Route the agent's chat_reply(text) back OUT for `sessionId`. `replyTarget` picks the ONE
   * channel (single binding, else the proactive home) — never a broadcast, never a cross-wire. NEVER submits
   * a turn (that would loop back in). Chunks a long reply to the adapter's max length so it can't throw on a
   * platform cap. Returns a STRUCTURED result on every failure (unknown session / no adapter / send threw) —
   * the chat_reply MCP handler stays symmetric.
   *
   * @param voice  the agent's PER-REPLY voice request (VOICE-P4, card edd11203) — `chat_reply`'s optional
   *   `voice` flag, threaded through unchanged. Only consulted when the route's mode is `"auto"`; ignored
   *   entirely for `"on"`/`"off"` (the user's pref always wins there) — see tryDeliverVoice's gating.
   */
  async deliverReply(sessionId: string, text: string, voice?: boolean): Promise<DeliverResult> {
    // PURELY per-turn-route: the target is the ORIGINATING route of the session's in-flight turn (the pty
    // pinned it when the turn was formed). NO binding-based / home fallback and NO broadcast — a turn with no
    // reply-to route (not formed from a companion inbound / proactive-home submit) delivers NOWHERE. This is
    // what makes cross-delivery impossible by construction: the reply can only go where the turn came from.
    const target = this.replyTarget(sessionId);
    if (!target) return { delivered: false, reason: "no-target" };
    // VOICE REPLY (Companion Voice epic, VOICE-P3/P4) — attempted BEFORE the text send, never INSTEAD of it:
    // tryDeliverVoice resolves a DeliverResult only on a genuine voice-message success; ANY ineligibility
    // or failure (no synthesize dep, mode off, mode auto with no/false agent flag, adapter lacks sendVoice,
    // synth not ready/fails, sendVoice throws) resolves null and falls straight through to the EXISTING
    // text send below — the reply is NEVER lost to a voice-pipeline problem.
    if (this.synthesize) {
      const voiceResult = await this.tryDeliverVoice(sessionId, target, text, voice);
      if (voiceResult) {
        this.recordOutboundSafely(sessionId, target.channel, target.chatId, text);
        return voiceResult;
      }
    }
    const result = await this.sendVia(target.channel, target.chatId, text);
    if (!result.delivered) {
      // PARTIAL SEND (CR#2 L1): a chunked reply that fails on chunk k>1 has already reached the chat with
      // chunks 1..k-1 — recording NOTHING here would leave Loom history/the web panel with zero trace of a
      // reply the user actually received. Record exactly the prefix that was actually sent (chunkText's
      // splits are byte-lossless, so joining the sent chunks reconstructs that prefix exactly).
      if (result.reason === "send-failed" && result.sentChunks > 0) {
        this.recordOutboundSafely(sessionId, target.channel, target.chatId, result.sentText);
      }
      return result.reason === "no-adapter" ? { delivered: false, reason: "no-adapter" } : { delivered: false, reason: "send-failed" };
    }
    // CHAT HISTORY record (unified cross-channel chat, card 7d63e200): recorded ONCE per logical reply,
    // AFTER every chunk has succeeded — a long Telegram reply may take several `adapter.send` calls under
    // its maxMessageLength, but this fires once, mirroring in-app.ts's own "never >1 send call per logical
    // reply" recording point. NOT called from sendToChannel (the web→other-channels MIRROR, card 92b6445c):
    // that echoes an ALREADY-recorded user message with a disclaimer — recording it again here would
    // misattribute it as a companion reply.
    this.recordOutboundSafely(sessionId, target.channel, target.chatId, text);
    return { delivered: true, chunks: result.chunks };
  }

  /**
   * Attempt to synthesize `text` and deliver it as a native voice message on `target` (Companion Voice
   * epic, VOICE-P3/P4). Returns a DeliverResult on SUCCESS ONLY; returns null on ANY ineligibility or
   * failure so `deliverReply` falls through to the plain text send — this method NEVER throws (an OUTER
   * try/catch contains everything, including a throwing voicePrefs.resolve or a throwing adapter.sendVoice)
   * and the temp audio file is ALWAYS cleaned up (`finally`) once synthesize() has handed one back.
   *
   * @param agentVoice  the agent's per-reply voice request (VOICE-P4) — consulted ONLY in `"auto"` mode;
   *   `"on"`/`"off"` never look at it. `"off"` can NEVER be forced to voice by this flag (the user's opt-out
   *   is load-bearing); an omitted/false flag in `"auto"` mode conservatively stays TEXT (no surprise voice).
   */
  private async tryDeliverVoice(sessionId: string, target: CompanionRoute, text: string, agentVoice?: boolean): Promise<DeliverResult | null> {
    if (!this.synthesize) return null;
    try {
      // Outbound pref resolution FIRST — senderId is ALWAYS null (Companion Voice epic, VOICE-P3 fork #3):
      // a DM's inbound pref key is ALSO senderId:null (voicePrefRoute), so this matches exactly end-to-end
      // for the single-owner DM companion — the SUPPORTED path in P3. A GROUP binding's /voice on is stored
      // PER-SENDER (senderId = the authenticated sender who set it), but a reply addressed to the whole
      // chat has no single sender to resolve — so this senderId:null lookup NEVER finds a group's row and a
      // group's voice replies ALWAYS degrade to plain text in P3, even after a member turns them on. This is
      // an intentional, DOCUMENTED P3 limitation (group per-sender outbound voice is future work), not a bug
      // and not a "works, just chat-wide" fallback. Checked BEFORE isReady()/adapter capability so a route
      // that doesn't want voice replies never kicks TTS provisioning or does any other work on its account.
      const pref = this.voicePrefs.resolve({ sessionId, channel: target.channel, chatId: target.chatId, senderId: null });
      // The tri-state gate (VOICE-P4): "on" always speaks, "off" never does (the agent can't override it),
      // "auto" defers to the agent's PER-REPLY flag — an omitted/false flag stays text, never a surprise.
      const shouldSpeak = pref.voiceReplies === "on" || (pref.voiceReplies === "auto" && agentVoice === true);
      if (!shouldSpeak) return null;
      const adapter = this.adapters.get(target.channel);
      if (!adapter?.sendVoice) return null;
      if (!this.synthesize.isReady()) return null;
      const audio = await this.synthesize.synthesize({ text, lang: pref.ttsLang, voice: pref.ttsVoice });
      if (!audio) return null;
      try {
        await adapter.sendVoice(target.chatId, audio.filePath, text);
        return { delivered: true, chunks: 1 };
      } finally {
        await audio.cleanup().catch(() => { /* best-effort — cleanup must never block/throw */ });
      }
    } catch (err) {
      this.debug(`voice reply failed, degrading to text: ${describeError(err)}`);
      return null;
    }
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
   *  "the adapter's send threw". Pure outbound: never calls submitTurn, never consults inbound routing.
   *  On a mid-stream send failure, `sentChunks`/`sentText` report exactly what already reached the chat
   *  (chunks 1..k-1) — see deliverReply's partial-send record (CR#2 L1). */
  private async sendVia(channel: string, chatId: string, text: string): Promise<
    | { delivered: true; chunks: number }
    | { delivered: false; reason: "no-adapter" }
    | { delivered: false; reason: "send-failed"; sentChunks: number; sentText: string }
  > {
    const adapter = this.adapters.get(channel);
    if (!adapter) return { delivered: false, reason: "no-adapter" };
    const parts = adapter.maxMessageLength ? chunkText(text, adapter.maxMessageLength) : [text];
    let sent = 0;
    try {
      for (const part of parts) {
        await adapter.send(chatId, part);
        sent++;
      }
      return { delivered: true, chunks: parts.length };
    } catch (err) {
      this.debug(`sendVia send failed for ${channel}/${chatId}: ${describeError(err)}`);
      return { delivered: false, reason: "send-failed", sentChunks: sent, sentText: parts.slice(0, sent).join("") };
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

/** Sent when an audio inbound can't be transcribed right now (cold venv / download or subprocess failure)
 *  — Companion Voice epic, VOICE-P2. A friendly nudge, not a silent vanish. */
const STT_UNAVAILABLE_ACK = "🎙️ Voice transcription isn't ready yet — please try again in a moment, or type your message.";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
