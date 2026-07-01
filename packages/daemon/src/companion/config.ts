/**
 * Loom Companion — env-sourced configuration (spike binding). Default OFF: the whole subsystem only comes
 * up when LOOM_COMPANION_BOT_TOKEN is set, so an unconfigured daemon is byte-identical.
 */

/** Companion configuration (spike scope) — all three are required for the adapter to run. */
export interface CompanionConfig {
  /** Telegram bot token — its PRESENCE is what turns the companion ON (default OFF; see readCompanionConfig). */
  botToken: string;
  /** The SINGLE allowlisted chat id (spike). Any other chat id is rejected. */
  allowedChatId: string;
  /** The bound companion session id — an EXISTING live session (assistant / manager / worker). */
  sessionId: string;
}

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
  return { botToken, allowedChatId, sessionId };
}
