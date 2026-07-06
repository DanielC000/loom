import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — VOICE-P4 inbound (browser mic → STT). Fully hermetic: a real ChatGateway + the real
// InAppChannel + a fake CompanionTranscriber + a fake web client (the InAppClient seam) — NO real browser,
// NO python/venv, NO daemon. Proves:
//   1. decodeInAppAudioToTempFile: valid base64 → a server-generated temp file with the exact decoded bytes;
//      an oversize/malformed/empty payload → null, NEVER throws.
//   2. InAppChannel.adapter.downloadAttachment is a trivial LOCAL pass-through (no network) — the file it
//      hands back is EXACTLY the one whose path was given (never a client-supplied path — that file didn't
//      come from attachment data, only from what decodeInAppAudioToTempFile already minted).
//   3. controller.handleInAppAudioInbound: an audio inbound transcribes through the SAME STT pipeline VOICE-P2
//      proved for Telegram, records the TRANSCRIPT (not empty audio) as the user message, mirrors it to other
//      bound channels, and pushes a { type:"transcript" } LIVE ECHO to the sender's own attached client(s) —
//      distinct from a companion reply frame ({ type:"chat" }).
//   4. Byte-identical when off: no transcribe dep injected ⇒ silently ignored (no-text), nothing recorded,
//      nothing pushed — mirrors VOICE-P2's existing off-by-default guarantee.
// (Outbound reply→playback is VOICE-P4's other half — see companion-voice-web-outbound.mjs.)
// Run: 1) build (turbo builds shared first), 2) node test/companion-voice-web-inbound.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { InAppChannel, IN_APP_CHANNEL, decodeInAppAudioToTempFile, IN_APP_AUDIO_MAX_BYTES } from "../dist/companion/in-app.js";
import { CompanionController } from "../dist/companion/controller.js";
import { inMemoryVoicePrefs } from "../dist/companion/voice-prefs.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };
const inAppBinding = (sessionId) => ({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });

function makeTranscriber({ ready = true, result = "hello from the web mic" } = {}) {
  const calls = [];
  return {
    calls,
    transcriber: {
      isReady() { return ready; },
      async transcribe(input) { calls.push(input); return typeof result === "function" ? result(input) : result; },
    },
  };
}

// A minimal fake db surface satisfying controller.ts's recordInboundMessageSafely +
// listEnabledCompanionReminders (rearmReminders' existence check) — records every insertCompanionMessage call.
function makeDb() {
  const inserted = [];
  return {
    inserted,
    listEnabledCompanionReminders: () => [],
    insertCompanionMessage(row) { inserted.push(row); },
  };
}

