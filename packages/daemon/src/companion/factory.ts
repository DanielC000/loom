/**
 * Loom Companion — wiring that assembles the ChatGateway + the productized Telegram adapter from a
 * companion config AND the DURABLE binding store (multi-companion runtime: the controller calls this ONCE
 * PER ENABLED config, one ChatGateway instance per companion session). Loads the persisted session↔chat
 * bindings from the db SCOPED TO cfg.sessionId (Companion authz layer — never the global binding table, so
 * one companion's gateway can never hold another's binding), bootstrap-seeds the single env binding when
 * THAT session has no bindings yet, injects the db-backed per-binding sender authorization, registers the
 * Telegram adapter, and routes the adapter's inbound through the gateway. Returns the gateway; the
 * controller starts/stops it and routes the agent's chat_reply out through `gateway.deliverReply`.
 * Constructing this does NOT touch the network — call `gateway.start()` to begin polling.
 */
import { randomUUID } from "node:crypto";
import { ChatGateway } from "./chat-gateway.js";
import { createDbCompanionAuth, type AllowlistReader } from "./auth.js";
import { createDbCompanionPairing, type PairingStore } from "./pairing.js";
import { createDbCompanionVoicePrefs, type VoicePrefStore } from "./voice-prefs.js";
import type { CompanionConfig } from "./config.js";
import { createTelegramAdapter, TELEGRAM_CHANNEL } from "./telegram.js";
import { IN_APP_CHANNEL, type InAppChannel } from "./in-app.js";
import { isLikelyGroupTelegramChatId, isNonNumericTelegramChatId, InvalidTelegramChatIdError, type CompanionHistoryExport, type CompanionHistoryReset, type CompanionLivePush, type CompanionMessageRecorder, type CompanionRoute, type CompanionSynthesizer, type CompanionTranscriber, type SessionBinding, type SubmitTurn } from "./types.js";
import { reconcileCompanionBindingRoutes } from "./reconcile.js";
import type { CompanionBinding, CompanionMessage } from "@loom/shared";

/** The narrow db surface the factory needs: the durable binding store + the allowlist reader (for authz)
 *  + the pairing-code redemption txn (for DM-pairing) + the per-route voice-pref store (VOICE-P1) + the
 *  chat-history store (the "/new"/"/reset" command's history-clear half). */
export interface CompanionBindingStore extends AllowlistReader, PairingStore, VoicePrefStore {
  listCompanionBindings(): CompanionBinding[];
  // card 3d19ecc7: upsertCompanionBinding itself now marks companion_config.bindings_seeded the moment a
  // write lands (see db.ts's own doc on that method) — there is no separate mark call on this surface
  // anymore; see CompanionConfig.bindingsSeeded's own doc for the full rationale.
  upsertCompanionBinding(input: { sessionId: string; scope?: "dm" | "group" } & CompanionRoute): CompanionBinding;
  /** The proactive HOME channel target (card 9488951e), PER SESSION — carried explicitly on the
   *  heartbeat's submitted turn (as its per-turn route), not consulted by deliverReply. */
  getCompanionHome(sessionId: string): CompanionRoute | null;
  /** The "/new"/"/reset" command's history-ARCHIVE half (card 85f62475): closes the session's current
   *  conversation and opens the next one — replaces the old delete-everything `clearAllCompanionMessages`. */
  startNewCompanionConversation(sessionId: string): void;
  /** The chat-history WRITE (unified cross-channel chat, card 7d63e200) — the gateway's injected recorder
   *  calls this for every non-in-app channel's inbound/outbound turn (see `recorder` below). `proactive`
   *  (proactive event-line producer) tags a heartbeat/reminder/attention-push-originated reply. */
  insertCompanionMessage(m: { id: string; sessionId: string; channel: string; chatId: string; author: "user" | "companion"; text: string; createdAt: string; viaVoice?: boolean; proactive?: boolean }): void;
  /** The "/export" command's data source (Companion Slash Commands, card 9db7d09c): the session's CURRENT
   *  (open) conversation's stored messages across every channel, chronological — respects the "/new"
   *  conversation boundary (mirrors the human-only chat-history REST read). */
  listCurrentCompanionMessages(sessionId: string): CompanionMessage[];
  /** Zero-reply detector (card 48e8d289): record that a `chat_reply` was just successfully delivered for
   *  `sessionId`, resetting its zero-reply streak. Threaded to the gateway's `onReplyDelivered` hook. */
  recordChatReplyDelivered(sessionId: string): void;
  /** Outbound-suppression flag persistence (card 7578dea2): threaded to the gateway's `flagNonPrivateBinding`
   *  hook, so a binding `warnUnconfirmedDirectInbound` observes as non-private stays flagged across a restart. */
  flagCompanionBindingNonPrivate(sessionId: string, channel: string): void;
  /** Durable-event persistence (card 1b0df437): threaded to the gateway's `onUnboundRouteRefused` hook, so
   *  a `route-unbound` delivery refusal `warnUnboundRouteRefused` observes is recorded for later audit, not
   *  just a process-lifetime console warning. */
  recordCompanionUnboundRouteRefused(sessionId: string, channel: string, chatId: string): void;
  // card d3f9b4d2 Minor 1: the remaining surface companion/reconcile.ts's CompanionRouteReconcileStore
  // needs (getCompanionHome is already declared above) — threaded to the gateway's `reconcileBindingChange`
  // hook (dm-bind pairing redemption).
  getCompanionBindingsForSession(sessionId: string): { channel: string; chatId: string }[];
  clearCompanionHome(sessionId: string): void;
  listCompanionRemindersForSession(sessionId: string): { id: string; route: CompanionRoute | null }[];
  clearCompanionReminderRoute(reminderId: string): void;
  appendEvent(evt: { id: string; ts: string; managerSessionId: string; kind: string; detail?: Record<string, unknown> }): void;
}

