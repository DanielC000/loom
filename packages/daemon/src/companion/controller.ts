/**
 * Loom Companion — the HOT LIFECYCLE controller (Companion epic Phase 3 backend, generalized to
 * MULTI-companion by the multi-companion runtime card). Closes the "no .env, no restart" headline of the
 * PL ruling: it makes the REST config writes (POST/PUT/DELETE at /api/companion/config) drive the RUNNING
 * gateway(s) LIVE, instead of applying only on the next daemon boot.
 *
 * It owns — as ONE stable facade the REST + MCP hooks hold across gateway rebuilds — ONE live ChatGateway
 * (Telegram long-poll) + ONE proactive CompanionHeartbeatWatcher + ONE CompanionReminderWatcher PER ENABLED
 * companion config, keyed by session id, all sharing the SAME stable in-app hub (`deps.inApp`, threaded
 * into every gateway build). `reconcile()` diffs the FULL live set against the FULL enabled set every time:
 *   • a session newly in the enabled set (not yet live) → START: build + start() its gateway, arm its
 *     heartbeat if cadence>0, arm its reminders, and add it to the chat_reply gate — NO restart of anyone
 *     else's gateway.
 *   • a session in both (live AND still enabled) → UPDATE: apply changes live — a cadence/prompt change
 *     re-arms/disarms THAT session's heartbeat; a token change RESTARTS THAT session's adapter (stop old
 *     long-poll, build+start fresh); a home change is already live (the gateway's homeResolver reads
 *     app_meta each deliver). Every OTHER live session is untouched.
 *   • a session live but no longer in the enabled set (disabled/deleted) → STOP: tear down THAT session's
 *     adapter/heartbeat/reminders and drop it from the chat_reply gate — the daemon returns that ONE
 *     session to the SAME OFF state as an unconfigured boot, every other live companion untouched
 *     (default-OFF byte-identical when the set is empty).
 *
 * It REUSES the existing primitives verbatim — createCompanionGateway (bind/adapter/inbound wiring),
 * ChatGateway.start()/stop()/bind()/unbind(), CompanionHeartbeatWatcher, CompanionReminderWatcher, and the
 * chat_reply hook gate the OrchestrationMcpRouter reads per MCP request — one instance of each PER SESSION,
 * never a parallel/second lifecycle path. A single-enabled-config daemon reconciles through the exact same
 * start/update/stop diff as today (the enabled SET just happens to have one member), so the single-companion
 * case stays byte-identical.
 *
 * IDEMPOTENCY + no-leak (load-bearing): every reconcile is SERIALIZED on an internal promise chain, so a
 * burst of REST writes can't interleave a teardown with a start; startGatewayFor refuses to stack a second
 * adapter for the SAME session, stopGatewayFor clears that session's map entry BEFORE awaiting the old
 * stop (a racing deliverReply/bind for that session can't touch a stopping gateway — a DIFFERENT session's
 * entry is untouched throughout), and a token change AWAITS the old long-poll's stop before starting the
 * new one — so repeated enable/disable toggles never leak a long-poll or double-register chat_reply, for
 * any session.
 *
 * SECURITY (load-bearing, generalized — do NOT regress): inbound = pty.enqueueStdin, outbound =
 * chat_reply→deliverReply, never cross-wired; chat_reply is gated PER SESSION (`companionSessionIds.has`,
 * a Set membership test — the sessionId tested is always the MCP server's OWN closed-over session id, never
 * agent-suppliable) instead of a single equality check. `deliverReply`/`bind`/`unbind`/`handleInAppInbound`/
 * `handleInAppAudioInbound` all dispatch through `this.gateways.get(sessionId)` — the SAME sessionId the
 * caller already owns (a companion's own MCP tool call, a REST :sessionId param, or a binding's own
 * sessionId — never attacker-suppliable) — so a given companion's turn can ONLY ever reach ITS OWN
 * gateway/adapter/bindings, never another companion's. `factory.ts`'s `createCompanionGateway` additionally
 * scopes the bindings it loads to `cfg.sessionId` (not the global binding table), so even a gateway's OWN
 * routing map can never contain another session's binding — belt-and-suspenders on top of the by-sessionId
 * dispatch above. Authz stays fail-closed at inbound time (the gateway's per-binding CompanionAuth,
 * unchanged). This controller only (re)wires the SAME parts, once per session.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { ChatGateway } from "./chat-gateway.js";
import { createCompanionGateway } from "./factory.js";
import { CompanionHeartbeatWatcher, type HeartbeatPty } from "./heartbeat.js";
import { CompanionReminderWatcher } from "./reminders.js";
import { resolveAllEnabledConfigs } from "./store.js";
import { IN_APP_CHANNEL, normalizeInAppMessage, type InAppChannel } from "./in-app.js";
import type { CompanionConfig } from "./config.js";
import type { CompanionRoute, CompanionSynthesizer, CompanionTranscriber, DeliverResult, InboundMessage, InboundResult, SessionBinding, SubmitTurn } from "./types.js";

/** The minimal lifecycle handle the controller needs from a heartbeat watcher (satisfied by
 *  CompanionHeartbeatWatcher; narrowed so a test can inject a spy). */
