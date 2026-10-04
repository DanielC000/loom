/**
 * Loom Companion — the productized Telegram CHANNEL ADAPTER.
 *
 * Implements the platform-agnostic ChannelAdapter: it is the ONLY file that touches grammY. It normalizes
 * each inbound Telegram update into the standard InboundMessage and pushes it up (the gateway allowlists +
 * submits the turn); and its `send` is the OUTBOUND leg. Long-poll by DEFAULT (grammY `bot.start()`) — no
 * public URL / webhook needed — with two productization hardenings the Phase-0 spike lacked:
 *   - an EXPLICIT ERROR BOUNDARY on the inbound path (a per-update try/catch + grammY `bot.catch`) so an
 *     enqueueStdin throw can never crash the poll loop (STRUCTURAL, not grammY's implicit default handler);
 *   - RECONNECT-ON-DROP (runWithReconnect) so a dropped long-poll recovers instead of silently dying.
 *
 * Testability: `normalizeTelegramMessage` is a pure exported function, and the grammY Bot is behind the
 * minimal `TelegramBotLike` seam so a test injects a fake (no live network). Default OFF: the daemon only
 * constructs this when the companion is configured (see companion/config.ts + factory.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { Bot, InputFile } from "grammy";
import type { ChannelAdapter, InboundAttachment, InboundHandler, InboundMessage } from "./types.js";
import { cappedBackoff, runWithReconnect } from "./resilience.js";
import { GROUP_COMMAND_MENU, PRIVATE_COMMAND_MENU } from "./commands.js";
import { LOOM_HOME } from "../paths.js";
import { guardedFetch } from "../connections/boundedFetch.js";

/** Telegram's cloud-API file-download size cap (Companion Voice epic, VOICE-P2). */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/**
 * The OVERALL deadline (ms) for a voice-note download — covers connect/TTFB AND the full body stream (one
 * AbortController threaded through both the `fetch` call and the piped body read below), so a mid-stream
 * stall is bounded exactly like a slow/hanging connect — neither can wedge the daemon. Exported (card
 * 986bdddd round 2, Major) so chat-gateway.ts can DERIVE its own inbound-queue wait bound from this plus
 * the STT constants, rather than carrying an independently hand-picked literal that can silently drift
 * below the real worst case.
 */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

export const TELEGRAM_CHANNEL = "telegram";
/** Telegram's hard per-message character limit — the gateway chunks outbound replies to this. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Extensions sent via `sendPhoto` (renders inline) — the `media-out` lever (card 3a81b0f2). Anything else
 *  goes through `sendDocument` (a generic file attachment) instead. */
