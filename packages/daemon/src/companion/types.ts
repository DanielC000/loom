/**
 * Loom Companion — the channel-adapter CONTRACT + the platform-agnostic normalized message shape.
 *
 * A ChannelAdapter is the ONLY thing that knows a given chat platform's wire format. It normalizes every
 * inbound platform update into an InboundMessage and pushes it to the ChatGateway; and it sends outbound
 * text back to a chat id. New channels (WhatsApp, Slack, …) slot in by implementing this interface — the
 * gateway never learns a platform's shape.
 *
 * Clean-room: the adapter → normalized-message split is modelled on OpenClaw/Hermes' Channel-Adapter
 * normalization pattern (learned, not copied).
 */
import type { CompanionRoute as SharedCompanionRoute } from "@loom/shared";

/** A non-text payload carried by an inbound update (Phase 1 carries the SHAPE; ingestion is a later card). */
export interface InboundAttachment {
  /** Coarse kind — "photo" | "document" | "audio" | "video" | … (adapter-defined, free-form). */
  type: string;
  /** A fetchable URL or platform file id, when the platform exposes one. */
  url?: string;
  fileName?: string;
  mimeType?: string;
  /**
   * An OPAQUE platform-specific reference (e.g. Telegram's `file_id`) — never a fetchable URL itself, only
   * resolvable by the SAME adapter's `downloadAttachment` (Companion Voice epic, VOICE-P2: inbound STT).
   */
  fileId?: string;
}

/** A platform-agnostic inbound message — every adapter normalizes its wire update into THIS. */
export interface InboundMessage {
  /** The source channel's name — matches the originating ChannelAdapter.name (e.g. "telegram"). */
  channel: string;
  /** The originating chat id, always a string (a numeric platform id is stringified for stable compare). */
  chatId: string;
  /** The message body text (may be empty when the update is attachment-only). */
  body: string;
  /** The sender, when the platform identifies them (all optional — some channels are chat-scoped only). */
  sender?: { id?: string; username?: string; displayName?: string };
  /** Non-text payloads carried by the update. */
  attachments?: InboundAttachment[];
  /** Free-form channel-specific extras (message id, timestamp, reply-to, …) — opaque to the gateway. */
  metadata?: Record<string, unknown>;
}

/** The gateway's inbound entrypoint, handed to each adapter so it can push normalized messages up. */
export type InboundHandler = (msg: InboundMessage) => void;

/**
 * A chat channel — the pluggable transport. The gateway owns a registry of these; each is started/stopped
 * with the daemon. `send` is the OUTBOUND leg (chat_reply → adapter.send); inbound flows the other way,
 * via the InboundHandler the adapter was constructed with.
 */
export interface ChannelAdapter {
  /** Stable channel name — the key in the gateway registry and the `channel` on every InboundMessage. */
  readonly name: string;
  /**
   * The platform's max single-message length in chars, when it has a hard cap (Telegram: 4096). The
   * gateway chunks outbound replies to this so a long reply never throws; undefined ⇒ no chunking.
   */
  readonly maxMessageLength?: number;
  /** Begin receiving (e.g. start long-polling). Fire-and-forget; must not throw synchronously. */
  start(): void;
  /** Stop receiving and release resources (best-effort on shutdown). */
  stop(): Promise<void>;
  /** OUTBOUND: send `text` to `chatId` on this channel. */
  send(chatId: string, text: string): Promise<void>;
  /**
   * OPTIONAL: download a non-text attachment to a local temp file (Companion Voice epic, VOICE-P2). Only
   * the adapter that emitted the attachment knows how to resolve it (wire-format-specific — e.g. Telegram's
   * `getFile` + `file_id`), so this is NOT implemented by the gateway. Resolves null when the platform/
   * adapter doesn't support downloading, or on ANY fetch failure (size cap exceeded, network error,
   * timeout) — never throws; the caller degrades gracefully (a friendly "not available" ack). The caller
   * MUST call the returned `cleanup()` (in a `finally`) once done with `filePath` — no unbounded disk growth.
   */
  downloadAttachment?(attachment: InboundAttachment): Promise<{ filePath: string; cleanup: () => Promise<void> } | null>;
  /**
   * OPTIONAL: send a local audio file to `chatId` as a native voice message (Companion Voice epic, VOICE-P3
   * — outbound TTS). Only implemented by adapters whose platform renders a voice bubble for the format the
   * gateway hands it (Telegram: OGG/Opus via `sendVoice`). Absent ⇒ the gateway never attempts voice replies
   * on this channel (degrades to the plain text send). May throw — the caller (deliverReply) contains it and
   * degrades to text, exactly like a `send` failure.
   */
  sendVoice?(chatId: string, audioFilePath: string): Promise<void>;
}

