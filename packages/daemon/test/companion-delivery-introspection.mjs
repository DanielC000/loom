import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Delivery Introspection (owner-directed, 2026-07-12): give the Companion read access to its OWN
// channel binding + last-delivery record, so it can answer "send the transcript of your last voice message"
// or "what did you just send, and where" from real state instead of re-guessing/re-pasting. Fully hermetic —
// isolated temp DB + fake ChatGateway/InAppChannel collaborators, NO daemon, NO real claude, NO pty/network.
// Covers:
//   (A) my_context (assistant role) folds in `companion: {bindings, lastDelivery}`:
//        - bindings lists every channel the session is bound on, with its EFFECTIVE voiceReplies mode
//          (resolved senderId:null — the SAME key ChatGateway.tryDeliverVoice itself resolves outbound with)
//        - lastDelivery is the MOST RECENT companion-authored reply across every channel — text, channel,
//          viaVoice, sentAt — null when the companion has never sent one
//        - a manager/worker session's my_context carries NO `companion` key at all (role-gated)
//        - a fresh companion (no bindings, no history) resolves to {bindings:[], lastDelivery:null}, never throws
//   (B) the root-cause fix: ChatGateway.deliverReply's outbound record now tags the ACTUAL viaVoice — false
//       for a plain text send, true for a genuinely voice-delivered reply (previously ALWAYS false, so a
//       voiced TTS reply was indistinguishable from text in companion_messages/my_context)
//   (C) the same fix on the in-app channel's own self-recording path (in-app.ts's sendVoice / InAppChannel)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-companion-introspect-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { inMemoryVoicePrefs } = await import("../dist/companion/voice-prefs.js");
const { InAppChannel } = await import("../dist/companion/in-app.js");

// ============================ (A) my_context companion introspection ============================
{
  const file = tmpDbFile("myctx");
  const db = new Db(file);
  const now = new Date().toISOString();

  db.insertProject({ id: "p1", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "a1", projectId: "p1", name: "companion", startupPrompt: "x", position: 0 });

  const mkSession = (id, role) => db.insertSession({
    id, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role,
  });
  mkSession("companionA", "assistant");
  mkSession("mgr1", "manager");
  mkSession("empty-companion", "assistant");

  // Two bindings for companionA: in-app (no pref set → defaults "off") + telegram (voiceReplies "on").
  db.upsertCompanionBinding({ sessionId: "companionA", channel: "in-app", chatId: "companionA", scope: "dm" });
  db.upsertCompanionBinding({ sessionId: "companionA", channel: "telegram", chatId: "555", scope: "dm" });
  db.upsertCompanionVoicePref({ sessionId: "companionA", channel: "telegram", chatId: "555", senderId: null, voiceReplies: "on" });

  // History: an inbound user turn, an EARLIER outbound text reply, then the LATEST outbound reply — voiced.
  db.insertCompanionMessage({ id: "m1", sessionId: "companionA", channel: "telegram", chatId: "555", author: "user", text: "hi", createdAt: "2026-07-12T10:00:00.000Z" });
  db.insertCompanionMessage({ id: "m2", sessionId: "companionA", channel: "telegram", chatId: "555", author: "companion", text: "hello (typed)", createdAt: "2026-07-12T10:00:01.000Z", viaVoice: false });
  db.insertCompanionMessage({ id: "m3", sessionId: "companionA", channel: "telegram", chatId: "555", author: "companion", text: "hello (spoken)", createdAt: "2026-07-12T10:00:02.000Z", viaVoice: true });

  const router = new OrchestrationMcpRouter(db, {});
  const ctx = (id) => router.myContext(id);

  {
    const c = ctx("companionA");
    check("(A) companion my_context carries a `companion` key", typeof c.companion === "object" && c.companion !== null);
    const bindings = c.companion.bindings;
    check("(A) bindings lists BOTH bound channels", Array.isArray(bindings) && bindings.length === 2);
    const byChannel = Object.fromEntries(bindings.map((b) => [b.channel, b]));
    check("(A) in-app binding present with default voiceReplies 'off' (no pref row set)",
      byChannel["in-app"]?.voiceReplies === "off");
    check("(A) telegram binding present with its SET voiceReplies 'on'",
      byChannel["telegram"]?.voiceReplies === "on");
    check("(A) lastDelivery is the MOST RECENT companion reply (m3, not the earlier m2 or the inbound m1)",
      c.companion.lastDelivery?.text === "hello (spoken)" && c.companion.lastDelivery?.channel === "telegram");
    check("(A) lastDelivery.viaVoice reflects the actual voice-delivered flag",
      c.companion.lastDelivery?.viaVoice === true);
    check("(A) lastDelivery.sentAt is the row's createdAt", c.companion.lastDelivery?.sentAt === "2026-07-12T10:00:02.000Z");
  }

  {
    const c = ctx("mgr1");
    check("(A) a MANAGER session's my_context has NO `companion` key (role-gated)", !("companion" in c));
  }

  {
    const c = ctx("empty-companion");
    check("(A) a fresh companion with no bindings/history → bindings:[] (never throws)",
      Array.isArray(c.companion?.bindings) && c.companion.bindings.length === 0);
    check("(A) a fresh companion with no history → lastDelivery:null", c.companion?.lastDelivery === null);
  }

  db.close();
  rmDb(file);
}

