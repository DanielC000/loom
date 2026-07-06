/**
 * Loom Companion — the "/" slash-command router (Companion Voice epic, VOICE-P1 foundation).
 *
 * Intercepts a leading "/command" BEFORE it ever reaches `submitTurn`, at the exact `chat-gateway.ts`
 * `handleInbound` pre-submit seam where `pairing.redeem` already intercepts a code-shaped body — so a
 * RECOGNIZED command's text NEVER becomes an agent turn (mirrors the redeemed-pairing-code path). An
 * unrecognized "/word" (no handler registered) is NOT treated as a command by this router: it falls
 * through unchanged to the normal text pipeline, so only "/lang" and "/voice" are ever swallowed — every
 * other message (including one that merely starts with "/") is byte-identical to today.
 *
 * Platform-agnostic: this sits ONE layer above the normalizer (Telegram, in-app, …), so it works the same
 * for every channel.
 *
 * Clean-room: modeled on OpenClaw's channel-level command dispatcher (pattern, not code) — see the design
 * note `Projects/Loom/Design/Companion Voice — STT-TTS Design.md` Part 2.
 */
import type { CompanionVoicePrefs, VoicePrefRoute } from "./voice-prefs.js";

/** Matches a leading "/command[@bot] [args]" — the WHOLE trimmed body must be command-shaped (a command
 *  followed by anything the regex can't consume, e.g. a trailing newline block, is NOT a command — the
 *  safer default: only an unambiguous single-line command is ever intercepted). */
const COMMAND_RE = /^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/;

/** A 2-letter ISO-639-1-ish code with an optional 2-4 letter region/script subtag (e.g. "en", "pt-BR"). */
const LANG_RE = /^[a-zA-Z]{2}(-[a-zA-Z]{2,4})?$/;

export interface ParsedCommand {
  /** Lowercased command name (without the leading "/" or an "@bot" suffix). */
  name: string;
  args: string | undefined;
}

/** Parse a leading "/command [args]" out of `body`, or null when it isn't command-shaped. Pure — no I/O,
 *  no db, safe to call on every inbound body. */
export function parseCommand(body: string): ParsedCommand | null {
  const m = COMMAND_RE.exec(body.trim());
  const name = m?.[1];
  if (!m || !name) return null;
  return { name: name.toLowerCase(), args: m[2]?.trim() || undefined };
}

/** The result of dispatching a recognized command — `ack` is sent back to the chat via `tryAck`. */
export interface CommandResult {
  ack: string;
}

export type CommandHandler = (args: string | undefined, route: VoicePrefRoute, prefs: CompanionVoicePrefs) => CommandResult;

function normalizeLangCode(code: string): string {
  const dash = code.indexOf("-");
  if (dash === -1) return code.toLowerCase();
  return `${code.slice(0, dash).toLowerCase()}-${code.slice(dash + 1).toUpperCase()}`;
}

interface CommandDef {
  handler: CommandHandler;
  /** The Telegram `setMyCommands` menu description for this command. */
  description: string;
}

/**
 * THE single source of truth for every recognized command: `commandHandler` and `COMMAND_MENU` are both
 * DERIVED from this one map (never a second parallel literal), so a handler can never exist without a menu
 * entry (unadvertised but working) and a menu entry can never exist without a handler (advertised, but
 * falls through to the agent as raw text) — the two structurally CANNOT drift apart.
 */
const COMMANDS: Record<string, CommandDef> = {
  lang: {
    description: "Set your voice language, e.g. /lang en",
    handler(args, route, prefs) {
      if (!args || !LANG_RE.test(args)) {
        return { ack: "Usage: /lang <code> — e.g. /lang en, /lang pt-BR" };
      }
      const code = normalizeLangCode(args);
      prefs.setLang(route, code);
      return { ack: `✅ Language set to ${code}.` };
    },
  },
  voice: {
    description: "Turn voice replies on or off",
    handler(args, route, prefs) {
      const norm = args?.toLowerCase();
      if (norm !== "on" && norm !== "off") {
        return { ack: "Usage: /voice on|off" };
      }
      prefs.setVoiceReplies(route, norm === "on");
      // Group-scoped voice replies aren't deliverable yet (VOICE-P3, DM-first): the outbound reply
      // always resolves senderId:null, so a per-sender group row is never found and the reply always
      // degrades to text. Don't let "/voice on" claim a success it can't deliver in a group.
      if (norm === "on" && route.senderId !== null) {
        return { ack: "Voice replies aren't available in group chats yet — DM the bot and turn it on there." };
      }
      return { ack: `✅ Voice replies turned ${norm}.` };
    },
  },
  help: {
    description: "List every recognized command",
    // Derives its output from COMMANDS itself (not a second hand-maintained list), so a new command
    // registered above automatically appears here — the in-app web chat has no native command menu
    // (Telegram gets one via setMyCommands), so this is the only way to discover commands there.
    handler() {
      const lines = Object.entries(COMMANDS).map(([command, def]) => `/${command} – ${def.description}`);
      return { ack: `Available commands:\n${lines.join("\n")}` };
    },
  },
};

/** Look up the handler for a parsed command name, or undefined when unrecognized — the router's signal
 *  to fall through to the normal text pipeline instead of intercepting. */
export function commandHandler(name: string): CommandHandler | undefined {
  return COMMANDS[name]?.handler;
}

/** The commands this router recognizes — the Telegram `setMyCommands` menu (`telegram.ts`), DERIVED from
 *  {@link COMMANDS} so the native "/" UI and the actual handler map can never drift apart. */
export const COMMAND_MENU: { command: string; description: string }[] = Object.entries(COMMANDS).map(
  ([command, def]) => ({ command, description: def.description }),
);

/** Every recognized command name (test seam — belt-and-suspenders: asserts the handler key-set equals
 *  the {@link COMMAND_MENU} command-set, on top of the by-construction guarantee above). */
export function registeredCommandNames(): string[] {
  return Object.keys(COMMANDS);
}