const TELEGRAM_PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** The minimal grammY Bot surface the adapter uses — lets a test inject a fake (no live network). */
export interface TelegramBotLike {
  api: {
    /** `other` mirrors grammY's own real signature (an options object, never used here — always `undefined`);
     *  `signal` (card dc5df70e) lets the adapter's `send` abort a hung request once `tryAck`'s own timeout
     *  fires, so a dead socket doesn't linger after the caller stops waiting on it. */
    sendMessage(chatId: string | number, text: string, other?: undefined, signal?: AbortSignal): Promise<unknown>;
    /** Register the native "/" command menu (Companion Voice epic, VOICE-P1). `other.scope` (card
     *  d100843f) mirrors grammY's own real `setMyCommands(commands, other?)` signature — the call site
     *  below registers the FULL menu against `all_private_chats` and a DM-only-command-free menu against
     *  `all_group_chats` as two separate calls, rather than one undifferentiated global menu. Optional on
     *  the seam so an existing test fake bot (no `setMyCommands`) stays valid — the call site guards with
     *  `?.`. */
    setMyCommands?(
      commands: { command: string; description: string }[],
      other?: { scope: { type: "all_private_chats" | "all_group_chats" | "default" } },
    ): Promise<unknown>;
    /** Resolve a Telegram `file_id` to its download path (Companion Voice epic, VOICE-P2). Optional on the
     *  seam so an existing test fake bot (no voice-download tests) stays valid. */
    getFile?(fileId: string): Promise<{ file_path?: string }>;
    /** Send a native voice message (Companion Voice epic, VOICE-P3 — outbound TTS). Optional on the seam
     *  so an existing test fake bot (no voice-reply tests) stays valid — the call site guards with `?.`.
     *  `other`/`signal` mirror `sendMessage`'s own two trailing params above (card 2c7ac1dd) — grammY's real
     *  `sendVoice` has the identical `(chat_id, voice, other?, signal?)` shape. */
    sendVoice?(chatId: string | number, voice: InputFile, other?: undefined, signal?: AbortSignal): Promise<unknown>;
    /** Send a native photo (renders inline) — the `media-out` lever (card 3a81b0f2). Optional on the seam
     *  so an existing test fake bot (no media tests) stays valid — the call site guards with `?.`.
     *  `other`/`signal` mirror `sendMessage`'s own two trailing params above (card 2c7ac1dd) — grammY's real
     *  `sendPhoto` has the identical `(chat_id, photo, other?, signal?)` shape. */
    sendPhoto?(chatId: string | number, photo: InputFile, other?: undefined, signal?: AbortSignal): Promise<unknown>;
    /** Send a native document (generic file attachment) — the `media-out` lever (card 3a81b0f2). Optional
     *  on the seam so an existing test fake bot (no media tests) stays valid — the call site guards with
     *  `?.`. `other`/`signal` mirror `sendMessage`'s own two trailing params above (card 2c7ac1dd) —
     *  grammY's real `sendDocument` has the identical `(chat_id, document, other?, signal?)` shape. */
    sendDocument?(chatId: string | number, document: InputFile, other?: undefined, signal?: AbortSignal): Promise<unknown>;
  };
  on(filter: "message", handler: (ctx: { update: unknown }) => void | Promise<void>): void;
  catch(handler: (err: unknown) => void): void;
  start(opts?: { onStart?: (info: { username: string }) => void }): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

/**
 * Normalize a Telegram Bot API update into the platform-agnostic InboundMessage, or null if it carries no
 * usable text. Reads message.chat.id + message.text + the sender (message.from.*); other update kinds
 * (edits, callbacks, media captions, channel posts) are ignored for now. Defensive against a malformed /
 * partial update shape.
 */
export function normalizeTelegramMessage(update: unknown): InboundMessage | null {
  const message = (
    update as {
      message?: {
        chat?: { id?: unknown; type?: unknown };
        text?: unknown;
        message_id?: unknown;
        from?: { id?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown };
        voice?: { file_id?: unknown; mime_type?: unknown };
      };
    } | null
  )?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  const voice = message?.voice;
  // Telegram's own chat.type ("private" | "group" | "supergroup" | "channel") is the ONLY signal that
  // distinguishes a 1:1 DM from a shared chat sharing the same message shape — a group's chatId is just as
  // stable/numeric as a DM's. A malformed/missing type (never expected from the real Bot API) leaves
  // `chatIsDirect` undefined rather than guessing, so the dm-bind pairing gate (pairing.ts) fails CLOSED.
  const chatType = message?.chat?.type;
  const chatIsDirect = typeof chatType === "string" ? chatType === "private" : undefined;
  // A voice note carries NO text (Telegram doesn't support a caption on `voice`) — the attachment alone
  // makes this inbound usable, so it must not be dropped by the text-only check below.
  const voiceFileId = typeof voice?.file_id === "string" && voice.file_id.length > 0 ? voice.file_id : undefined;
  if (
    (typeof chatId !== "number" && typeof chatId !== "string") ||
    (!voiceFileId && (typeof text !== "string" || text.length === 0))
  ) {
    return null;
  }
  const from = message?.from;
  const displayName = [from?.first_name, from?.last_name].filter((n) => typeof n === "string").join(" ").trim();
  const sender = from
    ? {
        id: from.id !== undefined ? String(from.id) : undefined,
        username: typeof from.username === "string" ? from.username : undefined,
        displayName: displayName.length > 0 ? displayName : undefined,
      }
    : undefined;
  const attachments: InboundAttachment[] | undefined = voiceFileId
    ? [{ type: "audio", fileId: voiceFileId, mimeType: typeof voice?.mime_type === "string" ? voice.mime_type : undefined }]
    : undefined;
  return {
    channel: TELEGRAM_CHANNEL,
    chatId: String(chatId),
    body: typeof text === "string" ? text : "",
    sender,
    chatIsDirect,
    attachments,
    metadata: message?.message_id !== undefined ? { messageId: message.message_id } : undefined,
  };
}

export interface TelegramAdapterOptions {
  /** Inject a fake bot for tests; defaults to a real grammY `Bot(botToken)`. */
  bot?: TelegramBotLike;
  /** Injectable sleep for the reconnect backoff (tests pass an immediate sleep — no real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the reconnect backoff (tests). */
  backoffMs?: (attempt: number) => number;
  /** fetch override for `downloadAttachment`'s guardedFetch call — the hermetic test seam (card
   *  731aa517; never makes a real network call in tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** `downloadAttachment` timeout override (TEST ONLY — lets a hang/redirect test use a short bound
   *  instead of waiting out the real DOWNLOAD_TIMEOUT_MS). Defaults to DOWNLOAD_TIMEOUT_MS. */
  downloadTimeoutMs?: number;
  /** `downloadAttachment` byte-cap override (TEST ONLY — lets an oversized test use a small bound
   *  instead of streaming the real 20MB MAX_AUDIO_BYTES). Defaults to MAX_AUDIO_BYTES. */
  maxAudioBytes?: number;
}

/**
 * Build the Telegram channel adapter. Constructing it does NOT touch the network — `start()` begins the
 * resilient long-poll loop. `onInbound` receives every normalized inbound message (the gateway wires this
 * to `handleInbound`).
 */
export function createTelegramAdapter(
  botToken: string,
  onInbound: InboundHandler,
  opts: TelegramAdapterOptions = {},
): ChannelAdapter {
  const bot: TelegramBotLike = opts.bot ?? (new Bot(botToken) as unknown as TelegramBotLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoffMs = opts.backoffMs ?? cappedBackoff();
  const fetchImpl = opts.fetchImpl;
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const maxAudioBytes = opts.maxAudioBytes ?? MAX_AUDIO_BYTES;
  let stopped = false;

  // ERROR BOUNDARY 1 — a per-update try/catch: a throw in normalize/onInbound (e.g. an enqueueStdin throw)
  // is contained to that update and never rejects the middleware / crashes the poll loop.
  bot.on("message", (ctx) => {
    try {
      const msg = normalizeTelegramMessage(ctx.update);
      if (msg) onInbound(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[companion] telegram inbound handler error: ${describeError(err)}`);
    }
  });
  // ERROR BOUNDARY 2 — grammY's central error handler: anything the middleware throws lands here instead of
  // bubbling out of the poll loop (structural, not grammY's implicit default handler).
  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[companion] telegram bot error: ${describeError(err)}`);
  });

  return {
    name: TELEGRAM_CHANNEL,
    maxMessageLength: TELEGRAM_MAX_MESSAGE_LENGTH,
    start() {
      // Register the native "/" command menu (Companion Voice epic, VOICE-P1; split into two scoped menus,
      // card d100843f) — best-effort, fire-and-forget: a failure (network / bad token) is logged, never
      // thrown, and never blocks/delays the poll loop below. `?.` guards a test fake bot that doesn't
      // implement setMyCommands (companion-telegram.mjs). THREE separate, independent calls, one per
      // Telegram scope, so a group chat's native menu never advertises a DM-only command its handler would
      // just refuse — including the DEFAULT scope (card e32faaf0, Code Review 3fb91c99): an existing bot
      // may still carry a leftover default-scope menu from before d100843f split the scoped calls out, and
      // that leftover is exactly the DM-only menu this fix exists to hide from groups. Registering
      // GROUP_COMMAND_MENU there too (rather than deleteMyCommands) means a group whose own all_group_chats
      // call fails (transient error / rate limit) still falls back to the least-advertising menu instead of
      // the stale DM-only one. Each call stands alone — one failing must never block or skip the others.
      void bot.api.setMyCommands?.(PRIVATE_COMMAND_MENU, { scope: { type: "all_private_chats" } }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[companion] telegram setMyCommands (private) failed: ${describeError(err)}`);
      });
      void bot.api.setMyCommands?.(GROUP_COMMAND_MENU, { scope: { type: "all_group_chats" } }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[companion] telegram setMyCommands (group) failed: ${describeError(err)}`);
      });
      void bot.api.setMyCommands?.(GROUP_COMMAND_MENU, { scope: { type: "default" } }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[companion] telegram setMyCommands (default) failed: ${describeError(err)}`);
      });
      // Fire-and-forget the RESILIENT poll loop: runWithReconnect re-runs bot.start() after a backoff on
      // any drop, until stop() flips `stopped`. A startup failure (bad token / network) is logged, never
      // thrown, so it can't crash the daemon boot.
      void runWithReconnect({
        run: async () => {
          // A reconnect must start from a clean state — grammY refuses start() while already running.
          if (bot.isRunning()) {
            try { await bot.stop(); } catch { /* ignore */ }
          }
          await bot.start({
            // eslint-disable-next-line no-console
            onStart: (info) => console.log(`[companion] telegram long-poll started as @${info.username}`),
          });
        },
        isStopped: () => stopped,
        delayMs: backoffMs,
        sleep,
        onError: (err, attempt) =>
          // eslint-disable-next-line no-console
          console.error(`[companion] telegram long-poll dropped (attempt ${attempt}): ${describeError(err)} — reconnecting`),
        // eslint-disable-next-line no-console
        onReconnect: (attempt) => console.log(`[companion] telegram reconnecting (attempt ${attempt})`),
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[companion] telegram reconnect loop exited: ${describeError(err)}`);
      });
    },
    async stop() {
      stopped = true;
      try { await bot.stop(); } catch { /* best-effort on shutdown */ }
    },
    async send(chatId, text, opts) {
      // `other` stays `undefined` (grammY's own options slot — never used here); `opts?.signal` lets the
      // caller's own timeout (ChatGateway.tryAck, card dc5df70e) actually abort this request instead of
      // merely giving up waiting on it.
      await bot.api.sendMessage(chatId, text, undefined, opts?.signal);
    },
    async sendVoice(chatId, audioFilePath, _text, _proactive, signal) {
      if (!bot.api.sendVoice) throw new Error("sendVoice not supported by this bot");
      // `other` stays `undefined` (grammY's own options slot — never used here), mirroring `send` above
      // (card 2c7ac1dd) — the caller's own timeout (ChatGateway.tryDeliverVoice) can then actually abort
      // this request via `signal` instead of merely giving up waiting on it.
      await bot.api.sendVoice(chatId, new InputFile(audioFilePath), undefined, signal);
    },
    async sendMedia(chatId, filePath, opts) {
      const fileName = opts?.fileName ?? path.basename(filePath);
      const input = new InputFile(filePath, fileName);
      // `signal` (card 2c7ac1dd) lets the caller's own timeout (ChatGateway.deliverMedia) actually abort
      // this request, same shape as `sendVoice` above.
      if (TELEGRAM_PHOTO_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
        if (!bot.api.sendPhoto) throw new Error("sendPhoto not supported by this bot");
        await bot.api.sendPhoto(chatId, input, undefined, opts?.signal);
      } else {
        if (!bot.api.sendDocument) throw new Error("sendDocument not supported by this bot");
        await bot.api.sendDocument(chatId, input, undefined, opts?.signal);
      }
    },
    async downloadAttachment(attachment) {
      if (!attachment.fileId || !bot.api.getFile) return null;
      let dest: string | undefined;
      // `guardedFetch` (connections/boundedFetch.ts, card 731aa517) arms ONE AbortController/timer for
      // the WHOLE operation — connect/TTFB (the fetch call) AND, since we keep using its `signal` and
      // only call `cancelTimeout()` ourselves once done, the full body stream below too (threaded into
      // Readable.fromWeb) — so a mid-download stall is bounded exactly like a slow connect. It also
      // guarantees `redirect:"manual"` — the bot token rides the URL PATH here (not a header), so a
      // followed redirect could otherwise hand an attacker-controlled host a request carrying it.
      let cancelTimeout: (() => void) | undefined;
      try {
        const file = await bot.api.getFile(attachment.fileId);
        if (!file?.file_path) return null;
        // Telegram's cloud-API file-download URL (bot-token-scoped — never a body-supplied path).
        const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
        const guarded = await guardedFetch(url, { timeoutMs: downloadTimeoutMs, fetchImpl });
        if (!guarded.ok) {
          // Distinct, diagnosable reason for a refused redirect — status code only, NEVER the Location
          // header or the URL (which carries the bot token) — so a real Telegram redirect shows up as a
          // clear "refused a redirect" failure instead of a generic one.
          throw new Error(guarded.kind === "redirect"
            ? `telegram attachment download refused a redirect (HTTP ${guarded.status})`
            : guarded.error);
        }
        cancelTimeout = guarded.cancelTimeout;
        const res = guarded.response;
        if (!res.ok || !res.body) {
          // Cancel the unread body (card 731aa517 round 2) so the connection can be released — nothing
          // downstream will ever read it either way.
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const dir = path.join(LOOM_HOME, "tmp", "companion-audio");
        fs.mkdirSync(dir, { recursive: true });
        dest = path.join(dir, `${randomUUID()}${path.extname(file.file_path) || ".ogg"}`);
        let bytes = 0;
        // Enforce the ≤20MB cap as a Transform stage so `pipeline` treats an over-cap stream exactly like
        // any other stream error — it destroys BOTH the source and the destination write stream for us
        // (unlike a manual write-stream loop, which left the destination's own 'error' event unhandled: an
        // async write failure would otherwise escape this try/catch as an uncaught exception).
        const capStream = new Transform({
          transform(chunk: Buffer, _enc, callback) {
            bytes += chunk.length;
            if (bytes > maxAudioBytes) { callback(new Error("attachment exceeds the size cap")); return; }
            callback(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body, { signal: guarded.signal }), capStream, fs.createWriteStream(dest));
        const filePath = dest;
        return {
          filePath,
          cleanup: async () => { try { await fs.promises.unlink(filePath); } catch { /* best-effort */ } },
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[companion] telegram attachment download failed: ${describeError(err)}`);
        if (dest) { try { await fs.promises.unlink(dest); } catch { /* best-effort cleanup of a partial file */ } }
        return null;
      } finally {
        cancelTimeout?.();
      }
    },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
