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
import { isConfirmedDirectChat } from "./types.js";
import { allowIfDmMatch, type CompanionAuth } from "./auth.js";
import { noPairing, type CompanionPairing } from "./pairing.js";
import { inMemoryVoicePrefs, voicePrefRoute, type CompanionVoicePrefs } from "./voice-prefs.js";
import { parseCommand, commandHandler } from "./commands.js";
import { vendorProcessSlashCommand } from "../pty/claude-doctrine.js";
import { IN_APP_CHANNEL } from "./in-app.js";
import { companionRouteBlockReason, type CompanionRouteBlockReason } from "./reconcile.js";

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

  /** Binding route keys (`channel:chatId`) already warned for the "dm-scope binding, unconfirmed-direct
   *  inbound" security event (card b4f124d8) — see `warnUnconfirmedDirectInbound` below. */
  private readonly warnedUnconfirmedDirectBindings = new Set<string>();

  /** (session, route) keys (`sessionId:channel:chatId`) already warned for a `route-unbound` delivery
   *  refusal (card 1b0df437) — see `warnUnboundRouteRefused` below. */
  private readonly warnedUnboundRoutes = new Set<string>();

  /** (session, channel) keys already warned for a `route-foreign-session` delivery refusal (card c7d7b43a)
   *  — see `warnForeignSessionRouteRefused` below. Keyed WITHOUT the chatId (disclosure-safe, like the
   *  warning itself) — this should never fire under correct operation, so dedup is a courtesy against log
   *  spam, not a correctness requirement the way the other two warned-sets are. */
  private readonly warnedForeignSessionRoutes = new Set<string>();

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
   * @param proactiveResolver  the injected PER-TURN PROACTIVE resolver (proactive event-line producer) —
   *                    given a sessionId, returns whether the session's in-flight turn was a daemon-driven
   *                    heartbeat/reminder/attention-push submit (the pty host pins it when the turn is
   *                    formed — mirrors `originResolver`'s route resolution exactly). `deliverReply` reads
   *                    this ONCE per reply and tags the outbound frame + persisted history row so the web
   *                    chat renders the amber event line instead of an ordinary bubble. Defaults to
   *                    undefined (⇒ never proactive ⇒ every existing/test construction stays byte-identical);
   *                    the daemon injects `(sid) => pty.getActiveTurnIsProactive(sid)`.
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
    private readonly proactiveResolver: ((sessionId: string) => boolean) | undefined = undefined,
    /** Companion Trust Window close hook (Framework Card 0): revoke every trust window held for a
     *  session — called on a pairing re-bind (dm-bind / group-sender redemption, below) and threaded to
     *  the "/lock" command (commands.ts) via CommandDeps. Default undefined ⇒ every existing/test
     *  construction stays byte-identical (no-op). The daemon injects `(sid) =>
     *  orchMcp.closeCompanionTrustWindow(sid)` (index.ts, via CompanionControllerDeps). */
    private readonly closeTrustWindow: ((sessionId: string) => void) | undefined = undefined,
    /** Zero-reply detector (card 48e8d289): fired on a GENUINE successful `deliverReply` (never on
     *  `no-target`/`no-adapter`/`send-failed`) so the detector's baseline resets on every real chat_reply,
     *  not just proactive ones. ALSO fires on `route-flagged-non-private` (card 7578dea2) — see
     *  deliverReply's own comment at that check: a suppressed reply is still a genuine ATTEMPT, and its
     *  cause is a different, already-surfaced problem the zero-reply alarm must not also fire for. Default
     *  undefined ⇒ every existing/test construction stays byte-identical (no-op). The daemon injects
     *  `(sid) => db.recordChatReplyDelivered(sid)` (companion/factory.ts). */
    private readonly onReplyDelivered: ((sessionId: string) => void) | undefined = undefined,
    /** Outbound-suppression persistence hook (card 7578dea2): called when `warnUnconfirmedDirectInbound`
     *  (below) first observes `binding` as non-private, so the flag survives a restart — see
     *  CompanionBinding.flaggedNonPrivate's doc (shared/types.ts). Default undefined ⇒ every existing/test
     *  construction stays byte-identical (the in-memory `binding.flaggedNonPrivate` flip and the
     *  process-lifetime `warnedUnconfirmedDirectBindings` dedup both still happen regardless — this hook
     *  only adds durability). The daemon injects `(b) => db.flagCompanionBindingNonPrivate(b.sessionId,
     *  b.channel)` (factory.ts). Never allowed to throw out of the inbound path — the call site wraps it. */
    private readonly flagNonPrivateBinding: ((binding: SessionBinding) => void) | undefined = undefined,
    /** card d3f9b4d2 Minor 1: called with `sessionId` after a dm-bind pairing redemption re-binds a
     *  channel to a NEW chatId — a re-pair can orphan the home/a reminder still naming the OLD chat for
     *  that channel, same shape as an unbind or a REST re-bind. Default undefined ⇒ every existing/test
     *  construction stays byte-identical (no-op). factory.ts injects the shared
     *  companion/reconcile.ts helper, built from `db` (mirrors flagNonPrivateBinding's own pattern). */
    private readonly reconcileBindingChange: ((sessionId: string) => void | Promise<void>) | undefined = undefined,
    /** Observability hook (card 1b0df437): called at most ONCE per (session, route) PER DAEMON PROCESS —
     *  the dedup Set below resets on restart, so a route can warn again across a restart; see
     *  `warnUnboundRouteRefused` below — when a `chat_reply`/media delivery is refused with reason
     *  `route-unbound` (no live binding backs the target at all, e.g. a stale/bad companion HOME stored
     *  before 94754bbe's write-time guards existed). Unlike `route-flagged-non-private`
     *  (`flagNonPrivateBinding` above), there is no binding row to flag/surface here — without this hook
     *  the refusal was COMPLETELY silent: `onReplyDelivered` still resets the zero-reply streak every
     *  time (see deliverReply's own comment), so a bad home burned a heartbeat/reminder/attention-push
     *  turn forever with zero trace. Default undefined ⇒ every existing/test construction stays
     *  byte-identical (no-op; the console warning + process-lifetime dedup below still happen regardless
     *  — this hook only adds durability). The daemon injects `(sid, channel, chatId) =>
     *  db.recordCompanionUnboundRouteRefused(sid, channel, chatId)` (factory.ts). Never allowed to throw
     *  out of the outbound path — the call site wraps it. */
    private readonly onUnboundRouteRefused: ((sessionId: string, channel: string, chatId: string) => void) | undefined = undefined,
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

  /**
   * Whether `channel`/`chatId` currently has a live binding — the "may this chat receive at all" half of
   * `mayDeliverTo`'s predicate (card d3f9b4d2), exposed so a reconciliation caller (e.g. the bindings
   * unbind REST route, deciding whether a proactive home/reminder route that named this chat is now dead)
   * can ask the SAME question outbound delivery is gated on, rather than growing a second implementation.
   * IN_APP_CHANNEL is always considered live — it has no "unbound" state to fall into (see in-app.ts's own
   * doc: every gateway registers that adapter unconditionally, with no binding/provisioning required).
   */
  hasLiveBinding(channel: string, chatId: string): boolean {
    return channel === IN_APP_CHANNEL || this.bindingForInbound(channel, chatId) !== undefined;
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
      const red = this.pairing.redeem({ grantType: "dm-bind", channel: msg.channel, chatId: msg.chatId, senderId: msg.sender?.id, body: msg.body, chatIsDirect: msg.chatIsDirect });
      if (red.outcome === "bound") {
        this.bind(red.binding); // live-sync the routing map so this chat routes immediately (no restart)
        // Companion Trust Window close path (Framework Card 0): a fresh re-pair changes WHO may drive this
        // session — revoke any window a prior binding left behind rather than let it silently carry over.
        this.closeTrustWindow?.(red.binding.sessionId);
        // card d3f9b4d2 Minor 1: reconcile after every binding mutation, not just REST writes — a home/
        // reminder can still name a chat this channel previously pointed at. In practice this redemption
        // path only ever reaches a FIRST bind FOR THE REDEEMED CHANNEL (which may be this session's first
        // binding on ANY channel, or an additional channel added alongside an existing one — e.g. a
        // Telegram dm-bind on a session that already has its in-app binding), or an idempotent re-pair to
        // the SAME chatId: db.ts's upsertCompanionBinding dm-bind handler (SILENT-TAKEOVER REFUSAL, card
        // 4c9ef86d) refuses any redemption that would repoint an already-bound session at a DIFFERENT
        // chatId ON THAT SAME CHANNEL, so this call never actually sees an existing route REROUTED to
        // reconcile against (only ever a route ADDED) — it's still here for defense in depth and to stay
        // identical to every other binding-mutation call site. Wrapped in try/catch, like
        // flagNonPrivateBinding's own call site above, so a reconcile failure can never drop the PAIRED ack
        // that follows.
        try {
          await this.reconcileBindingChange?.(red.binding.sessionId);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[companion] dm-bind pairing reconcile failed: ${describeError(err)}`);
        }
        const acked = await this.tryAck(red.binding, PAIRED_ACK);
        this.debug(`inbound PAIRED (dm-bind): chat now bound (channel=${msg.channel} chat=${msg.chatId} session=${red.binding.sessionId})`);
        return { accepted: false, reason: "paired-dm", sessionId: red.binding.sessionId, acked };
      }
      this.debug(`inbound REJECTED: chat not allowlisted (channel=${msg.channel} chat=${msg.chatId})`);
      return { accepted: false, reason: "chat-not-allowlisted" };
    }
    // Per-binding SENDER authz (Companion authz layer) — the load-bearing deny gate. Placed IMMEDIATELY
    // after the route match and BEFORE submitTurn, so an unauthorized sender PROVABLY never reaches turn
    // submission. DM: authorized by the route match ONLY when the inbound itself CONFIRMS a private chat
    // (card b4f124d8 — see auth.ts / isConfirmedDirectChat). GROUP: requires an allowlisted sender.id; a
    // missing/unlisted sender is rejected here.
    if (!this.auth.isSenderAuthorized(binding, msg.sender, msg.chatIsDirect)) {
      // SECURITY (card b4f124d8): a `dm`-scope binding whose inbound did NOT confirm a private chat — the
      // binding may name a group/supergroup chatId (minted before card db49891d's write-side fix, or
      // hand-bound by a human). Logged once per binding, disclosure-safe (routing metadata only — no
      // message body, no sender identity) so a misconfigured binding is discoverable without spamming the
      // log on every retried inbound.
      if (binding.scope === "dm" && !isConfirmedDirectChat(msg.chatIsDirect)) {
        this.warnUnconfirmedDirectInbound(binding, msg.chatIsDirect);
      }
      // Companion DM-pairing: BEFORE rejecting an unauthorized sender on a matched GROUP binding, attempt a
      // `group-sender` redemption. SCOPED TO `group` ONLY (Code Review, card b4f124d8 follow-up): a `dm`
      // binding falling into this branch (the unconfirmed-direct-chat case just above) must NOT also
      // attempt a group-sender redemption — a group member holding a valid group-sender code for this
      // session would otherwise get "paired" (allowlist row written, code consumed, trust window closed)
      // while still remaining UNAUTHORIZED against the dm binding, misleading the owner and burning the
      // code for nothing. The added id is the AUTHENTICATED sender.id, and the code MUST be scoped to THIS
      // binding's session (enforced in the db txn) — a code for session A can't grant into group B. On
      // success the code text never reaches submitTurn; on failure we fall through to the SAME silent
      // reject below.
      if (binding.scope === "group") {
        const red = this.pairing.redeem({ grantType: "group-sender", channel: msg.channel, chatId: msg.chatId, senderId: msg.sender?.id, body: msg.body, bindingSessionId: binding.sessionId });
        if (red.outcome === "sender-added") {
          // Companion Trust Window close path (Framework Card 0): a new group member being paired in
          // changes WHO may drive this session — revoke every window so the fresh member (and everyone
          // else) starts cold, never inheriting an existing member's warm window.
          this.closeTrustWindow?.(binding.sessionId);
          const acked = await this.tryAck(binding, PAIRED_ACK);
          this.debug(`inbound PAIRED (group-sender): sender allowlisted (channel=${msg.channel} chat=${msg.chatId} session=${binding.sessionId})`);
          return { accepted: false, reason: "paired-sender", sessionId: binding.sessionId, acked };
        }
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
        closeTrustWindow: (sid) => this.closeTrustWindow?.(sid),
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
      // inbound's own (channel, chatId) — never a body-supplied one. `body` is ALSO passed as `ownerText`
      // (Companion injection-guard Primitive A) — this is the ONE place `body` is both the turn's text AND
      // the literal AUTHORIZED owner bytes forming it (past the allowlist + sender-authz gates above), so
      // getActiveTurnOwnerText can attest it for the sensitive ACT levers later cards will add. `senderId`
      // (Companion Trust Window) mirrors voicePrefRoute's own group-only rule: the authenticated sender for
      // a GROUP-scope binding, null for DM (the chatId alone already identifies the single owner) — so a
      // trust window keyed off it can never let one group member's confirm cover another's. Card f286919e:
      // that guarantee holds even once the pty host COALESCES this submit with another queued one into the
      // same turn (drainPending) — a coalesced batch spanning more than one sender (only reachable via the
      // legacy `coalesceAgentMessages:true` full-coalesce) has `submit()` null BOTH `activeTurnSenderId`
      // and the owner-text primitive together, by construction, rather than let a trust window read back
      // one member's id paired with a DIFFERENT member's attested words.
      submit = this.submitTurn(
        binding.sessionId, body, { channel: msg.channel, chatId: msg.chatId }, body,
        binding.scope === "group" ? (msg.sender?.id ?? null) : null,
      );
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
   *   (d) TRUST WINDOW / GRANT CLOSE — via the SAME `closeTrustWindow` dep used above (undefined ⇒ no-op):
   *       closes both the trust window and any live inline authored-content grant so neither silently
   *       survives this "/new"/"/reset" clean-slate boundary.
   *       @decision 2b26035c — sessionId does NOT change across "/new"/"/reset"; skipping this call
   *       is what lets the grant/trust window silently survive a reset instead of closing with it.
   *
   * Runs BEFORE the command's ack is sent (see handleInbound) — the persisted history is already empty and
   * any live viewer already cleared by the time the ack is recorded+pushed as the first message of the new,
   * empty conversation. Never throws.
   */
  private async resetConversation(sessionId: string): Promise<void> {
    try {
      // HarnessAdapter seam (card 2b099e48): the injected reset command is a vendor-process built-in
      // (Claude Code's "/clear"), not Loom's own — resolved via vendorProcessSlashCommand rather than a
      // hardcoded literal so a harness with no in-band equivalent (returns null) skips this half instead
      // of submitting a nonsense turn. Every harness registered today always returns "/clear" here.
      const resetCmd = vendorProcessSlashCommand("reset");
      if (resetCmd) this.submitTurn(sessionId, resetCmd);
    } catch (err) {
      this.debug(`resetConversation: reset-command submit failed for ${sessionId}: ${describeError(err)}`);
    }
    this.refreshPersona(sessionId);
    this.closeTrustWindow?.(sessionId);
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
        // An inbound turn is always the owner's own message, never proactive (that's an outbound-only tag).
        this.recorder.record(sessionId, channel, chatId, "user", text, viaVoice, id, false);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[companion] inbound history record failed: ${describeError(err)}`);
      }
    }
    this.pushLiveSafely(sessionId, channel, "user", text, viaVoice, id, false);
  }

  /** Best-effort outbound chat-history record for a delivered/voiced reply (unified cross-channel chat,
   *  card 7d63e200) — generalizes in-app.ts's own outbound record hook to every channel; see
   *  {@link recordInboundSafely} / {@link CompanionMessageRecorder}. ADDITIONALLY live-pushes the reply —
   *  see {@link recordInboundSafely}'s live-push note. `proactive` (proactive event-line producer) tags a
   *  heartbeat/reminder/attention-push-originated reply so the persisted row + live push both carry it —
   *  defaults false (every existing caller omitting it stays byte-identical). `viaVoice` (Companion Delivery
   *  Introspection) tags a reply actually DELIVERED as a synthesized voice clip rather than plain text —
   *  defaults false, so every text-send call site stays byte-identical; only the successful-voice branch of
   *  `deliverReply` passes true. Never throws. */
  private recordOutboundSafely(sessionId: string, channel: string, chatId: string, text: string, proactive = false, viaVoice = false): void {
    if (!this.recorder && !this.livePush) return;
    const id = randomUUID();
    if (this.recorder) {
      try {
        this.recorder.record(sessionId, channel, chatId, "companion", text, viaVoice, id, proactive);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[companion] outbound history record failed: ${describeError(err)}`);
      }
    }
    this.pushLiveSafely(sessionId, channel, "companion", text, viaVoice, id, proactive);
  }

  /** Shared live-push containment (live-push card): a push failure must NEVER break the record/inbound/
   *  reply path it's mirroring — contained exactly like {@link recordInboundSafely}/{@link
   *  recordOutboundSafely}'s own recorder try/catch. No-op when no `livePush` is injected. */
  private pushLiveSafely(sessionId: string, channel: string, author: "user" | "companion", text: string, viaVoice: boolean, id: string, proactive: boolean): void {
    if (!this.livePush) return;
    try {
      this.livePush.push(sessionId, { id, channel, author, text, viaVoice, proactive });
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
    // OUTBOUND SUPPRESSION (card 7578dea2 / d3f9b4d2): covers chat_reply AND every heartbeat/reminder/
    // attention-push reply — all resolve through this same method (see deliveryBlockReason's doc).
    const blockReason = this.deliveryBlockReason(target.channel, target.chatId, sessionId);
    if (blockReason) {
      // Zero-reply detector (card 48e8d289) hardening: this IS a genuine chat_reply ATTEMPT — the agent
      // called it, and the reason it can't land is a PERMANENT, already-surfaced-elsewhere condition (the
      // binding-flag UI/log, or — card 1b0df437 — the once-per-(session,route) log/event below for an
      // unbound route), not the agent going silent/stuck. Firing onReplyDelivered here resets that
      // detector's "turns since last reply" baseline so it can never misfire `companion_zero_reply_detected`
      // for a companion that is actively trying every turn — that alarm exists to catch an UNDIAGNOSED
      // silence, and this cause is already fully diagnosed and surfaced through a different channel; letting
      // both fire for the same root cause would misdirect a human toward "the agent is stuck" instead of
      // "re-bind the channel" / "fix the home".
      if (blockReason === "route-unbound") this.warnUnboundRouteRefused(sessionId, target.channel, target.chatId);
      if (blockReason === "route-foreign-session") this.warnForeignSessionRouteRefused(sessionId, target.channel); // card c7d7b43a
      this.onReplyDelivered?.(sessionId);
      return { delivered: false, reason: blockReason };
    }
    // Loom Companion (proactive event-line producer): resolve ONCE whether the turn this reply answers was
    // a daemon-driven heartbeat/reminder/attention-push submit — read via the SAME per-turn mechanism as
    // `target` above (the pty pins it when the turn is formed), so it can never drift from the turn this
    // reply is actually answering. Threaded to every record/send path below.
    const proactive = this.isProactive(sessionId);
    // VOICE REPLY (Companion Voice epic, VOICE-P3/P4) — attempted BEFORE the text send, never INSTEAD of it:
    // tryDeliverVoice resolves a DeliverResult only on a genuine voice-message success; ANY ineligibility
    // or failure (no synthesize dep, mode off, mode auto with no/false agent flag, adapter lacks sendVoice,
    // synth not ready/fails, sendVoice throws) resolves null and falls straight through to the EXISTING
    // text send below — the reply is NEVER lost to a voice-pipeline problem.
    if (this.synthesize) {
      const voiceResult = await this.tryDeliverVoice(sessionId, target, text, voice, proactive);
      if (voiceResult) {
        this.recordOutboundSafely(sessionId, target.channel, target.chatId, text, proactive, true);
        this.onReplyDelivered?.(sessionId);
        return voiceResult;
      }
    }
    const result = await this.sendVia(sessionId, target.channel, target.chatId, text, { proactive });
    if (!result.delivered) {
      // PARTIAL SEND (CR#2 L1): a chunked reply that stopped on chunk k>1 (a send failure, OR — card
      // 7578dea2 — a mid-flight flag flip) has already reached the chat with chunks 1..k-1 — recording
      // NOTHING here would leave Loom history/the web panel with zero trace of a reply the user actually
      // received. Record exactly the prefix that was actually sent (chunkText's splits are byte-lossless,
      // so joining the sent chunks reconstructs that prefix exactly).
      if (result.reason !== "no-adapter" && result.sentChunks > 0) {
        this.recordOutboundSafely(sessionId, target.channel, target.chatId, result.sentText, proactive);
      }
      if (result.reason === "no-adapter") return { delivered: false, reason: "no-adapter" };
      if (result.reason === "route-flagged-non-private" || result.reason === "route-unbound" || result.reason === "route-foreign-session") {
        // Zero-reply detector (card 48e8d289) hardening, card 7578dea2 / d3f9b4d2: a MID-FLIGHT suppression
        // is still a genuine chat_reply attempt, exactly like the up-front deliveryBlockReason gate above —
        // see that gate's own comment on why this resets the streak instead of letting it accumulate
        // toward a misfire.
        if (result.reason === "route-unbound") this.warnUnboundRouteRefused(sessionId, target.channel, target.chatId); // card 1b0df437
        if (result.reason === "route-foreign-session") this.warnForeignSessionRouteRefused(sessionId, target.channel); // card c7d7b43a
        this.onReplyDelivered?.(sessionId);
        return { delivered: false, reason: result.reason };
      }
      return { delivered: false, reason: "send-failed" };
    }
    // CHAT HISTORY record (unified cross-channel chat, card 7d63e200): recorded ONCE per logical reply,
    // AFTER every chunk has succeeded — a long Telegram reply may take several `adapter.send` calls under
    // its maxMessageLength, but this fires once, mirroring in-app.ts's own "never >1 send call per logical
    // reply" recording point. NOT called from sendToChannel (the web→other-channels MIRROR, card 92b6445c):
    // that echoes an ALREADY-recorded user message with a disclaimer — recording it again here would
    // misattribute it as a companion reply.
    this.recordOutboundSafely(sessionId, target.channel, target.chatId, text, proactive);
    this.onReplyDelivered?.(sessionId);
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
   * @param proactive  Loom Companion (proactive event-line producer) — threaded through to `adapter.sendVoice`
   *   exactly like `send`'s `opts.proactive`, so an adapter that self-records on the voice path (in-app) can
   *   tag its OWN frame + history row (unlike `send`, `sendVoice` REPLACES the record/deliver step entirely on
   *   the voice path — see in-app.ts's `sendVoice` doc — so this can't ride the generic recordOutboundSafely
   *   tagging alone).
   */
  private async tryDeliverVoice(sessionId: string, target: CompanionRoute, text: string, agentVoice?: boolean, proactive = false): Promise<DeliverResult | null> {
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
      // Cheap hardening (card 7578dea2): re-check right before the actual send, not just once at
      // deliverReply's own entry — synth (above) is async and can take real time, during which a
      // concurrent inbound could flip this route to flagged. Returning null (not a DeliverResult) falls
      // through to the plain-text sendVia path below, whose OWN per-chunk mayDeliverTo check (see sendVia)
      // then correctly reports route-flagged-non-private rather than sending voice to a route that just
      // got flagged mid-synth.
      if (!this.mayDeliverTo(target.channel, target.chatId, sessionId)) return null;
      try {
        await adapter.sendVoice(target.chatId, audio.filePath, text, proactive);
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
   * OUTBOUND MEDIA — the `media-out` lever's delivery seam (card 3a81b0f2, "show me the latest mockup";
   * in-app delivery added by card 9ec79b52). Resolves the target EXACTLY like `deliverReply` (the
   * ORIGINATING route of `sessionId`'s in-flight turn, via `replyTarget` — no binding/home fallback, no
   * broadcast), then sends `filePath` through the target adapter's OPTIONAL `sendMedia` instead of `send`.
   * An adapter with no `sendMedia` at all (every channel today implements it — Telegram and in-app — this
   * is future-proofing for one that doesn't) degrades to `{delivered:false, reason:"unsupported-channel"}`
   * rather than throwing, so the lever can tell the owner where the file is instead of failing outright. No
   * chunking (a file is one unit, unlike a long text reply) and no chat-history record (media isn't part of
   * the text conversation log `companion_messages.text` models). Never throws — a throwing `sendMedia` is
   * contained and reported as `{delivered:false, reason:"send-failed"}`.
   */
  async deliverMedia(sessionId: string, filePath: string): Promise<{ delivered: boolean; reason?: string }> {
    const target = this.replyTarget(sessionId);
    if (!target) return { delivered: false, reason: "no-target" };
    const blockReason = this.deliveryBlockReason(target.channel, target.chatId, sessionId); // card 7578dea2 / d3f9b4d2
    if (blockReason) {
      if (blockReason === "route-unbound") this.warnUnboundRouteRefused(sessionId, target.channel, target.chatId); // card 1b0df437
      if (blockReason === "route-foreign-session") this.warnForeignSessionRouteRefused(sessionId, target.channel); // card c7d7b43a
      return { delivered: false, reason: blockReason };
    }
    const adapter = this.adapters.get(target.channel);
    if (!adapter) return { delivered: false, reason: "no-adapter" };
    if (!adapter.sendMedia) return { delivered: false, reason: "unsupported-channel" };
    try {
      await adapter.sendMedia(target.chatId, filePath);
      return { delivered: true };
    } catch (err) {
      this.debug(`deliverMedia send failed for ${target.channel}/${target.chatId}: ${describeError(err)}`);
      return { delivered: false, reason: "send-failed" };
    }
  }

  /**
   * OUTBOUND MIRROR primitive: send a plain, non-reply message to an EXPLICIT (channel, chatId) — never
   * resolved from a turn's origin (unlike deliverReply/replyTarget). Callers pass a route already known to
   * be one of `sessionId`'s own bound channels (see bindingsForSession) — the ONLY binding lookup this does
   * is the `mayDeliverTo` suppression check (card 7578dea2) below, a read-only routing-map lookup, never
   * inbound routing. It NEVER calls submitTurn and never touches bindingForInbound/handleInbound's INBOUND
   * path, so it structurally cannot form a turn or loop a mirrored message back in. Used to echo a web-chat
   * turn out to the session's other bound channels (e.g. Telegram) with a disclaimer — the caller composes
   * that text; this just sends it. `sessionId` (card c7d7b43a) is threaded to `deliveryBlockReason` as the
   * requesting session — every real caller already resolves `channel`/`chatId` from THIS session's own
   * `bindingsForSession`, so the ownership check is a no-op in practice, same as every other scoped caller.
   */
  async sendToChannel(sessionId: string, channel: string, chatId: string, text: string): Promise<DeliverResult> {
    const blockReason = this.deliveryBlockReason(channel, chatId, sessionId); // card 7578dea2 / d3f9b4d2
    if (blockReason) {
      if (blockReason === "route-foreign-session") this.warnForeignSessionRouteRefused(sessionId, channel); // card c7d7b43a
      return { delivered: false, reason: blockReason };
    }
    const result = await this.sendVia(sessionId, channel, chatId, text);
    if (!result.delivered) {
      if (result.reason === "no-adapter") return { delivered: false, reason: "no-adapter" };
      // card 7578dea2 / d3f9b4d2 hardening: sendVia's own per-chunk recheck caught a mid-flight flag flip
      // or unbind. Not a chat_reply, so no onReplyDelivered here — the zero-reply detector only tracks
      // chat_reply/deliverReply.
      if (result.reason === "route-flagged-non-private" || result.reason === "route-unbound" || result.reason === "route-foreign-session") return { delivered: false, reason: result.reason };
      return { delivered: false, reason: "send-failed" };
    }
    return { delivered: true, chunks: result.chunks };
  }

  /** Shared outbound send: chunk to the adapter's max length and send every part, in order. Contains a
   *  throw (never propagates) — the only failure modes are "no adapter registered for this channel", "the
   *  adapter's send threw", and (card 7578dea2 / d3f9b4d2) "the route got flagged non-private, or lost its
   *  live binding, mid-flight". On a mid-stream stop, `sentChunks`/`sentText` report exactly what already
   *  reached the chat (chunks 1..k-1) — see deliverReply's partial-send record (CR#2 L1). `opts.proactive`
   *  (proactive event-line producer) is forwarded to the adapter's `send` verbatim — `sendToChannel`'s
   *  mirror-echo caller omits it (never proactive), only `deliverReply` passes it. `sessionId` (card
   *  c7d7b43a) is the REQUESTING session, threaded to every per-chunk `deliveryBlockReason` recheck below. */
  private async sendVia(sessionId: string, channel: string, chatId: string, text: string, opts?: { proactive?: boolean }): Promise<
    | { delivered: true; chunks: number }
    | { delivered: false; reason: "no-adapter" }
    | { delivered: false; reason: "send-failed" | "route-flagged-non-private" | "route-unbound" | "route-foreign-session"; sentChunks: number; sentText: string }
  > {
    const adapter = this.adapters.get(channel);
    if (!adapter) return { delivered: false, reason: "no-adapter" };
    const parts = adapter.maxMessageLength ? chunkText(text, adapter.maxMessageLength) : [text];
    let sent = 0;
    try {
      for (const part of parts) {
        // Cheap hardening (card 7578dea2 / d3f9b4d2): every caller already checked deliveryBlockReason ONCE
        // before calling sendVia — this re-checks on EVERY chunk, so a concurrent inbound flipping the flag
        // (or an unbind) mid-flight (between two chunks of a long reply) stops the REST of the reply
        // instead of finishing a send that started before the route went bad.
        const blockReason = this.deliveryBlockReason(channel, chatId, sessionId);
        if (blockReason) {
          return { delivered: false, reason: blockReason, sentChunks: sent, sentText: parts.slice(0, sent).join("") };
        }
        await adapter.send(chatId, part, opts);
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

  /**
   * Whether `sessionId`'s IN-FLIGHT turn was a daemon-driven proactive submit (heartbeat/reminder/
   * attention-push), via the injected proactiveResolver (pty.getActiveTurnIsProactive) — mirrors {@link
   * replyTarget} exactly. False when no resolver is injected, and a throwing resolver degrades to false
   * (never breaks a reply path).
   */
  private isProactive(sessionId: string): boolean {
    try { return this.proactiveResolver?.(sessionId) ?? false; } catch { return false; }
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

  /**
   * SECURITY (card b4f124d8), ALWAYS ON (unlike `debug` above): a `dm`-scope binding rejected an inbound
   * the channel did not confirm as a private chat — a strong signal the binding names a group/supergroup
   * chatId. Logged at most ONCE per binding (keyed by its route, not the session — a re-bound session gets
   * a fresh warning if it names a new route) so a misconfigured binding surfaces without spamming the log
   * on every retried inbound from the same chat. Disclosure-safe: only server-known routing metadata
   * (session id, channel) — never the binding's own chatId, nor the inbound's `body`/`sender`, all of
   * which are either identifying or untrusted, attacker-influenced content.
   */
  private warnUnconfirmedDirectInbound(binding: SessionBinding, chatIsDirect: boolean | undefined): void {
    // OUTBOUND SUPPRESSION (card 7578dea2): flip the flag on the SAME object stored in the live routing map
    // — mayDeliverTo reads it straight off `bindingForInbound`'s return, so this takes effect immediately,
    // no re-bind/restart needed. Done UNCONDITIONALLY (before the once-per-route log dedup below), since a
    // binding restored from the db already flagged (persisted by a PRIOR process) still needs this in-memory
    // flip on THIS process's fresh warnedUnconfirmedDirectBindings Set — the log line is once-per-process,
    // the flag is not.
    binding.flaggedNonPrivate = true;
    try {
      this.flagNonPrivateBinding?.(binding);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[companion] persisting non-private binding flag failed: ${describeError(err)}`);
    }
    const key = `${binding.channel}:${binding.chatId}`;
    if (this.warnedUnconfirmedDirectBindings.has(key)) return;
    this.warnedUnconfirmedDirectBindings.add(key);
    const confirmedState = chatIsDirect === undefined ? "unknown (not reported)" : String(chatIsDirect);
    // eslint-disable-next-line no-console
    console.warn(
      `[companion] SECURITY: dm-scope binding (session=${binding.sessionId} channel=${binding.channel}) ` +
        `rejected an inbound whose chat was NOT confirmed private (chatIsDirect=${confirmedState}). Outbound ` +
        `delivery to this route is now suppressed (card 7578dea2). This binding may name a group/supergroup ` +
        `chat — re-bind it with scope "group", or delete it, if so.`,
    );
  }

  /**
   * SECURITY/observability (card 1b0df437): `deliveryBlockReason` returned `route-unbound` for a
   * `sessionId` delivery attempt — unlike a flagged binding (`warnUnconfirmedDirectInbound` above), there
   * is NO binding row here to flag/surface (an unbound route has none, by definition), so this was
   * otherwise COMPLETELY silent: no log, no event, while `onReplyDelivered` still resets the zero-reply
   * streak every time (see deliverReply's own comment on why that reset is still correct once this is no
   * longer silent). Logged + durably eventED at most ONCE per (session, route) per daemon process — keyed
   * on the session too (unlike the flagged-binding warn above, which is route-only), since a route-unbound
   * refusal has no binding row to key off and the SAME route could in principle be a different session's
   * home after a future rebind. Disclosure-safe console log (session id + channel only, never the chatId —
   * same posture as `warnUnconfirmedDirectInbound`); the durable event's `detail` DOES carry the chatId
   * (same as `companion_home_cleared`/`companion_reminder_rerouted` — a project-scoped durable record, not
   * a public log).
   *
   * @decision 1b0df437 — never read `CompanionReplyStatus.homeRouteRefused` (the UI banner) off this
   * event; it is LIVE-derived from current home+binding state so it self-heals on a fix, while this
   * durable event is an audit trail that stays fired once per (session, route) per process.
   */
  private warnUnboundRouteRefused(sessionId: string, channel: string, chatId: string): void {
    const key = `${sessionId}:${channel}:${chatId}`;
    if (this.warnedUnboundRoutes.has(key)) return;
    this.warnedUnboundRoutes.add(key);
    // eslint-disable-next-line no-console
    console.warn(
      `[companion] session ${sessionId} chat_reply/media delivery route (channel=${channel}) was refused ` +
        `— no live binding backs this route (card 1b0df437). If this is the companion's HOME, fix it via ` +
        `PUT /api/companion/home; if it's a reminder's own pinned route, update or delete that reminder.`,
    );
    try {
      this.onUnboundRouteRefused?.(sessionId, channel, chatId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[companion] persisting unbound-route-refused event failed: ${describeError(err)}`);
    }
  }

  /**
   * SECURITY (card c7d7b43a, defense in depth): `deliveryBlockReason` returned `route-foreign-session` — the
   * route `sessionId` is attempting to deliver to is backed by a binding belonging to a DIFFERENT session.
   * This should never happen via today's REST surface (every binding-mutating route scopes writes to one
   * session, and `replyTarget` is pinned per-turn from that SAME session's own origin resolver) — if it ever
   * fires, it signals a bug elsewhere, not a benign config issue, so unlike `warnUnboundRouteRefused` this
   * is logged ALWAYS ON (not behind `LOOM_COMPANION_DEBUG`). Deduped per (session, channel) PER DAEMON
   * PROCESS (resets on restart). Disclosure-safe: session id + channel only, never the chatId (same posture
   * as `warnUnboundRouteRefused`/`warnUnconfirmedDirectInbound`).
   */
  private warnForeignSessionRouteRefused(sessionId: string, channel: string): void {
    const key = `${sessionId}:${channel}`;
    if (this.warnedForeignSessionRoutes.has(key)) return;
    this.warnedForeignSessionRoutes.add(key);
    // eslint-disable-next-line no-console
    console.warn(
      `[companion] SECURITY: session ${sessionId} attempted chat_reply/media delivery on channel=${channel} ` +
        `to a route owned by another session — refused (card c7d7b43a). This should never happen ` +
        `via normal use; if seen, investigate how this session's reply target came to name another ` +
        `session's route.`,
    );
  }

  // @decision 7578dea2 — outbound suppression to a flagged route is SILENT; never send even a re-bind
  // notice to it (that would itself be a disclosure to an unauthorized chat). See the full record.
  //
  // card d3f9b4d2: the SAME silent-suppression posture now ALSO applies to a route with no live binding at
  // all (never bound, or revoked since the turn carrying this route was formed — e.g. a proactive home or
  // reminder route surviving past its binding's unbind). The one true "may this chat receive" predicate
  // every outbound producer (deliverReply/deliverMedia/sendToChannel/sendVia's per-chunk recheck) gates
  // through — see `deliveryBlockReason` for the discriminated reason each of them actually reports.
  private mayDeliverTo(channel: string, chatId: string, sessionId: string): boolean {
    return this.deliveryBlockReason(channel, chatId, sessionId) === undefined;
  }

  /** The discriminated reason `channel`/`chatId` may NOT currently receive outbound FROM `sessionId`, or
   *  undefined when it may — `mayDeliverTo`'s own boolean collapses this; every real call site needs the
   *  actual reason to report on its DeliverResult, so this is the one implementation both read from. The
   *  actual decision is `companionRouteBlockReason` (reconcile.ts) — shared with `warnStaleStoredHomes`,
   *  the reply status's `homeRouteRefused`, and `validateHomeTarget` (card ddf08614) — this method's own
   *  job is just resolving the binding (`bindingForInbound`, scoped to THIS gateway instance's own routing
   *  map) that predicate needs. `sessionId` is passed through as `requestingSessionId` (card c7d7b43a) —
   *  see that predicate's own doc for why the real cross-session vector it guards is the shared in-app
   *  adapter, not a global binding lookup (every gateway instance is built per-session in production). */
  private deliveryBlockReason(channel: string, chatId: string, sessionId: string): CompanionRouteBlockReason | undefined {
    return companionRouteBlockReason({ channel, chatId }, this.bindingForInbound(channel, chatId), sessionId);
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
