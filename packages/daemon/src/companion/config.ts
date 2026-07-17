/**
 * Loom Companion — env-sourced configuration (spike binding). Default OFF: the whole subsystem only comes
 * up when LOOM_COMPANION_BOT_TOKEN is set, so an unconfigured daemon is byte-identical.
 */
import { TELEGRAM_CHANNEL } from "./telegram.js";

/** Companion configuration (spike scope) — all three are required for the adapter to run. */
export interface CompanionConfig {
  /**
   * Telegram bot token. `null` ⇒ an IN-APP-ONLY companion (no external channel — the provision default):
   * the gateway comes up with only the in-app adapter and NO Telegram long-poll is armed. A non-null token
   * additionally wires Telegram. (The env spike path always supplies a token — its presence is what turns
   * that path ON; see readCompanionConfig — so only the DB-backed provision path produces a null here.)
   */
  botToken: string | null;
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
 *
 * Repeat-tick token friction (card e5a7f208): `decisions_list` (capabilities.ts) is a CHEAP read and the
 * ONLY way the companion learns a decision changed OUT-OF-BAND — the owner can answer a pending decision
 * on the board/manager side, which produces no message in the companion's own chat transcript, so the
 * companion cannot skip calling it based on its own memory of "nothing new happened." What IS expensive
 * and worth cutting is re-narrating / re-writing a brief for a decision that comes back unchanged
 * (`alreadySurfaced:true`, dependency 0c1365d0) — so the prompt below keeps the cheap check every tick but
 * explicitly teaches holding quietly on an all-unchanged result, rather than trying to skip the check.
 */
export const DEFAULT_HEARTBEAT_PROMPT =
  "Proactive check-in. Briefly review anything you are tracking for the owner (running work, follow-ups, " +
  "reminders, things you said you would get back to them on) — including decisions_list if you have it. " +
  "A decision's `alreadySurfaced:true` means you already told the owner about it in this exact state: do " +
  "not re-narrate it or write a fresh brief about it again on your own; only mention it if the owner asks " +
  "or something else prompts it. If every tracked decision is alreadySurfaced:true (or otherwise " +
  "unchanged) and nothing else is newly worth mentioning, stay quiet and do nothing. If — and only if — " +
  "something is genuinely new or changed (a decision newly surfaced, one whose state changed, or anything " +
  "else worth flagging), send it with chat_reply. Don't message just because you were pinged.";

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
