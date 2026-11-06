import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CompanionController.notifyOwnerContextExhausted — the Loom-authored owner chat message for an exhausted
// Companion (owner decision, request 2235c924). Hermetic: a REAL ChatGateway over FAKE channel adapters,
// built into a REAL CompanionController through the `buildGateway` seam — no network, no claude, no daemon.
//
// Asserts: the fixed text goes to exactly ONE binding; DM-only (a group-scope binding, a flagged-non-private
// dm binding and the in-app channel are never sent to); a Companion with TWO eligible DM bindings gets
// exactly ONE send, to the channel the owner most recently messaged from (falling back to the first by
// (channel, chatId) when no inbound is recorded); no eligible binding / no live gateway -> no-binding and
// zero sends; a throwing adapter -> send-failed, contained, not retried; the text carries no ids/names.
// Run: 1) build (turbo builds shared first), 2) node test/companion-exhaustion-owner-message.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-exh-owner-msg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { CompanionController, COMPANION_EXHAUSTED_OWNER_MESSAGE } = await import("../dist/companion/controller.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");

function fakeAdapter(name, { throws = false } = {}) {
  const sent = [];
  return { name, start() {}, async stop() {}, async send(chatId, text) { if (throws) throw new Error("simulated outage"); sent.push({ chatId, text }); }, sent };
}

const cfg = (sessionId) => ({ botToken: null, allowedChatId: "", sessionId, chatScope: "dm", homeChannel: null, homeChatId: null, heartbeatIntervalMinutes: 0, heartbeatPrompt: "" });

// Build a controller with ONE live Companion `sid` bound as `bindings`; `latest` maps channel -> last inbound ts.
async function setup(sid, bindings, adapters, latest = {}) {
  const submit = () => ({ delivered: true });
  const gw = new ChatGateway(submit, bindings);
  for (const a of adapters) gw.registerAdapter(a);
  const controller = new CompanionController({
    db: { listEnabledCompanionReminders: () => [], latestCompanionUserMessageAt: (_s, ch) => latest[ch] ?? null },
    submitTurn: submit,
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks: { companionSessionIds: new Set() },
    env: {},
    buildGateway: () => gw,
  });
  await controller.startInitial([cfg(sid)]);
  return controller;
}

