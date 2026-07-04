/**
 * Loom Companion — the HOT LIFECYCLE controller (Companion epic Phase 3 backend). Closes the "no .env, no
 * restart" headline of the PL ruling: it makes the REST config writes (POST/PUT/DELETE at
 * /api/companion/config) drive the RUNNING gateway LIVE, instead of applying only on the next daemon boot.
 *
 * It owns — as ONE stable facade the REST + MCP hooks hold across gateway rebuilds — the live ChatGateway
 * (Telegram long-poll) and the proactive CompanionHeartbeatWatcher, and reconciles them to the current DB
 * config on demand:
 *   • CREATE/enable  (a config write makes an enabled row the effective companion): build + start() the
 *     gateway, arm the heartbeat if cadence>0, and flip the chat_reply gate ON — NO restart.
 *   • UPDATE: apply changes live — a cadence/prompt change re-arms/disarms the heartbeat; a
 *     token/session/chat/scope change RESTARTS the adapter (stop old long-poll, build+start fresh); a home
 *     change is already live (the gateway's homeResolver reads app_meta each deliver).
 *   • DELETE/disable: stop() the adapter, disarm the heartbeat, flip chat_reply OFF → the daemon returns to
 *     the SAME OFF state as an unconfigured boot (default-OFF byte-identical).
 *
 * It REUSES the existing primitives verbatim — createCompanionGateway (bind/adapter/inbound wiring),
 * ChatGateway.start()/stop()/bind()/unbind(), CompanionHeartbeatWatcher, and the chat_reply hook gate the
 * OrchestrationMcpRouter reads per MCP request — and adds no new turn-submit / delivery path.
 *
 * IDEMPOTENCY + no-leak (load-bearing): every reconcile is SERIALIZED on an internal promise chain, so a
 * burst of REST writes can't interleave a teardown with a start; startGateway refuses to stack a second
 * adapter, stopGateway clears the ref BEFORE awaiting the old stop (a racing deliverReply/bind can't touch
 * a stopping gateway), and a token change AWAITS the old long-poll's stop before starting the new one — so
 * repeated enable/disable toggles never leak a long-poll or double-register chat_reply.
 *
 * SECURITY (unchanged, do NOT regress): inbound = pty.enqueueStdin, outbound = chat_reply→deliverReply,
 * never cross-wired; chat_reply stays gated to the single bound companion session; authz stays fail-closed
 * at inbound time (the gateway's per-binding CompanionAuth). This controller only (re)wires the SAME parts.
 */
import type { Db } from "../db.js";
import type { ChatGateway } from "./chat-gateway.js";
import { createCompanionGateway } from "./factory.js";
import { CompanionHeartbeatWatcher, type HeartbeatPty } from "./heartbeat.js";
import { CompanionReminderWatcher } from "./reminders.js";
import { resolveEffectiveConfig } from "./store.js";
import { IN_APP_CHANNEL, normalizeInAppMessage, type InAppChannel } from "./in-app.js";
import type { CompanionConfig } from "./config.js";
import type { CompanionRoute, DeliverResult, InboundResult, SessionBinding, SubmitTurn } from "./types.js";

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
  /** Best-effort teardown on daemon shutdown (stops the adapter long-poll + the heartbeat). */
  stop(): Promise<void>;
}

/** The mutable chat_reply gate the OrchestrationMcpRouter reads per MCP request. The controller flips
 *  `companionSessionId` as the companion starts/stops so chat_reply (un)registers with no restart, and
 *  routes `deliverReply` back through the controller so it always targets the CURRENT gateway. */
export interface CompanionReplyHooks {
  companionSessionId: string | null;
  deliverReply?: (sessionId: string, text: string) => Promise<{ delivered: boolean; reason?: string }>;
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
  /** Resolve the effective desired config from db+env (test seam — defaults to resolveEffectiveConfig). */
  resolveEffective?: (db: Db, env: NodeJS.ProcessEnv, keyPath?: string) => CompanionConfig | null;
}

