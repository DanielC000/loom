/**
 * Loom Companion — the IN-APP channel adapter + its transport hub.
 *
 * Unlike Telegram (an external-network long-poll behind a bot token), the in-app channel's transport is the
 * Loom WEB CLIENT talking to the daemon over a dedicated session WebSocket (/ws/companion/:sessionId, see
 * gateway/server.ts). The loopback cockpit IS the authenticated local user, so there is NO bot token, NO
 * pairing, and NO external authz. The in-app binding is loopback-authenticated. This adapter only CARRIES
 * traffic for a companion that ALREADY has an in-app binding (provisioned elsewhere — the human-triggered
 * provision endpoint, card cbc9fa68); it NEVER creates a companion or a binding itself.
 *
 * Separation from the terminal stream (LOAD-BEARING, PL-flagged): the in-app chat WS is a SEPARATE route
 * (/ws/companion/:sessionId) and a SEPARATE JSON message channel from the terminal-attach path
 * (/ws/term/:sessionId, which streams raw pty bytes + JSON control events). The two multiplex cleanly
 * ALONGSIDE each other on the SAME session — the chat WS never touches pty bytes, and terminal-attach never
 * sees a chat frame. There is no shared socket to hijack.
 *
 * Address convention: an in-app "chat id" IS the bound companion SESSION id — a loopback self-address. A web
 * client attaches to /ws/companion/:sessionId; inbound normalizes to { channel:"in-app", chatId:sessionId },
 * which the bindings-authoritative gateway routes back to the SAME session. The in-app binding is therefore
 * { sessionId:S, channel:"in-app", chatId:S, scope:"dm" } (minted by the provision endpoint, not here).
 *
 * The hub (InAppChannel) is STABLE across gateway rebuilds — a Telegram token change (which rebuilds the
 * gateway) must not drop live chat clients: it owns the connected-client registry and IS the outbound sink.
 * Its `.adapter` is registered on every ChatGateway the factory builds; outbound chat_reply → deliverReply →
 * adapter.send → the hub pushes a framed message to every web client attached to that chat id. INBOUND does
 * NOT flow through an adapter-constructor handler (there is no long-poll): it enters via the controller's
 * stable `handleInAppInbound` indirection (symmetric with deliverReply) so it always targets the CURRENT
 * gateway and never a torn-down one — see controller.ts.
 *
 * VOICE (Companion Voice epic, VOICE-P4): the web mic's inbound audio and Kokoro's synthesized outbound
 * replies both ride THIS SAME channel — inbound as a server-generated temp file resolved via
 * `downloadAttachment` (mirrors Telegram's file download, except the bytes are already local — see
 * `decodeInAppAudioToTempFile`), outbound as a base64 field on the existing `{type:"chat"}` frame
 * (`sendVoice`). Neither touches the terminal WS or adds a new route.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LOOM_HOME } from "../paths.js";
import type { ChannelAdapter, InboundMessage } from "./types.js";

/** The stable channel name — the key in the gateway registry and the `channel` on every in-app binding. */
export const IN_APP_CHANNEL = "in-app";

/** Base64-encoded audio carried on an outbound frame (Companion Voice epic, VOICE-P4 outbound) — always a
 *  Kokoro-synthesized OGG/Opus clip. Never persisted (text is what's stored/shown); transport only. */
export interface InAppServerAudio {
  /** Base64-encoded audio bytes. */
  data: string;
  mimeType: string;
}

/**
 * A framed OUTBOUND message pushed to a connected in-app web client. `type:"chat"` is DELIBERATELY distinct
 * from the terminal stream (raw pty bytes / `{type:"data"|"exit"|…}` control events), so the two multiplex
 * on the same session without collision — a terminal viewer ignores a `chat` frame and vice versa.
 *
 * `type:"transcript"` (Companion Voice epic, VOICE-P4 inbound) is the daemon's live echo of the SENDER'S OWN
 * web-mic recording once STT completes — a genuine round trip, unlike a typed message (the panel already
 * knows its own typed text and renders it locally without waiting on the server). Kept as a DISTINCT frame
 * type (never `"chat"`) so the panel can never confuse "your own transcribed turn" with a companion reply.
 *
 * `type:"cleared"` (the "/new"/"/reset" command — companion/commands.ts + chat-gateway.ts's
 * `resetConversation`) tells an attached web viewer its conversation was just reset: the daemon has already
 * cleared the durable history, so this is PURELY the live push — an open panel empties immediately instead
 * of waiting for its next reload/history-fetch.
 *
 * `type:"cross-channel"` (live-push card, closing a gap in the unified cross-channel chat, card 7d63e200) —
 * a turn that happened on a NON-in-app channel (e.g. Telegram), pushed live to an attached web client the
 * moment chat-gateway.ts's generic recorder path persists it, so an already-OPEN CompanionChat panel sees it
 * appear without a reload. `id` is the SAME id the row was persisted under (companion_messages.id) — the
 * stable identity a client dedups on against the same row's later history-reload.
 */
