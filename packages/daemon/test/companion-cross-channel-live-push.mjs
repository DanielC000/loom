import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — LIVE-PUSH a NON-in-app channel turn into an ALREADY-OPEN web chat (closes the gap left
// by the unified cross-channel chat, card 7d63e200: that card recorded Telegram turns into companion_
// messages and rendered them on SEED/reload, but an open panel never saw one appear live). Fully hermetic:
// a temp LOOM_HOME + a REAL Db + a REAL ChatGateway + the REAL createCompanionGateway/InAppChannel wiring —
// NO network, NO real grammY Bot (a hand-built fake ChannelAdapter stands in, same seam as
// companion-cross-channel-messages.mjs), NO real claude, NO daemon. Proves the card DoD:
//   (a) a recorded Telegram INBOUND and a recorded Telegram OUTBOUND each push the expected LIVE
//       {type:"cross-channel"} frame (channel/author/text/viaVoice) to a CONNECTED in-app client, carrying
//       the SAME id the row was persisted under (the dedup identity).
//   (b) an IN-APP message does NOT trigger the cross-channel push (no double-render — that channel already
//       renders live via its own dedicated {type:"chat"}/{type:"transcript"} path).
//   (c) containment: a THROWING live-push never breaks the record/inbound/reply path it mirrors.
// Run: 1) build (turbo builds shared first), 2) node test/companion-cross-channel-live-push.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-cross-channel-live-push-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { TELEGRAM_CHANNEL } = await import("../dist/companion/telegram.js");
const { createCompanionGateway } = await import("../dist/companion/factory.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

// A minimal real project/agent/session so companion_messages' FK (session_id REFERENCES sessions(id)) is
// satisfiable — mirrors companion-cross-channel-messages.mjs's seeding.
const now0 = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Cross-Channel Live Push", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
const makeCompanionSession = () => {
  const agentId = randomUUID();
  db.insertAgent({ id: agentId, projectId: projId, name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
  const sessId = randomUUID();
  db.insertSession({
    id: sessId, projectId: projId, agentId, engineSessionId: `eng-${sessId}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now0, lastActivity: now0, lastError: null, role: "assistant",
  });
  return sessId;
};

// A fake WEB CLIENT — the InAppClient seam the WS route wraps around a real socket (mirrors
// companion-in-app.mjs's makeClient). Records every frame pushed to it.
const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };

// A hand-built fake Telegram-shaped ChannelAdapter (no grammY, no network) — same seam
// companion-cross-channel-messages.mjs / companion-telegram.mjs use.
function makeFakeTelegramAdapter() {
  const sent = [];
  return {
    sent,
    adapter: {
      name: TELEGRAM_CHANNEL,
      maxMessageLength: 4096,
      start() {},
      async stop() {},
      async send(chatId, text) { sent.push({ chatId, text }); },
      async downloadAttachment() { return { filePath: "/fake/voice-note.ogg", cleanup: async () => {} }; },
    },
  };
}

try {
  // ============ (a) Telegram INBOUND + OUTBOUND each push the expected LIVE frame, same id as the row =====
  {
    const sessTg = makeCompanionSession();
    const tgBinding = { sessionId: sessTg, channel: TELEGRAM_CHANNEL, chatId: "999", scope: "dm" };
    const inApp = new InAppChannel();
    const { client, frames } = makeClient();
    inApp.attach(sessTg, client);

    const cfg = {
      botToken: "fake-token", allowedChatId: "999", sessionId: sessTg, chatScope: "dm",
      homeChannel: TELEGRAM_CHANNEL, homeChatId: "999", heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
    };
    db.upsertCompanionBinding(tgBinding);
    const gw = createCompanionGateway(cfg, () => ({ delivered: true }), db, inApp, (sid) => (sid === sessTg ? { channel: TELEGRAM_CHANNEL, chatId: "999" } : null));
    const { adapter, sent } = makeFakeTelegramAdapter();
    // Swap in the fake adapter so no real grammY/network is involved for the send path (registerAdapter
    // upserts by name — TELEGRAM_CHANNEL — replacing the one createCompanionGateway registered for cfg.botToken).
    gw.registerAdapter(adapter);

    const inboundResult = await gw.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "999", body: "hello from my phone" });
    check("(a) telegram inbound: accepted", inboundResult.accepted === true);

    const rows = db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL);
    check("(a) telegram inbound: recorded exactly once", rows.length === 1 && rows[0].author === "user" && rows[0].text === "hello from my phone");

    check("(a) telegram inbound: exactly one live frame pushed to the connected client", frames.length === 1);
    const inboundFrame = frames[0];
    check(
      "(a) telegram inbound: the live frame is {type:cross-channel} with the expected channel/author/text/viaVoice AND the persisted row's own id",
      inboundFrame.type === "cross-channel" && inboundFrame.chatId === sessTg && inboundFrame.channel === TELEGRAM_CHANNEL &&
        inboundFrame.author === "user" && inboundFrame.text === "hello from my phone" && inboundFrame.viaVoice === false &&
        inboundFrame.id === rows[0].id,
    );

    const deliverResult = await gw.deliverReply(sessTg, "hi from your companion");
    check("(a) telegram outbound: delivered", deliverResult.delivered === true && sent.length === 1);

    const rowsAfter = db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL);
    const outboundRow = rowsAfter.find((r) => r.author === "companion");
    check("(a) telegram outbound: recorded exactly once, author:companion", rowsAfter.length === 2 && !!outboundRow);

    check("(a) telegram outbound: a SECOND live frame pushed (the reply)", frames.length === 2);
    const outboundFrame = frames[1];
    check(
      "(a) telegram outbound: the live frame is {type:cross-channel} author:companion, viaVoice:false, same id as the persisted row",
      outboundFrame.type === "cross-channel" && outboundFrame.channel === TELEGRAM_CHANNEL && outboundFrame.author === "companion" &&
        outboundFrame.text === "hi from your companion" && outboundFrame.viaVoice === false && outboundFrame.id === outboundRow.id,
    );

    // A Telegram VOICE-NOTE inbound (viaVoice:true) also carries viaVoice through to the live frame.
    const fakeTranscriber = { isReady: () => true, transcribe: async () => "a voice note transcript" };
    const gwVoice = createCompanionGateway(
      { ...cfg }, () => ({ delivered: true }), db, inApp, undefined, fakeTranscriber,
    );
    gwVoice.registerAdapter(makeFakeTelegramAdapter().adapter);
    const voiceResult = await gwVoice.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "999", body: "", attachments: [{ type: "audio", fileId: "tg-file-id" }] });
    check("(a) telegram voice inbound: accepted, submittedText is the transcript", voiceResult.accepted === true && voiceResult.submittedText === "a voice note transcript");
    const voiceFrame = frames[frames.length - 1];
    check(
      "(a) telegram voice inbound: the live frame carries viaVoice:true and the transcript text",
      voiceFrame.type === "cross-channel" && voiceFrame.viaVoice === true && voiceFrame.text === "a voice note transcript",
    );
  }

  // ============ (b) An IN-APP message does NOT trigger the cross-channel push (no double-render) =========
  {
    const sessInApp = makeCompanionSession();
    const inAppBinding = { sessionId: sessInApp, channel: IN_APP_CHANNEL, chatId: sessInApp, scope: "dm" };
    db.upsertCompanionBinding(inAppBinding);
    const inApp = new InAppChannel();
    const { client, frames } = makeClient();
    inApp.attach(sessInApp, client);

    const cfg = {
      botToken: null, allowedChatId: "", sessionId: sessInApp, chatScope: "dm",
      homeChannel: IN_APP_CHANNEL, homeChatId: sessInApp, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
    };
    const gw = createCompanionGateway(cfg, () => ({ delivered: true }), db, inApp);

    const r = await gw.handleInbound({ channel: IN_APP_CHANNEL, chatId: sessInApp, body: "typed in the web panel" });
    check("(b) in-app inbound: still accepted (routing unaffected)", r.accepted === true);
    check(
      "(b) in-app inbound: NO {type:cross-channel} frame pushed (in-app already renders live via its own {type:chat}/{type:transcript} path)",
      frames.every((f) => f.type !== "cross-channel"),
    );
    check("(b) in-app inbound: the generic recorder also skips in-app (0 companion_messages rows via this path)", db.listCompanionMessages(sessInApp, IN_APP_CHANNEL).length === 0);
  }

  // ============ (c) Containment: a THROWING live-push never breaks the record/inbound/reply path =========
  {
    const sessTg = makeCompanionSession();
    const tgBinding = { sessionId: sessTg, channel: TELEGRAM_CHANNEL, chatId: "888", scope: "dm" };
    const { adapter, sent } = makeFakeTelegramAdapter();
    const throwingLivePush = { push() { throw new Error("hub is down"); } };
    const gw = new ChatGateway(
      () => ({ delivered: true }), [tgBinding], undefined, undefined,
      (sid) => (sid === sessTg ? { channel: TELEGRAM_CHANNEL, chatId: "888" } : null),
      undefined, undefined, undefined, undefined,
      { record(sessionId, channel, chatId, author, text, viaVoice, id) { db.insertCompanionMessage({ id: id ?? randomUUID(), sessionId, channel, chatId, author, text, createdAt: new Date().toISOString(), viaVoice }); } },
      undefined, throwingLivePush,
    );
    gw.registerAdapter(adapter);

    let threwInbound = false;
    const r = await gw.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "888", body: "still works despite a dead hub" }).catch(() => { threwInbound = true; return null; });
    check("(c) containment: a THROWING live-push never breaks an accepted inbound", threwInbound === false && r?.accepted === true);
    check("(c) containment: the turn was still RECORDED despite the live-push throwing", db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL).some((m) => m.text === "still works despite a dead hub"));

    let threwReply = false;
    const d = await gw.deliverReply(sessTg, "still delivered despite a dead hub").catch(() => { threwReply = true; return null; });
    check("(c) containment: a THROWING live-push never breaks a delivered reply", threwReply === false && d?.delivered === true && sent.some((s) => s.text === "still delivered despite a dead hub"));
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a Telegram inbound/outbound (incl. a voiced inbound) now live-pushes a {type:cross-channel} frame to a connected in-app client under the SAME id the row was persisted under, an in-app turn never double-triggers this generic push, and a throwing live-push is fully contained."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