try {
  // ===== (1) one DM binding: exactly one send of the fixed text =====
  {
    const tg = fakeAdapter("telegram");
    const c = await setup("s1", [{ sessionId: "s1", channel: "telegram", chatId: "111", scope: "dm" }], [tg]);
    const r = await c.notifyOwnerContextExhausted("s1");
    check("(1) outcome sent on the DM channel", r.outcome === "sent" && r.channel === "telegram");
    check("(1) exactly one send, to the DM chat, with the fixed text", tg.sent.length === 1 && tg.sent[0].chatId === "111" && tg.sent[0].text === COMPANION_EXHAUSTED_OWNER_MESSAGE);
    check("(1) the text names the recycle control the way the UI does and the restart caveat",
      /Recycle onto a fresh session/.test(COMPANION_EXHAUSTED_OWNER_MESSAGE) && /Confirm recycle/.test(COMPANION_EXHAUSTED_OWNER_MESSAGE) && /unless Loom restarts first/.test(COMPANION_EXHAUSTED_OWNER_MESSAGE));
    check("(1) the text carries no session id or digits", !/s1/.test(COMPANION_EXHAUSTED_OWNER_MESSAGE) && !/\d/.test(COMPANION_EXHAUSTED_OWNER_MESSAGE));
    await c.stop();
  }

  // ===== (2) DM-ONLY: group-scope, flagged-non-private dm, and in-app are never sent to =====
  {
    const tg = fakeAdapter("telegram"), inApp = fakeAdapter(IN_APP_CHANNEL), grp = fakeAdapter("grpchan"), flagged = fakeAdapter("flagchan");
    const c = await setup("s2", [
      { sessionId: "s2", channel: IN_APP_CHANNEL, chatId: "s2", scope: "dm" },
      { sessionId: "s2", channel: "grpchan", chatId: "-100500", scope: "group" },
      { sessionId: "s2", channel: "flagchan", chatId: "-100600", scope: "dm", flaggedNonPrivate: true },
      { sessionId: "s2", channel: "telegram", chatId: "222", scope: "dm" },
    ], [tg, inApp, grp, flagged]);
    const r = await c.notifyOwnerContextExhausted("s2");
    check("(2) sent via the real DM binding", r.outcome === "sent" && r.channel === "telegram" && tg.sent.length === 1 && tg.sent[0].chatId === "222");
    check("(2) group-scope binding received nothing", grp.sent.length === 0);
    check("(2) flagged-non-private dm binding received nothing", flagged.sent.length === 0);
    check("(2) the in-app channel received nothing", inApp.sent.length === 0);
    await c.stop();
  }

  // ===== (2b) only ineligible bindings -> no-binding, zero sends =====
  {
    const inApp = fakeAdapter(IN_APP_CHANNEL), grp = fakeAdapter("grpchan");
    const c = await setup("s2b", [
      { sessionId: "s2b", channel: IN_APP_CHANNEL, chatId: "s2b", scope: "dm" },
      { sessionId: "s2b", channel: "grpchan", chatId: "-100500", scope: "group" },
    ], [inApp, grp]);
    const r = await c.notifyOwnerContextExhausted("s2b");
    check("(2b) only in-app + group bound: no-binding, nothing sent anywhere", r.outcome === "no-binding" && inApp.sent.length === 0 && grp.sent.length === 0);
    await c.stop();
  }

  // ===== (3) TWO eligible DM bindings: exactly ONE send, to the most recently messaged channel =====
  {
    const tg = fakeAdapter("telegram"), sl = fakeAdapter("slackish");
    const c = await setup("s3", [
      { sessionId: "s3", channel: "telegram", chatId: "333", scope: "dm" },
      { sessionId: "s3", channel: "slackish", chatId: "U9", scope: "dm" },
    ], [tg, sl], { telegram: "2026-11-06T09:00:00.000Z", slackish: "2026-11-06T09:30:00.000Z" });
    const r = await c.notifyOwnerContextExhausted("s3");
    check("(3) two DM bindings: exactly one send in total", tg.sent.length + sl.sent.length === 1);
    check("(3) …to the channel with the newest inbound message", r.outcome === "sent" && r.channel === "slackish" && sl.sent.length === 1 && tg.sent.length === 0);
    await c.stop();
    // flip the recency: the other channel wins
    const tg2 = fakeAdapter("telegram"), sl2 = fakeAdapter("slackish");
    const c2 = await setup("s3b", [
      { sessionId: "s3b", channel: "telegram", chatId: "333", scope: "dm" },
      { sessionId: "s3b", channel: "slackish", chatId: "U9", scope: "dm" },
    ], [tg2, sl2], { telegram: "2026-11-06T09:45:00.000Z", slackish: "2026-11-06T09:30:00.000Z" });
    const r2 = await c2.notifyOwnerContextExhausted("s3b");
    check("(3) recency flipped: the other channel is chosen, still exactly one send", r2.channel === "telegram" && tg2.sent.length === 1 && sl2.sent.length === 0);
    await c2.stop();
    // no inbound recorded anywhere: stable fallback = first by (channel, chatId)
    const tg3 = fakeAdapter("telegram"), sl3 = fakeAdapter("slackish");
    const c3 = await setup("s3c", [
      { sessionId: "s3c", channel: "telegram", chatId: "333", scope: "dm" },
      { sessionId: "s3c", channel: "slackish", chatId: "U9", scope: "dm" },
    ], [tg3, sl3], {});
    const r3 = await c3.notifyOwnerContextExhausted("s3c");
    check("(3) no inbound recorded: stable fallback picks the first channel by name, one send", r3.channel === "slackish" && sl3.sent.length === 1 && tg3.sent.length === 0);
    await c3.stop();
  }

  // ===== (4) send failure: contained, reported, one attempt =====
  {
    const origErr = console.error; console.error = () => {};
    const tg = fakeAdapter("telegram", { throws: true });
    const c = await setup("s4", [{ sessionId: "s4", channel: "telegram", chatId: "444", scope: "dm" }], [tg]);
    let r, threw = false;
    try { r = await c.notifyOwnerContextExhausted("s4"); } catch { threw = true; }
    console.error = origErr;
    check("(4) a throwing adapter does not throw out; outcome send-failed with the channel", !threw && r?.outcome === "send-failed" && r?.channel === "telegram");
    await c.stop();
  }

  // ===== (5) no live gateway for the session =====
  {
    const tg = fakeAdapter("telegram");
    const c = await setup("s5", [{ sessionId: "s5", channel: "telegram", chatId: "555", scope: "dm" }], [tg]);
    const r = await c.notifyOwnerContextExhausted("not-a-live-companion");
    check("(5) unknown session: no-binding, nothing sent", r.outcome === "no-binding" && tg.sent.length === 0);
    await c.stop();
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