try {
  // ================= 1 — decodeInAppAudioToTempFile: valid, oversize, malformed =================
  {
    const bytes = Buffer.from("fake webm/opus bytes — not real audio, just a payload to round-trip", "utf-8");
    const b64 = bytes.toString("base64");
    const decoded = decodeInAppAudioToTempFile(b64, "audio/webm;codecs=opus");
    check("1: decode succeeds and returns a filePath + cleanup", decoded !== null && typeof decoded.filePath === "string" && typeof decoded.cleanup === "function");
    check("1: the temp file's extension reflects the mimeType", decoded.filePath.endsWith(".webm"));
    check("1: the temp file's bytes EXACTLY match the decoded payload", fs.readFileSync(decoded.filePath).equals(bytes));
    await decoded.cleanup();
    check("1: cleanup() removed the temp file", !fs.existsSync(decoded.filePath));
    // A second cleanup() call (mirrors the outer WS-route belt-and-suspenders unlink) is a harmless no-op.
    await decoded.cleanup();

    check("1: empty string → null", decodeInAppAudioToTempFile("", "audio/ogg") === null);
    check("1: non-string base64 → null", decodeInAppAudioToTempFile(undefined, "audio/ogg") === null);
    check("1: non-string mimeType still decodes (defensive default, not a required field)", decodeInAppAudioToTempFile(b64, undefined) !== null);

    // Oversize: a base64 string long enough to decode past IN_APP_AUDIO_MAX_BYTES is rejected BEFORE decode.
    const oversizeB64 = "A".repeat(Math.ceil((IN_APP_AUDIO_MAX_BYTES * 4) / 3) + 100);
    check("1: an oversize payload is rejected (never materialized)", decodeInAppAudioToTempFile(oversizeB64, "audio/webm") === null);
  }

  // ================= 2 — InAppChannel.adapter.downloadAttachment: local pass-through, no network =========
  {
    const inApp = new InAppChannel();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-voice-web-"));
    const filePath = path.join(dir, `${randomUUID()}.webm`);
    fs.writeFileSync(filePath, "already-local-bytes");

    const got = await inApp.adapter.downloadAttachment({ type: "audio", fileId: filePath });
    check("2: downloadAttachment hands back the EXACT path given (no network, no rewrite)", got !== null && got.filePath === filePath);
    await got.cleanup();
    check("2: cleanup() removed the file", !fs.existsSync(filePath));

    const missing = await inApp.adapter.downloadAttachment({ type: "audio" }); // no fileId
    check("2: no fileId → null (never a network call, never a client-supplied path)", missing === null);
  }

  // ================= 3 — controller.handleInAppAudioInbound: transcribe → record → mirror → live echo ====
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-voice-web-"));
    const audioPath = path.join(dir, "clip.webm");
    fs.writeFileSync(audioPath, "clip bytes");

    const inApp = new InAppChannel();
    const submitted = [];
    const submitSpy = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const tr = makeTranscriber({ result: "transcribed from the mic" });
    const db = makeDb();

    const buildGateway = (_cfg, submit) => {
      const gw = new ChatGateway(submit, [inAppBinding("sess-A")], undefined, undefined, undefined, inMemoryVoicePrefs(), tr.transcriber);
      gw.registerAdapter(inApp.adapter);
      return gw;
    };
    const cfg = { botToken: null, allowedChatId: "sess-A", sessionId: "sess-A", chatScope: "dm", homeChannel: IN_APP_CHANNEL, homeChatId: "sess-A", heartbeatIntervalMinutes: 0, heartbeatPrompt: "p" };
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: submitSpy, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, inApp, buildGateway, resolveEffective: () => [cfg],
    });
    await controller.reconcile();

    const { frames, client } = makeClient();
    inApp.attach("sess-A", client);

    const result = await controller.handleInAppAudioInbound("sess-A", audioPath);
    check("3: accepted, submittedText carries the TRANSCRIPT (not empty audio)", result.accepted === true && result.submittedText === "transcribed from the mic");
    check("3: the turn was submitted with the transcript text", submitted.length === 1 && submitted[0].sid === "sess-A" && submitted[0].text === "transcribed from the mic");
    check("3: the transcript was RECORDED as the user message", db.inserted.length === 1 && db.inserted[0].author === "user" && db.inserted[0].text === "transcribed from the mic");
    check("3: the recorded row is tagged viaVoice:true (unified cross-channel chat, card 7d63e200 — matches Telegram's own voice-note tagging so the web panel's mic indicator renders for BOTH channels)", db.inserted[0].viaVoice === true);
    check("3: a LIVE { type:'transcript' } echo was pushed to the sender's own client", frames.length === 1 && frames[0].type === "transcript" && frames[0].text === "transcribed from the mic" && frames[0].chatId === "sess-A");
    check("3: the transcript echo is DISTINCT from a companion reply frame (never type:'chat')", frames[0].type !== "chat");
  }

  // ================= 4 — byte-identical when off: no transcribe dep injected ==============================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-voice-web-"));
    const audioPath = path.join(dir, "clip.webm");
    fs.writeFileSync(audioPath, "clip bytes");

    const inApp = new InAppChannel();
    const submitted = [];
    const db = makeDb();
    const buildGateway = (_cfg, submit) => {
      const gw = new ChatGateway(submit, [inAppBinding("sess-B")]); // NO transcribe injected
      gw.registerAdapter(inApp.adapter);
      return gw;
    };
    const cfg = { botToken: null, allowedChatId: "sess-B", sessionId: "sess-B", chatScope: "dm", homeChannel: IN_APP_CHANNEL, homeChatId: "sess-B", heartbeatIntervalMinutes: 0, heartbeatPrompt: "p" };
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; },
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, inApp, buildGateway, resolveEffective: () => [cfg],
    });
    await controller.reconcile();
    const { frames, client } = makeClient();
    inApp.attach("sess-B", client);

    const result = await controller.handleInAppAudioInbound("sess-B", audioPath);
    check("4: with no transcribe dep, audio inbound is silently ignored (no-text)", result.accepted === false && result.reason === "no-text");
    check("4: nothing submitted, nothing recorded, nothing pushed", submitted.length === 0 && db.inserted.length === 0 && frames.length === 0);
  }

  // ================= 4b — graceful degrade: STT dep injected but NOT READY (cold venv) ====================
  // Distinct from case 4 (no dep at all): here the transcriber EXISTS but isReady()===false, so the EXISTING
  // (untouched) STT-unavailable ack path fires — the same "🎙️ ... try again" friendly ack VOICE-P2 already
  // proved for Telegram, reused unchanged for in-app via adapter.send (recorded + framed as a companion
  // reply the sender's own client sees), never a silent vanish and never a broken UI.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-voice-web-"));
    const audioPath = path.join(dir, "clip.webm");
    fs.writeFileSync(audioPath, "clip bytes");

    const inApp = new InAppChannel();
    const submitted = [];
    const db = makeDb();
    const tr = makeTranscriber({ ready: false });
    const buildGateway = (_cfg, submit) => {
      const gw = new ChatGateway(submit, [inAppBinding("sess-C")], undefined, undefined, undefined, inMemoryVoicePrefs(), tr.transcriber);
      gw.registerAdapter(inApp.adapter);
      return gw;
    };
    const cfg = { botToken: null, allowedChatId: "sess-C", sessionId: "sess-C", chatScope: "dm", homeChannel: IN_APP_CHANNEL, homeChatId: "sess-C", heartbeatIntervalMinutes: 0, heartbeatPrompt: "p" };
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; },
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, inApp, buildGateway, resolveEffective: () => [cfg],
    });
    await controller.reconcile();
    const { frames, client } = makeClient();
    inApp.attach("sess-C", client);

    const result = await controller.handleInAppAudioInbound("sess-C", audioPath);
    check("4b: not-ready STT degrades to 'transcribe-unavailable', not a crash", result.accepted === false && result.reason === "transcribe-unavailable");
    check("4b: nothing submitted, nothing recorded as a user message", submitted.length === 0 && db.inserted.length === 0);
    check("4b: the friendly ack reached the sender's own client as a normal companion reply frame (never a broken/blank UI)", frames.length === 1 && frames[0].type === "chat" && frames[0].text.includes("Voice transcription"));
    check("4b: transcribe() itself was NEVER called (isReady() gates it, exactly like Telegram's VOICE-P2 path)", tr.calls.length === 0);
  }
} catch (err) {
  console.error(err);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — VOICE-P4 inbound: web-mic audio decodes to a server-generated temp file (never a client-supplied path) and transcribes through the SAME STT pipeline VOICE-P2 proved, recording the transcript (not empty audio) and live-echoing it back to the sender distinctly from a companion reply."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
