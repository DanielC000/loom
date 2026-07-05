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
import { Bot } from "grammy";
import type { ChannelAdapter, InboundAttachment, InboundHandler, InboundMessage } from "./types.js";
import { cappedBackoff, runWithReconnect } from "./resilience.js";
import { COMMAND_MENU } from "./commands.js";
import { LOOM_HOME } from "../paths.js";

/** Telegram's cloud-API file-download size cap (Companion Voice epic, VOICE-P2). */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/**
 * The OVERALL deadline (ms) for a voice-note download — covers connect/TTFB AND the full body stream (one
 * AbortController threaded through both the `fetch` call and the piped body read below), so a mid-stream
 * stall is bounded exactly like a slow/hanging connect — neither can wedge the daemon.
 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

export const TELEGRAM_CHANNEL = "telegram";
/** Telegram's hard per-message character limit — the gateway chunks outbound replies to this. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** The minimal grammY Bot surface the adapter uses — lets a test inject a fake (no live network). */
export interface TelegramBotLike {
  api: {
    sendMessage(chatId: string | number, text: string): Promise<unknown>;
    /** Register the native "/" command menu (Companion Voice epic, VOICE-P1). Optional on the seam so an
     *  existing test fake bot (no `setMyCommands`) stays valid — the call site guards with `?.`. */
    setMyCommands?(commands: { command: string; description: string }[]): Promise<unknown>;
    /** Resolve a Telegram `file_id` to its download path (Companion Voice epic, VOICE-P2). Optional on the
     *  seam so an existing test fake bot (no voice-download tests) stays valid. */
    getFile?(fileId: string): Promise<{ file_path?: string }>;
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
        chat?: { id?: unknown };
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
      // Register the native "/" command menu (Companion Voice epic, VOICE-P1) — best-effort, fire-and-forget:
      // a failure (network / bad token) is logged, never thrown, and never blocks/delays the poll loop below.
      // `?.` guards a test fake bot that doesn't implement setMyCommands (companion-telegram.mjs).
      void bot.api.setMyCommands?.(COMMAND_MENU).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[companion] telegram setMyCommands failed: ${describeError(err)}`);
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
    async send(chatId, text) {
      await bot.api.sendMessage(chatId, text);
    },
    async downloadAttachment(attachment) {
      if (!attachment.fileId || !bot.api.getFile) return null;
      let dest: string | undefined;
      // ONE AbortController for the WHOLE operation — connect/TTFB (the fetch call) AND the full body
      // stream (threaded into Readable.fromWeb below) — so a mid-download stall is bounded exactly like a
      // slow connect, not just the initial response.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      try {
        const file = await bot.api.getFile(attachment.fileId);
        if (!file?.file_path) return null;
        // Telegram's cloud-API file-download URL (bot-token-scoped — never a body-supplied path).
        const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok || !res.body) return null;
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
            if (bytes > MAX_AUDIO_BYTES) { callback(new Error("attachment exceeds the size cap")); return; }
            callback(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body, { signal: controller.signal }), capStream, fs.createWriteStream(dest));
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
        clearTimeout(timer);
      }
    },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
