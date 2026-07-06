/**
 * Loom Companion — wiring that assembles the ChatGateway + the productized Telegram adapter from the env
 * companion config AND the DURABLE binding store. Loads the persisted session↔chat bindings from the db
 * (Companion authz layer), bootstrap-seeds the single env binding when the store is empty, injects the
 * db-backed per-binding sender authorization, registers the Telegram adapter, and routes the adapter's
 * inbound through the gateway. Returns the gateway; index.ts starts/stops it and routes the agent's
 * chat_reply out through `gateway.deliverReply`. Constructing this does NOT touch the network — call
 * `gateway.start()` to begin polling.
 */
import { ChatGateway } from "./chat-gateway.js";
import { createDbCompanionAuth, type AllowlistReader } from "./auth.js";
import { createDbCompanionPairing, type PairingStore } from "./pairing.js";
import { createDbCompanionVoicePrefs, type VoicePrefStore } from "./voice-prefs.js";
import type { CompanionConfig } from "./config.js";
import { createTelegramAdapter, TELEGRAM_CHANNEL } from "./telegram.js";
import { IN_APP_CHANNEL, type InAppChannel } from "./in-app.js";
import type { CompanionHistoryReset, CompanionRoute, CompanionSynthesizer, CompanionTranscriber, SessionBinding, SubmitTurn } from "./types.js";
import type { CompanionBinding } from "@loom/shared";

/** The narrow db surface the factory needs: the durable binding store + the allowlist reader (for authz)
 *  + the pairing-code redemption txn (for DM-pairing) + the per-route voice-pref store (VOICE-P1) + the
 *  chat-history store (the "/new"/"/reset" command's history-clear half). */
export interface CompanionBindingStore extends AllowlistReader, PairingStore, VoicePrefStore {
  listCompanionBindings(): CompanionBinding[];
  upsertCompanionBinding(input: { sessionId: string; scope?: "dm" | "group" } & CompanionRoute): CompanionBinding;
  /** The proactive HOME channel target (card 9488951e) — carried explicitly on the heartbeat's submitted
   *  turn (as its per-turn route), not consulted by deliverReply. */
  getCompanionHome(): CompanionRoute | null;
  clearCompanionMessages(sessionId: string, channel: string): void;
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
 * undefined ⇒ deliverReply's text path is unchanged, byte-identical to today.
 */
export function createCompanionGateway(cfg: CompanionConfig, submitTurn: SubmitTurn, db: CompanionBindingStore, inApp?: InAppChannel, originResolver?: (sessionId: string) => CompanionRoute | null, transcribe?: CompanionTranscriber, synthesize?: CompanionSynthesizer): ChatGateway {
  // Load durable bindings. BOOTSTRAP: an empty store + present env config seeds ONE binding (the
  // single-owner env path). The DM authz rule means the owner works with no allowlist row; a group scope
  // (LOOM_COMPANION_CHAT_SCOPE=group) seeds a group binding to which senders are added over REST. This
  // whole path only runs when the companion is configured (index.ts gates on a non-null CompanionConfig),
  // so an unconfigured daemon never writes a binding row — default-OFF stays byte-identical.
  // Bootstrap the single env/Telegram binding ONLY when a token exists (the env single-owner path). An
  // IN-APP-ONLY companion (no token) carries no Telegram route — its in-app binding is minted by the
  // provision endpoint, not here — so seeding a Telegram binding from an empty allowedChatId is skipped.
  let bindings = db.listCompanionBindings();
  if (bindings.length === 0 && cfg.botToken) {
    db.upsertCompanionBinding({ sessionId: cfg.sessionId, channel: TELEGRAM_CHANNEL, chatId: cfg.allowedChatId, scope: cfg.chatScope });
    bindings = db.listCompanionBindings();
  }
  // DM-pairing coordinator: the db-backed redemption path with the real wall clock (epoch ms). Default
  // rate-limit/lockout policy (5 attempts / 10-min window / 15-min lockout) — tests inject a fake clock.
  const pairing = createDbCompanionPairing(db, { now: () => Date.now() });
  // The "/new"/"/reset" command's history-clear half (ChatGateway resets the agent's own context itself,
  // via the SAME submitTurn above — no dependency needed for that half). Scoped to IN_APP_CHANNEL: it's the
  // only channel that ever writes companion_messages (Telegram keeps its own history in the Telegram app —
  // see db.ts/gateway/server.ts's comments), so clearing it is correct regardless of which channel's "/new"
  // triggered the reset (one companion session, one shared conversation).
  const historyReset: CompanionHistoryReset = {
    async clear(sessionId) {
      db.clearCompanionMessages(sessionId, IN_APP_CHANNEL);
      inApp?.pushCleared(sessionId);
    },
  };
  // Per-turn ORIGIN resolver (multi-channel reply routing): deliverReply targets the in-flight turn's
  // originating route (pty.getActiveTurnOrigin, injected). NOT the old home fallback — a proactive/heartbeat
  // turn now carries the home route ON its submit, so its chat_reply flows through the SAME per-turn path.
  const gateway = new ChatGateway(submitTurn, bindings.map(toSessionBinding), createDbCompanionAuth(db), pairing, originResolver, createDbCompanionVoicePrefs(db), transcribe, synthesize, historyReset);
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
