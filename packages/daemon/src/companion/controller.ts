/**
 * Loom Companion — the HOT LIFECYCLE controller (Companion epic Phase 3 backend, generalized to
 * MULTI-companion by the multi-companion runtime card). Closes the "no .env, no restart" headline of the
 * PL ruling: it makes the REST config writes (POST/PUT/DELETE at /api/companion/config) drive the RUNNING
 * gateway(s) LIVE, instead of applying only on the next daemon boot.
 *
 * It owns — as ONE stable facade the REST + MCP hooks hold across gateway rebuilds — ONE live ChatGateway
 * (Telegram long-poll) + ONE proactive CompanionHeartbeatWatcher + ONE CompanionReminderWatcher PER ENABLED
 * companion config, keyed by session id, all sharing the SAME stable in-app hub (`deps.inApp`, threaded
 * into every gateway build). `reconcile(sessionId?)` diffs the enabled set against the live set: given a
 * `sessionId` (every REST config write and reminder CRUD call knows the one session it just touched), the
 * diff — and any resulting rearm — is scoped to THAT session alone; omitted (boot / no known origin), it
 * diffs the FULL live set against the FULL enabled set, exactly as before:
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
import { AttentionPushWatcher } from "./attention-push.js";
import { resolveCompanionGrant } from "./capabilities.js";
import { resolveAllEnabledConfigs } from "./store.js";
import { IN_APP_CHANNEL, normalizeInAppMessage, type InAppChannel } from "./in-app.js";
import type { CompanionConfig } from "./config.js";
import type { CompanionRoute, CompanionSynthesizer, CompanionTranscriber, DeliverResult, InboundMessage, InboundResult, SessionBinding, SubmitTurn } from "./types.js";
import type { Session } from "@loom/shared";

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

/** The minimal lifecycle handle the controller needs from an attention-push watcher (satisfied by
 *  AttentionPushWatcher; narrowed so a test can inject a spy) — same shape as HeartbeatHandle/ReminderHandle. */
export interface AttentionPushHandle {
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
  /**
   * Reconcile the live companion to the CURRENT DB config after a REST config write (the hot path).
   * `sessionId`, when given, is the ONE session known to have actually changed (the REST route's own
   * :sessionId / the reminder tool's own bound session) — the diff + any rearm is scoped to THAT session
   * only, leaving every other live companion's watchers untouched. Omitted (boot / no known origin) ⇒
   * diff the FULL live set, matching the historical behavior.
   */
  reconcile(sessionId?: string): Promise<void>;
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
  /**
   * Disarm ONE session's live gateway/heartbeat/reminders on an UNEXPECTED pty exit (index.ts's onExit),
   * without touching its DB config row. A plain `reconcile(sessionId)` would no-op here: the config's
   * `enabled` flag is untouched by a pty death (see companion/revive.ts — an exited-but-enabled companion
   * is later auto-revived), so the session is STILL in the desired set and applyDesired's STOP branch never
   * fires. This bypasses that diff and reuses `teardownOne` directly — the same teardown the config-DELETE
   * REST path drives indirectly by deleting the row first. Serialized on the same chain as reconcile/stop.
   * A no-op for any session with no live entry (non-companion sessions, or an already-torn-down one).
   *
   * Also closes the SAME-HOME suppression's known residual latency (store.ts's
   * `suppressDuplicateHomeHeartbeats`): if this exited session was the WINNER of a same-home group, any
   * still-LIVE sibling(s) sharing its home are re-armed as part of this same call — see `teardownOne`'s
   * caller below — instead of staying silently suppressed until the next boot or an unrelated config write.
   * The exited session itself is NEVER re-resolved/reconciled (that would re-START its now-dead gateway) —
   * UNLESS it has ALREADY come back alive by the time this (serialized, possibly delayed) op actually runs,
   * in which case it's a STALE exit event and this is a no-op (CR fix) — see the implementation's comment.
   * That's what makes `upgrade()` below safe: its own pty.stop() triggers exactly this same exit path, but
   * by the time it's this op's turn on the chain the fresh pty is already live again.
   */
  onSessionExit(sessionId: string): Promise<void>;
  /**
   * The CONVERSATION-PRESERVING respawn (Companion Capability & Permission-Lever Framework §6) — a
   * human/REST-triggered upgrade, `POST /api/companion/:sessionId/upgrade`, NEVER auto-fired from a grant
   * write. Delegates to the injected `upgradeCompanionSession` (SessionService.upgradeCompanionCapabilities)
   * and is SERIALIZED on the same reconcile chain as start/update/stop/onSessionExit, so it can never
   * interleave with a concurrent teardown/start of the SAME session's gateway (e.g. a racing token-change
   * reconcile). Its own pty.stop() triggers index.ts's onExit → `onSessionExit` for the SAME session — see
   * that method's stale-exit guard for why this does NOT leave the companion's gateway/heartbeat/reminders/
   * chat_reply torn down once the fresh pty comes back up. Returns a discriminated result rather than
   * throwing — a bad request (unknown session, wrong role, no engine id, the pty didn't stop in time) is a
   * normal, expected outcome for a REST caller to relay, not an exceptional one.
   *
   * KNOWN TRADE-OFF (CR-confirmed acceptable, by design): `this.chain` is GLOBAL, not per-session — a slow
   * upgrade (worst case ~10s if the pty won't die) briefly blocks every OTHER live companion's reconcile
   * behind it too, not just this session's.
   */
  upgrade(sessionId: string): Promise<{ ok: true; session: Session } | { ok: false; error: string }>;
}