export interface HeartbeatHandle {
  start(): void;
  stop(): void;
}

/** The minimal lifecycle handle the controller needs from a reminder watcher (satisfied by
 *  CompanionReminderWatcher; narrowed so a test can inject a spy) — same shape as HeartbeatHandle. */
export interface ReminderHandle {
  start(): void;
  stop(): void;
}

/** The minimal facade the human-only companion REST + shutdown hold — a STABLE reference that survives a
 *  gateway rebuild (the REST closures capture this once at buildServer time). */
export interface CompanionControl {
  /** Live-sync a new/edited binding into the running gateway's routing map (no-op when OFF). */
  bind(binding: SessionBinding): void;
  /** Live-remove a binding from the running gateway's routing map (no-op when OFF). When `channel` is
   *  given, removes only that ONE channel's entry, leaving the session's other channel(s) routing. */
  unbind(sessionId: string, channel?: string): void;
  /** Reconcile the live companion to the CURRENT DB config after a REST config write (the hot path). */
  reconcile(): Promise<void>;
  /**
   * INBOUND for the in-app channel: a message typed in the cockpit companion chat panel, routed through the
   * SAME bindings-authoritative gateway (chatId == the companion session id). Stable indirection over the
   * CURRENT gateway (symmetric with deliverReply) so it never targets a torn-down one; returns "companion-off"
   * when no gateway is live. The /ws/companion route calls this. An ACCEPTED turn is also (fire-and-forget)
   * MIRRORED out to the session's other bound channels — see mirrorWebInputToOtherChannels.
   */
  handleInAppInbound(sessionId: string, body: string): Promise<InboundResult | { accepted: false; reason: "companion-off" }>;
  /**
   * INBOUND for a web-mic voice clip (Companion Voice epic, VOICE-P4). `filePath` is the SERVER-GENERATED
   * temp file the /ws/companion route already decoded the client's base64 audio into
   * (in-app.ts's `decodeInAppAudioToTempFile`) — never a client-supplied path. Mirrors `handleInAppInbound`
   * exactly, except the final text isn't known up front (it's the STT transcript, resolved INSIDE
   * `gateway.handleInbound`) — so recording + the cross-channel mirror + the live "your turn" echo all read
   * it off the result's `submittedText` instead of a passed-in `body`. Returns "companion-off" when no
   * gateway is live; never throws.
   */
  handleInAppAudioInbound(sessionId: string, filePath: string): Promise<InboundResult | { accepted: false; reason: "companion-off" }>;
  /** Best-effort teardown on daemon shutdown (stops the adapter long-poll + the heartbeat). */
  stop(): Promise<void>;
}

/** The mutable chat_reply gate the OrchestrationMcpRouter reads per MCP request. The controller adds/removes
 *  a session's id in `companionSessionIds` as THAT companion starts/stops so chat_reply (un)registers for
 *  it with no restart (every other live companion's membership is untouched), and routes `deliverReply`
 *  back through the controller so it always targets that session's CURRENT gateway. */
