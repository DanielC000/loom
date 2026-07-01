// Loom Companion — Telegram ADAPTER test (normalization + reply-routing + reconnect wiring). Fully
// hermetic: a simulated grammY update is normalized in-process, and the adapter's grammY Bot is REPLACED
// by an injected FAKE (no live Telegram, no network). Proves:
//   • normalizeTelegramMessage maps a simulated grammY update → the standard InboundMessage shape;
//   • the adapter's `send` routes to the bot API (fake) with the right chat id + text;
//   • the inbound handler wiring: a bot "message" event → onInbound(normalized), with an ERROR BOUNDARY
//     so a throwing onInbound can't escape the handler;
//   • start() invokes the resilient poll loop (bot.start); stop() flips the loop off and stops the bot;
//   • the reconnect wrapper (runWithReconnect) re-runs on a drop until stop, with capped backoff.
// Run: 1) build, 2) node test/companion-telegram.mjs
import {
  createTelegramAdapter,
  normalizeTelegramMessage,
  TELEGRAM_CHANNEL,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../dist/companion/telegram.js";
import { runWithReconnect, cappedBackoff } from "../dist/companion/resilience.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const tick = () => new Promise((r) => setTimeout(r, 15));

// --- normalizeTelegramMessage: simulated grammY update → standard InboundMessage -----------------
{
  const update = {
    message: {
      message_id: 42,
      chat: { id: 12345 },
      text: "hello from telegram",
      from: { id: 777, username: "danielc", first_name: "Daniel", last_name: "C" },
    },
  };
  const m = normalizeTelegramMessage(update);
  check("normalize: channel is telegram", m?.channel === TELEGRAM_CHANNEL);
  check("normalize: numeric chat id stringified", m?.chatId === "12345");
  check("normalize: body is the message text", m?.body === "hello from telegram");
  check("normalize: sender id stringified", m?.sender?.id === "777");
  check("normalize: sender username carried", m?.sender?.username === "danielc");
  check("normalize: sender displayName joins first+last", m?.sender?.displayName === "Daniel C");
  check("normalize: metadata carries the message id", m?.metadata?.messageId === 42);

  check("normalize: no message → null", normalizeTelegramMessage({}) === null);
  check("normalize: empty text → null", normalizeTelegramMessage({ message: { chat: { id: 1 }, text: "" } }) === null);
  check("normalize: missing chat → null", normalizeTelegramMessage({ message: { text: "x" } }) === null);
  check("normalize: null update → null", normalizeTelegramMessage(null) === null);
  // A message with no sender still normalizes (chat-scoped only).
  const noFrom = normalizeTelegramMessage({ message: { chat: { id: 9 }, text: "hi" } });
  check("normalize: missing 'from' → sender undefined, still normalized", noFrom?.chatId === "9" && noFrom?.sender === undefined);
}

// A fake grammY Bot implementing the minimal TelegramBotLike seam (no network).
function makeFakeBot({ startResolves = false } = {}) {
  const sends = [];
  let messageHandler = null;
  let errorHandler = null;
  let running = false;
  let startCalls = 0, stopCalls = 0;
  return {
    sends,
    get startCalls() { return startCalls; },
    get stopCalls() { return stopCalls; },
    get hasMessageHandler() { return messageHandler !== null; },
    get hasErrorHandler() { return errorHandler !== null; },
    fireMessage(update) { return messageHandler?.({ update }); },
    bot: {
      api: { async sendMessage(chatId, text) { sends.push({ chatId, text }); } },
      on(_filter, h) { messageHandler = h; },
      catch(h) { errorHandler = h; },
      async start(opts) { startCalls++; running = true; opts?.onStart?.({ username: "loombot" }); if (!startResolves) await new Promise(() => {}); },
      async stop() { stopCalls++; running = false; },
      isRunning() { return running; },
    },
  };
}

// --- send routing → bot API; inbound handler wiring + error boundary -----------------------------
{
  const inboundSeen = [];
  const fake = makeFakeBot();
  const adapter = createTelegramAdapter("test-token", (msg) => inboundSeen.push(msg), { bot: fake.bot });

  check("adapter: name is telegram", adapter.name === TELEGRAM_CHANNEL);
  check("adapter: exposes Telegram's 4096 max length", adapter.maxMessageLength === TELEGRAM_MAX_MESSAGE_LENGTH && TELEGRAM_MAX_MESSAGE_LENGTH === 4096);
  check("adapter: registered a message handler on the bot", fake.hasMessageHandler);
  check("adapter: registered an error handler (bot.catch) on the bot", fake.hasErrorHandler);

  // send → bot.api.sendMessage
  await adapter.send("555", "outbound text");
  check("adapter.send: routes to the bot API with chat id + text", fake.sends.length === 1 && fake.sends[0].chatId === "555" && fake.sends[0].text === "outbound text");

  // inbound: a bot message event → onInbound(normalized)
  await fake.fireMessage({ message: { chat: { id: 12345 }, text: "ping" } });
  check("adapter inbound: normalized message pushed to onInbound", inboundSeen.length === 1 && inboundSeen[0].chatId === "12345" && inboundSeen[0].body === "ping" && inboundSeen[0].channel === TELEGRAM_CHANNEL);

  // a no-text update is dropped (normalize → null), onInbound NOT called
  await fake.fireMessage({ message: { chat: { id: 12345 } } });
  check("adapter inbound: a no-text update is not forwarded", inboundSeen.length === 1);
}

// --- error boundary: a throwing onInbound cannot escape the handler ------------------------------
{
  const fake = makeFakeBot();
  createTelegramAdapter("test-token", () => { throw new Error("enqueueStdin blew up"); }, { bot: fake.bot });
  let escaped = false;
  try { await fake.fireMessage({ message: { chat: { id: 1 }, text: "boom" } }); } catch { escaped = true; }
  check("error boundary: a throwing onInbound is contained (did not escape)", escaped === false);
}

// --- start()/stop() lifecycle drive the bot -----------------------------------------------------
{
  const fake = makeFakeBot(); // start() never resolves → the reconnect loop parks on the first run
  const adapter = createTelegramAdapter("test-token", () => {}, { bot: fake.bot, sleep: async () => {} });
  adapter.start();
  await tick();
  check("lifecycle: start() invoked the bot poll loop exactly once", fake.startCalls === 1 && fake.bot.isRunning());
  await adapter.stop();
  check("lifecycle: stop() stopped the bot", fake.stopCalls >= 1 && !fake.bot.isRunning());
}

// --- reconnect wrapper: re-runs on a drop until stop --------------------------------------------
{
  let runs = 0, reconnects = 0, errors = 0;
  await runWithReconnect({
    run: async () => { runs++; throw new Error("dropped"); },
    isStopped: () => runs >= 3,
    delayMs: () => 0,
    sleep: async () => {},
    onError: () => { errors++; },
    onReconnect: () => { reconnects++; },
  });
  check("reconnect: re-ran the loop until isStopped (3 runs)", runs === 3);
  check("reconnect: fired a reconnect between each surviving drop (2)", reconnects === 2);
  check("reconnect: reported each surviving drop as an error (2)", errors === 2);
}
{
  // A CLEAN resolve (poll ended without error) also reconnects — the loop only returns when it ends.
  let runs = 0, reconnects = 0;
  await runWithReconnect({
    run: async () => { runs++; /* resolves cleanly */ },
    isStopped: () => runs >= 2,
    delayMs: () => 0,
    sleep: async () => {},
    onReconnect: () => { reconnects++; },
  });
  check("reconnect: a clean poll end also triggers a reconnect", runs === 2 && reconnects === 1);
}
{
  // Already stopped → never runs.
  let runs = 0;
  await runWithReconnect({ run: async () => { runs++; }, isStopped: () => true, delayMs: () => 0, sleep: async () => {} });
  check("reconnect: isStopped from the start → run never called", runs === 0);
}
{
  // Backoff RESET after a healthy (long-lived) connection: a run that lasted ≥ resetAfterMs resets the
  // attempt counter, so a link up for a long time then dropping reconnects fast (not at the 30s cap).
  // Inject a fake monotonic clock; run #2 "lasts" 100s, the others are instant.
  let runs = 0;
  const delays = [];
  let clock = 0;
  await runWithReconnect({
    run: async () => { runs++; clock += (runs === 2 ? 100_000 : 10); throw new Error("drop"); },
    isStopped: () => runs >= 4,
    delayMs: (attempt) => { delays.push(attempt); return 0; },
    sleep: async () => {},
    now: () => clock,
    resetAfterMs: 60_000,
  });
  // Without a reset the attempts would climb 1,2,3; the healthy run #2 resets, so the 2nd delay is 1 again.
  check("backoff-reset: a long-lived run resets the backoff counter", delays.length === 3 && delays[0] === 1 && delays[1] === 1 && delays[2] === 2);
}

// --- capped exponential backoff -----------------------------------------------------------------
{
  const b = cappedBackoff(1000, 30000);
  check("backoff: attempt 1 = base 1000ms", b(1) === 1000);
  check("backoff: attempt 2 = 2000ms", b(2) === 2000);
  check("backoff: attempt 3 = 4000ms", b(3) === 4000);
  check("backoff: large attempt capped at 30000ms", b(50) === 30000);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a simulated grammY update normalizes to the standard shape, send routes to the bot API, the inbound handler has an error boundary, and the long-poll reconnects on a drop until stop."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
