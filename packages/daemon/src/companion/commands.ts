/**
 * Loom Companion — the "/" slash-command router (Companion Voice epic, VOICE-P1 foundation).
 *
 * Intercepts a leading "/command" BEFORE it ever reaches `submitTurn`, at the exact `chat-gateway.ts`
 * `handleInbound` pre-submit seam where `pairing.redeem` already intercepts a code-shaped body — so a
 * RECOGNIZED command's text NEVER becomes an agent turn (mirrors the redeemed-pairing-code path). An
 * unrecognized "/word" (no handler registered) is NOT treated as a command by this router: it falls
 * through unchanged to the normal text pipeline, so only a REGISTERED command name (see COMMANDS below —
 * today "/lang", "/voice", "/new", "/reset", "/status", "/whoami", "/export", "/start", "/help") is ever
 * swallowed — every other message (including one that merely starts with "/") is byte-identical to today.
 *
 * Platform-agnostic: this sits ONE layer above the normalizer (Telegram, in-app, …), so it works the same
 * for every channel.
 *
 * Clean-room: modeled on OpenClaw's channel-level command dispatcher (pattern, not code) — see the design
 * note `Projects/Loom/Design/Companion Voice — STT-TTS Design.md` Part 2.
 *
 * Tier-2 slash commands (card 9db7d09c): `/status` (in-chat state readout) and `/start` (Telegram's
 * automatic first-contact message, intercepted so it never leaks a raw agent turn) need no new
 * `CommandDeps` — both read only from the existing `prefs`/`route` params already threaded through every
 * handler. `/whoami` (a route/identity readout) likewise needs no new deps. `/export` (a markdown dump of
 * the CURRENT conversation, replied in-chat to the SAME authenticated route — never written to disk or
 * sent anywhere else) rides the injected `CommandDeps.exportConversation`, backed by the gateway's
 * `CompanionHistoryExport` (types.ts) — the db-backed impl mirrors `listCurrentCompanionMessages`, so an
 * archived (pre-"/new") conversation is never re-exported.
 *
 * `/refresh` (live non-destructive persona/memory upgrade) rides `CommandDeps.refreshPersona` — the SAME
 * `reinjectPersona` side-channel `/new` already uses for its post-"/clear" persona reinject
 * (chat-gateway.ts's `resetConversation`), called HERE on its own with no preceding "/clear" and no history
 * reset: the companion's own DB-stored prompt + given name + current memory-recall digest are recomposed
 * fresh (an agent-definition edit made after this companion was spawned is picked up) and re-enqueued as a
 * live turn, while the existing conversation is untouched. This is deliberately NOT a capability/MCP-surface
 * upgrade — a companion's mounted MCP servers/tool-allowlist are fixed in the `claude` process's argv at
 * spawn and cannot change on a live pty (see chat-gateway.ts's `refreshPersona` doc).
 */
import type { CompanionMessage } from "@loom/shared";
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
  /** The "/export" command's data source: the session's CURRENT (open) conversation's stored messages
   *  across every channel, chronological (ChatGateway.exportConversation → the injected
   *  `CompanionHistoryExport`). Empty when there's nothing to export OR no exporter is configured — the
   *  handler can't tell the two apart, which is fine: both read "nothing to export yet". Never throws. */
  exportConversation(sessionId: string): CompanionMessage[];
  /** The "/refresh" command's live persona/memory upgrade: recompose + re-enqueue this session's
   *  fresh-spawn-equivalent startup prompt (base brief + given name + current memory recall) into the
   *  ALREADY-RUNNING pty — no "/clear", no history reset, the conversation is untouched
   *  (ChatGateway.refreshPersona → the injected `reinjectPersona` side-channel). Returns whether a prompt
   *  was actually composed+enqueued — false for a missing/non-assistant session or no injected side-channel
   *  (e.g. a test construction that doesn't inject one). Never throws. */
  refreshPersona(sessionId: string): boolean;
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

/** Format the "/export" command's conversation dump: one block per message, chronological, `**Bold**`
 *  speaker label (rendered as literal asterisks — the companion never sets Telegram `parse_mode`, so this
 *  is plain readable text on every channel, not markup that could misrender) + the ISO timestamp, then the
 *  message text verbatim. Pure — no I/O. */
function formatConversationExport(messages: CompanionMessage[]): string {
  return messages
    .map((m) => `**${m.author === "user" ? "You" : "Companion"}** (${m.createdAt}):\n${m.text}`)
    .join("\n\n");
}

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
      // Group-scoped voice replies aren't deliverable yet (VOICE-P3, DM-first): the outbound reply always
      // resolves senderId:null, so a per-sender group row is never found and the reply always degrades to
      // text. Check BEFORE persisting — don't write a pref the outbound path can never honor, and don't
      // let "/voice on"/"/voice auto" claim a success it can't deliver in a group.
      if (norm !== "off" && route.senderId !== null) {
        return { ack: "Voice replies aren't available in group chats yet — DM the bot and turn it on there." };
      }
      prefs.setVoiceReplies(route, norm);
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
  whoami: {
    // A support/debug readout of the route this chat is bound over — which channel/chat (and, in a group,
    // which authenticated sender) THIS message came in on. Every field is SERVER-derived (the same `route`
    // every handler already gets — never body-supplied), so it can never be spoofed by the message text.
    description: "Show which chat/channel you're talking to me on",
    handler(_args, route) {
      const senderLine = route.senderId ? `\nSender: ${route.senderId}` : "";
      return { ack: `🪪 Channel: ${route.channel}\nChat: ${route.chatId}${senderLine}` };
    },
  },
  refresh: {
    description: "Reload my instructions and memory — keeps our conversation",
    // Live, NON-destructive upgrade: recomposes+re-enqueues the persona/memory prompt with no "/clear" and
    // no history reset, so an agent-definition edit (persona brief, given name, memory) lands mid-
    // conversation. Cannot pick up an MCP-server/tool-allowlist change — those are fixed at process spawn.
    handler(_args, route, _prefs, deps) {
      const ok = deps.refreshPersona(route.sessionId);
      return ok
        ? { ack: "🔄 Reloaded my instructions and memory — our conversation continues." }
        : { ack: "⚠️ Nothing to refresh right now." };
    },
  },
  export: {
    description: "Export the current conversation as an in-chat markdown dump",
    // Replies IN-CHAT to the SAME authenticated route only — never writes to disk, never sends via a
    // separate document/file mechanism, never leaves this route. `deps.exportConversation` reads exactly
    // the CURRENT (open) conversation (respects a prior "/new" boundary), so this can never leak an
    // already-archived conversation.
    handler(_args, route, _prefs, deps) {
      const messages = deps.exportConversation(route.sessionId);
      if (messages.length === 0) {
        return { ack: "📤 Nothing to export yet — this conversation is empty." };
      }
      return { ack: `📤 Conversation export (${messages.length} message${messages.length === 1 ? "" : "s"}):\n\n${formatConversationExport(messages)}` };
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