export interface CompanionReplyHooks {
  companionSessionIds: Set<string>;
  deliverReply?: (sessionId: string, text: string, voice?: boolean) => Promise<{ delivered: boolean; reason?: string }>;
  /**
   * Server-derived route capture for the reminder_create MCP tool (mirrors wake_me's getActiveTurnOrigin) —
   * consumed by the orchestration MCP router, not by this controller.
   */
  getActiveTurnOrigin?: (sessionId: string) => CompanionRoute | null;
  /**
   * (Re)arm/disarm the live reminder watcher after a reminder_create/cancel MCP write — ARM-ON-CREATE
   * (Companion Memory & Reminders Design, Surface 2 s4). Wired to `() => controller.reconcile()`: a
   * reminder CRUD write lands in its own table, independent of CompanionConfig, so re-running the SAME
   * reconcile a config write already triggers is the only way this path picks up the new/removed row
   * (see rearmReminders' unconditional call in applyDesired). Consumed by the orchestration MCP router,
   * not by this controller.
   */
  rearmReminders?: () => Promise<void>;
}

export interface CompanionControllerDeps {
  db: Db;
  /** The pty turn-submit primitive handed to the gateway (kept db-free; index passes enqueueStdin). */
  submitTurn: SubmitTurn;
  /** The pty slice the heartbeat watcher needs (isAlive / enqueueStdin / getPending). */
  pty: HeartbeatPty;
  /** The chat_reply gate the OrchestrationMcpRouter reads — the controller mutates it on start/stop. */
  hooks: CompanionReplyHooks;
  /** Process env — read to resolve the EFFECTIVE config (which session env pins), never re-bootstrapped. */
  env: NodeJS.ProcessEnv;
  /** The STABLE in-app transport hub (default companion channel). Threaded into the default gateway builder
   *  so every built gateway registers its adapter (outbound in-app delivery) — see createCompanionGateway.
   *  Optional: absent ⇒ no in-app channel is registered (Telegram-only / test seams). */
  inApp?: InAppChannel;
  /** The per-turn ORIGIN resolver (multi-channel reply routing) threaded into the default gateway builder —
   *  the daemon injects `(sid) => pty.getActiveTurnOrigin(sid)` so chat_reply delivers to the in-flight
   *  turn's originating route. Optional: absent ⇒ deliverReply has no target (test seams that don't exercise
   *  reply routing). */
  originResolver?: (sessionId: string) => CompanionRoute | null;
  /** The injected STT transcriber (Companion Voice epic, VOICE-P2), threaded into the default gateway
   *  builder exactly like `inApp`/`originResolver` — STABLE across a gateway rebuild (a token change never
   *  drops STT). Optional: absent ⇒ every built gateway's audio inbound is a no-op (default OFF). */
  transcribe?: CompanionTranscriber;
  /** The injected TTS synthesizer (Companion Voice epic, VOICE-P3), threaded into the default gateway
   *  builder exactly like `transcribe` — STABLE across a gateway rebuild. Optional: absent ⇒ every built
   *  gateway's deliverReply is byte-identical to today (no synth attempted, default OFF). */
  synthesize?: CompanionSynthesizer;
  /** Envelope key-file override (test seam only). */
  keyPath?: string;
  /** Build the gateway for an effective config (test seam — defaults to createCompanionGateway with the
   *  real Telegram adapter). Returns the gateway NOT started; the controller calls start(). */
  buildGateway?: (cfg: CompanionConfig, submitTurn: SubmitTurn, db: Db) => ChatGateway;
  /** Build the heartbeat watcher for an effective config (test seam — defaults to a CompanionHeartbeatWatcher
   *  over db+pty). Returns it NOT started; the controller calls start(). */
  buildHeartbeat?: (cfg: CompanionConfig) => HeartbeatHandle;
  /** Build the reminder watcher for a companion session id (test seam — defaults to a
   *  CompanionReminderWatcher over db+pty). Returns it NOT started; the controller calls start(). */
  buildReminders?: (sessionId: string) => ReminderHandle;
  /** Resolve the FULL desired config SET from db+env (test seam — defaults to resolveAllEnabledConfigs).
   *  Every entry is a distinct session id to arm; an empty array ⇒ OFF (no companion enabled). */
  resolveEffective?: (db: Db, env: NodeJS.ProcessEnv, keyPath?: string) => CompanionConfig[];
}