/** Drop the db-only createdAt — the gateway's routing map wants just the SessionBinding shape. Carries
 *  `flaggedNonPrivate` through (card 7578dea2) so a binding persisted-flagged by a PRIOR process still
 *  suppresses outbound delivery from the moment this session's gateway is built, with no fresh inbound
 *  needed to re-observe it. */
function toSessionBinding(b: CompanionBinding): SessionBinding {
  return { sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope, flaggedNonPrivate: b.flaggedNonPrivate };
}

// @decision 61e33b99 — never use a different predicate here than db.upsertCompanionBinding's write-time
// check (isLikelyGroupTelegramChatId, companion/types.ts); never let this gate INBOUND authorization.
//
// This is now a BACKSTOP, not the primary enforcement point: upsertCompanionBinding computes the flag on
// every write (bind, re-bind, pairing redemption, bootstrap seed, provision), so a FRESH write can no
// longer leave a dm-scope + negative-chatId binding unflagged. This boot-time pass exists for a binding
// row written by an OLDER daemon build (before the write-time check existed) that predates this fix and
// has never been re-bound since — it still needs catching at boot, with no inbound required.
//
// @decision 94754bbe — a dm-scope + non-numeric Telegram chatId is REFUSED at the write chokepoint for a
// FRESH bind, so this boot pass can only ever meet one as a LEGACY row (predates the refusal). It still
// cannot be un-written retroactively — flag it exactly like the negative-integer case, never throw here.
function preFlagLikelyGroupDmBindings(bindings: CompanionBinding[], db: Pick<CompanionBindingStore, "flagCompanionBindingNonPrivate">): void {
  for (const b of bindings) {
    if (b.flaggedNonPrivate || b.scope !== "dm") continue;
    const likelyGroup = isLikelyGroupTelegramChatId(b.channel, b.chatId);
    const nonNumeric = !likelyGroup && isNonNumericTelegramChatId(b.channel, b.chatId);
    if (!likelyGroup && !nonNumeric) continue;
    b.flaggedNonPrivate = true;
    try {
      db.flagCompanionBindingNonPrivate(b.sessionId, b.channel);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[companion] persisting boot-time non-private binding flag failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[companion] SECURITY: dm-scope Telegram binding (session=${b.sessionId}) names a ` +
        `${likelyGroup ? "NEGATIVE" : "NON-NUMERIC"} chatId — Telegram's convention for a group/supergroup ` +
        `(or, non-numeric, never a valid private chat at all), not a private chat. Outbound delivery to this ` +
        `route is now suppressed at boot (cards 61e33b99/94754bbe); re-bind it with scope "group", or delete it, if so.`,
    );
  }
}

