/**
 * Loom Companion — wiring that assembles the ChatGateway + the productized Telegram adapter from the env
 * companion config (spike binding). Seeds ONE session↔chat binding, registers the Telegram adapter, and
 * routes the adapter's inbound through the gateway. Returns the gateway; index.ts starts/stops it and
 * routes the agent's chat_reply out through `gateway.deliverReply`. Constructing this does NOT touch the
 * network — call `gateway.start()` to begin polling.
 */
import { ChatGateway } from "./chat-gateway.js";
import type { CompanionConfig } from "./config.js";
import { createTelegramAdapter, TELEGRAM_CHANNEL } from "./telegram.js";
import type { SubmitTurn } from "./types.js";

export function createCompanionGateway(cfg: CompanionConfig, submitTurn: SubmitTurn): ChatGateway {
  const gateway = new ChatGateway(submitTurn, [
    { sessionId: cfg.sessionId, channel: TELEGRAM_CHANNEL, chatId: cfg.allowedChatId },
  ]);
  // The adapter normalizes each Telegram update, then hands it to the gateway (allowlist → submit turn).
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
