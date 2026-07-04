import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — OUTBOUND MIRROR (card 92b6445c): a web-chat (in-app) user turn is echoed OUT to the
// session's OTHER bound channels (e.g. Telegram) with a "— via web chat" disclaimer, so the Telegram side
// stays in sync with what the owner typed in the cockpit. Fully hermetic: a REAL Db + a REAL ChatGateway
// wrapping FAKE channel adapters, driven through CompanionController.handleInAppInbound — NO live network,
// NO real claude, NO daemon. This is a SECURITY-sensitive addition to the companion routing surface (touches
// the "cross-delivery is impossible by construction" invariant's neighborhood), so this asserts the mirror is
// additive-only and never regresses it:
//   1. BOUND-ONLY, never-unbound: a session with an in-app + Telegram binding mirrors its web turn to THAT
//      Telegram chat, with the disclaimer suffix; a DIFFERENT session with no Telegram binding mirrors
//      NOTHING (proven with both sessions live at once, so there is no "only one session was ever tested"
//      loophole — a broadcast bug would show up as B's turn reaching A's Telegram chat).
//   2. NO INBOUND TURN on the mirrored channel: the mirror is a plain adapter.send, never submitTurn — the
//      Telegram adapter records a `sent` message, but submitTurn is called EXACTLY once (the original web
//      turn), never twice, proving the mirror cannot loop back in as a second turn.
//   3. Fire-and-forget: handleInAppInbound resolves (the original turn is accepted) WITHOUT waiting on the
//      mirror send — a slow Telegram adapter must never delay or block the cockpit's own turn/reply.
//   4. A mirror send that fails (adapter.send throws) is CONTAINED — it does not throw out of
//      handleInAppInbound and does not stop the original turn from being accepted — and is LOGGED (visible,
//      not opt-in debug) so a silent Telegram outage doesn't vanish unnoticed.
// Run: 1) build (turbo builds shared first), 2) node test/companion-mirror.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-mirror-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { CompanionController } = await import("../dist/companion/controller.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");

const TELEGRAM = "telegram";
// A conformant fake ChannelAdapter recording sends (no network); `send` optionally throws once to exercise
// the contained-failure path.
function fakeAdapter(name, { throwOnce = false } = {}) {
  const sent = [];
  let thrown = false;
  return {
    name,
    maxMessageLength: name === TELEGRAM ? 4096 : undefined,
    start() {},
    async stop() {},
    async send(chatId, text) {
      if (throwOnce && !thrown) { thrown = true; throw new Error("simulated telegram outage"); }
      sent.push({ chatId, text });
    },
    sent,
  };
}

// Console.error capture — the mirror's failure path must LOG (visibly, not gated behind LOOM_COMPANION_DEBUG).
function captureConsoleError() {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(" ")); };
  return { lines, restore: () => { console.error = orig; } };
}