/**
 * Build the ChatGateway. `originResolver` (multi-channel reply routing) resolves a session's in-flight turn
 * origin — the daemon injects `(sid) => pty.getActiveTurnOrigin(sid)` so chat_reply delivers to the exact
 * route of the turn it answers. Undefined ⇒ deliverReply has no target (`no-target`); test seams that don't
 * exercise chat_reply routing may omit it. `transcribe` (Companion Voice epic, VOICE-P2) is the injected STT
 * transcriber — the daemon injects the local faster-whisper transcriber (companion/stt.ts); undefined ⇒ an
 * audio inbound is a no-op, byte-identical to today. `synthesize` (Companion Voice epic, VOICE-P3) is the
 * injected TTS synthesizer — the daemon injects the local kokoro-onnx synthesizer (companion/tts.ts);
 * undefined ⇒ deliverReply's text path is unchanged, byte-identical to today. `reinjectPersona` (the "/new"
 * persona-reinject side-channel — companion-persona-after-clear card, generalized by the standalone
 * "/refresh" command) is a raw-pty-enqueue impl built from SessionService.composeCompanionReinjectPrompt,
 * returning whether a prompt was actually composed+enqueued; undefined ⇒ resetConversation's persona-reinject
 * half and "/refresh" are both no-ops, byte-identical to today.
 */
