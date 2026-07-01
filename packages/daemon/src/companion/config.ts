/**
 * Loom Companion — env-sourced configuration (spike binding). Default OFF: the whole subsystem only comes
 * up when LOOM_COMPANION_BOT_TOKEN is set, so an unconfigured daemon is byte-identical.
 */
import { TELEGRAM_CHANNEL } from "./telegram.js";

/** Companion configuration (spike scope) — all three are required for the adapter to run. */
export interface CompanionConfig {
  /** Telegram bot token — its PRESENCE is what turns the companion ON (default OFF; see readCompanionConfig). */
  botToken: string;
  /** The SINGLE allowlisted chat id (spike). Any other chat id is rejected. */
  allowedChatId: string;
  /** The bound companion session id — an EXISTING live session (assistant / manager / worker). */
  sessionId: string;
  /**
   * The scope the boot-seeded binding is created with (Companion authz layer). "dm" (DEFAULT) = the
   * single-owner private-chat path; "group" lets the owner bind a shared chat at boot (then adds
   * allowlisted senders over REST). From LOOM_COMPANION_CHAT_SCOPE.
   */
  chatScope: "dm" | "group";
  /**
   * The Companion HOME channel + chat id (the proactive/outbound "where to reach the owner" target the
   * proactive card 9488951e will read). `homeChannel` defaults to the Telegram channel; `homeChatId`
   * defaults to `allowedChatId`. From LOOM_COMPANION_HOME_CHANNEL / LOOM_COMPANION_HOME_CHAT_ID.
   */
  homeChannel: string;
  homeChatId: string;
  /**
   * Proactive HEARTBEAT cadence, in minutes (card 9488951e). 0 (the DEFAULT — unset/blank/non-numeric)
   * means OFF: no heartbeat watcher is ever armed and every existing path is byte-identical. A positive
   * value opts the companion into a periodic daemon-driven proactive turn that runs and (only if there's
   * something worth saying) `chat_reply`s the HOME channel. Keep it CONSERVATIVE so a companion never
   * starves the fleet's rate-limit budget — e.g. 360 (6h). From LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES.
   */
  heartbeatIntervalMinutes: number;
  /**
   * The framed proactive-prompt text injected on each heartbeat turn. TRUSTED daemon text (clearly
   * framed, NOT untrusted chat). Defaults to DEFAULT_HEARTBEAT_PROMPT. From LOOM_COMPANION_HEARTBEAT_PROMPT.
   */
  heartbeatPrompt: string;
}

/**
 * The default proactive-prompt text (TRUSTED daemon text — the heartbeat watcher frames it as
 * `[loom:heartbeat] …`, distinct from untrusted inbound chat). It instructs a brief proactive check and
 * a reply ONLY when there's something worth surfacing, so a conservative cadence stays quiet by default.
 */
export const DEFAULT_HEARTBEAT_PROMPT =
  "Proactive check-in. Briefly review anything you are tracking for the owner (running work, follow-ups, " +
  "reminders, things you said you would get back to them on). If — and only if — there is something " +
  "genuinely worth surfacing, send it with chat_reply. If there is nothing worth saying, stay quiet and " +
  "do nothing. Don't message just because you were pinged.";

/**
 * Read the companion config from env (spike scope). Returns null when the bot token is UNSET → the whole
 * subsystem never starts and the daemon is byte-identical to today. When the token IS set but the chat id
 * or bound session id is missing, warn and stay off (a half-configured companion is a no-op, not a crash).
 */
export function readCompanionConfig(env: NodeJS.ProcessEnv): CompanionConfig | null {
  const botToken = env.LOOM_COMPANION_BOT_TOKEN?.trim();
  const allowedChatId = env.LOOM_COMPANION_CHAT_ID?.trim();
  const sessionId = env.LOOM_COMPANION_SESSION_ID?.trim();
  if (!botToken) return null; // OFF by default — the whole subsystem never starts.
  if (!allowedChatId || !sessionId) {
    // eslint-disable-next-line no-console
    console.warn(
      "[companion] LOOM_COMPANION_BOT_TOKEN is set but LOOM_COMPANION_CHAT_ID and/or " +
        "LOOM_COMPANION_SESSION_ID are missing — companion NOT started.",
    );
    return null;
  }
  // Boot-binding scope: "group" only when explicitly requested, else the safe single-owner "dm".
  const chatScope = env.LOOM_COMPANION_CHAT_SCOPE?.trim() === "group" ? "group" : "dm";
  // Home channel target: channel defaults to Telegram (the only channel today), chatId to the owner's chat.
  const homeChannel = env.LOOM_COMPANION_HOME_CHANNEL?.trim() || TELEGRAM_CHANNEL;
  const homeChatId = env.LOOM_COMPANION_HOME_CHAT_ID?.trim() || allowedChatId;
  // Proactive heartbeat: OFF unless a POSITIVE cadence is set (unset/blank/0/non-numeric ⇒ 0 ⇒ off).
  const rawInterval = Number(env.LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES);
  const heartbeatIntervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 0;
  const heartbeatPrompt = env.LOOM_COMPANION_HEARTBEAT_PROMPT?.trim() || DEFAULT_HEARTBEAT_PROMPT;
  return { botToken, allowedChatId, sessionId, chatScope, homeChannel, homeChatId, heartbeatIntervalMinutes, heartbeatPrompt };
}
