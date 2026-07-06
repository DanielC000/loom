import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — UNIFIED CROSS-CHANNEL CHAT (card 7d63e200): Telegram inbound/outbound now records into
// `companion_messages` exactly like the in-app channel already did (bug 0f01f234), so the owner's Telegram
// conversation shows up in the web cockpit's unified stream. Fully hermetic: a temp LOOM_HOME + a REAL Db +
// a REAL ChatGateway + the REAL buildServer (app.inject) for the REST read. NO network, NO real grammY Bot
// (a hand-built fake ChannelAdapter stands in for Telegram — the SAME seam companion-telegram.mjs uses), NO
// real claude, NO daemon. Proves:
//   1. A Telegram TEXT inbound (accepted) records author:"user", channel:"telegram", viaVoice:false.
//   2. A Telegram VOICE-NOTE inbound (injected fake transcriber) records the STT TRANSCRIPT as `text`, with
//      viaVoice:true.
//   3. A Telegram outbound reply (deliverReply) records author:"companion", channel:"telegram" — recorded
//      ONCE even though the adapter's `send` is called under the hood; a VOICED outbound (tryDeliverVoice)
//      records too, exactly once, via the SAME hook.
//   4. The in-app channel is NEVER double-recorded through this generic gateway-level hook (it already
//      records via its own dedicated hooks in controller.ts/in-app.ts) — an in-app inbound routed through
//      the SAME gateway's handleInbound must insert ZERO companion_messages rows via this path.
//   5. GET /api/companion/messages/:sessionId returns BOTH channels' rows chronologically (the unified
//      cross-channel REST read).
//   6. Containment: a THROWING recorder never breaks an accepted inbound result or a delivered reply.
//   7. The in-app skip is proven against the REAL production wiring too (createCompanionGateway's actual
//      factory-built recorder), not just this file's own test-double recorder — locks the double-write
//      guard against a regression that a test-double-only assertion couldn't catch.
// Run: 1) build (turbo builds shared first), 2) node test/companion-cross-channel-messages.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-cross-channel-${Date.now()}-${process.pid}`);
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
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { TELEGRAM_CHANNEL } = await import("../dist/companion/telegram.js");
const { buildServer } = await import("../dist/gateway/server.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

// A minimal real project/agent/session so companion_messages' FK (session_id REFERENCES sessions(id)) is
// satisfiable — mirrors companion-messages.mjs's seeding.
const now0 = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Cross-Channel", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
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

// The SAME recorder shape companion/factory.ts builds — skips in-app (already recorded via its own
// dedicated hooks), else writes through to the real Db. `throwOnRecord` lets test 6 flip it to a throw.
let throwOnRecord = false;
function makeRecorder() {
  return {
    record(sessionId, channel, chatId, author, text, viaVoice) {
      if (throwOnRecord) throw new Error("db is down");
      if (channel === IN_APP_CHANNEL) return;
      db.insertCompanionMessage({ id: randomUUID(), sessionId, channel, chatId, author, text, createdAt: new Date().toISOString(), viaVoice });
    },
  };
}

// A hand-built fake Telegram-shaped ChannelAdapter (no grammY, no network) — the same seam
// companion-telegram.mjs uses for the adapter itself; here it stands in on the REGISTERED-adapter side of
// ChatGateway so handleInbound/deliverReply exercise the real routing + recording without a live bot.
function makeFakeTelegramAdapter() {
  const sent = [];
  const sentVoice = [];
  return {
    sent,
    sentVoice,
    adapter: {
      name: TELEGRAM_CHANNEL,
      maxMessageLength: 4096,
      start() {},
      async stop() {},
      async send(chatId, text) { sent.push({ chatId, text }); },
      async downloadAttachment() { return { filePath: "/fake/voice-note.ogg", cleanup: async () => {} }; },
      // Native voice-reply send (Companion Voice epic, VOICE-P3 outbound) — only exercised when a test
      // injects `synthesize` + a voiceReplies:true pref (test 3b); every other test's deliverReply never
      // reaches tryDeliverVoice at all (gated on `this.synthesize` being set), so this is inert elsewhere.
      async sendVoice(chatId, audioFilePath, text) { sentVoice.push({ chatId, audioFilePath, text }); },
    },
  };
}

const sessTg = makeCompanionSession();
const tgBinding = { sessionId: sessTg, channel: TELEGRAM_CHANNEL, chatId: "999", scope: "dm" };
const inAppBinding = { sessionId: sessTg, channel: IN_APP_CHANNEL, chatId: sessTg, scope: "dm" };
const fakeTranscriber = { isReady: () => true, transcribe: async () => "a voice note transcript" };

try {
  // ============ 1) Telegram TEXT inbound → recorded as author:user, channel:telegram ============
  {
    const { adapter } = makeFakeTelegramAdapter();
    const gw = new ChatGateway(
      () => ({ delivered: true }), [tgBinding, inAppBinding], undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, makeRecorder(),
    );
    gw.registerAdapter(adapter);

    const r = await gw.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "999", body: "hello from my phone" });
    check("telegram inbound: accepted", r.accepted === true && r.sessionId === sessTg);

    const rows = db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL);
    check("telegram inbound: recorded exactly once, tagged channel:telegram", rows.length === 1 && rows[0].channel === TELEGRAM_CHANNEL);
    check("telegram inbound: author:user, text is the typed body, viaVoice:false", rows[0].author === "user" && rows[0].text === "hello from my phone" && rows[0].viaVoice === false);
  }

  // ============ 2) Telegram VOICE-NOTE inbound → recorded with the STT TRANSCRIPT + viaVoice:true ========
  {
    const { adapter } = makeFakeTelegramAdapter();
    const gw = new ChatGateway(
      () => ({ delivered: true }), [tgBinding], undefined, undefined,
      undefined, undefined, fakeTranscriber, undefined, undefined, makeRecorder(),
    );
    gw.registerAdapter(adapter);

    const r = await gw.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "999", body: "", attachments: [{ type: "audio", fileId: "tg-file-id" }] });
    check("telegram voice inbound: accepted, submittedText is the transcript", r.accepted === true && r.submittedText === "a voice note transcript");

    const rows = db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL);
    const voiceRow = rows.find((m) => m.text === "a voice note transcript");
    check("telegram voice inbound: recorded the TRANSCRIPT text, tagged viaVoice:true", !!voiceRow && voiceRow.viaVoice === true && voiceRow.author === "user");
  }

  // ============ 3) Telegram OUTBOUND (deliverReply) → recorded as author:companion, ONCE ============
  {
    const { adapter, sent } = makeFakeTelegramAdapter();
    const gw = new ChatGateway(
      () => ({ delivered: true }), [tgBinding], undefined, undefined,
      (sid) => (sid === sessTg ? { channel: TELEGRAM_CHANNEL, chatId: "999" } : null),
      undefined, undefined, undefined, undefined, makeRecorder(),
    );
    gw.registerAdapter(adapter);

    const before = db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL).length;
    const d = await gw.deliverReply(sessTg, "hi from your companion");
    check("telegram outbound: delivered + actually sent via the adapter", d.delivered === true && sent.length === 1 && sent[0].text === "hi from your companion");

    const after = db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL);
    check("telegram outbound: recorded exactly once, author:companion", after.length === before + 1 && after[after.length - 1].author === "companion" && after[after.length - 1].text === "hi from your companion");
  }

  // ============ 3b) Telegram VOICED outbound (tryDeliverVoice success) → ALSO recorded, once ============
  {
    const { adapter, sentVoice } = makeFakeTelegramAdapter();
    const fakeSynthesize = { isReady: () => true, synthesize: async () => ({ filePath: "/fake/reply.ogg", cleanup: async () => {} }) };
    const voicedPrefs = { resolve: () => ({ sttLang: null, ttsLang: null, ttsVoice: null, voiceReplies: true }), setLang: (r) => r, setVoiceReplies: (r) => r };
    const gw = new ChatGateway(
      () => ({ delivered: true }), [tgBinding], undefined, undefined,
      (sid) => (sid === sessTg ? { channel: TELEGRAM_CHANNEL, chatId: "999" } : null),
      voicedPrefs, undefined, fakeSynthesize, undefined, makeRecorder(),
    );
    gw.registerAdapter(adapter);

    const before = db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL).length;
    const d = await gw.deliverReply(sessTg, "a voiced reply");
    check("telegram VOICED outbound: delivered as a native voice message (sendVoice, not send)", d.delivered === true && sentVoice.length === 1 && sentVoice[0].text === "a voiced reply");

    const after = db.listCompanionMessages(sessTg, TELEGRAM_CHANNEL);
    check("telegram VOICED outbound: recorded exactly once too, author:companion (tryDeliverVoice's success path records — not just the plain-text path)", after.length === before + 1 && after[after.length - 1].author === "companion" && after[after.length - 1].text === "a voiced reply");
  }

  // ============ 4) In-app is NEVER double-recorded through this generic gateway-level hook ============
  {
    const { adapter } = makeFakeTelegramAdapter();
    const gw = new ChatGateway(
      () => ({ delivered: true }), [tgBinding, inAppBinding], undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, makeRecorder(),
    );
    gw.registerAdapter(adapter);

    const before = db.listCompanionMessages(sessTg, IN_APP_CHANNEL).length;
    check("setup: no in-app rows recorded yet via this path", before === 0);
    const r = await gw.handleInbound({ channel: IN_APP_CHANNEL, chatId: sessTg, body: "typed in the web panel" });
    check("in-app inbound via the generic gateway hook: still accepted (routing unaffected)", r.accepted === true);
    check("in-app inbound: the generic recorder SKIPS in-app (0 rows) — controller.ts's own dedicated hook is the only in-app writer", db.listCompanionMessages(sessTg, IN_APP_CHANNEL).length === 0);
  }

  // ============ 5) REST read returns BOTH channels chronologically (unified cross-channel stream) ========
  {
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
    try {
      db.insertCompanionMessage({ id: randomUUID(), sessionId: sessTg, channel: IN_APP_CHANNEL, chatId: sessTg, author: "user", text: "typed in the web panel too", createdAt: "2026-07-06T09:00:00.000Z" });
      const res = await app.inject({ method: "GET", url: `/api/companion/messages/${sessTg}` });
      const body = JSON.parse(res.payload);
      check("REST GET: 200", res.statusCode === 200);
      check("REST GET: includes BOTH the telegram rows and the in-app row for this session", body.messages.some((m) => m.channel === TELEGRAM_CHANNEL) && body.messages.some((m) => m.channel === IN_APP_CHANNEL));
      const times = body.messages.map((m) => m.createdAt);
      const sorted = [...times].sort();
      check("REST GET: chronological order across channels", JSON.stringify(times) === JSON.stringify(sorted));
    } finally {
      await app.close();
    }
  }

  // ============ 6) Containment: a THROWING recorder never breaks the inbound/reply path it mirrors ========
  {
    const { adapter, sent } = makeFakeTelegramAdapter();
    const gw = new ChatGateway(
      () => ({ delivered: true }), [tgBinding], undefined, undefined,
      (sid) => (sid === sessTg ? { channel: TELEGRAM_CHANNEL, chatId: "999" } : null),
      undefined, undefined, undefined, undefined, makeRecorder(),
    );
    gw.registerAdapter(adapter);

    throwOnRecord = true;
    let threwInbound = false;
    const r = await gw.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "999", body: "history db is down" }).catch(() => { threwInbound = true; return null; });
    check("containment: a THROWING recorder never breaks an accepted inbound", threwInbound === false && r?.accepted === true);

    let threwReply = false;
    const d = await gw.deliverReply(sessTg, "still delivered despite a throwing recorder").catch(() => { threwReply = true; return null; });
    check("containment: a THROWING recorder never breaks a delivered reply", threwReply === false && d?.delivered === true && sent.some((s) => s.text === "still delivered despite a throwing recorder"));
    throwOnRecord = false;
  }

  // ============ 7) The REAL factory-built recorder (createCompanionGateway) also skips in-app ============
  // Tests 1-6 above reimplement the in-app skip in this file's OWN makeRecorder — they'd stay green even if
  // the REAL guard in companion/factory.ts (the `record()` that returns early on IN_APP_CHANNEL) broke and
  // started double-writing every in-app message. This exercises the ACTUAL production wiring end to end:
  // the real createCompanionGateway, a real InAppChannel, and no botToken (in-app-only companion, so no
  // Telegram adapter/network is involved at all) — proving the production guard itself, not a test double.
  {
    const { createCompanionGateway } = await import("../dist/companion/factory.js");
    const { InAppChannel } = await import("../dist/companion/in-app.js");
    const sessReal = makeCompanionSession();
    db.upsertCompanionBinding({ sessionId: sessReal, channel: IN_APP_CHANNEL, chatId: sessReal, scope: "dm" });
    const cfg = {
      botToken: null, allowedChatId: "", sessionId: sessReal, chatScope: "dm",
      homeChannel: IN_APP_CHANNEL, homeChatId: sessReal, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
    };
    // No recorder injected into InAppChannel here — irrelevant to this assertion (that's the SEPARATE
    // in-app-specific outbound hook index.ts wires; this test is only about the GENERIC gateway-level one).
    const gw = createCompanionGateway(cfg, () => ({ delivered: true }), db, new InAppChannel());

    const before = db.listCompanionMessages(sessReal, IN_APP_CHANNEL).length;
    const r = await gw.handleInbound({ channel: IN_APP_CHANNEL, chatId: sessReal, body: "typed via the REAL factory-built gateway" });
    check("REAL factory guard: an in-app inbound through the production-wired gateway is still accepted", r.accepted === true);
    check(
      "REAL factory guard: ...but inserts ZERO companion_messages rows — factory.ts's ACTUAL recorder skips in-app, not just this test's stand-in",
      db.listCompanionMessages(sessReal, IN_APP_CHANNEL).length === before,
    );
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Telegram inbound/outbound (incl. a voiced reply) now record into companion_messages (tagged channel:telegram, voice notes tagged viaVoice:true with their transcript as text), the in-app channel is never double-recorded through this generic hook — proven against BOTH a test-double recorder and the REAL factory-built one — the unified REST read returns every channel chronologically, and a throwing recorder is fully contained."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