/** The mutable chat_reply gate the OrchestrationMcpRouter reads per MCP request. The controller adds/removes
 *  a session's id in `companionSessionIds` as THAT companion starts/stops so chat_reply (un)registers for
 *  it with no restart (every other live companion's membership is untouched), and routes `deliverReply`
 *  back through the controller so it always targets that session's CURRENT gateway. */
export interface CompanionReplyHooks {
  companionSessionIds: Set<string>;
  deliverReply?: (sessionId: string, text: string, voice?: boolean) => Promise<{ delivered: boolean; reason?: string }>;
  /**
   * Deliver a local file to the chat bound to the session, as a native image/document (the `media-out`
   * lever, card 3a81b0f2). Mirrors `deliverReply`'s dispatch (routes THROUGH the controller to that
   * session's CURRENT gateway) but sends media instead of text — see `ChatGateway.deliverMedia`. Consumed
   * by the orchestration MCP router's `GrantOutbound.deliverMediaToOwner` seam.
   */
  deliverMedia?: (sessionId: string, filePath: string) => Promise<{ delivered: boolean; reason?: string }>;
  /**
   * Server-derived route capture for the reminder_create MCP tool (mirrors wake_me's getActiveTurnOrigin) —
   * consumed by the orchestration MCP router, not by this controller.
   */
  getActiveTurnOrigin?: (sessionId: string) => CompanionRoute | null;
  /**
   * (Re)arm/disarm the live reminder watcher after a reminder_create/cancel MCP write — ARM-ON-CREATE
   * (Companion Memory & Reminders Design, Surface 2 s4). Wired to `(sessionId) =>
   * controller.reconcile(sessionId)`: a reminder CRUD write lands in its own table, independent of
   * CompanionConfig, so re-running reconcile SCOPED TO the reminder's own bound session is the only way
   * this path picks up the new/removed row — without perturbing any OTHER live companion's reminder
   * watcher (see rearmRemindersFor's per-session rearm in applyDesired). Consumed by the orchestration
   * MCP router, not by this controller.
   */
  rearmReminders?: (sessionId: string) => Promise<void>;
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
  /** The injected PERSONA reinject (companion-persona-after-clear card, generalized by the standalone
   *  "/refresh" command), threaded into the default gateway builder exactly like `transcribe`/`synthesize`.
   *  The daemon injects a raw-pty-enqueue impl built from SessionService.composeCompanionReinjectPrompt
   *  (index.ts) — deliberately NOT the narrow `submitTurn` primitive above, since the reinject must bypass
   *  chat-history recording + live-viewer rendering entirely (see chat-gateway.ts's resetConversation /
   *  refreshPersona). Returns whether a prompt was actually composed+enqueued. Optional: absent ⇒ every
   *  built gateway's "/new" leaves the companion identity-less after `/clear`, and "/refresh" is a no-op,
   *  byte-identical to today. */
  reinjectPersona?: (sessionId: string) => boolean;
  /** The per-turn PROACTIVE resolver (proactive event-line producer), threaded into the default gateway
   *  builder exactly like `originResolver` — STABLE across a gateway rebuild. The daemon injects
   *  `(sid) => pty.getActiveTurnIsProactive(sid)` so `deliverReply` can tag a heartbeat/reminder/
   *  attention-push-originated reply for the web chat's amber event line. Optional: absent ⇒ every built
   *  gateway's replies are never tagged proactive (test seams that don't exercise the event-line path stay
   *  byte-identical). */
  proactiveResolver?: (sessionId: string) => boolean;
  /** Companion Trust Window close hook (Framework Card 0), threaded into the default gateway builder
   *  exactly like `originResolver`/`proactiveResolver` — the daemon injects
   *  `(sid) => orchMcp.closeCompanionTrustWindow(sid)` (index.ts). Called on a pairing re-bind and the
   *  "/lock" command. Optional: absent ⇒ every built gateway's re-pair/"/lock" close is a no-op (test
   *  seams that don't exercise the trust window stay byte-identical). */
  closeTrustWindow?: (sessionId: string) => void;
  /** CONVERSATION-PRESERVING respawn primitive (Framework §6) — the daemon injects
   *  `(sid) => sessions.upgradeCompanionCapabilities(sid)`, mirroring how `submitTurn`/`reinjectPersona`
   *  close over SessionService rather than the controller holding a direct reference. Optional: absent ⇒
   *  {@link CompanionControl.upgrade} resolves `{ok:false}` for every session (test seams that don't
   *  exercise the upgrade path stay byte-identical). */
  upgradeCompanionSession?: (sessionId: string) => Promise<Session>;
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
  /** Build the attention-push watcher for a companion session id (test seam — defaults to an
   *  AttentionPushWatcher over db+pty). Returns it NOT started; the controller calls start(). */
  buildAttentionPush?: (sessionId: string) => AttentionPushHandle;
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
  private attentionPush = new Map<string, AttentionPushHandle>();
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
  reconcile(sessionId?: string): Promise<void> {
    return this.enqueue(() => {
      const resolve = this.deps.resolveEffective ?? resolveAllEnabledConfigs;
      return this.applyDesired(resolve(this.deps.db, this.deps.env, this.deps.keyPath), sessionId);
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

  onSessionExit(sessionId: string): Promise<void> {
    return this.enqueue(() => {
      // STALE-EXIT GUARD (CR fix): by the time this enqueued op actually runs — strictly AFTER anything
      // already ahead of it on `this.chain`, which now includes a live-upgrade's own stop→resume
      // (`upgrade()` shares this SAME chain; see its doc) — the session may have ALREADY come back alive
      // (a live-upgrade respawn, a fast manual restart, a self-heal resume racing a slow exit-event queue).
      // Tearing down a companion that's alive again would silently kill its gateway/heartbeat/reminders/
      // chat_reply gate for a process this stale exit event no longer describes — and since the exited
      // pty's own gateway/heartbeat/reminders dispatch every turn by (pty, sessionId) rather than holding
      // any reference to the specific OS process, none of them actually needed rebuilding across a same-
      // session-id respawn; the ONLY bug was tearing them down and never bringing them back. This check is
      // scoped to onSessionExit alone — `teardownOne`'s OTHER caller (applyDesired's STOP branch, a
      // genuine disable/delete) must NOT gate on aliveness: the pty typically stays running there and the
      // wiring must still come down regardless.
      if (this.deps.pty.isAlive(sessionId)) return Promise.resolve();
      return this.teardownOneAndRearmSameHomeSiblings(sessionId);
    });
  }

  /** See {@link CompanionControl.upgrade}. Serialized via {@link enqueueResult} (NOT {@link enqueue}) — the
   *  respawn's outcome must reach the REST caller, unlike the best-effort reconcile ops `enqueue` guards. */
  upgrade(sessionId: string): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
    return this.enqueueResult(async () => {
      if (!this.deps.upgradeCompanionSession) return { ok: false, error: "companion live-upgrade is not wired on this daemon" };
      try {
        const session = await this.deps.upgradeCompanionSession(sessionId);
        return { ok: true, session };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
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
   * The media-delivery indirection wired into `CompanionReplyHooks.deliverMedia` (the `media-out` lever,
   * card 3a81b0f2) — mirrors `deliverReply` exactly (dispatches to `sessionId`'s OWN current gateway, never
   * cross-wired; "companion-off" when no gateway is live) but sends a file via `ChatGateway.deliverMedia`.
   */
  async deliverMedia(sessionId: string, filePath: string): Promise<{ delivered: boolean; reason?: string }> {
    const gateway = this.gateways.get(sessionId);
    if (!gateway) return { delivered: false, reason: "companion-off" };
    return gateway.deliverMedia(sessionId, filePath);
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

  /** Read-only introspection (tests + potential status surface): the live cached `CompanionConfig` for one
   *  session — the exact `cfgs` entry `startOne`/`updateOne` populate (includes `homeChannel`/`homeChatId`),
   *  or undefined when that session isn't live. Lets a test assert a home write's scoped `reconcile()`
   *  actually refreshed the cache, without exposing the internal map itself. */
  configFor(sessionId: string): CompanionConfig | undefined {
    return this.cfgs.get(sessionId);
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

  /** Like {@link enqueue}, but for an op whose RESULT (or rejection) the caller needs back — `upgrade`'s
   *  REST caller must see a real error, unlike a reconcile's fire-and-forget best-effort. Still serializes
   *  on the SAME `this.chain` (so it can't interleave with a concurrent teardown/start of this session), but
   *  never lets this op's own rejection poison `this.chain` for whatever's enqueued after it — `this.chain`
   *  is advanced to an always-resolving derivative, while the returned promise carries the REAL outcome. */
  private enqueueResult<T>(op: () => Promise<T>): Promise<T> {
    const result = this.chain.then(op);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Reconcile the live SET to `desired` (every enabled config; empty ⇒ all OFF). The single decision point
   * for start/update/stop, diffed by session id:
   *   - a live session absent from `desired` → STOP (teardownOne) — every OTHER live session untouched.
   *   - a session in `desired` with no live entry → START (full build).
   *   - a session in `desired` that's ALREADY live → UPDATE (apply only what changed, exactly like the
   *     single-companion ON→ON diff below, now scoped to that one map entry).
   *
   * `onlySessionId`, when given, narrows BOTH the STOP scan and the START/UPDATE pass to that one session —
   * `desired` is still the freshly-resolved FULL set (resolveEffective has no per-session variant), but every
   * other live session's map entry is left completely untouched: no teardownOne, no startOne/updateOne, no
   * rearmRemindersFor/rearmHeartbeatFor call. This is the fix for the cross-companion rearm-all bug — a
   * single config/reminder write for session A used to re-run updateOne (and its unconditional
   * rearmRemindersFor) for EVERY OTHER live session B, C, … too, resetting their reminder watchers' tick
   * phase for no reason. Omitted (boot / no known origin) ⇒ every live+desired session is visited, exactly
   * as before.
   */
  private async applyDesired(desired: CompanionConfig[], onlySessionId?: string): Promise<void> {
    const desiredBySid = new Map(desired.map((c) => [c.sessionId, c]));
    const liveIds = onlySessionId ? (this.cfgs.has(onlySessionId) ? [onlySessionId] : []) : [...this.cfgs.keys()];
    // STOP first: any live session (in scope) no longer in the enabled set.
    for (const sessionId of liveIds) {
      if (!desiredBySid.has(sessionId)) await this.teardownOne(sessionId);
    }
    // START / UPDATE: every desired session (in scope), independently.
    const desiredInScope = onlySessionId ? desired.filter((c) => c.sessionId === onlySessionId) : desired;
    for (const cfg of desiredInScope) {
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
    this.rearmAttentionPushFor(desired.sessionId);
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
    // Reminders: reconcile on EVERY visit of THIS session (not gated like hbChanged) — the reminder SET
    // lives in its own table, independent of CompanionConfig fields, so a rearm is the only way this
    // path picks up a reminder CRUD write (s4's concern) that landed since the last reconcile. Cheap +
    // idempotent: rearmReminders re-reads the current enabled rows and reseeds lastFiredAt from durable
    // fired-events, so a rearm with an unchanged reminder set never double-fires or loses cadence state.
    // applyDesired's `onlySessionId` scoping means THIS updateOne call — and therefore this rearm — only
    // ever runs for the session a caller told us actually changed; every OTHER live session's watcher is
    // never touched by this call (see applyDesired's doc + the cross-companion fix it describes).
    this.rearmRemindersFor(desired.sessionId);
    // Attention-push grants live in their OWN table too (companion_capability_grants), independent of
    // CompanionConfig — same reasoning as rearmRemindersFor's unconditional call just above: this is the
    // only reconcile point a grants CRUD write (gateway/server.ts's three /grants writers) has to pick up
    // a new/changed/removed attention-push grant for THIS session.
    this.rearmAttentionPushFor(desired.sessionId);
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
      ((c: CompanionConfig, submit: SubmitTurn, db: typeof this.deps.db) => createCompanionGateway(c, submit, db, this.deps.inApp, this.deps.originResolver, this.deps.transcribe, this.deps.synthesize, this.deps.reinjectPersona, this.deps.proactiveResolver, this.deps.closeTrustWindow));
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
   *  KNOWN TRADE-OFF (intra-session only): this rearm is UNGATED (unlike rearmHeartbeatFor's cfg-diff gate)
   *  and stop+rebuilds the watcher on every visit of THAT session, resetting ITS OWN in-memory tick PHASE
   *  (the next setInterval tick is a fresh tickMs away, not continuous from the prior watcher's cadence) —
   *  never lost due-ness (seedLastFired reseeds lastFiredAt from durable fired-events either way), just
   *  possible jitter of up to one tick for the session actually being reconciled. Acceptable because
   *  reconciles are rare (a human config write or a reminder_create/cancel MCP call), not a hot path.
   *  FIXED (was a cross-companion bug): applyDesired's `onlySessionId` scoping means a config/reminder
   *  write for session A visits (and can rearm) ONLY A's updateOne — an UNRELATED live sibling B is never
   *  passed through updateOne at all for that reconcile, so B's tick phase is never perturbed by A's write.
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

  /** Disarm `sessionId`'s existing attention-push watcher and (re-)arm a fresh one, but ONLY when
   *  `resolveCompanionGrant` resolves a non-null `attention-push` scope for it — the grant-existence analog
   *  of rearmRemindersFor's row-existence gate (a session with no grant never builds/starts a watcher, so
   *  DEFAULT-OFF stays byte-identical: this is a single cheap grant lookup and nothing else). Called
   *  unconditionally on every live reconcile of that session (same UNGATED posture as rearmRemindersFor —
   *  see its doc for the accepted tick-phase-jitter trade-off, which applies here identically). NEVER
   *  touches another session's attention-push watcher. */
  private rearmAttentionPushFor(sessionId: string): void {
    this.stopAttentionPushFor(sessionId);
    if (!resolveCompanionGrant(this.deps.db, sessionId, "attention-push")) return;
    const build = this.deps.buildAttentionPush ?? ((sid: string) => new AttentionPushWatcher({ db: this.deps.db, pty: this.deps.pty, sessionId: sid }));
    const attentionPush = build(sessionId);
    this.attentionPush.set(sessionId, attentionPush);
    attentionPush.start();
  }

  private stopAttentionPushFor(sessionId: string): void {
    const attentionPush = this.attentionPush.get(sessionId);
    if (attentionPush) {
      attentionPush.stop();
      this.attentionPush.delete(sessionId);
    }
  }

  /** Tear down ONE session → the OFF state for it: stop its adapter long-poll, disarm its heartbeat +
   *  reminders, drop it from the chat_reply gate. Every OTHER live session is untouched. */
  private async teardownOne(sessionId: string): Promise<void> {
    await this.stopGatewayFor(sessionId);
    this.stopHeartbeatFor(sessionId);
    this.stopRemindersFor(sessionId);
    this.stopAttentionPushFor(sessionId);
    this.cfgs.delete(sessionId);
    this.deps.hooks.companionSessionIds.delete(sessionId);
  }

  /**
   * `teardownOne` PLUS the same-home rearm (store.ts's KNOWN RESIDUAL LATENCY, closed): if the exited
   * session shared its home with a still-LIVE sibling, that sibling may currently be SUPPRESSED (its
   * heartbeat zeroed by `suppressDuplicateHomeHeartbeats` because the exited session was the group's
   * winner) — re-resolving + reconciling just that sibling re-arms it promptly instead of leaving it
   * disarmed until the next boot or an unrelated config write.
   *
   * ONE SOURCE OF TRUTH for the same-home match (CR fix): both the exited session's home AND the
   * candidate-sibling homes are read from the freshly-`resolve`d set — the SAME authoritative source
   * `suppressDuplicateHomeHeartbeats`'s own winner-pick uses (`db.getCompanionHome` via `buildConfigFromRow`)
   * — never from the `this.cfgs` CACHE. A home REST write (`PUT /api/companion/home`) mutates app_meta
   * WITHOUT calling `reconcile()`, so a live sibling's cached `cfgs` entry can go stale on a home change;
   * matching against the cache could then MISS a survivor whose home just changed — exactly the latency
   * class this card exists to close, in a home-changed sub-case. `desired` already includes the exited
   * session's own (still-enabled) row — resolving liveness has no bearing on `buildConfigFromRow`, only on
   * the suppression step — so its home is read off `desired` too, before `teardownOne` clears its `cfgs`
   * entry (order doesn't matter functionally here, since `resolve` is a pure DB read, but reading it up
   * front keeps the "one resolve, one source" property obvious).
   *
   * A non-companion session (absent from `desired` — no enabled row at all) or one with no same-home LIVE
   * sibling is a no-op — `siblingIds` is simply empty (still-live is checked against `this.cfgs`, the
   * controller's own liveness truth, which `desired` alone can't tell — an enabled-but-long-dead row would
   * otherwise wrongly count as a "sibling"). Each sibling is reconciled via `applyDesired` DIRECTLY (not
   * `reconcile()`/`enqueue()`, which would recursively await this very op's own place in the serialization
   * chain and deadlock) — this method already runs serialized inside that chain via `onSessionExit`'s
   * `enqueue`, so a plain sequential `applyDesired` call preserves the same ordering guarantee for free. The
   * exited session's id is NEVER passed to `applyDesired` here — only its still-live siblings — so its
   * now-dead gateway is never re-started (see `onSessionExit`'s doc on the CompanionControl interface). With
   * ≥2 surviving same-home siblings, `desired`'s own suppression pass has already picked the NEW winner
   * among them (the exited session is excluded from that competition via `isLiveSession`, since its
   * `processState`/`archivedAt` are set BEFORE `onSessionExit` is ever called — see index.ts's `onExit`) —
   * so re-arming every sibling here converges on exactly one winner armed, the rest still suppressed.
   */
  private async teardownOneAndRearmSameHomeSiblings(sessionId: string): Promise<void> {
    const resolve = this.deps.resolveEffective ?? resolveAllEnabledConfigs;
    const desired = resolve(this.deps.db, this.deps.env, this.deps.keyPath);
    const exited = desired.find((cfg) => cfg.sessionId === sessionId);
    await this.teardownOne(sessionId);
    if (!exited) return;
    const siblingIds = desired
      .filter((cfg) => cfg.sessionId !== sessionId && cfg.homeChannel === exited.homeChannel && cfg.homeChatId === exited.homeChatId)
      .map((cfg) => cfg.sessionId)
      .filter((sid) => this.cfgs.has(sid));
    for (const siblingId of siblingIds) await this.applyDesired(desired, siblingId);
  }

  /** Tear down EVERY live session (daemon shutdown only — `stop()`). */
  private async teardownAll(): Promise<void> {
    await Promise.all([...this.cfgs.keys()].map((sessionId) => this.teardownOne(sessionId)));
  }
}
