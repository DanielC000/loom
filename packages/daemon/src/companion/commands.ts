/**
 * Loom Companion — the "/" slash-command router (Companion Voice epic, VOICE-P1 foundation).
 *
 * Intercepts a leading "/command" BEFORE it ever reaches `submitTurn`, at the exact `chat-gateway.ts`
 * `handleInbound` pre-submit seam where `pairing.redeem` already intercepts a code-shaped body — so a
 * RECOGNIZED command's text NEVER becomes an agent turn (mirrors the redeemed-pairing-code path). An
 * unrecognized "/word" (no handler registered) is NOT treated as a command by this router: it falls
 * through unchanged to the normal text pipeline, so only a REGISTERED command name (see COMMANDS below —
 * today "/lang", "/voice", "/new", "/reset", "/status", "/start", "/help") is ever swallowed — every other
 * message (including one that merely starts with "/") is byte-identical to today.
 *
 * Platform-agnostic: this sits ONE layer above the normalizer (Telegram, in-app, …), so it works the same
 * for every channel.
 *
 * Clean-room: modeled on OpenClaw's channel-level command dispatcher (pattern, not code) — see the design
 * note `Projects/Loom/Design/Companion Voice — STT-TTS Design.md` Part 2.
 *
 * Tier-2 slash commands (card 9db7d09c, first slice — `/export`/`/whoami` are a later slice): `/status`
 * (in-chat state readout) and `/start` (Telegram's automatic first-contact message, intercepted so it
 * never leaks a raw agent turn) need no new `CommandDeps` — both read only from the existing `prefs`/
 * `route` params already threaded through every handler.
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

/**
 * Capabilities beyond the voice-prefs store a command handler may need — injected so commands.ts stays
 * pure/testable (mirrors how ChatGateway itself is built from small injected interfaces, never a raw db/
 * pty). Extended as later commands need more (Tier-2 slash commands, card 9db7d09c); kept to exactly what
 * `/new`/`/reset` need today.
 */
export interface CommandDeps {
  /** Start a fresh conversation for `sessionId`: forgets the underlying agent's prior context AND clears
   *  any persisted chat history for the route, notifying a live viewer (ChatGateway.resetConversation).
   *  Never throws. */
  resetConversation(sessionId: string): Promise<void>;
}

/**
 * A command handler may be sync (every handler before `/new`) or async (`/new`/`/reset`, which await a
 * session-lifecycle side effect) — `CommandResult | Promise<CommandResult>` covers both, and the dispatch
 * call site always `await`s the result, which resolves a plain (non-Promise) object through unchanged. The
 * `deps` param is ADDITIVE: a handler declared with fewer params (every existing `/lang`/`/voice`/`/help`
 * handler) is still a valid `CommandHandler` — TypeScript allows a shorter-arity function to satisfy a
 * wider function type, since a JS call with extra arguments is always safe — so none of them needed to
 * change shape for this contract to grow.
 */
export type CommandHandler = (
  args: string | undefined,
  route: VoicePrefRoute,
  prefs: CompanionVoicePrefs,
  deps: CommandDeps,
) => CommandResult | Promise<CommandResult>;

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

/** `/new` — start a fresh conversation (forgets prior context + clears the chat history). `/reset` is a
 *  literal ALIAS (Hermes collapses the two; Loom has no archive-split to distinguish them either — see
 *  the design note) — both COMMANDS entries below point at this SAME function object, so COMMAND_MENU
 *  advertises both with zero risk of the two drifting apart. */
const startFreshConversation: CommandHandler = async (_args, route, _prefs, deps) => {
  await deps.resetConversation(route.sessionId);
  return { ack: "🆕 Started a fresh conversation." };
};

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
    description: "Turn voice replies on, off, or auto (the agent decides per reply)",
    handler(args, route, prefs) {
      const norm = args?.toLowerCase();
      if (norm !== "on" && norm !== "off" && norm !== "auto") {
        return { ack: "Usage: /voice on|off|auto" };
      }
      prefs.setVoiceReplies(route, norm);
      // Group-scoped voice replies aren't deliverable yet (VOICE-P3, DM-first): the outbound reply
      // always resolves senderId:null, so a per-sender group row is never found and the reply always
      // degrades to text. Don't let "/voice on"/"/voice auto" claim a success it can't deliver in a group.
      if (norm !== "off" && route.senderId !== null) {
        return { ack: "Voice replies aren't available in group chats yet — DM the bot and turn it on there." };
      }
      if (norm === "auto") return { ack: "✅ Voice replies set to auto — I'll decide when to speak." };
      return { ack: `✅ Voice replies turned ${norm}.` };
    },
  },
  new: {
    description: "Start a fresh conversation — forgets everything said so far",
    handler: startFreshConversation,
  },
  reset: {
    description: "Alias of /new — start a fresh conversation",
    handler: startFreshConversation,
  },
  status: {
    description: "Show your current voice reply and language settings",
    handler(_args, route, prefs) {
      const resolved = prefs.resolve(route);
      const lang = resolved.ttsLang ?? "auto-detect";
      return { ack: `🔎 Voice replies: ${resolved.voiceReplies} · Language: ${lang}` };
    },
  },
  start: {
    // Telegram sends a literal "/start" on first contact with a bot; with no handler registered it fell
    // straight through to `submitTurn` as a raw agent turn. Registering it here swallows that handshake
    // instead — platform-agnostic (a human typing "/start" in the in-app chat gets the same harmless ack).
    description: "Say hello",
    handler() {
      return { ack: "👋 I'm your Loom companion — I'm here. Send me a message anytime." };
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