export function createCompanionGateway(cfg: CompanionConfig, submitTurn: SubmitTurn, db: CompanionBindingStore, inApp?: InAppChannel, originResolver?: (sessionId: string) => CompanionRoute | null, transcribe?: CompanionTranscriber, synthesize?: CompanionSynthesizer, reinjectPersona?: (sessionId: string) => boolean, proactiveResolver?: (sessionId: string) => boolean, closeTrustWindow?: (sessionId: string) => void): ChatGateway {
  // Load durable bindings SCOPED TO THIS SESSION (multi-companion runtime, SECURITY-CRITICAL): filtering to
  // cfg.sessionId — rather than the global companion_bindings table — is what guarantees a gateway's OWN
  // routing map can NEVER contain another companion's binding, even when multiple companions are armed
  // concurrently (each gets its own ChatGateway instance via the controller's per-session map).
  //
  // @decision sha:55f1b628 — the bootstrap-seed guard below checks "this session has NO bindings yet"; a
  // GLOBAL binding read can't tell that apart from "a DIFFERENT companion already has some", so it would
  // wrongly make companion B skip seeding its own binding.
  //
  // BOOTSTRAP: an empty (session-scoped) store + present env config seeds ONE binding (the single-owner env
  // path). The DM authz rule means the owner works with no allowlist row; a group scope
  // (LOOM_COMPANION_CHAT_SCOPE=group) seeds a group binding to which senders are added over REST. This
  // whole path only runs when the companion is configured (index.ts gates on the enabled config SET), so an
  // unconfigured daemon never writes a binding row — default-OFF stays byte-identical.
  // Bootstrap the single env/Telegram binding ONLY when a token exists (the env single-owner path). An
  // IN-APP-ONLY companion (no token) carries no Telegram route — its in-app binding is minted by the
  // provision endpoint, not here — so seeding a Telegram binding from an empty allowedChatId is skipped.
  //
  // @decision a8480338 — never drop the `!cfg.bindingsSeeded` guard below: "zero bindings right now" is not
  // the same fact as "never provisioned" (an owner revoke also leaves zero bindings), and dropping it lets
  // the next gateway build silently re-seed a binding the owner deliberately revoked.
  let bindings = db.listCompanionBindings().filter((b) => b.sessionId === cfg.sessionId);
  if (bindings.length === 0 && cfg.botToken && !cfg.bindingsSeeded) {
    try {
      // card 3d19ecc7: db.upsertCompanionBinding marks bindings_seeded itself, in the SAME write, so there
      // is no separate mark call here anymore (see that method's own doc in db.ts).
      db.upsertCompanionBinding({ sessionId: cfg.sessionId, channel: TELEGRAM_CHANNEL, chatId: cfg.allowedChatId, scope: cfg.chatScope });
      bindings = db.listCompanionBindings().filter((b) => b.sessionId === cfg.sessionId);
    } catch (err) {
      // card 94754bbe: never let this refusal die silently inside the generic "hot-lifecycle reconcile
      // failed" catch (controller.ts's enqueue()) — that log names neither the companion nor the fix. An
      // owner whose LOOM_COMPANION_CHAT_ID (or allowedChatId, if set via the companion config) is non-numeric
      // (e.g. "@me") would otherwise just see this companion silently fail to arm, with no further signal
      // than a one-line "reconcile failed". Degrade instead of re-throwing: the gateway still builds (its
      // other wiring below is unaffected), just with NO Telegram BINDING until the chat id is fixed — this
      // is scoped to the binding (inbound + chat_reply) ONLY; a separately-configured home target is its own
      // value, validated at its own writers and suppressed independently at ChatGateway.mayDeliverTo (see
      // docs/decisions/94754bbe-refuse-non-numeric-telegram-dm-chatid.md's "Fix round 2").
      if (!(err instanceof InvalidTelegramChatIdError)) throw err;
      console.error(
        `[companion] SETUP: session ${cfg.sessionId.slice(0, 8)}'s env/bootstrap Telegram binding was ` +
          `REFUSED — ${err.message}. This companion has NO Telegram BINDING (its chat_reply/inbound route) ` +
          `until the chat id is corrected (LOOM_COMPANION_CHAT_ID, or the companion's allowedChatId) and the ` +
          `daemon restarts, or it is bound via the REST admin surface instead.`,
      );
    }
  } else if (bindings.length === 0 && cfg.botToken && cfg.bindingsSeeded) {
    // @decision a8480338 — never let this branch stay silent: zero bindings + bindingsSeeded:true covers
    // TWO stranded shapes (a deliberate owner revoke, or an interrupted env-bootstrap row — see that
    // record's "Known, accepted limitations"), and silence is indistinguishable from a broken companion.
    console.warn(
      `[companion] SETUP: session ${cfg.sessionId.slice(0, 8)} has no Telegram binding (revoked, or a first ` +
        `bind never landed); rebind via POST /api/companion/bindings.`,
    );
  }
  preFlagLikelyGroupDmBindings(bindings, db);
  // DM-pairing coordinator: the db-backed redemption path with the real wall clock (epoch ms). Default
  // rate-limit/lockout policy (5 attempts / 10-min window / 15-min lockout) — tests inject a fake clock.
  const pairing = createDbCompanionPairing(db, { now: () => Date.now() });
  // The "/new"/"/reset" command's history-ARCHIVE half (ChatGateway resets the agent's own context itself,
  // via the SAME submitTurn above — no dependency needed for that half). Archives EVERY channel's stored
  // history as ONE closed conversation and opens the next (card 85f62475, superseding the old delete-
  // everything behavior from card 4124b61e) — one companion shares one claude context across channels, so
  // "/new" starting fresh means starting fresh everywhere, not just the in-app rows. Every prior message is
  // RETAINED (tagged with the now-closed conversation seq), browsable via the history REST surface; this
  // does NOT and cannot clear the owner's Telegram-app history — Telegram keeps its own message history
  // client-side, independent of this reset. Still pushes the live "cleared" notice to an attached web viewer
  // — the panel empties immediately even though the old conversation's rows live on server-side.
  const historyReset: CompanionHistoryReset = {
    async clear(sessionId) {
      db.startNewCompanionConversation(sessionId);
      inApp?.pushCleared(sessionId);
    },
  };
  // CHAT HISTORY recorder (unified cross-channel chat, card 7d63e200) — generalizes the in-app-only
  // "reload loses history" fix (bug 0f01f234) to every channel the gateway routes (today: Telegram). Skips
  // the in-app channel: it already records via its own dedicated hooks (controller.ts's inbound record,
  // in-app.ts's outbound record via the `inApp` recorder passed in from index.ts) — recording it again here
  // would double-write the same turn.
  const recorder: CompanionMessageRecorder = {
    record(sessionId, channel, chatId, author, text, viaVoice, id, proactive) {
      if (channel === IN_APP_CHANNEL) return;
      db.insertCompanionMessage({ id: id ?? randomUUID(), sessionId, channel, chatId, author, text, createdAt: new Date().toISOString(), viaVoice, proactive });
    },
  };
  // LIVE PUSH (live-push card, closing a gap in the unified cross-channel chat): pushes the SAME turn the
  // recorder above just persisted — under the SAME `msg.id` — to any web client attached to `sessionId` via
  // the stable in-app hub, so an already-open CompanionChat panel sees a Telegram message appear without a
  // reload. Skips the in-app channel exactly like `recorder` above: it already renders live via its own
  // dedicated {type:"chat"}/{type:"transcript"} round trip, so pushing it again here would double-render.
  // `inApp` optional (Telegram-only / test seams without a hub) ⇒ this is a no-op.
  const livePush: CompanionLivePush = {
    push(sessionId, msg) {
      if (msg.channel === IN_APP_CHANNEL) return;
      inApp?.pushCrossChannel(sessionId, msg);
    },
  };
  // "/export" command's data source (Companion Slash Commands, card 9db7d09c): reads the session's CURRENT
  // (open) conversation only — same scoping as the human-only chat-history REST read, so "/export" can
  // never re-surface a conversation already closed by a prior "/new"/"/reset".
  const historyExport: CompanionHistoryExport = {
    read(sessionId) {
      return db.listCurrentCompanionMessages(sessionId);
    },
  };
  // Per-turn ORIGIN resolver (multi-channel reply routing): deliverReply targets the in-flight turn's
  // originating route (pty.getActiveTurnOrigin, injected). NOT the old home fallback — a proactive/heartbeat
  // turn now carries the home route ON its submit, so its chat_reply flows through the SAME per-turn path.
  // Zero-reply detector (card 48e8d289): reset THIS companion's zero-reply streak on every genuine
  // successful chat_reply delivery — see ChatGateway's onReplyDelivered doc.
  const onReplyDelivered = (sessionId: string) => db.recordChatReplyDelivered(sessionId);
  // Outbound-suppression persistence (card 7578dea2): see ChatGateway's flagNonPrivateBinding doc.
  const flagNonPrivateBinding = (b: SessionBinding) => db.flagCompanionBindingNonPrivate(b.sessionId, b.channel);
  // card d3f9b4d2 Minor 1: see ChatGateway's reconcileBindingChange call site for why this only ever
  // reconciles a FIRST dm-bind pair for the redeemed channel (or an idempotent same-chat re-pair) — db.ts's
  // own takeover check (card 4c9ef86d) already refuses a redemption that would repoint an already-bound
  // session at a different chatId on that SAME channel, but allows a different channel's first bind
  // through, so this never sees an existing route reconciled away, only a new one added.
  const reconcileBindingChange = (sessionId: string) => reconcileCompanionBindingRoutes(db, sessionId);
  // card 1b0df437: see ChatGateway's onUnboundRouteRefused doc — records the durable half of
  // warnUnboundRouteRefused's once-per-(session,route) console warning.
  const onUnboundRouteRefused = (sessionId: string, channel: string, chatId: string) => db.recordCompanionUnboundRouteRefused(sessionId, channel, chatId);
  const gateway = new ChatGateway(submitTurn, bindings.map(toSessionBinding), createDbCompanionAuth(db), pairing, originResolver, createDbCompanionVoicePrefs(db), transcribe, synthesize, historyReset, recorder, reinjectPersona, livePush, historyExport, proactiveResolver, closeTrustWindow, onReplyDelivered, flagNonPrivateBinding, reconcileBindingChange, onUnboundRouteRefused);
  // Telegram adapter — registered ONLY when a bot token exists. An IN-APP-ONLY companion (cfg.botToken null)
  // arms NO Telegram long-poll: the gateway comes up with the in-app adapter alone (registered below), so no
  // external network transport is started and default-OFF stays byte-identical. The adapter normalizes each
  // Telegram update, then hands it to the gateway (route → authz → submit). handleInbound is fire-and-forget,
  // so BACKSTOP its promise with .catch(): even though the gateway already contains a synchronous submit
  // throw, any future rejection here must never become an unhandled rejection (which the daemon's global
  // handler turns into process.exit(1) — the whole daemon down).
  if (cfg.botToken) {
    const adapter = createTelegramAdapter(cfg.botToken, (msg) => {
      gateway.handleInbound(msg).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[companion] inbound handling failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    gateway.registerAdapter(adapter);
  }
  // The in-app channel (default companion transport): register the STABLE hub's adapter so an in-app
  // binding routes over the same bindings-authoritative gateway (OUTBOUND chat_reply → deliverReply →
  // hub.adapter.send → the connected web client). ADDITIVE — with no in-app binding + no attached client
  // it is inert, so a Telegram-only companion is byte-identical. INBOUND does not wire here (no long-poll);
  // it enters via the controller's stable handleInAppInbound indirection. The hub is threaded in so it
  // survives a gateway rebuild (a token change must not drop live chat clients).
  if (inApp) gateway.registerAdapter(inApp.adapter);
  return gateway;
}
