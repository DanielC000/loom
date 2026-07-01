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
import type { CompanionConfig } from "./config.js";
import { createTelegramAdapter, TELEGRAM_CHANNEL } from "./telegram.js";
import type { SessionBinding, SubmitTurn } from "./types.js";
import type { CompanionBinding } from "@loom/shared";

/** The narrow db surface the factory needs: the durable binding store + the allowlist reader (for authz). */
export interface CompanionBindingStore extends AllowlistReader {
  listCompanionBindings(): CompanionBinding[];
  upsertCompanionBinding(input: { sessionId: string; channel: string; chatId: string; scope?: "dm" | "group" }): CompanionBinding;
}

/** Drop the db-only createdAt — the gateway's routing map wants just the SessionBinding shape. */
function toSessionBinding(b: CompanionBinding): SessionBinding {
  return { sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope };
}

export function createCompanionGateway(cfg: CompanionConfig, submitTurn: SubmitTurn, db: CompanionBindingStore): ChatGateway {
  // Load durable bindings. BOOTSTRAP: an empty store + present env config seeds ONE binding (the
  // single-owner env path). The DM authz rule means the owner works with no allowlist row; a group scope
  // (LOOM_COMPANION_CHAT_SCOPE=group) seeds a group binding to which senders are added over REST. This
  // whole path only runs when the companion is configured (index.ts gates on a non-null CompanionConfig),
  // so an unconfigured daemon never writes a binding row — default-OFF stays byte-identical.
  let bindings = db.listCompanionBindings();
  if (bindings.length === 0) {
    db.upsertCompanionBinding({ sessionId: cfg.sessionId, channel: TELEGRAM_CHANNEL, chatId: cfg.allowedChatId, scope: cfg.chatScope });
    bindings = db.listCompanionBindings();
  }
  const gateway = new ChatGateway(submitTurn, bindings.map(toSessionBinding), createDbCompanionAuth(db));
  // The adapter normalizes each Telegram update, then hands it to the gateway (route → authz → submit).
  // handleInbound is fire-and-forget, so BACKSTOP its promise with .catch(): even though the gateway
  // already contains a synchronous submit throw, any future rejection here must never become an unhandled
  // rejection (which the daemon's global handler turns into process.exit(1) — the whole daemon down).
  const adapter = createTelegramAdapter(cfg.botToken, (msg) => {
    gateway.handleInbound(msg).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[companion] inbound handling failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  gateway.registerAdapter(adapter);
  return gateway;
}
