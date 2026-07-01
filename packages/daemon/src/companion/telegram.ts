/**
 * Loom Companion — Telegram adapter (Phase 0 spike). A THIN wire between the real grammY bot and the
 * transport-agnostic CompanionGateway core: the bot's `sendMessage` is the OUTBOUND transport, and each
 * inbound message update is fed into `handleInboundUpdate` (which allowlists + submits the turn).
 *
 * LONG-POLL (grammY `bot.start()`), NOT a webhook — so no public URL / TLS is needed. Default OFF: the
 * daemon only constructs this when the bot token env is set (see index.ts + readCompanionConfig), so a
 * normal daemon is byte-identical.
 *
 * Kept intentionally minimal — the real channel-adapter interface is a later card (Phase 1). This file is
 * the only one that touches grammY; the loop's logic lives in gateway.ts so it can be tested without a
 * live network.
 */
import { Bot } from "grammy";
import { CompanionGateway, type ChatTransport, type CompanionConfig, type SubmitTurn } from "./gateway.js";

export interface CompanionAdapter {
  /** The core gateway — index.ts routes the agent's chat_reply through `gateway.deliverReply`. */
  gateway: CompanionGateway;
  /** Begin the long-poll loop (fire-and-forget; resolves only when the bot stops). */
  start(): void;
  /** Stop the long-poll loop (best-effort on shutdown). */
  stop(): Promise<void>;
}

/**
 * Wire the real grammY Telegram bot as the companion's transport AND long-poll feed. Constructing this
 * does NOT touch the network; call `start()` to begin polling.
 */
export function createTelegramCompanion(cfg: CompanionConfig, submitTurn: SubmitTurn): CompanionAdapter {
  const bot = new Bot(cfg.botToken);
  const transport: ChatTransport = {
    async send(chatId, text) {
      await bot.api.sendMessage(chatId, text);
    },
  };
  const gateway = new CompanionGateway(cfg, submitTurn, transport);
  // Feed every inbound message update into the transport-agnostic core (allowlist-check → submit turn).
  bot.on("message", (ctx) => {
    gateway.handleInboundUpdate(ctx.update);
  });
  return {
    gateway,
    start() {
      // bot.start() only resolves when the bot stops, so fire-and-forget the long-poll loop; a startup
      // failure (bad token / network) is logged, not thrown, so it can never crash the daemon boot.
      void bot
        .start({ onStart: (info) => console.log(`[companion] Telegram long-poll started as @${info.username}`) })
        .catch((err) => console.error(`[companion] Telegram long-poll error: ${(err as Error).message}`));
    },
    stop() {
      return bot.stop();
    },
  };
}