try {
  // ============ Part 1 — BOUND-ONLY: a web turn mirrors to ITS session's Telegram, not another's ============
  {
    const submitted = [];
    const submitSpy = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };

    // Session A: in-app + telegram bound. Session B: in-app ONLY (no telegram) — proves no broadcast.
    const bindings = [
      { sessionId: "sess-A", channel: IN_APP_CHANNEL, chatId: "sess-A", scope: "dm" },
      { sessionId: "sess-A", channel: TELEGRAM, chatId: "tg-A", scope: "dm" },
      { sessionId: "sess-B", channel: IN_APP_CHANNEL, chatId: "sess-B", scope: "dm" },
    ];
    const gw = new ChatGateway(submitSpy, bindings);
    const inApp = fakeAdapter(IN_APP_CHANNEL);
    const tg = fakeAdapter(TELEGRAM);
    gw.registerAdapter(inApp);
    gw.registerAdapter(tg);

    const hooks = { companionSessionId: null };
    const controller = new CompanionController({
      db: { listEnabledCompanionReminders: () => [] },
      submitTurn: submitSpy,
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks,
      env: {},
      buildGateway: () => gw,
    });
    // Boot the controller with a config so `this.gateway` is live (startGateway wires the injected builder).
    await controller.startInitial({
      botToken: null, allowedChatId: "", sessionId: "sess-A", chatScope: "dm",
      homeChannel: null, homeChatId: null, heartbeatIntervalMinutes: 0, heartbeatPrompt: "",
    });

    // A web turn on session A (bound to telegram tg-A): accepted, submitted once, and mirrored to tg-A ONLY.
    const resA = await controller.handleInAppInbound("sess-A", "hello from the cockpit");
    check("A: web turn accepted", resA.accepted === true && resA.sessionId === "sess-A");
    check("A: submitted exactly ONE turn (the original web turn)", submitted.length === 1 && submitted[0].sid === "sess-A" && submitted[0].text === "hello from the cockpit");
    await sleep(20); // let the fire-and-forget mirror settle
    check("A: mirrored to A's bound telegram chat with the disclaimer", tg.sent.length === 1 && tg.sent[0].chatId === "tg-A" && tg.sent[0].text === "hello from the cockpit\n\n— via web chat");
    check("A: the in-app adapter itself was never sent the mirror (only the OTHER bound channel)", inApp.sent.length === 0);

    // A web turn on session B (in-app ONLY — no telegram binding): accepted + submitted, mirrors NOTHING.
    const resB = await controller.handleInAppInbound("sess-B", "hello from B, unrelated session");
    check("B: web turn accepted", resB.accepted === true && resB.sessionId === "sess-B");
    check("B: submitted exactly one MORE turn (two total)", submitted.length === 2 && submitted[1].sid === "sess-B");
    await sleep(20);
    check("B: NOTHING mirrored — B has no telegram binding (no broadcast to A's telegram or anywhere else)", tg.sent.length === 1); // still just A's earlier mirror
    check("B: in-app adapter still untouched", inApp.sent.length === 0);

    await controller.stop();
  }

  // ============ Part 2 — fire-and-forget: handleInAppInbound does not wait on a SLOW mirror send ============
  {
    const submitted = [];
    const submitSpy = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const bindings = [
      { sessionId: "sess-slow", channel: IN_APP_CHANNEL, chatId: "sess-slow", scope: "dm" },
      { sessionId: "sess-slow", channel: TELEGRAM, chatId: "tg-slow", scope: "dm" },
    ];
    const gw = new ChatGateway(submitSpy, bindings);
    const inApp = fakeAdapter(IN_APP_CHANNEL);
    let releaseTg;
    const slowGate = new Promise((r) => { releaseTg = r; });
    const tg = { name: TELEGRAM, maxMessageLength: 4096, start() {}, async stop() {}, sent: [], async send(chatId, text) { await slowGate; tg.sent.push({ chatId, text }); } };
    gw.registerAdapter(inApp);
    gw.registerAdapter(tg);

    const controller = new CompanionController({
      db: { listEnabledCompanionReminders: () => [] },
      submitTurn: submitSpy,
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks: { companionSessionId: null },
      env: {},
      buildGateway: () => gw,
    });
    await controller.startInitial({
      botToken: null, allowedChatId: "", sessionId: "sess-slow", chatScope: "dm",
      homeChannel: null, homeChatId: null, heartbeatIntervalMinutes: 0, heartbeatPrompt: "",
    });

    const started = Date.now();
    const res = await controller.handleInAppInbound("sess-slow", "don't wait on me");
    const elapsed = Date.now() - started;
    check("slow-mirror: the inbound call resolves WITHOUT waiting on the (still-blocked) telegram send", res.accepted === true && elapsed < 200 && tg.sent.length === 0);
    releaseTg();
    await sleep(20);
    check("slow-mirror: the mirror eventually lands once released", tg.sent.length === 1 && tg.sent[0].text.endsWith("— via web chat"));
    await controller.stop();
  }

  // ============ Part 3 — a FAILED mirror send is CONTAINED (never throws, never blocks the turn) + LOGGED ============
  {
    const submitted = [];
    const submitSpy = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const bindings = [
      { sessionId: "sess-fail", channel: IN_APP_CHANNEL, chatId: "sess-fail", scope: "dm" },
      { sessionId: "sess-fail", channel: TELEGRAM, chatId: "tg-fail", scope: "dm" },
    ];
    const gw = new ChatGateway(submitSpy, bindings);
    const inApp = fakeAdapter(IN_APP_CHANNEL);
    const tg = fakeAdapter(TELEGRAM, { throwOnce: true }); // adapter.send throws on the mirror attempt
    gw.registerAdapter(inApp);
    gw.registerAdapter(tg);

    const controller = new CompanionController({
      db: { listEnabledCompanionReminders: () => [] },
      submitTurn: submitSpy,
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks: { companionSessionId: null },
      env: {},
      buildGateway: () => gw,
    });
    await controller.startInitial({
      botToken: null, allowedChatId: "", sessionId: "sess-fail", chatScope: "dm",
      homeChannel: null, homeChatId: null, heartbeatIntervalMinutes: 0, heartbeatPrompt: "",
    });

    const cap = captureConsoleError();
    let threw = false;
    let res;
    try { res = await controller.handleInAppInbound("sess-fail", "this mirror will fail"); } catch { threw = true; }
    await sleep(20);
    cap.restore();
    check("failed-mirror: handleInAppInbound never throws even though the mirror send does", threw === false && res.accepted === true);
    check("failed-mirror: the original turn was still submitted (mirror failure doesn't block the turn)", submitted.length === 1 && submitted[0].sid === "sess-fail");
    check("failed-mirror: the failure is LOGGED (visible, not silently swallowed)", cap.lines.some((l) => l.includes("web-chat mirror") && l.toLowerCase().includes("telegram") && l.toLowerCase().includes("failed")));
    await controller.stop();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an accepted web-chat (in-app) turn mirrors OUT to its session's other bound channels (Telegram) with a \"— via web chat\" disclaimer, bound-only (a session with no telegram binding mirrors nothing, proven alongside a session that DOES have one), never forms a second/inbound turn on the mirrored channel (submitTurn fires exactly once per original turn), is fire-and-forget (the inbound call never waits on the mirror send), and a mirror-send failure is contained + logged without ever breaking or blocking the original turn."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
