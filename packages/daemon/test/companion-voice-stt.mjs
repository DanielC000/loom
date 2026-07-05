import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — VOICE-P2 (inbound STT: transcribe Telegram voice notes via local faster-whisper).
// Fully hermetic: a FAKE ChannelAdapter + a FAKE CompanionTranscriber drive the gateway; NO live network,
// NO real claude, NO daemon, NO python/venv. Proves the card's SECURITY-CRITICAL DoD:
//   1. STT STRICTLY BEHIND AUTHZ — an unauthorized (group, unlisted sender) OR unbound (foreign chat) voice
//      note is rejected BEFORE the transcribe block: ZERO calls to downloadAttachment AND ZERO calls to
//      transcribe. No compute is ever spent on an untrusted sender's audio.
//   2. An authorized voice note transcribes and flows through the EXISTING submitTurn path as a normal
//      turn — the transcript is DATA the agent reads, never a new interpretation path.
//   3. Download is GATED on STT readiness: transcriber.isReady()===false skips downloadAttachment entirely
//      (no wasted ≤20MB fetch on a cold venv) and acks 'transcribe-unavailable'.
//   4. A download failure or an empty/null transcript degrades to 'transcribe-unavailable' (friendly ack),
//      never a crash, never a turn with empty text; the downloaded temp file's cleanup() is ALWAYS called
//      once a download succeeded (even when transcribe then fails).
//   5. BYTE-IDENTICAL WHEN OFF: no transcribe dep injected ⇒ an audio-only inbound is silently ignored
//      ('no-text'), and a plain text inbound with a transcribe dep injected never touches transcribe.
//   6. The per-route sttLang voice pref is read and forced as transcribe()'s langHint.
//   7. normalizeTelegramMessage (telegram.ts): a voice-note update (no text) normalizes to an InboundMessage
//      with an "audio" attachment carrying the file_id and an empty body; a genuinely empty update (no text,
//      no voice) still normalizes to null (unchanged).
// Run: 1) build (turbo builds shared first), 2) node test/companion-voice-stt.mjs
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { inMemoryVoicePrefs } from "../dist/companion/voice-prefs.js";
import { normalizeTelegramMessage } from "../dist/companion/telegram.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeAdapter(name, { downloadResult } = {}) {
  const sent = [];
  const downloadCalls = [];
  return {
    sent,
    downloadCalls,
    adapter: {
      name,
      maxMessageLength: 4096,
      start() {},
      async stop() {},
      async send(chatId, text) { sent.push({ chatId, text }); },
      async downloadAttachment(attachment) {
        downloadCalls.push(attachment);
        return typeof downloadResult === "function" ? downloadResult(attachment) : downloadResult ?? null;
      },
    },
  };
}

function makeTranscriber({ ready = true, result = "hello from voice" } = {}) {
  const calls = [];
  let readyCalls = 0;
  return {
    calls,
    get readyCalls() { return readyCalls; },
    transcriber: {
      isReady() { readyCalls++; return ready; },
      async transcribe(input) { calls.push(input); return typeof result === "function" ? result(input) : result; },
    },
  };
}

const audioMsg = (channel, chatId, sender) => ({ channel, chatId, body: "", sender, attachments: [{ type: "audio", fileId: "file-1" }] });
const textMsg = (channel, chatId, body, sender) => ({ channel, chatId, body, sender });