export class CompanionController implements CompanionControl {
  /** ONE gateway/heartbeat/reminder-watcher/config PER live companion session — the diff source for a
   *  reconcile. A session present here is "live"; absent ⇒ OFF for that session. */
  private gateways = new Map<string, ChatGateway>();
  private heartbeats = new Map<string, HeartbeatHandle>();
  private reminders = new Map<string, ReminderHandle>();
  private cfgs = new Map<string, CompanionConfig>();
  /** Serializes reconciles so a burst of REST writes can't interleave a teardown with a start. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CompanionControllerDeps) {}

  /**
   * BOOT entry: apply the already-resolved boot config SET (may be empty/null). Kept separate from
   * reconcile() so the exact boot set (env bootstrap already applied by resolveAllCompanionConfigs) is used
   * verbatim — no re-resolve. Serialized on the same chain as reconcile. `null` normalizes to `[]` (no
   * companion configured) so every existing `startInitial(null)` call site stays byte-identical.
   */
  startInitial(cfgs: CompanionConfig[] | null): Promise<void> {
    return this.enqueue(() => this.applyDesired(cfgs ?? []));
  }

  /**
   * The HOT path: recompute the FULL enabled-config SET from the DB (side-effect-free — never
   * re-bootstraps env) and reconcile the live set to it. Called by the REST config POST/PUT/DELETE after
   * the durable write.
   *
   * NOTE (env-pinned revival — known, no code change): a live REST DELETE/disable of an ENV-pinned companion
   * (LOOM_COMPANION_* set for its session) tears it down live here, but the env bootstrap re-creates the row
   * and revives it on the NEXT daemon boot. This is surfaced to the human via `envPinned:true` in the masked
   * config read, so a REST edit to an env-pinned companion is visibly "reverts on restart" rather than silent.
   */
  reconcile(): Promise<void> {
    return this.enqueue(() => {
      const resolve = this.deps.resolveEffective ?? resolveAllEnabledConfigs;
      return this.applyDesired(resolve(this.deps.db, this.deps.env, this.deps.keyPath));
    });
  }

  /** Dispatch to the ONE gateway that owns `binding.sessionId` — a binding for a session with no live
   *  gateway is a no-op (matches the old single-gateway `this.gateway?.bind`). NEVER touches another
   *  session's gateway. */
  bind(binding: SessionBinding): void {
    this.gateways.get(binding.sessionId)?.bind(binding);
  }

