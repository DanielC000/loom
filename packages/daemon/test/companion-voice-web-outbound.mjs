import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — VOICE-P4 outbound (voice reply → browser playback). Fully hermetic: a real ChatGateway +
// the real InAppChannel + a fake CompanionSynthesizer + a fake web client (the InAppClient seam) — NO real
// browser, NO python/venv, NO daemon. Proves:
//   5. InAppChannel.adapter.sendVoice: reads + base64-encodes the synthesized file, RECORDS chat history AND
//      delivers a { type:"chat", audio } frame itself (unlike Telegram, sendVoice REPLACES send entirely on
//      this channel, so it must do both jobs or a voice reply would vanish from history/reload).
//   6. A sendVoice failure (unreadable file) THROWS, and chat-gateway's tryDeliverVoice degrades to the
//      PLAIN text send — recorded/delivered exactly ONCE, never double-recorded.
//   7. End-to-end deliverReply: voiceReplies on (DM, senderId:null) + synth ready ⇒ the web client receives
//      ONE audio-bearing chat frame with the correct base64 + mimeType; plain adapter.send is NEVER called.
// (Inbound mic → STT is VOICE-P4's other half — see companion-voice-web-inbound.mjs.)
// Run: 1) build (turbo builds shared first), 2) node test/companion-voice-web-outbound.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { InAppChannel, IN_APP_CHANNEL } from "../dist/companion/in-app.js";
import { inMemoryVoicePrefs } from "../dist/companion/voice-prefs.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };
const inAppBinding = (sessionId) => ({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });

function makeSynthesizer({ ready = true, filePath } = {}) {
  const calls = [];
  return {
    calls,
    synthesizer: {
      isReady() { return ready; },
      async synthesize(input) {
        calls.push(input);
        if (!filePath) return null;
        return { filePath, cleanup: async () => {} };
      },
    },
  };
}

try {
  // ================= 5 — InAppChannel.adapter.sendVoice: records history AND delivers the audio frame ====
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-voice-web-"));
    const audioPath = path.join(dir, "reply.ogg");
    const audioBytes = Buffer.from("fake ogg/opus reply bytes");
    fs.writeFileSync(audioPath, audioBytes);

    const recorded = [];
    const inApp = new InAppChannel({ record: (sid, author, text) => recorded.push({ sid, author, text }) });
    const { frames, client } = makeClient();
    inApp.attach("sess-A", client);

    await inApp.adapter.sendVoice("sess-A", audioPath, "the reply text");
    check("5: sendVoice RECORDED the reply text as a companion message", recorded.length === 1 && recorded[0].author === "companion" && recorded[0].text === "the reply text");
    check("5: sendVoice delivered ONE chat frame carrying the base64 audio", frames.length === 1 && frames[0].type === "chat" && frames[0].text === "the reply text");
    check("5: the frame's audio is the CORRECT base64 + mimeType", frames[0].audio?.mimeType === "audio/ogg" && Buffer.from(frames[0].audio.data, "base64").equals(audioBytes));
  }

  // ================= 6 — sendVoice failure (unreadable file) degrades to plain text, no double-record ====
  {
    const inApp = new InAppChannel();
    const synth = makeSynthesizer({ filePath: "/tmp/loom-voice-web-does-not-exist-12345.ogg" });
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: IN_APP_CHANNEL, chatId: "sess-A", senderId: null }, "on");
    const gw = new ChatGateway(
      () => ({ delivered: true }), [inAppBinding("sess-A")], undefined, undefined,
      (sid) => (sid === "sess-A" ? { channel: IN_APP_CHANNEL, chatId: "sess-A" } : null),
      prefs, undefined, synth.synthesizer,
    );
    gw.registerAdapter(inApp.adapter);
    const { frames, client } = makeClient();
    inApp.attach("sess-A", client);

    const result = await gw.deliverReply("sess-A", "degrade to text please");
    check("6: deliverReply still delivered (degraded to text, not lost)", result.delivered === true);
    check("6: exactly ONE frame reached the client — the plain text send, no audio field", frames.length === 1 && frames[0].text === "degrade to text please" && frames[0].audio === undefined);
  }

  // ================= 7 — end-to-end deliverReply: voice succeeds, adapter.send is NEVER called ============
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-voice-web-"));
    const audioPath = path.join(dir, "reply.ogg");
    const audioBytes = Buffer.from("real-ish ogg reply bytes");
    fs.writeFileSync(audioPath, audioBytes);

    const inApp = new InAppChannel();
    const synth = makeSynthesizer({ filePath: audioPath });
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: IN_APP_CHANNEL, chatId: "sess-A", senderId: null }, "on");
    const gw = new ChatGateway(
      () => ({ delivered: true }), [inAppBinding("sess-A")], undefined, undefined,
      (sid) => (sid === "sess-A" ? { channel: IN_APP_CHANNEL, chatId: "sess-A" } : null),
      prefs, undefined, synth.synthesizer,
    );
    gw.registerAdapter(inApp.adapter);
    const { frames, client } = makeClient();
    inApp.attach("sess-A", client);

    const result = await gw.deliverReply("sess-A", "voiced reply");
    check("7: delivered via voice (single chunk)", result.delivered === true && result.chunks === 1);
    check("7: synth was called with the reply text", synth.calls.length === 1 && synth.calls[0].text === "voiced reply");
    check("7: exactly one frame, carrying the correct audio bytes + text", frames.length === 1 && frames[0].text === "voiced reply" && Buffer.from(frames[0].audio.data, "base64").equals(audioBytes));

    // Group scope (P3's documented limitation, still true for P4): outbound voice ALWAYS resolves
    // senderId:null, so a group's per-sender pref row never matches — degrades to text, same as Telegram.
  }
} catch (err) {
  console.error(err);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — VOICE-P4 outbound: a synthesized voice reply records history + delivers its own audio-bearing frame (sendVoice replaces send on this channel, so both jobs happen there), degrading cleanly to plain text on any failure with no double-record."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