/**
 * An originating chat ROUTE — WHICH chat on WHICH channel a turn came from (companion inbound) or is
 * addressed to (proactive/heartbeat home). Threaded per-turn through the pty host so an agent's chat_reply
 * resolves DAEMON-side to the exact route of the turn it is answering — never a shared/guessed channel.
 * ALIAS, not a duplicate: the canonical shape lives in `@loom/shared` (shared is the dependency leaf and
 * can't import this module back, so it can't be the one importing FROM here) — keeping the local name so
 * every existing `./types.js` importer is unchanged.
 */
export type CompanionRoute = SharedCompanionRoute;

/**
 * A RECURRING companion reminder (Companion Memory & Reminders Design, Surface 2 s3) — a named cron job
 * that fires a proactive turn into its OWN companion session, generalizing the single heartbeat
 * cadence+prompt to N independently-scheduled, independently-routed reminders. Row shape of the
 * `companion_reminders` table (db.ts); `route` reuses THIS module's CompanionRoute (never a new type) so
 * a fired reminder's chat_reply carries the exact same shape the heartbeat's home route and a wake's
 * captured route already use.
 */
export interface CompanionReminder {
  id: string;
  /** The companion session this reminder targets — its OWN long-lived session (never a fresh spawn). */
  sessionId: string;
  /** 5-field cron expression (validated + next-fire computed via orchestration/cron.ts, like Schedule). */
  cron: string;
  /** The framed proactive prompt text fired into the session on each due tick. */
  prompt: string;
  /** Human-facing name (management/REST — not yet wired by this card), or null. */
  label: string | null;
  /** SERVER-DERIVED chat route to carry on fire, or null (a fired reminder then has nowhere to chat_reply). */
  route: CompanionRoute | null;
  /** A disabled reminder is skipped by the watcher without being deleted. */
  enabled: boolean;
  /** ISO; anchors the FIRST-fire computation (nextFireAt(cron, createdAt)) before any real fire exists. */
  createdAt: string;
}

/**
 * Submit inbound text as a TURN into a live session — the EXISTING PTY primitive (pty.enqueueStdin),
 * injected so the gateway stays free of the pty host. `route` is the ORIGINATING (channel, chatId): the pty
 * pins it to the formed turn so chat_reply delivers back there. Returns the primitive's contract:
 *   { delivered:true }               → submitted immediately as a turn
 *   { delivered:false, position:N }  → HELD in the session's FIFO (busy/not-ready) — still accepted
 *   { delivered:false }              → session not alive (DEAD) — nothing queued
 */
export type SubmitTurn = (sessionId: string, text: string, route?: CompanionRoute) => { delivered: boolean; position?: number };

/**
 * The injected STT transcriber (Companion Voice epic, VOICE-P2 — see companion/stt.ts for the local
 * faster-whisper implementation). Kept as a narrow interface (not a bare function) so the gateway can skip
 * a wasted attachment download when STT definitely isn't ready, without knowing anything about venvs/pip.
 */
export interface CompanionTranscriber {
  /**
   * A CHEAP, synchronous readiness check — true iff a `transcribe()` call right now will actually attempt
   * STT (not "will eventually be ready"). A false result may itself kick background provisioning as a
   * side effect (see companion/stt.ts) — repeated calls are safe (deduped).
   */
  isReady(): boolean;
  /**
   * Transcribe the audio at `filePath`. `langHint` forces the decode language (from the per-route voice
   * pref), or null for auto-detect. Resolves null on ANY failure (cold venv, subprocess crash/timeout,
   * unreadable file, empty result) — NEVER throws; the caller degrades to a friendly "not available" ack.
   */
  transcribe(input: { filePath: string; langHint: string | null }): Promise<string | null>;
}

/**
 * The injected TTS synthesizer (Companion Voice epic, VOICE-P3 — see companion/tts.ts for the local
 * Kokoro-onnx implementation). Mirrors {@link CompanionTranscriber}'s shape exactly: a cheap readiness
 * check the gateway can consult BEFORE doing any work, and a never-throws synthesize call that resolves
 * null on ANY failure so the caller degrades to the existing text send.
 */
export interface CompanionSynthesizer {
  /**
   * A CHEAP, synchronous readiness check — true iff a `synthesize()` call right now will actually attempt
   * TTS (not "will eventually be ready"). A false result may itself kick background provisioning as a side
   * effect (see companion/tts.ts) — repeated calls are safe (deduped).
   */
  isReady(): boolean;
  /**
   * Synthesize `text` to a local audio file. `lang`/`voice` come from the route's voice pref (ttsLang/
   * ttsVoice) — either may be null (no pref set), in which case the implementation picks a sensible
   * default. Resolves null on ANY failure (cold venv, subprocess crash/timeout, encode failure) — NEVER
   * throws; the caller degrades to the existing text send. On success the caller MUST call the returned
   * `cleanup()` (in a `finally`) once done with `filePath` — no unbounded disk growth.
   */
  synthesize(input: { text: string; lang: string | null; voice: string | null }): Promise<{ filePath: string; cleanup: () => Promise<void> } | null>;
}