  /** Dispatch to the ONE gateway that owns `sessionId` — see {@link bind}. */
  unbind(sessionId: string, channel?: string): void {
    this.gateways.get(sessionId)?.unbind(sessionId, channel);
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.teardownAll());
  }

  /**
   * The chat_reply delivery indirection wired into the MCP hooks. Dispatches to the ONE gateway that owns
   * `sessionId` (the MCP tool's own closed-over session — never agent-suppliable), so a reply can NEVER
   * reach a different companion's gateway/adapter. STABLE across that gateway's rebuilds (a token change
   * rebuilds the map entry in place — the hooks object never holds a stale closure). Returns a structured
   * "companion-off" when that session has no live gateway (chat_reply is gated to enabled sessions, so this
   * is only reachable in a brief window; it never throws).
   *
   * NOTE (stateless-MCP tool discovery — known, SAFE, no code change): adding/removing a session in
   * `hooks.companionSessionIds` (un)registers chat_reply at the ROUTER for THAT session, but an
   * ALREADY-CONNECTED companion `claude` session won't re-list tools until its next MCP (re)connect — so a
   * LIVE enable may not surface chat_reply on a running session until reconnect/resume, and a lingering
   * chat_reply call on a running session AFTER its teardown routes HERE and no-ops with "companion-off"
   * (its map entry is cleared) — never a cross-wire or a throw.
   */
  async deliverReply(sessionId: string, text: string, voice?: boolean): Promise<DeliverResult | { delivered: false; reason: "companion-off" }> {
    const gateway = this.gateways.get(sessionId);
    if (!gateway) return { delivered: false, reason: "companion-off" };
    return gateway.deliverReply(sessionId, text, voice);
  }

  /**
   * The in-app INBOUND indirection wired into the /ws/companion route. Dispatches to the ONE gateway that
   * owns `sessionId` (the route's own :sessionId param), so a message can never reach a different
   * companion's session. STABLE across that gateway's rebuilds (symmetric with deliverReply) — a torn-down
   * gateway never receives traffic. For in-app the chat id IS the companion session id (a loopback
   * self-address), so this normalizes to { channel:"in-app", chatId:sessionId } and hands it to the SAME
   * bindings-authoritative handleInbound — routing/authz are UNCHANGED (a session with no in-app binding is
   * rejected there, so this carries traffic only for an already-provisioned in-app companion). Returns
   * "companion-off" when that session has no live gateway; never throws.
   */
  async handleInAppInbound(sessionId: string, body: string): Promise<InboundResult | { accepted: false; reason: "companion-off" }> {
    const gateway = this.gateways.get(sessionId);
    if (!gateway) return { accepted: false, reason: "companion-off" };
    const msg = normalizeInAppMessage(sessionId, body);
    if (!msg) return { accepted: false, reason: "no-text" };
    const result = await gateway.handleInbound(msg);
    // CHAT HISTORY record (bug 0f01f234): only an ACCEPTED turn (delivered now OR queued in the session's
    // FIFO) is a real user message — a command/pairing-redemption/rejection/no-text never becomes a turn,
    // so recording only on `accepted` keeps history exactly the conversation the agent actually sees. `body`
    // is the FINAL submitted text (today always the typed text; VOICE-P4's web-mic transcript would slot in
    // here unchanged, since this is already the point where the final text is known — see chat-gateway.ts's
    // `body` var for the analogous Telegram-side seam). Best-effort: a history-record failure must never
    // break the inbound path it's mirroring.
    if (result.accepted) this.recordInboundMessageSafely(sessionId, body);
    // OUTBOUND MIRROR (card 92b6445c): an accepted web-chat turn echoes out to the session's other bound
    // channels — NOT awaited (fire-and-forget: the cockpit's own turn/reply never waits on a Telegram send).
    if (result.accepted) this.mirrorWebInputToOtherChannels(sessionId, body);
    return result;
  }

  /**
   * The in-app AUDIO INBOUND indirection wired into the /ws/companion route (Companion Voice epic, VOICE-P4
   * inbound). Stable across gateway rebuilds, mirrors `handleInAppInbound` — except the final text (the STT
   * transcript) isn't known ahead of time, so it's read off `result.submittedText` once `gateway.handleInbound`
   * resolves it, rather than a caller-supplied `body`. `filePath` is ALWAYS the server-generated temp file the
   * WS route already decoded the client's audio bytes into — never a client-supplied path.
   */
  async handleInAppAudioInbound(sessionId: string, filePath: string): Promise<InboundResult | { accepted: false; reason: "companion-off" }> {
    const gateway = this.gateways.get(sessionId);
    if (!gateway) return { accepted: false, reason: "companion-off" };
    const msg: InboundMessage = { channel: IN_APP_CHANNEL, chatId: sessionId, body: "", attachments: [{ type: "audio", fileId: filePath }] };
    const result = await gateway.handleInbound(msg);
    if (result.accepted && result.submittedText) {
      // viaVoice:true (unified cross-channel chat, card 7d63e200 follow-up) — this whole method exists
      // BECAUSE the inbound carried audio, so the recorded row is always a voice-note transcript, matching
      // how a Telegram voice note's inbound row is tagged (chat-gateway.ts's recordInboundSafely).
      this.recordInboundMessageSafely(sessionId, result.submittedText, true);
      this.mirrorWebInputToOtherChannels(sessionId, result.submittedText);
      // Live echo (VOICE-P4): unlike typed text (the panel already knows what it sent), the sender's own
      // client has no way to know the transcript ahead of time — push it back as their "your turn" bubble.
      this.deps.inApp?.pushTranscript(sessionId, result.submittedText);
    }
    return result;
  }

  /** Best-effort chat-history record for an ACCEPTED in-app inbound (bug 0f01f234), scoped to the IN-APP
   *  channel — a Telegram-originated turn records instead through chat-gateway.ts's own generalized hook
   *  (unified cross-channel chat, card 7d63e200). `viaVoice` (default false — the typed-text call site
   *  omits it) tags a web-mic voice-note transcript, matching Telegram's own via_voice tagging so the
   *  unified web panel's mic indicator renders for BOTH channels' voice notes, not just Telegram's. Never
   *  throws — a history-record failure must never break the inbound path it's mirroring. */
  private recordInboundMessageSafely(sessionId: string, text: string, viaVoice = false): void {
    try {
      this.deps.db.insertCompanionMessage({
        id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "user", text,
        createdAt: new Date().toISOString(), viaVoice,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[companion] in-app history record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * OUTBOUND MIRROR (card 92b6445c): echo an ACCEPTED web-chat user turn out to the session's OTHER bound
   * channels (e.g. Telegram) with a "— via web chat" disclaimer, so the Telegram side stays in sync with
   * what the owner typed in the cockpit. Uses ONLY the gateway's existing bindings-authoritative routing map
   * (bindingsForSession) and its outbound-only sendToChannel primitive — NEITHER calls submitTurn nor
   * touches inbound routing (bindingForInbound/handleInbound), so this can NEVER form an inbound turn on the
   * mirrored channel (no loop-back) and can NEVER reach a channel the session isn't ALREADY bound to (no
   * broadcast). Fire-and-forget from the caller's perspective; every failure is caught + logged here, never
   * thrown (mirrors the existing inbound-error-boundary posture in factory.ts / gateway/server.ts).
   */
  private mirrorWebInputToOtherChannels(sessionId: string, body: string): void {
    const gateway = this.gateways.get(sessionId);
    if (!gateway) return;
    const others = gateway.bindingsForSession(sessionId).filter((b) => b.channel !== IN_APP_CHANNEL);
    if (others.length === 0) return;
    const text = `${body}\n\n— via web chat`;
    for (const b of others) {
      void gateway
        .sendToChannel(b.channel, b.chatId, text)
        .then((result) => {
          if (!result.delivered) {
            // eslint-disable-next-line no-console
            console.error(`[companion] web-chat mirror to ${b.channel} did not deliver: ${result.reason}`);
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[companion] web-chat mirror to ${b.channel} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  }

  /** Read-only introspection (tests + potential status surface). `sessionId` mirrors the pre-multi-companion
   *  shape (the first live session, or null) — a legacy single-companion convenience; use
   *  {@link liveSessionIds} for the full live set. `running`/`heartbeatArmed` are aggregate: true iff AT
   *  LEAST ONE companion is live/armed. */
  snapshot(): { running: boolean; sessionId: string | null; heartbeatArmed: boolean } {
    const ids = [...this.gateways.keys()];
    return { running: ids.length > 0, sessionId: ids[0] ?? null, heartbeatArmed: this.heartbeats.size > 0 };
  }

  /** Read-only introspection (multi-companion): every currently-live companion session id. */
  liveSessionIds(): string[] {
    return [...this.gateways.keys()];
  }

  // ---- internals -------------------------------------------------------------------------------

  /** Append an op to the serialized reconcile chain; a failed op is caught + logged (never rejects the
   *  chain nor the REST write — the durable DB write already succeeded; the live apply is best-effort). */
  private enqueue(op: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(() =>
      op().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[companion] hot-lifecycle reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
    return this.chain;
  }

  /**
   * Reconcile the live SET to `desired` (every enabled config; empty ⇒ all OFF). The single decision point
   * for start/update/stop, diffed by session id:
   *   - a live session absent from `desired` → STOP (teardownOne) — every OTHER live session untouched.
   *   - a session in `desired` with no live entry → START (full build).
   *   - a session in `desired` that's ALREADY live → UPDATE (apply only what changed, exactly like the
   *     single-companion ON→ON diff below, now scoped to that one map entry).
   */
  private async applyDesired(desired: CompanionConfig[]): Promise<void> {
    const desiredBySid = new Map(desired.map((c) => [c.sessionId, c]));
    // STOP first: any live session no longer in the enabled set.
    for (const sessionId of [...this.cfgs.keys()]) {
      if (!desiredBySid.has(sessionId)) await this.teardownOne(sessionId);
    }
    // START / UPDATE: every desired session, independently.
    for (const cfg of desired) {
      const current = this.cfgs.get(cfg.sessionId);
      if (!current) {
        await this.startOne(cfg);
      } else {
        await this.updateOne(current, cfg);
      }
    }
  }

  /** OFF → ON for one session: full start (build+start its gateway, arm its heartbeat/reminders, gate it in). */
  private async startOne(desired: CompanionConfig): Promise<void> {
    await this.stopGatewayFor(desired.sessionId); // defensive (invariant: no gateway when not in cfgs) — never stack
    this.startGatewayFor(desired);
    this.rearmHeartbeatFor(desired);
    this.rearmRemindersFor(desired.sessionId);
    this.cfgs.set(desired.sessionId, desired);
    this.deps.hooks.companionSessionIds.add(desired.sessionId);
  }

  /**
   * ON → ON for one already-live session: apply only what changed, exactly like the pre-multi-companion
   * single-slot diff — just scoped to this one map entry, never touching any other session's gateway.
   *
   * The adapter/long-poll depends ONLY on the BOT TOKEN at runtime, so a token change is the ONLY thing
   * that requires restarting it. Routing + per-binding authz are owned by the BINDINGS layer
   * (companion_bindings — the single source of truth, managed live via the bindings REST / the Access UI
   * section, and consulted live by the gateway at inbound time). config.allowedChatId/chatScope are
   * BOOT-SEED ONLY: createCompanionGateway seeds the INITIAL binding from them ONLY when the SESSION's
   * bindings are empty (mirroring LOOM_COMPANION_CHAT_ID) — once a binding row exists, a rebuilt gateway
   * re-reads the SAME durable bindings, so churning the adapter on an allowedChatId/chatScope change would
   * NOT re-route. They are therefore DELIBERATELY not rebuild triggers (a home change is picked up live by
   * the gateway's homeResolver — no rebuild needed there either). NOTE: `current.sessionId ===
   * desired.sessionId` always here (both keyed by the SAME map entry — company_config's sessionId is its
   * primary key and never changes for an existing row), so unlike the old single-slot diff there is no
   * "sessionId changed" case to detect: a session moving out of the enabled set and a DIFFERENT session
   * moving in is a STOP + a START (applyDesired's two loops above), not an in-place retarget.
   */
  private async updateOne(current: CompanionConfig, desired: CompanionConfig): Promise<void> {
    if (desired.botToken !== current.botToken) {
      await this.stopGatewayFor(current.sessionId); // AWAIT the old long-poll's stop before starting the new one
      this.startGatewayFor(desired);
    }
    // Heartbeat: re-arm on a cadence/prompt change.
    const hbChanged =
      desired.heartbeatIntervalMinutes !== current.heartbeatIntervalMinutes || desired.heartbeatPrompt !== current.heartbeatPrompt;
    if (hbChanged) this.rearmHeartbeatFor(desired);
    // Reminders: reconcile on EVERY live config change (not gated like hbChanged) — the reminder SET
    // lives in its own table, independent of CompanionConfig fields, so a rearm is the only way this
    // path picks up a reminder CRUD write (s4's concern) that landed since the last reconcile. Cheap +
    // idempotent: rearmReminders re-reads the current enabled rows and reseeds lastFiredAt from durable
    // fired-events, so a rearm with an unchanged reminder set never double-fires or loses cadence state.
    this.rearmRemindersFor(desired.sessionId);
    this.cfgs.set(desired.sessionId, desired);
    this.deps.hooks.companionSessionIds.add(desired.sessionId); // already present — idempotent
  }

  /** Build + start `sessionId`'s gateway. Idempotent: refuses to stack a second adapter/long-poll for the
   *  SAME session (a rebuild caller stopGatewayFor()s first; this guard is the defensive backstop). NEVER
   *  touches another session's map entry. */
  private startGatewayFor(cfg: CompanionConfig): void {
    if (this.gateways.has(cfg.sessionId)) return;
    // Default builder threads the stable in-app hub so every built gateway registers its adapter (an
    // injected buildGateway test seam supplies its own). The hub is stable across rebuilds — see in-app.ts.
    const build =
      this.deps.buildGateway ??
      ((c: CompanionConfig, submit: SubmitTurn, db: typeof this.deps.db) => createCompanionGateway(c, submit, db, this.deps.inApp, this.deps.originResolver, this.deps.transcribe, this.deps.synthesize));
    const gateway = build(cfg, this.deps.submitTurn, this.deps.db);
    this.gateways.set(cfg.sessionId, gateway);
    gateway.start();
  }

  /** Stop + drop `sessionId`'s gateway (releases its long-poll). Clears the map entry FIRST so a concurrent
   *  deliverReply/bind for THAT session can't touch a stopping gateway — a DIFFERENT session's entry is
   *  untouched throughout. Then awaits the best-effort adapter stop. */
  private async stopGatewayFor(sessionId: string): Promise<void> {
    const gateway = this.gateways.get(sessionId);
    if (!gateway) return;
    this.gateways.delete(sessionId);
    await gateway.stop();
  }

  /** Disarm `sessionId`'s existing heartbeat and (re-)arm a fresh one iff cadence>0 (0 ⇒ stay disarmed).
   *  NEVER touches another session's heartbeat. */
  private rearmHeartbeatFor(cfg: CompanionConfig): void {
    this.stopHeartbeatFor(cfg.sessionId);
    if (cfg.heartbeatIntervalMinutes > 0) {
      const build =
        this.deps.buildHeartbeat ??
        ((c: CompanionConfig) =>
          new CompanionHeartbeatWatcher({
            db: this.deps.db,
            pty: this.deps.pty,
            sessionId: c.sessionId,
            intervalMinutes: c.heartbeatIntervalMinutes,
            prompt: c.heartbeatPrompt,
          }));
      const heartbeat = build(cfg);
      this.heartbeats.set(cfg.sessionId, heartbeat);
      heartbeat.start();
    }
  }

  private stopHeartbeatFor(sessionId: string): void {
    const heartbeat = this.heartbeats.get(sessionId);
    if (heartbeat) {
      heartbeat.stop();
      this.heartbeats.delete(sessionId);
    }
  }

  /** Disarm `sessionId`'s existing reminder watcher and (re-)arm a fresh one targeting it, but ONLY when
   *  the session has at least one ENABLED reminder row — the reminder-set analog of rearmHeartbeatFor's
   *  cadence>0 gate (a config with cadence 0 never builds/starts a heartbeat watcher either). Called
   *  unconditionally on every live reconcile of that session (unlike rearmHeartbeatFor's cfg-diff gate):
   *  the reminder set lives in its own table, independent of CompanionConfig, so THIS is the reconcile
   *  point a future reminder CRUD write (s4) needs — see updateOne's comment. The one-row-existence check is
   *  a single cheap read; with zero rows (every companion today, until s4 ships) it is the ONLY db touch
   *  this path makes — no watcher is built or started, so DEFAULT-OFF stays truly byte-identical. NEVER
   *  touches another session's reminder watcher.
   *
   *  KNOWN TRADE-OFF: this rearm is UNGATED (unlike rearmHeartbeatFor's cfg-diff gate) and stop+rebuilds the
   *  watcher on EVERY reconcile of that session, resetting its in-memory tick PHASE (the next setInterval
   *  tick is a fresh tickMs away, not continuous from the prior watcher's cadence) — never lost due-ness
   *  (seedLastFired reseeds lastFiredAt from durable fired-events either way), just possible jitter of up
   *  to one tick. Acceptable because reconciles are rare (a human config write or a reminder_create/cancel
   *  MCP call), not a hot path.
   */
  private rearmRemindersFor(sessionId: string): void {
    this.stopRemindersFor(sessionId);
    if (this.deps.db.listEnabledCompanionReminders(sessionId).length === 0) return;
    const build = this.deps.buildReminders ?? ((sid: string) => new CompanionReminderWatcher({ db: this.deps.db, pty: this.deps.pty, sessionId: sid }));
    const reminders = build(sessionId);
    this.reminders.set(sessionId, reminders);
    reminders.start();
  }

  private stopRemindersFor(sessionId: string): void {
    const reminders = this.reminders.get(sessionId);
    if (reminders) {
      reminders.stop();
      this.reminders.delete(sessionId);
    }
  }

  /** Tear down ONE session → the OFF state for it: stop its adapter long-poll, disarm its heartbeat +
   *  reminders, drop it from the chat_reply gate. Every OTHER live session is untouched. */
  private async teardownOne(sessionId: string): Promise<void> {
    await this.stopGatewayFor(sessionId);
    this.stopHeartbeatFor(sessionId);
    this.stopRemindersFor(sessionId);
    this.cfgs.delete(sessionId);
    this.deps.hooks.companionSessionIds.delete(sessionId);
  }

  /** Tear down EVERY live session (daemon shutdown only — `stop()`). */
  private async teardownAll(): Promise<void> {
    await Promise.all([...this.cfgs.keys()].map((sessionId) => this.teardownOne(sessionId)));
  }
}
