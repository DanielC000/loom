import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — proactive event-line PRODUCER (card beb61d23): correlates a turn's proactive origin
// (a heartbeat/reminder/attention-push submit) with its outbound `chat_reply` and tags BOTH the outbound
// in-app frame and the persisted companion_messages row — so the web chat's already-shipped
// ChatMessage.proactive render path (buildTimeline's amber event line) actually lights up.
//
// Fully hermetic: a temp LOOM_HOME + a REAL Db + the REAL ChatGateway/createCompanionGateway/InAppChannel
// wiring (mirrors companion-cross-channel-live-push.mjs's harness) — NO network, NO real grammY Bot, NO real
// claude, NO daemon. The `proactiveResolver` is injected directly (the same seam `originResolver` already
// uses in every companion test) rather than driving a real PtyHost turn — pty/host.ts's OWN correlation
// (enqueueStdin's `proactive` arg → submit() → getActiveTurnIsProactive) is covered separately by
// pty-proactive-turn.mjs. Proves the DoD:
//   (a) a proactive-origin in-app reply's live frame carries `proactive:true`, AND the persisted history row
//       is tagged too (so a panel reload / late-attach still shows the amber line).
//   (b) an ORDINARY (non-proactive) in-app reply carries NO `proactive` key at all — never mistagged.
//   (c) a proactive-origin Telegram (non-in-app) reply is ALSO tagged: the generic recorder's persisted row
//       AND the live cross-channel push to an attached in-app client both carry proactive:true.
//   (d) a proactive-origin VOICED in-app reply (sendVoice REPLACES send entirely on this channel) is ALSO
//       tagged: both the audio-bearing live frame and the self-recorded history row carry proactive:true.
// Run: 1) build (turbo builds shared first), 2) node test/companion-proactive-tagging.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-proactive-tagging-${Date.now()}-${process.pid}`);
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
const { inMemoryVoicePrefs } = await import("../dist/companion/voice-prefs.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

// A minimal real project/agent/session so companion_messages' FK (session_id REFERENCES sessions(id)) is
// satisfiable — mirrors companion-cross-channel-live-push.mjs's seeding.
const now0 = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Proactive Tagging", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
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

// A fake WEB CLIENT — the InAppClient seam the WS route wraps around a real socket.
const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };

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
    },
  };
}