// ============ (B) ChatGateway.deliverReply tags the ACTUAL viaVoice on the recorded row ============
{
  const recorded = [];
  const fakeRecorder = { record: (sessionId, channel, chatId, author, text, viaVoice, id, proactive) => { recorded.push({ sessionId, channel, chatId, author, text, viaVoice, proactive }); } };
  const originResolver = (sid) => (sid === "sess-A" ? { channel: "telegram", chatId: "111" } : null);
  const noopSubmit = () => ({ delivered: true });
  const tgAdapter = { name: "telegram", maxMessageLength: 4096, start() {}, async stop() {}, async send() {}, async sendVoice() {} };

  // TEXT reply (no synthesize dep at all — mirrors companion-voice-tts.mjs case 1) → recorded viaVoice:false.
  {
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, inMemoryVoicePrefs(), undefined, undefined, undefined, fakeRecorder);
    gw.registerAdapter(tgAdapter);
    await gw.deliverReply("sess-A", "typed reply");
    const row = recorded.find((r) => r.text === "typed reply");
    check("(B) a plain TEXT reply is recorded with viaVoice:false", row?.viaVoice === false);
  }

  // VOICE reply (synth ready + pref "on" + adapter has sendVoice) → recorded viaVoice:true, text unchanged.
  {
    recorded.length = 0;
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null }, "on");
    const synth = { isReady: () => true, synthesize: async () => ({ filePath: "/tmp/reply.ogg", cleanup: async () => {} }) };
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, originResolver, prefs, undefined, synth, undefined, fakeRecorder);
    gw.registerAdapter(tgAdapter);
    await gw.deliverReply("sess-A", "spoken reply");
    const row = recorded.find((r) => r.text === "spoken reply");
    check("(B) a genuinely VOICE-delivered reply is recorded with viaVoice:true (previously always false)",
      row?.viaVoice === true);
    check("(B) the recorded text IS the synthesized clip's transcript (TTS speaks exactly this text)",
      row?.text === "spoken reply");
  }
}

// ============ (C) the in-app channel's own self-recording path tags viaVoice too ============
{
  const recorded = [];
  const inApp = new InAppChannel({
    record: (sessionId, author, text, proactive, viaVoice) => { recorded.push({ sessionId, author, text, proactive, viaVoice }); },
  });
  const audioFile = path.join(os.tmpdir(), `loom-inapp-voice-${Date.now()}.ogg`);
  fs.writeFileSync(audioFile, Buffer.from([0, 1, 2, 3]));
  try {
    await inApp.adapter.send("sessX", "typed in-app reply");
    const textRow = recorded.find((r) => r.text === "typed in-app reply");
    check("(C) in-app plain `send` records viaVoice:false", textRow?.viaVoice === false);

    await inApp.adapter.sendVoice("sessX", audioFile, "spoken in-app reply");
    const voiceRow = recorded.find((r) => r.text === "spoken in-app reply");
    check("(C) in-app `sendVoice` records viaVoice:true (previously omitted entirely — always falsy)",
      voiceRow?.viaVoice === true);
  } finally {
    fs.rmSync(audioFile, { force: true });
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Companion can introspect its own channel binding(s) + effective voice mode and its LAST delivered reply (channel/text/viaVoice) via my_context; outbound voice replies are now correctly tagged viaVoice:true on BOTH the generic (Telegram) and in-app recording paths, so `text` reliably doubles as the synthesized clip's transcript."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