export class CompanionController implements CompanionControl {
  private gateway: ChatGateway | null = null;
  private heartbeat: HeartbeatHandle | null = null;
  private reminders: ReminderHandle | null = null;
  /** The config the live state currently reflects (null ⇒ OFF). The diff source for a reconcile. */
  private cfg: CompanionConfig | null = null;
  /** Serializes reconciles so a burst of REST writes can't interleave a teardown with a start. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CompanionControllerDeps) {}

  /**
   * BOOT entry: apply the already-resolved boot config (may be null). Kept separate from reconcile() so the
   * exact boot config (env bootstrap already applied by resolveCompanionConfig) is used verbatim — no
   * re-resolve. Serialized on the same chain as reconcile.
   */
  startInitial(cfg: CompanionConfig | null): Promise<void> {
    return this.enqueue(() => this.applyDesired(cfg));
  }

  /**
   * The HOT path: recompute the effective config from the DB (side-effect-free — never re-bootstraps env)
   * and reconcile the live state to it. Called by the REST config POST/PUT/DELETE after the durable write.
   *
   * NOTE (env-pinned revival — known, no code change): a live REST DELETE/disable of an ENV-pinned companion
   * (LOOM_COMPANION_* set for its session) tears it down live here, but the env bootstrap re-creates the row
   * and revives it on the NEXT daemon boot. This is surfaced to the human via `envPinned:true` in the masked
   * config read, so a REST edit to an env-pinned companion is visibly "reverts on restart" rather than silent.
   */
  reconcile(): Promise<void> {
    return this.enqueue(() => {
      const resolve = this.deps.resolveEffective ?? resolveEffectiveConfig;
      return this.applyDesired(resolve(this.deps.db, this.deps.env, this.deps.keyPath));
    });
  }

  bind(binding: SessionBinding): void {
    this.gateway?.bind(binding);
  }