try {
  // ============ (a) A proactive-origin in-app reply: live frame + persisted row both tagged ==============
  {
    const sess = makeCompanionSession();
    const binding = { sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, scope: "dm" };
    db.upsertCompanionBinding(binding);
    const inApp = new InAppChannel({
      record: (sessionId, author, text, proactive) => {
        db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author, text, createdAt: new Date().toISOString(), proactive });
      },
    });
    const { client, frames } = makeClient();
    inApp.attach(sess, client);

    const cfg = { botToken: null, allowedChatId: "", sessionId: sess, chatScope: "dm", homeChannel: IN_APP_CHANNEL, homeChatId: sess, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p" };
    // originResolver + proactiveResolver mirror the daemon's real injection (index.ts: pty.getActiveTurnOrigin
    // / pty.getActiveTurnIsProactive) — this IS the turn a heartbeat/reminder/attention-push watcher formed.
    const gw = createCompanionGateway(
      cfg, () => ({ delivered: true }), db, inApp,
      (sid) => (sid === sess ? { channel: IN_APP_CHANNEL, chatId: sess } : null),
      undefined, undefined, undefined,
      (sid) => sid === sess, // proactiveResolver: true for this session's in-flight turn
    );

    const result = await gw.deliverReply(sess, "your heartbeat check-in: nothing urgent");
    check("(a) delivered", result.delivered === true);
    check("(a) exactly one live frame pushed", frames.length === 1);
    check("(a) the live {type:chat} frame carries proactive:true", frames[0].type === "chat" && frames[0].proactive === true);

    const rows = db.listCompanionMessages(sess, IN_APP_CHANNEL);
    check("(a) recorded exactly once, author:companion, proactive:true", rows.length === 1 && rows[0].author === "companion" && rows[0].proactive === true);
  }

  // ============ (b) An ORDINARY in-app reply carries NO proactive key at all — never mistagged ============
  {
    const sess = makeCompanionSession();
    const binding = { sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, scope: "dm" };
    db.upsertCompanionBinding(binding);
    const inApp = new InAppChannel({
      record: (sessionId, author, text, proactive) => {
        db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author, text, createdAt: new Date().toISOString(), proactive });
      },
    });
    const { client, frames } = makeClient();
    inApp.attach(sess, client);

    const cfg = { botToken: null, allowedChatId: "", sessionId: sess, chatScope: "dm", homeChannel: IN_APP_CHANNEL, homeChatId: sess, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p" };
    // NO proactiveResolver injected at all (mirrors a plain user-driven chat_reply) — the untagged default.
    const gw = createCompanionGateway(
      cfg, () => ({ delivered: true }), db, inApp,
      (sid) => (sid === sess ? { channel: IN_APP_CHANNEL, chatId: sess } : null),
    );

    const result = await gw.deliverReply(sess, "sure, I can help with that");
    check("(b) delivered", result.delivered === true);
    check("(b) the live {type:chat} frame carries NO proactive key at all (never proactive:false)", frames.length === 1 && !("proactive" in frames[0]));

    const rows = db.listCompanionMessages(sess, IN_APP_CHANNEL);
    check("(b) recorded, proactive:false (an ordinary reply is never mistagged)", rows.length === 1 && rows[0].proactive === false);
  }

  // ============ (c) A proactive-origin Telegram reply: generic record + cross-channel live push tagged =====
  {
    const sess = makeCompanionSession();
    const tgBinding = { sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "777", scope: "dm" };
    db.upsertCompanionBinding(tgBinding);
    const inApp = new InAppChannel(); // no in-app binding for this session — only the cross-channel live push matters here
    const { client, frames } = makeClient();
    inApp.attach(sess, client); // an open cockpit panel, even though this companion's OWN channel is Telegram

    const cfg = { botToken: "fake-token", allowedChatId: "777", sessionId: sess, chatScope: "dm", homeChannel: TELEGRAM_CHANNEL, homeChatId: "777", heartbeatIntervalMinutes: 0, heartbeatPrompt: "p" };
    const gw = createCompanionGateway(
      cfg, () => ({ delivered: true }), db, inApp,
      (sid) => (sid === sess ? { channel: TELEGRAM_CHANNEL, chatId: "777" } : null),
      undefined, undefined, undefined,
      (sid) => sid === sess, // proactiveResolver: this WAS a reminder-originated turn
    );
    const { adapter, sent } = makeFakeTelegramAdapter();
    gw.registerAdapter(adapter);

    const result = await gw.deliverReply(sess, "your daily reminder fired — nothing else needed");
    check("(c) delivered to Telegram", result.delivered === true && sent.length === 1);

    const rows = db.listCompanionMessages(sess, TELEGRAM_CHANNEL);
    check("(c) the generic recorder tagged the persisted row proactive:true", rows.length === 1 && rows[0].author === "companion" && rows[0].proactive === true);

    check("(c) a {type:cross-channel} live frame was pushed to the attached in-app client, tagged proactive:true", frames.length === 1 && frames[0].type === "cross-channel" && frames[0].proactive === true);
  }

  // ============ (d) A proactive-origin VOICED in-app reply: sendVoice REPLACES send on this channel, so
  // its OWN self-record + audio-bearing frame must both carry proactive:true (CR-caught gap: sendVoice
  // didn't thread it through at all until this fix). ================================================
  {
    const sess = makeCompanionSession();
    db.upsertCompanionBinding({ sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, scope: "dm" });
    const inApp = new InAppChannel({
      record: (sessionId, author, text, proactive) => {
        db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author, text, createdAt: new Date().toISOString(), proactive });
      },
    });
    const { client, frames } = makeClient();
    inApp.attach(sess, client);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-proactive-voice-"));
    const audioPath = path.join(dir, "reply.ogg");
    const audioBytes = Buffer.from("fake ogg/opus reply bytes");
    fs.writeFileSync(audioPath, audioBytes);
    const synth = { isReady: () => true, synthesize: async () => ({ filePath: audioPath, cleanup: async () => {} }) };
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, senderId: null }, "on");

    const gw = new ChatGateway(
      () => ({ delivered: true }), [{ sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, scope: "dm" }],
      undefined, undefined,
      (sid) => (sid === sess ? { channel: IN_APP_CHANNEL, chatId: sess } : null), // originResolver
      prefs, undefined, synth, // voicePrefs, transcribe, synthesize
      undefined, undefined, undefined, undefined, undefined, // historyReset, recorder, reinjectPersona, livePush, historyExport
      (sid) => sid === sess, // proactiveResolver: this WAS an attention-push-originated turn
    );
    gw.registerAdapter(inApp.adapter);

    const result = await gw.deliverReply(sess, "your alert digest, voiced");
    check("(d) delivered via voice (sendVoice, not the plain text send)", result.delivered === true && result.chunks === 1);
    check("(d) the live audio-bearing frame carries proactive:true", frames.length === 1 && frames[0].type === "chat" && frames[0].audio !== undefined && frames[0].proactive === true);

    const rows = db.listCompanionMessages(sess, IN_APP_CHANNEL);
    check("(d) sendVoice's OWN self-recorded row is tagged proactive:true too", rows.length === 1 && rows[0].author === "companion" && rows[0].proactive === true);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a proactive-origin reply's outbound frame + persisted history row are BOTH tagged proactive (in-app text AND voice, and — via the generic recorder + cross-channel live push — Telegram too), and an ordinary reply is never mistagged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