/** The OUTBOUND delivery result — STRUCTURED across every failure mode (never throws out of chat_reply).
 *  `no-target` = the in-flight turn had NO reply-to route (a turn that wasn't formed from a companion
 *  inbound / proactive-home submit) ⇒ chat_reply delivers NOWHERE (never broadcasts, never guesses). */
export type DeliverResult =
  | { delivered: true; chunks: number }
  | { delivered: false; reason: "unknown-session" | "no-adapter" | "send-failed" | "no-target" };

/** The result of routing one inbound message. */
export type InboundResult =
  | { accepted: true; sessionId: string; queued: boolean; position?: number }
  | { accepted: false; reason: "no-text" | "chat-not-allowlisted" }
  // The (channel, chatId) binding matched, but the SENDER is not authorized for it (Companion authz
  // layer): a GROUP-scoped binding with a missing or unlisted sender.id. Rejected BEFORE any turn is
  // submitted — the load-bearing deny path for the multi-user (shared-chat) case.
  | { accepted: false; reason: "sender-not-authorized" }
  | { accepted: false; reason: "session-dead"; sessionId: string; acked: boolean }
  // The submit primitive THREW (e.g. pty.write racing a dying session, or a fail-loud M1/M2 guard). The
  // gateway contains it — a racy inbound must NEVER crash the daemon via an unhandled rejection.
  | { accepted: false; reason: "submit-failed"; sessionId: string; acked: boolean }
  // A DM-PAIRING code redeemed successfully (Companion DM-pairing). NOT a turn (no submit — the code text
  // never reaches the agent): the redeemer's AUTHENTICATED chat.id was bound to `sessionId` ('paired-dm')
  // or their authenticated sender.id was added to a group binding's allowlist ('paired-sender'). `acked`
  // reports whether the "paired" confirmation reached the chat. A FAILED redemption never returns these —
  // it falls through to the SAME silent reject as any unallowlisted inbound (no pairing oracle).
  | { accepted: false; reason: "paired-dm"; sessionId: string; acked: boolean }
  | { accepted: false; reason: "paired-sender"; sessionId: string; acked: boolean }
  // A RECOGNIZED "/" slash-command (Companion Voice epic, VOICE-P1 — companion/commands.ts) was
  // intercepted BEFORE submitTurn: an already-authorized route's command text never reaches the agent
  // as a turn (mirrors 'paired-dm'/'paired-sender' above). `command` is the parsed command name (e.g.
  // "lang"); `acked` reports whether the ack reached the chat.
  | { accepted: false; reason: "command"; sessionId: string; command: string; acked: boolean }
  // An inbound carried an audio attachment but STT could not produce a transcript — a cold/unwarmed venv
  // (skipped BEFORE downloading, via CompanionTranscriber.isReady()), an unsupported adapter (no
  // downloadAttachment), a download failure, or the transcribe subprocess failing/timing out/returning
  // empty. Distinct from the silent 'no-text' no-transcriber-injected case so a degraded voice note is
  // debuggable instead of silently vanishing; `acked` reports whether the "try again" ack reached the chat.
  | { accepted: false; reason: "transcribe-unavailable"; sessionId: string; acked: boolean };

/**
 * A session↔chat binding (spike scope: seeded from env as a SINGLE binding). Models WHICH chat on WHICH
 * channel is wired to WHICH companion session. Kept as a small in-memory map so the routing abstraction is
 * clean and the identity-binding/auth card (5e574ca9) can extend it — NO persistence / pairing / multi-user
 * auth here.
 */
export interface SessionBinding {
  readonly sessionId: string;
  readonly channel: string;
  readonly chatId: string;
  /**
   * The AUTHORIZATION scope (Companion authz layer). Selects the rule handleInbound applies after the
   * (channel, chatId) route match, via the injected CompanionAuth (companion/auth.ts):
   *   • "dm"    — a private 1:1 chat: the route match alone proves the single owner ⇒ authorized (the
   *               single-owner spike path, UNCHANGED). • "group" — a shared chat: authorized ONLY when
   *               the inbound carries a `sender.id` on this binding's per-binding allowlist; a missing
   *               or unlisted sender is HARD-rejected. The db-backed CompanionBinding carries the same
   *               field; a binding minted without it defaults to the safe single-owner "dm".
   */
  readonly scope: "dm" | "group";
}
