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
import type { CompanionHistoryExport, CompanionHistoryReset, CompanionLivePush, CompanionMessageRecorder, CompanionRoute, CompanionSynthesizer, CompanionTranscriber, SessionBinding, SubmitTurn } from "./types.js";
import type { CompanionBinding, CompanionMessage } from "@loom/shared";

/** The narrow db surface the factory needs: the durable binding store + the allowlist reader (for authz)
 *  + the pairing-code redemption txn (for DM-pairing) + the per-route voice-pref store (VOICE-P1) + the
 *  chat-history store (the "/new"/"/reset" command's history-clear half). */
export interface CompanionBindingStore extends AllowlistReader, PairingStore, VoicePrefStore {
  listCompanionBindings(): CompanionBinding[];
  upsertCompanionBinding(input: { sessionId: string; scope?: "dm" | "group" } & CompanionRoute): CompanionBinding;
  /** The proactive HOME channel target (card 9488951e), PER SESSION — carried explicitly on the
   *  heartbeat's submitted turn (as its per-turn route), not consulted by deliverReply. */
  getCompanionHome(sessionId: string): CompanionRoute | null;
  /** The "/new"/"/reset" command's history-ARCHIVE half (card 85f62475): closes the session's current
   *  conversation and opens the next one — replaces the old delete-everything `clearAllCompanionMessages`. */
  startNewCompanionConversation(sessionId: string): void;
  /** The chat-history WRITE (unified cross-channel chat, card 7d63e200) — the gateway's injected recorder
   *  calls this for every non-in-app channel's inbound/outbound turn (see `recorder` below). */
  insertCompanionMessage(m: { id: string; sessionId: string; channel: string; chatId: string; author: "user" | "companion"; text: string; createdAt: string; viaVoice?: boolean }): void;
  /** The "/export" command's data source (Companion Slash Commands, card 9db7d09c): the session's CURRENT
   *  (open) conversation's stored messages across every channel, chronological — respects the "/new"
   *  conversation boundary (mirrors the human-only chat-history REST read). */
  listCurrentCompanionMessages(sessionId: string): CompanionMessage[];
}

/** Drop the db-only createdAt — the gateway's routing map wants just the SessionBinding shape. */
function toSessionBinding(b: CompanionBinding): SessionBinding {
  return { sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope };
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
export function createCompanionGateway(cfg: CompanionConfig, submitTurn: SubmitTurn, db: CompanionBindingStore, inApp?: InAppChannel, originResolver?: (sessionId: string) => CompanionRoute | null, transcribe?: CompanionTranscriber, synthesize?: CompanionSynthesizer, reinjectPersona?: (sessionId: string) => boolean): ChatGateway {
  // Load durable bindings SCOPED TO THIS SESSION (multi-companion runtime, SECURITY-CRITICAL): filtering to
  // cfg.sessionId — rather than the global companion_bindings table — is what guarantees a gateway's OWN
  // routing map can NEVER contain another companion's binding, even when multiple companions are armed
  // concurrently (each gets its own ChatGateway instance via the controller's per-session map). It also
  // fixes a correctness bug the global read would otherwise hit under multi-companion: the bootstrap-seed
  // guard below checks "this session has NO bindings yet", which the GLOBAL binding count would answer
  // wrongly (companion B would see companion A's bindings and skip seeding its OWN).
  // BOOTSTRAP: an empty (session-scoped) store + present env config seeds ONE binding (the single-owner env
  // path). The DM authz rule means the owner works with no allowlist row; a group scope
  // (LOOM_COMPANION_CHAT_SCOPE=group) seeds a group binding to which senders are added over REST. This
  // whole path only runs when the companion is configured (index.ts gates on the enabled config SET), so an
  // unconfigured daemon never writes a binding row — default-OFF stays byte-identical.
  // Bootstrap the single env/Telegram binding ONLY when a token exists (the env single-owner path). An
  // IN-APP-ONLY companion (no token) carries no Telegram route — its in-app binding is minted by the
  // provision endpoint, not here — so seeding a Telegram binding from an empty allowedChatId is skipped.
  let bindings = db.listCompanionBindings().filter((b) => b.sessionId === cfg.sessionId);
  if (bindings.length === 0 && cfg.botToken) {
    db.upsertCompanionBinding({ sessionId: cfg.sessionId, channel: TELEGRAM_CHANNEL, chatId: cfg.allowedChatId, scope: cfg.chatScope });
    bindings = db.listCompanionBindings().filter((b) => b.sessionId === cfg.sessionId);
  }
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
    record(sessionId, channel, chatId, author, text, viaVoice, id) {
      if (channel === IN_APP_CHANNEL) return;
      db.insertCompanionMessage({ id: id ?? randomUUID(), sessionId, channel, chatId, author, text, createdAt: new Date().toISOString(), viaVoice });
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
  const gateway = new ChatGateway(submitTurn, bindings.map(toSessionBinding), createDbCompanionAuth(db), pairing, originResolver, createDbCompanionVoicePrefs(db), transcribe, synthesize, historyReset, recorder, reinjectPersona, livePush, historyExport);
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