try {
  // ============ 1a — UNAUTHORIZED sender (group scope, default auth rejects) → zero download/transcribe ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const tg = makeAdapter("telegram", { downloadResult: { filePath: "/tmp/should-not-be-used.ogg", cleanup: async () => {} } });
    const tr = makeTranscriber();
    // (submitTurn, bindings, auth[default], pairing[default], originResolver, voicePrefs, transcribe)
    const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "grp-1", scope: "group" }], undefined, undefined, undefined, undefined, tr.transcriber);
    gw.registerAdapter(tg.adapter);

    const r = await gw.handleInbound(audioMsg("telegram", "grp-1", { id: "not-on-allowlist" }));
    check("1a: unauthorized group sender's voice note rejected", r.accepted === false && r.reason === "sender-not-authorized");
    check("1a: downloadAttachment NEVER called", tg.downloadCalls.length === 0);
    check("1a: transcribe NEVER called", tr.calls.length === 0);
    check("1a: transcriber.isReady() NEVER called (rejected before the transcribe block is even reached)", tr.readyCalls === 0);
    check("1a: no turn submitted", submitted.length === 0);
  }

  // ============ 1b — FOREIGN chat (no binding at all) → zero download/transcribe (widened no-text guard) ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const tg = makeAdapter("telegram", { downloadResult: { filePath: "/tmp/should-not-be-used.ogg", cleanup: async () => {} } });
    const tr = makeTranscriber();
    const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }], undefined, undefined, undefined, undefined, tr.transcriber);
    gw.registerAdapter(tg.adapter);

    const r = await gw.handleInbound(audioMsg("telegram", "999-unbound", { id: "anyone" }));
    check("1b: foreign chat's voice note rejected as chat-not-allowlisted (not swallowed as no-text)", r.accepted === false && r.reason === "chat-not-allowlisted");
    check("1b: downloadAttachment NEVER called", tg.downloadCalls.length === 0);
    check("1b: transcribe NEVER called", tr.calls.length === 0);
    check("1b: no turn submitted", submitted.length === 0);
  }

  // ============ 2 — authorized voice note transcribes → flows through submitTurn as a normal turn ============
  {
    const submitted = [];
    const submit = (sid, text, route) => { submitted.push({ sid, text, route }); return { delivered: true }; };
    let cleanupCalls = 0;
    const tg = makeAdapter("telegram", { downloadResult: { filePath: "/tmp/voice.ogg", cleanup: async () => { cleanupCalls++; } } });
    const tr = makeTranscriber({ result: "what is the weather today" });
    const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }], undefined, undefined, undefined, undefined, tr.transcriber);
    gw.registerAdapter(tg.adapter);

    const r = await gw.handleInbound(audioMsg("telegram", "111", { id: "owner" }));
    check("2: accepted as a normal turn", r.accepted === true && r.sessionId === "sess-A");
    check("2: transcribe called with the downloaded filePath", tr.calls.length === 1 && tr.calls[0].filePath === "/tmp/voice.ogg");
    check("2: the transcript (not the empty body) was submitted as the turn text", submitted.length === 1 && submitted[0].text === "what is the weather today");
    check("2: the ORIGINATING route was preserved on submit", submitted[0].route?.channel === "telegram" && submitted[0].route?.chatId === "111");
    check("2: the temp file was cleaned up", cleanupCalls === 1);
    check("2: no unavailable ack was sent (a successful transcript never acks)", tg.sent.length === 0);
  }

  // ============ 3 — STT not ready → download is SKIPPED (readiness gate before the fetch) ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const tg = makeAdapter("telegram", { downloadResult: { filePath: "/tmp/voice.ogg", cleanup: async () => {} } });
    const tr = makeTranscriber({ ready: false });
    const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }], undefined, undefined, undefined, undefined, tr.transcriber);
    gw.registerAdapter(tg.adapter);

    const r = await gw.handleInbound(audioMsg("telegram", "111", { id: "owner" }));
    check("3: reason is transcribe-unavailable", r.accepted === false && r.reason === "transcribe-unavailable");
    check("3: downloadAttachment was SKIPPED (no wasted fetch on a cold venv)", tg.downloadCalls.length === 0);
    check("3: transcribe() itself was never called either", tr.calls.length === 0);
    check("3: a friendly 'try again' ack was sent", r.acked === true && tg.sent.length === 1 && /isn't ready yet/i.test(tg.sent[0].text));
    check("3: no turn submitted", submitted.length === 0);
  }

  // ============ 4 — download fails (adapter returns null) → transcribe-unavailable, transcribe() never called ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const tg = makeAdapter("telegram", { downloadResult: null });
    const tr = makeTranscriber();
    const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }], undefined, undefined, undefined, undefined, tr.transcriber);
    gw.registerAdapter(tg.adapter);

    const r = await gw.handleInbound(audioMsg("telegram", "111", { id: "owner" }));
    check("4: reason is transcribe-unavailable", r.accepted === false && r.reason === "transcribe-unavailable");
    check("4: downloadAttachment WAS attempted (STT was ready)", tg.downloadCalls.length === 1);
    check("4: transcribe() never called (nothing downloaded)", tr.calls.length === 0);
    check("4: no turn submitted", submitted.length === 0);
  }

  // ============ 5 — download succeeds but transcribe resolves null (subprocess failure) → cleanup still runs ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    let cleanupCalls = 0;
    const tg = makeAdapter("telegram", { downloadResult: { filePath: "/tmp/voice.ogg", cleanup: async () => { cleanupCalls++; } } });
    const tr = makeTranscriber({ result: null });
    const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }], undefined, undefined, undefined, undefined, tr.transcriber);
    gw.registerAdapter(tg.adapter);

    const r = await gw.handleInbound(audioMsg("telegram", "111", { id: "owner" }));
    check("5: reason is transcribe-unavailable", r.accepted === false && r.reason === "transcribe-unavailable");
    check("5: the temp file was STILL cleaned up (finally, even on transcribe failure)", cleanupCalls === 1);
    check("5: no turn submitted", submitted.length === 0);
  }

  // ============ 6 — no transcribe dep injected (default OFF) → audio-only inbound silently ignored ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const tg = makeAdapter("telegram", { downloadResult: { filePath: "/tmp/voice.ogg", cleanup: async () => {} } });
    // NOTE: no 7th ctor arg — mirrors an existing bare `new ChatGateway(submit, bindings)` construction.
    const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }]);
    gw.registerAdapter(tg.adapter);

    const r = await gw.handleInbound(audioMsg("telegram", "111", { id: "owner" }));
    check("6: audio ignored as no-text when transcribe is undefined (byte-identical no-op)", r.accepted === false && r.reason === "no-text");
    check("6: downloadAttachment never called", tg.downloadCalls.length === 0);
    check("6: no turn submitted", submitted.length === 0);
  }

  // ============ 7 — a plain TEXT inbound never touches transcribe, even when a transcriber IS injected ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const tg = makeAdapter("telegram");
    const tr = makeTranscriber();
    const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }], undefined, undefined, undefined, undefined, tr.transcriber);
    gw.registerAdapter(tg.adapter);

    const r = await gw.handleInbound(textMsg("telegram", "111", "hi there", { id: "owner" }));
    check("7: plain text still submits normally", r.accepted === true && submitted.length === 1 && submitted[0].text === "hi there");
    check("7: transcribe.isReady()/transcribe() never touched by a text-only inbound", tr.readyCalls === 0 && tr.calls.length === 0);
  }

  // ============ 8 — the per-route sttLang voice pref is forced as transcribe()'s langHint ============
  {
    const submit = () => ({ delivered: true });
    const tg = makeAdapter("telegram", { downloadResult: { filePath: "/tmp/voice.ogg", cleanup: async () => {} } });
    const tr = makeTranscriber();
    const prefs = inMemoryVoicePrefs();
    const binding = { sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" };
    prefs.setLang({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, "es");
    const gw = new ChatGateway(submit, [binding], undefined, undefined, undefined, prefs, tr.transcriber);
    gw.registerAdapter(tg.adapter);

    await gw.handleInbound(audioMsg("telegram", "111", { id: "owner" }));
    check("8: transcribe() received the route's sttLang as langHint", tr.calls.length === 1 && tr.calls[0].langHint === "es");
  }

  // ============ 9 — normalizeTelegramMessage: a voice-note update normalizes with an audio attachment ============
  {
    const update = { message: { chat: { id: 111 }, message_id: 5, from: { id: 7 }, voice: { file_id: "AAbb", mime_type: "audio/ogg" } } };
    const msg = normalizeTelegramMessage(update);
    check("9: a voice-only update normalizes (not dropped despite no text)", msg !== null);
    check("9: body is empty for a voice-only update", msg?.body === "");
    check("9: carries ONE 'audio' attachment with the file_id + mime type", JSON.stringify(msg?.attachments) === JSON.stringify([{ type: "audio", fileId: "AAbb", mimeType: "audio/ogg" }]));

    const emptyUpdate = { message: { chat: { id: 111 }, message_id: 6, from: { id: 7 } } };
    check("9: an update with neither text nor voice still normalizes to null (unchanged)", normalizeTelegramMessage(emptyUpdate) === null);
  }
} catch (err) {
  console.error("UNCAUGHT:", err);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