export type InAppServerFrame =
  | {
      type: "chat";
      /** The in-app chat id this reply is for (== the bound companion session id). */
      chatId: string;
      text: string;
      /** Present only when this reply was voiced (`/voice on` + successful synthesis) — see `sendVoice`. */
      audio?: InAppServerAudio;
    }
  | {
      type: "transcript";
      chatId: string;
      /** The STT transcript of the sender's own just-recorded web-mic clip. */
      text: string;
    }
  | {
      type: "cleared";
      chatId: string;
    }
  | {
      type: "cross-channel";
      chatId: string;
      /** The persisted companion_messages row id — the client's dedup identity. */
      id: string;
      /** The originating channel, e.g. "telegram" (never "in-app" — that channel renders live via its own
       *  dedicated {type:"chat"}/{type:"transcript"} round trip, not this frame). */
      channel: string;
      author: "user" | "companion";
      text: string;
      viaVoice: boolean;
    };

/** The minimal surface of a connected web client the hub pushes outbound frames to. The WS route wraps the
 *  real socket; a test injects a fake recorder. */
export interface InAppClient {
  deliver(frame: InAppServerFrame): void;
}

/**
 * The injected CHAT HISTORY recorder (bug 0f01f234 — the "reload loses the whole conversation" fix). Kept
 * as a narrow interface (not a raw `Db`) so the hub stays db-agnostic, mirroring how CompanionVoicePrefs/
 * CompanionPairing are injected into ChatGateway rather than the gateway holding a `Db` directly. The
 * daemon injects `(sessionId, author, text) => db.insertCompanionMessage({ sessionId, channel: IN_APP_CHANNEL,
 * chatId: sessionId, author, text, ... })` (index.ts). Optional: absent ⇒ no recording (every existing/test
 * `new InAppChannel()` construction stays byte-identical).
 */
export interface InAppMessageRecorder {
  record(sessionId: string, author: "user" | "companion", text: string): void;
}

/**
 * Normalize an in-app inbound (a message typed in the cockpit companion chat panel) into the
 * platform-agnostic InboundMessage. `chatId` is the bound session id (the loopback self-address). There is
 * NO sender — the loopback cockpit is the single authenticated owner, so the binding's "dm" scope authorizes
 * on the route match alone (no per-sender allowlist, no pairing). Returns null for a non-string / empty body
 * (nothing to submit — mirrors the Telegram normalizer's empty-text guard).
 */
export function normalizeInAppMessage(chatId: string, body: unknown): InboundMessage | null {
  if (typeof body !== "string" || body.length === 0) return null;
  return { channel: IN_APP_CHANNEL, chatId, body };
}

/** Inbound web-mic audio size cap (Companion Voice epic, VOICE-P4 inbound) — a chat voice clip is far
 *  smaller than Telegram's 20MB cloud-download cap (telegram.ts), but nothing bounds a browser recording's
 *  length on its own, so this caps the DECODED byte count generously above a normal few-minutes clip while
 *  still bounding the in-memory Buffer this allocates. */
export const IN_APP_AUDIO_MAX_BYTES = 15 * 1024 * 1024;

/** Where an in-app inbound audio clip's decoded temp file lands — the SAME dir Telegram's downloaded voice
 *  notes and Kokoro's synthesized replies use (companion-audio), so there is exactly one temp-audio
 *  lifecycle to reason about across every channel. */
function audioTmpDir(): string {
  return path.join(LOOM_HOME, "tmp", "companion-audio");
}

/** Map a MediaRecorder mimeType to a plausible file extension — cosmetic only (the STT pipeline sniffs the
 *  real container from the bytes via PyAV, not the extension); kept for on-disk debuggability. */
function extForMimeType(mimeType: string): string {
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("webm")) return ".webm";
  return ".bin";
}

/**
 * Decode a base64-encoded inbound web-mic clip to a SERVER-GENERATED temp file (Companion Voice epic,
 * VOICE-P4 inbound). The caller (gateway/server.ts's `/ws/companion` route) hands this the RAW base64
 * payload off an `{type:"audio"}` frame — untrusted bytes, never a client-supplied path. Rejects an
 * oversized payload by its BASE64 length BEFORE decoding (bounds the `Buffer.from` allocation itself, not
 * just the eventual byte count) and again after decode as a belt-and-suspenders check. Returns null on ANY
 * failure (empty/non-string input, oversize, write failure) — NEVER throws; the caller degrades to a
 * friendly ack via the SAME STT-unavailable path a download failure already takes. The returned path is
 * ALWAYS a fresh `randomUUID` under `LOOM_HOME/tmp/companion-audio` — `downloadAttachment` below only ever
 * hands back a path THIS function minted, never one derived from client input.
 */
