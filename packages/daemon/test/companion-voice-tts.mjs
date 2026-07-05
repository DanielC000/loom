import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — VOICE-P3 (outbound TTS: synthesize agent replies via local Kokoro-onnx). Fully
// hermetic: a FAKE ChannelAdapter + a FAKE CompanionSynthesizer drive the gateway; NO live network, NO
// real claude, NO daemon, NO python/venv. Proves the card's SECURITY-CRITICAL DoD:
//   1. BYTE-IDENTICAL WHEN OFF: no synthesize dep injected ⇒ deliverReply's text path is UNCHANGED —
//      zero synth calls, the adapter's plain `send` fires exactly as it does today.
//   2. voiceReplies:false (the default pref) ⇒ zero synth calls even WITH a ready synthesizer injected —
//      the pref gate is checked before any TTS work is attempted.
//   3. voiceReplies:true + ready + the adapter advertises sendVoice ⇒ synth() is called with the route's
//      ttsLang/ttsVoice, the adapter's sendVoice() receives the synthesized file, and the temp file is
//      cleaned up — with NO plain text send alongside it.
//   4. synth not ready (isReady()===false) ⇒ degrades to the plain text send, synth() itself never called.
//   5. synth() resolves null (subprocess/encode failure) ⇒ degrades to text; nothing left to clean up.
//   6. sendVoice() THROWS (adapter transport failure) ⇒ degrades to text, and the temp file is STILL
//      cleaned up (finally, even on a throwing send).
//   7. the target adapter doesn't implement sendVoice at all ⇒ degrades to text WITHOUT ever calling
//      synth() (no wasted synthesis for a channel that can't play it back).
//   8. the outbound pref resolves via {sessionId, channel, chatId, senderId:null} — the SAME key a DM's
//      inbound voicePrefRoute uses — so a DM's /voice on + /lang setting is honored end-to-end with no
//      extra wiring (the SUPPORTED path in P3).
//   9. sendToChannel (the outbound MIRROR primitive) NEVER attempts voice — mirrors stay text-only.
//  10. a GROUP binding's /voice on is stored PER-SENDER (senderId = the authenticated sender), but the
//      outbound resolve always uses senderId:null — so a group's voice-reply pref is NEVER found and a
//      group reply ALWAYS degrades to text, even after a member turns voice replies on. Documented P3
//      limitation (group per-sender outbound voice is future work), asserted here so a regression that
//      accidentally "fixes" this without the sender-selection design is caught, not silently shipped.
// Run: 1) build (turbo builds shared first), 2) node test/companion-voice-tts.mjs
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { inMemoryVoicePrefs } from "../dist/companion/voice-prefs.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeAdapter(name, { withSendVoice = true, sendVoiceThrows = false } = {}) {
  const sent = [];
  const voiceSent = [];
  const adapter = {
    name,
    maxMessageLength: 4096,
    start() {},
    async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); },
  };
  if (withSendVoice) {
    adapter.sendVoice = async (chatId, filePath) => {
      if (sendVoiceThrows) throw new Error("simulated telegram sendVoice failure");
      voiceSent.push({ chatId, filePath });
    };
  }
  return { sent, voiceSent, adapter };
}

function makeSynthesizer({ ready = true, result = () => ({ filePath: "/tmp/reply.ogg" }) } = {}) {
  const calls = [];
  let readyCalls = 0;
  let cleanupCalls = 0;
  return {
    calls,
    get readyCalls() { return readyCalls; },
    get cleanupCalls() { return cleanupCalls; },
    synthesizer: {
      isReady() { readyCalls++; return ready; },
      async synthesize(input) {
        calls.push(input);
        const r = typeof result === "function" ? result(input) : result;
        if (!r) return null;
        return { filePath: r.filePath, cleanup: async () => { cleanupCalls++; } };
      },
    },
  };
}

// A fixed originResolver: sess-A's in-flight turn always originated on telegram/111 — deliverReply's ONLY
// target source, so this is all a test needs to exercise the outbound path (no real pty required).
const originResolver = (sid) => (sid === "sess-A" ? { channel: "telegram", chatId: "111" } : null);
const noopSubmit = () => ({ delivered: true });