  unbind(sessionId: string, channel?: string): void {
    this.gateway?.unbind(sessionId, channel);
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.teardown());
  }

  /**
   * The chat_reply delivery indirection wired into the MCP hooks. STABLE across gateway rebuilds: it always
   * routes to the CURRENT gateway, so the hooks object never holds a stale closure. Returns a structured
   * "companion-off" when there is no live gateway (chat_reply is gated to the companion session, so this is
   * only reachable in a brief window; it never throws).
   *
   * NOTE (stateless-MCP tool discovery — known, SAFE, no code change): flipping `hooks.companionSessionId`
   * (un)registers chat_reply at the ROUTER, but an ALREADY-CONNECTED companion `claude` session won't
   * re-list tools until its next MCP (re)connect — so a LIVE enable may not surface chat_reply on a running
   * session until reconnect/resume, and a lingering chat_reply on a running session AFTER teardown routes
   * HERE and no-ops with "companion-off" (the gateway ref is cleared) — never a cross-wire or a throw.
   */
  async deliverReply(sessionId: string, text: string): Promise<DeliverResult | { delivered: false; reason: "companion-off" }> {
    if (!this.gateway) return { delivered: false, reason: "companion-off" };
    return this.gateway.deliverReply(sessionId, text);
  }

  /**
   * The in-app INBOUND indirection wired into the /ws/companion route. STABLE across gateway rebuilds: it
   * always routes to the CURRENT gateway (symmetric with deliverReply), so a torn-down gateway never
   * receives traffic. For in-app the chat id IS the companion session id (a loopback self-address), so this
   * normalizes to { channel:"in-app", chatId:sessionId } and hands it to the SAME bindings-authoritative
   * handleInbound — routing/authz are UNCHANGED (a session with no in-app binding is rejected there, so this
   * carries traffic only for an already-provisioned in-app companion). Returns "companion-off" when no
   * gateway is live; never throws.
   */
  async handleInAppInbound(sessionId: string, body: string): Promise<InboundResult | { accepted: false; reason: "companion-off" }> {
    if (!this.gateway) return { accepted: false, reason: "companion-off" };
    const msg = normalizeInAppMessage(sessionId, body);
    if (!msg) return { accepted: false, reason: "no-text" };
    const result = await this.gateway.handleInbound(msg);
    // OUTBOUND MIRROR (card 92b6445c): an accepted web-chat turn echoes out to the session's other bound
    // channels — NOT awaited (fire-and-forget: the cockpit's own turn/reply never waits on a Telegram send).
    if (result.accepted) this.mirrorWebInputToOtherChannels(sessionId, body);
    return result;
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
    if (!this.gateway) return;
    const others = this.gateway.bindingsForSession(sessionId).filter((b) => b.channel !== IN_APP_CHANNEL);
    if (others.length === 0) return;
    const text = `${body}\n\n— via web chat`;
    for (const b of others) {
      void this.gateway
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

  /** Read-only introspection (tests + potential status surface): is a gateway live, which session, heartbeat armed. */
  snapshot(): { running: boolean; sessionId: string | null; heartbeatArmed: boolean } {
    return { running: this.gateway != null, sessionId: this.cfg?.sessionId ?? null, heartbeatArmed: this.heartbeat != null };
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

  /** Reconcile the live state to `desired` (null ⇒ OFF). The single decision point for start/stop/rebuild. */
  private async applyDesired(desired: CompanionConfig | null): Promise<void> {
    const current = this.cfg;
    if (!desired) {
      // → OFF: tear down to the same state as an unconfigured boot.
      await this.teardown();
      return;
    }
    if (!current) {
      // OFF → ON: full start.
      await this.stopGateway(); // defensive (invariant: no gateway when cfg is null) — never stack
      this.startGateway(desired);
      this.rearmHeartbeat(desired);
      this.rearmReminders(desired.sessionId);
      this.cfg = desired;
      this.deps.hooks.companionSessionId = desired.sessionId;
      return;
    }
    // ON → ON: apply only what changed.
    // The adapter/long-poll depends ONLY on the BOT TOKEN at runtime, so a token change is the ONLY thing
    // that requires restarting it. Routing + per-binding authz are owned by the BINDINGS layer
    // (companion_bindings — the single source of truth, managed live via the bindings REST / the Access UI
    // section, and consulted live by the gateway at inbound time). config.allowedChatId/chatScope are
    // BOOT-SEED ONLY: createCompanionGateway seeds the INITIAL binding from them ONLY when the bindings
    // store is empty (mirroring LOOM_COMPANION_CHAT_ID) — once a binding row exists, a rebuilt gateway
    // re-reads the SAME durable bindings, so churning the adapter on an allowedChatId/chatScope/sessionId
    // change would NOT re-route. They are therefore DELIBERATELY not rebuild triggers. (A sessionId change
    // IS still applied below — it re-points the chat_reply gate + the proactive heartbeat at the config's
    // session; a home change is picked up live by the gateway's homeResolver — neither needs a rebuild.)
    if (desired.botToken !== current.botToken) {
      await this.stopGateway(); // AWAIT the old long-poll's stop before starting the new one (no overlap)
      this.startGateway(desired);
    }
    // Heartbeat: re-arm on a cadence/prompt change (or a session change — the watcher targets the session).
    const hbChanged =
      desired.sessionId !== current.sessionId ||
      desired.heartbeatIntervalMinutes !== current.heartbeatIntervalMinutes ||
      desired.heartbeatPrompt !== current.heartbeatPrompt;
    if (hbChanged) this.rearmHeartbeat(desired);
    // Reminders: reconcile on EVERY live config change (not gated like hbChanged) — the reminder SET
    // lives in its own table, independent of CompanionConfig fields, so a rearm is the only way this
    // path picks up a reminder CRUD write (s4's concern) that landed since the last reconcile. Cheap +
    // idempotent: rearmReminders re-reads the current enabled rows and reseeds lastFiredAt from durable
    // fired-events, so a rearm with an unchanged reminder set never double-fires or loses cadence state.
    this.rearmReminders(desired.sessionId);
    this.cfg = desired;
    this.deps.hooks.companionSessionId = desired.sessionId;
  }

  /** Build + start the gateway. Idempotent: refuses to stack a second adapter/long-poll (a rebuild caller
   *  stopGateway()s first; this guard is the defensive backstop). */
  private startGateway(cfg: CompanionConfig): void {
    if (this.gateway) return;
    // Default builder threads the stable in-app hub so every built gateway registers its adapter (an
    // injected buildGateway test seam supplies its own). The hub is stable across rebuilds — see in-app.ts.
    const build =
      this.deps.buildGateway ??
      ((c: CompanionConfig, submit: SubmitTurn, db: typeof this.deps.db) => createCompanionGateway(c, submit, db, this.deps.inApp, this.deps.originResolver));
    this.gateway = build(cfg, this.deps.submitTurn, this.deps.db);
    this.gateway.start();
  }

  /** Stop + drop the current gateway (releases the long-poll). Clears the ref FIRST so a concurrent
   *  deliverReply/bind can't touch a stopping gateway, then awaits the best-effort adapter stop. */
  private async stopGateway(): Promise<void> {
    const gw = this.gateway;
    if (!gw) return;
    this.gateway = null;
    await gw.stop();
  }

  /** Disarm any existing heartbeat and (re-)arm a fresh one iff cadence>0 (0 ⇒ stay disarmed). */
  private rearmHeartbeat(cfg: CompanionConfig): void {
    this.stopHeartbeat();
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
      this.heartbeat = build(cfg);
      this.heartbeat.start();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      this.heartbeat.stop();
      this.heartbeat = null;
    }
  }

  /** Disarm any existing reminder watcher and (re-)arm a fresh one targeting `sessionId`, but ONLY when
   *  the session has at least one ENABLED reminder row — the reminder-set analog of rearmHeartbeat's
   *  cadence>0 gate (a config with cadence 0 never builds/starts a heartbeat watcher either). Called
   *  unconditionally on every live reconcile (unlike rearmHeartbeat's cfg-diff gate): the reminder set
   *  lives in its own table, independent of CompanionConfig, so THIS is the reconcile point a future
   *  reminder CRUD write (s4) needs — see the ON→ON call site's comment. The one-row-existence check is
   *  a single cheap read; with zero rows (every companion today, until s4 ships) it is the ONLY db touch
   *  this path makes — no watcher is built or started, so DEFAULT-OFF stays truly byte-identical.
   *
   *  KNOWN TRADE-OFF: this rearm is UNGATED (unlike rearmHeartbeat's cfg-diff gate) and stop+rebuilds the
   *  watcher on EVERY reconcile, resetting its in-memory tick PHASE (the next setInterval tick is a fresh
   *  tickMs away, not continuous from the prior watcher's cadence) — never lost due-ness (seedLastFired
   *  reseeds lastFiredAt from durable fired-events either way), just possible jitter of up to one tick.
   *  Acceptable because reconciles are rare (a human config write or a reminder_create/cancel MCP call),
   *  not a hot path.
   */
  private rearmReminders(sessionId: string): void {
    this.stopReminders();
    if (this.deps.db.listEnabledCompanionReminders(sessionId).length === 0) return;
    const build = this.deps.buildReminders ?? ((sid: string) => new CompanionReminderWatcher({ db: this.deps.db, pty: this.deps.pty, sessionId: sid }));
    this.reminders = build(sessionId);
    this.reminders.start();
  }

  private stopReminders(): void {
    if (this.reminders) {
      this.reminders.stop();
      this.reminders = null;
    }
  }

  /** Full teardown → the OFF state: stop the adapter long-poll, disarm the heartbeat + reminders, flip
   *  chat_reply OFF. */
  private async teardown(): Promise<void> {
    await this.stopGateway();
    this.stopHeartbeat();
    this.stopReminders();
    this.cfg = null;
    this.deps.hooks.companionSessionId = null;
  }
}