export function decodeInAppAudioToTempFile(base64: unknown, mimeType: unknown): { filePath: string; cleanup: () => Promise<void> } | null {
  if (typeof base64 !== "string" || base64.length === 0) return null;
  const mime = typeof mimeType === "string" ? mimeType : "";
  // Base64 encodes 3 bytes as 4 chars (plus up to 2 padding chars) — reject before ever materializing the
  // decoded Buffer.
  if (base64.length > Math.ceil((IN_APP_AUDIO_MAX_BYTES * 4) / 3) + 4) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > IN_APP_AUDIO_MAX_BYTES) return null;
  try {
    const dir = audioTmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${randomUUID()}${extForMimeType(mime)}`);
    fs.writeFileSync(filePath, bytes);
    return {
      filePath,
      cleanup: async () => { try { await fs.promises.unlink(filePath); } catch { /* best-effort */ } },
    };
  } catch {
    return null;
  }
}

/**
 * The stable in-app transport hub. Constructed ONCE (index.ts) and threaded into BOTH the gateway factory
 * (its `.adapter` is registered on every ChatGateway build) and buildServer (the /ws/companion route attaches
 * clients here). No bot token, no network — constructing it touches nothing, and with no attached client +
 * no in-app binding every path is a no-op (default-OFF byte-identical).
 */
export class InAppChannel {
  /** chatId → the set of web clients currently attached to that in-app chat. */
  private readonly clients = new Map<string, Set<InAppClient>>();

  /** @param recorder  the optional CHAT HISTORY recorder (bug 0f01f234) — see {@link InAppMessageRecorder}. */
  constructor(private readonly recorder?: InAppMessageRecorder) {}

  /**
   * The ChannelAdapter registered on each gateway. OUTBOUND-only here: `send` pushes to the attached web
   * clients; `start`/`stop` are no-ops (there is no long-poll — the /ws/companion route owns connection
   * lifecycle). No `maxMessageLength`: the web client renders arbitrary-length replies, so the gateway does
   * not chunk (a reply is delivered as a single frame) — which is exactly why this is the ONE place to
   * record an outbound in-app reply (never >1 `send` call per logical reply, so recording here can't
   * double-record a chunked message).
   */
  readonly adapter: ChannelAdapter = {
    name: IN_APP_CHANNEL,
    start() {
      /* no long-poll — the /ws/companion route drives the transport */
    },
    async stop() {
      /* no long-poll to stop */
    },
    send: async (chatId: string, text: string, opts?: { record?: boolean }) => {
      // Record by default (`opts.record !== false`) — even with zero attached clients — so a proactive
      // heartbeat/reminder reply to a session nobody is viewing right now still shows up in history on the
      // next attach (this is what "in-app has no store-and-forward" used to mean for chat history; now it's
      // stored, just not LIVE-pushed to nobody). `tryAck` (chat-gateway.ts) explicitly passes `record:false`
      // for a command/error/pairing ack — that's transport chrome, not conversation, so it must NOT persist
      // as a history row (cross-channel asymmetry fix: Telegram's `send` never recorded these either). The
      // "/new"/"/reset" conversation-boundary marker is the one ack `tryAck` opts back IN. Contained: a
      // history-record failure must never break the actual reply delivery below.
      if (opts?.record !== false) this.recordSafely(chatId, "companion", text);
      this.deliver(chatId, text);
    },
    // VOICE INBOUND (Companion Voice epic, VOICE-P4). Unlike Telegram's real network fetch, the in-app
    // channel's audio is ALREADY local by the time handleInbound sees it: the /ws/companion route decodes
    // the client's base64 bytes into a server-generated temp file (decodeInAppAudioToTempFile) BEFORE
    // calling the controller, threading that path through as `attachment.fileId` — so this is a pass-through,
    // not a real download. It still returns the SAME { filePath, cleanup } shape Telegram's version does, so
    // chat-gateway.ts's existing download→transcribe→cleanup discipline (including its `finally` unlink)
    // runs unchanged. `attachment.fileId` is NEVER client-supplied — only ever a path THIS channel's own
    // decodeInAppAudioToTempFile minted for this exact request.
    async downloadAttachment(attachment) {
      if (!attachment.fileId) return null;
      const filePath = attachment.fileId;
      return {
        filePath,
        cleanup: async () => { try { await fs.promises.unlink(filePath); } catch { /* best-effort */ } },
      };
    },
    // VOICE OUTBOUND (Companion Voice epic, VOICE-P4). Unlike Telegram, `sendVoice` here REPLACES `send`
    // entirely on the voice path (chat-gateway.ts's tryDeliverVoice calls sendVoice INSTEAD of send when
    // synthesis succeeds) — so recording + live delivery must both happen HERE, exactly mirroring `send`
    // above, or a successful voice reply would silently vanish from history/reload. Reads + base64-encodes
    // the synthesized OGG/Opus file; a read failure THROWS (deliberately) so chat-gateway's tryDeliverVoice
    // catch degrades to the plain `send` above instead of this method silently double-recording nothing.
    sendVoice: async (chatId: string, audioFilePath: string, text: string) => {
      const data = await fs.promises.readFile(audioFilePath, { encoding: "base64" });
      this.recordSafely(chatId, "companion", text);
      this.deliver(chatId, text, { data, mimeType: "audio/ogg" });
    },
  };

  /** Best-effort record (never throws upward) — mirrors `deliver`'s per-client try/catch containment. A
   *  dropped history row is acceptable; it must never break the reply/inbound path it's mirroring. */
  private recordSafely(sessionId: string, author: "user" | "companion", text: string): void {
    if (!this.recorder) return;
    try {
      this.recorder.record(sessionId, author, text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[companion] in-app history record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * WS route: attach a connected web client to an in-app chat (chatId == the companion session id). Returns
   * an unsubscribe to call on socket close. Multiple viewers of the same companion chat are allowed (each
   * gets the reply).
   */
  attach(chatId: string, client: InAppClient): () => void {
    let set = this.clients.get(chatId);
    if (!set) {
      set = new Set();
      this.clients.set(chatId, set);
    }
    set.add(client);
    return () => {
      const s = this.clients.get(chatId);
      if (!s) return;
      s.delete(client);
      if (s.size === 0) this.clients.delete(chatId);
    };
  }

  /** Whether any web client is currently attached to a chat (introspection / tests). */
  hasClients(chatId: string): boolean {
    return (this.clients.get(chatId)?.size ?? 0) > 0;
  }

  /**
   * OUTBOUND sink: frame `text` (+ optional `audio`, VOICE-P4 outbound) and push it to every client attached
   * to `chatId`. With no attached client the LIVE push is simply dropped — nobody is there to receive a
   * frame — but the reply is still RECORDED to chat history by `adapter.send`/`sendVoice` before this runs,
   * so a proactive reply (heartbeat) to a session nobody is viewing right now shows up on the next attach
   * instead of vanishing. A reply-to-inbound always has an attached client (they just sent the message).
   */
  private deliver(chatId: string, text: string, audio?: InAppServerAudio): void {
    this.pushFrame(chatId, audio ? { type: "chat", chatId, text, audio } : { type: "chat", chatId, text });
  }

  /**
   * Push the STT transcript of an ACCEPTED web-mic inbound back to the SAME session's attached client(s) as
   * the sender's OWN "your turn" bubble (Companion Voice epic, VOICE-P4 inbound) — a genuine round trip,
   * unlike a typed message (the panel already knows its own typed text and renders it locally without
   * waiting on the server). A distinct `type:"transcript"` frame so the panel can never confuse this with a
   * companion reply. The daemon already recorded this text to history (controller.ts's
   * `recordInboundMessageSafely`) — this call is PURELY the live push, so it never records again.
   */
  pushTranscript(chatId: string, text: string): void {
    this.pushFrame(chatId, { type: "transcript", chatId, text });
  }

  /**
   * Push a "conversation cleared" notice to every client attached to `chatId` (the "/new"/"/reset" command,
   * chat-gateway.ts's `resetConversation`). The daemon has ALREADY cleared the durable history by the time
   * this runs — this call is PURELY the live push, so it never records/deletes anything itself.
   */
  pushCleared(chatId: string): void {
    this.pushFrame(chatId, { type: "cleared", chatId });
  }

  /**
   * Push an ALREADY-recorded NON-in-app channel turn (live-push card) to every client attached to `chatId`
   * (== the companion session id) — chat-gateway.ts's generic recorder path calls this right after
   * persisting the row, so an open CompanionChat panel sees a Telegram message appear without a reload.
   * `msg.id` is the SAME id the row was persisted under — the client's dedup identity against the same
   * row's later history-reload. Purely the live push (mirrors pushCleared/pushTranscript): never writes to
   * the db itself.
   */
  pushCrossChannel(chatId: string, msg: { id: string; channel: string; author: "user" | "companion"; text: string; viaVoice: boolean }): void {
    this.pushFrame(chatId, { type: "cross-channel", chatId, id: msg.id, channel: msg.channel, author: msg.author, text: msg.text, viaVoice: msg.viaVoice });
  }

  /** Shared per-client fan-out: a client `deliver` that throws is CONTAINED (one bad socket can't drop the
   *  others or bubble out of the reply/transcript path). */
  private pushFrame(chatId: string, frame: InAppServerFrame): void {
    const set = this.clients.get(chatId);
    if (!set || set.size === 0) return;
    for (const client of set) {
      try {
        client.deliver(frame);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[companion] in-app deliver failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