try {
  // ============ 1 — BYTE-IDENTICAL WHEN OFF: no synthesize dep ⇒ plain text send, zero synth calls =========
  {
    const tg = makeAdapter("telegram");
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, true); // ON — still must not matter with no dep
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs); // no 8th arg
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "hello there");
    check("1: delivered via plain text send", r.delivered === true && tg.sent.length === 1 && tg.sent[0].text === "hello there");
    check("1: sendVoice NEVER called (no synthesize dep injected at all)", tg.voiceSent.length === 0);
  }

  // ============ 2 — voiceReplies:false (default pref) ⇒ zero synth calls even with a ready synthesizer ======
  {
    const tg = makeAdapter("telegram");
    const synth = makeSynthesizer({ ready: true });
    const prefs = inMemoryVoicePrefs(); // default: voiceReplies false
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "hello there");
    check("2: delivered via plain text send (pref off)", r.delivered === true && tg.sent.length === 1 && tg.sent[0].text === "hello there");
    check("2: synth() NEVER called (pref gate checked first)", synth.calls.length === 0);
    check("2: sendVoice NEVER called", tg.voiceSent.length === 0);
  }

  // ============ 3 — voiceReplies:true + ready + adapter has sendVoice ⇒ synth + sendVoice, no text send =====
  {
    const tg = makeAdapter("telegram");
    const synth = makeSynthesizer({ ready: true, result: () => ({ filePath: "/tmp/voice-reply.ogg" }) });
    const prefs = inMemoryVoicePrefs();
    prefs.setLang({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, "es");
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, true);
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "hola");
    check("3: delivered as a voice message", r.delivered === true);
    check("3: synth() called ONCE with the reply text + the route's ttsLang", synth.calls.length === 1 && synth.calls[0].text === "hola" && synth.calls[0].lang === "es");
    check("3: adapter.sendVoice received the synthesized file path", tg.voiceSent.length === 1 && tg.voiceSent[0].chatId === "111" && tg.voiceSent[0].filePath === "/tmp/voice-reply.ogg");
    check("3: NO plain text send alongside the voice message", tg.sent.length === 0);
    check("3: the temp audio file was cleaned up", synth.cleanupCalls === 1);
  }

  // ============ 4 — synth not ready ⇒ degrades to text, synth() itself never called ===========================
  {
    const tg = makeAdapter("telegram");
    const synth = makeSynthesizer({ ready: false });
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, true);
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "hello there");
    check("4: degraded to plain text send (cold venv)", r.delivered === true && tg.sent.length === 1 && tg.sent[0].text === "hello there");
    check("4: synth() never called (readiness gate)", synth.calls.length === 0);
    check("4: sendVoice never called", tg.voiceSent.length === 0);
  }

  // ============ 5 — synth() resolves null (failure) ⇒ degrades to text =========================================
  {
    const tg = makeAdapter("telegram");
    const synth = makeSynthesizer({ ready: true, result: () => null });
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, true);
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "hello there");
    check("5: degraded to plain text send (synth failure)", r.delivered === true && tg.sent.length === 1 && tg.sent[0].text === "hello there");
    check("5: sendVoice never called (nothing to send)", tg.voiceSent.length === 0);
  }

  // ============ 6 — adapter.sendVoice THROWS ⇒ degrades to text; temp file STILL cleaned up ====================
  {
    const tg = makeAdapter("telegram", { sendVoiceThrows: true });
    const synth = makeSynthesizer({ ready: true, result: () => ({ filePath: "/tmp/voice-reply.ogg" }) });
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, true);
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "hello there");
    check("6: degraded to plain text send (sendVoice threw)", r.delivered === true && tg.sent.length === 1 && tg.sent[0].text === "hello there");
    check("6: the temp file was STILL cleaned up (finally, even on a throwing send)", synth.cleanupCalls === 1);
  }

  // ============ 7 — adapter doesn't implement sendVoice ⇒ degrades to text, synth() never called ===============
  {
    const tg = makeAdapter("telegram", { withSendVoice: false });
    const synth = makeSynthesizer({ ready: true });
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, true);
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "hello there");
    check("7: degraded to plain text send (adapter can't play voice)", r.delivered === true && tg.sent.length === 1);
    check("7: synth() NEVER called (no wasted synthesis for a channel that can't use it)", synth.calls.length === 0);
  }

  // ============ 8 — outbound pref key: DM (senderId:null) matches inbound exactly; GROUP also senderId:null ====
  {
    const tg = makeAdapter("telegram");
    const synth = makeSynthesizer({ ready: true, result: () => ({ filePath: "/tmp/voice-reply.ogg" }) });
    const prefs = inMemoryVoicePrefs();
    // Set the pref via the EXACT route an inbound voicePrefRoute() would produce for a DM binding
    // (scope:"dm" ⇒ senderId always null) — proves deliverReply's outbound resolve reaches the SAME row.
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, true);
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "dm reply");
    check("8: a DM's /voice on pref (senderId:null) is honored end-to-end by the outbound reply", r.delivered === true && tg.voiceSent.length === 1);
  }

  // ============ 9 — sendToChannel (the outbound MIRROR) never attempts voice — mirrors stay text-only ==========
  {
    const tg = makeAdapter("telegram");
    const synth = makeSynthesizer({ ready: true });
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, true);
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.sendToChannel("telegram", "111", "mirrored web-chat turn");
    check("9: sendToChannel delivers as plain text", r.delivered === true && tg.sent.length === 1 && tg.sent[0].text === "mirrored web-chat turn");
    check("9: sendToChannel NEVER attempts synth/voice (mirror stays text-only by construction)", synth.calls.length === 0 && tg.voiceSent.length === 0);
  }

  // ============ 10 — a GROUP's per-sender /voice on is NEVER found by the outbound (senderId:null) resolve;
  //                   a group reply ALWAYS degrades to text (documented P3 limitation, not a bug) ============
  {
    const tg = makeAdapter("telegram");
    const synth = makeSynthesizer({ ready: true });
    const prefs = inMemoryVoicePrefs();
    // A group member turns voice replies ON via /voice on — stored PER-SENDER (mirrors voicePrefRoute's
    // group-scope rule: senderId = the authenticated sender who ran the command).
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: "member-42" }, true);
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth.synthesizer);
    gw.registerAdapter(tg.adapter);

    const r = await gw.deliverReply("sess-A", "reply to the group");
    check("10: a group reply ALWAYS degrades to text (outbound senderId:null never matches a per-sender row)", r.delivered === true && tg.sent.length === 1 && tg.sent[0].text === "reply to the group");
    check("10: synth() NEVER called for a group reply (the pref row can never resolve)", synth.calls.length === 0);
    check("10: sendVoice NEVER called", tg.voiceSent.length === 0);
  }
} catch (err) {
  console.error("UNCAUGHT:", err);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
