import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the CHAT HISTORY store + its record hooks (bug 0f01f234: the web in-app chat lost the
// whole conversation on reload). Fully hermetic: a temp LOOM_HOME + a REAL Db, a real InAppChannel + a real
// ChatGateway, and the real CompanionController. NO network, NO real claude, NO daemon. Proves:
//   1. Db.insertCompanionMessage/listCompanionMessages: chronological order, per (session,channel) isolation,
//      and the bounded-growth prune (pruned to the most recent 200 rows on every insert).
//   2. InAppChannel's injected recorder fires on EVERY outbound send — even with ZERO attached clients (so a
//      proactive heartbeat/reminder reply to an unattended session still persists) — and a THROWING recorder
//      never breaks the actual delivery to an attached client (contained, mirrors `deliver`'s containment).
//   3. CompanionController's inbound record fires ONLY for an ACCEPTED turn (immediate delivery OR queued) —
//      never for a command / rejected / no-text inbound — and a THROWING db.insertCompanionMessage never
//      breaks the inbound path it's mirroring (submitTurn still runs, the caller still gets its result).
// Run: 1) build (turbo builds shared first), 2) node test/companion-messages.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-messages-${Date.now()}-${process.pid}`);
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
const { InAppChannel, IN_APP_CHANNEL, normalizeInAppMessage } = await import("../dist/companion/in-app.js");
const { CompanionController } = await import("../dist/companion/controller.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

const inAppBinding = (sessionId) => ({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });
const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };

// A minimal real project/agent/session trio so companion_messages' FK (session_id REFERENCES sessions(id))
// is satisfiable — mirrors companion-reminders-rest.mjs's seeding, reused here for three sessions (A/B/C).
const now0 = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Messages", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
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

try {
  // ============ 1) Db store: chronological, per-(session,channel) isolation, bounded-growth prune ============
  {
    const sessA = makeCompanionSession();
    const sessB = makeCompanionSession();
    const now = Date.now();
    const mk = (sessionId, i, author) => ({
      id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author, text: `msg-${i}`,
      createdAt: new Date(now + i * 1000).toISOString(),
    });
    db.insertCompanionMessage(mk(sessA, 0, "user"));
    db.insertCompanionMessage(mk(sessA, 1, "companion"));
    db.insertCompanionMessage(mk(sessA, 2, "user"));
    db.insertCompanionMessage(mk(sessB, 0, "user")); // a different session — must not bleed into A's list

    const listA = db.listCompanionMessages(sessA, IN_APP_CHANNEL);
    check("store: chronological order", listA.map((m) => m.text).join(",") === "msg-0,msg-1,msg-2");
    check("store: author round-trips", listA[0].author === "user" && listA[1].author === "companion");
    check("store: per-session isolation — session B's row is absent from A's list", !listA.some((m) => m.text === "msg-0" && m.sessionId === sessB));
    const listB = db.listCompanionMessages(sessB, IN_APP_CHANNEL);
    check("store: session B sees only its own row", listB.length === 1 && listB[0].text === "msg-0" && listB[0].sessionId === sessB);

    // A channel query for a DIFFERENT channel name on the SAME session returns nothing (channel-keyed, not
    // just session-keyed — proves the table's real scoping column, even though today only in-app writes it).
    check("store: channel isolation — a different channel sees nothing for session A", db.listCompanionMessages(sessA, "telegram").length === 0);

    // Bounded growth: insert past the 200-row cap for ONE (session,channel) and confirm it's pruned to the
    // most recent 200, oldest-first-dropped.
    const sessC = makeCompanionSession();
    for (let i = 0; i < 205; i++) db.insertCompanionMessage(mk(sessC, i, "user"));
    const listC = db.listCompanionMessages(sessC, IN_APP_CHANNEL);
    check("store: bounded growth — capped at 200 rows", listC.length === 200);
    check("store: bounded growth — the OLDEST rows were pruned (msg-0..msg-4 gone)", !listC.some((m) => ["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"].includes(m.text)));
    check("store: bounded growth — the newest rows survive", listC[listC.length - 1].text === "msg-204");
  }

  // ============ 2) InAppChannel outbound record: unconditional + contained ============
  {
    const recorded = [];
    const inApp = new InAppChannel({ record: (sessionId, author, text) => recorded.push({ sessionId, author, text }) });
    const gw = new ChatGateway(() => ({ delivered: true }), [inAppBinding("sess-A")], undefined, undefined, (sid) => (sid === "sess-A" ? { channel: IN_APP_CHANNEL, chatId: "sess-A" } : null));
    gw.registerAdapter(inApp.adapter);

    // NO client attached — the live push is dropped, but the record must STILL fire (proactive reply to an
    // unattended session persists to history even though nobody sees it live).
    const d1 = await gw.deliverReply("sess-A", "nobody is watching, but I still say this");
    check("outbound record: fires even with ZERO attached clients", d1.delivered === true && recorded.length === 1 && recorded[0].sessionId === "sess-A" && recorded[0].author === "companion" && recorded[0].text === "nobody is watching, but I still say this");

    // Now attach a client and confirm delivery + record both happen exactly once (no double-record from a
    // chunked send — in-app never chunks).
    const { frames, client } = makeClient();
    inApp.attach("sess-A", client);
    await gw.deliverReply("sess-A", "hello, someone's here now");
    check("outbound record: also fires (once) with an attached client, alongside the live frame", recorded.length === 2 && frames.length === 1 && frames[0].text === "hello, someone's here now");

    // A THROWING recorder must never break the actual reply delivery (contained, mirrors deliver()'s per-client try/catch).
    const throwingInApp = new InAppChannel({ record: () => { throw new Error("boom"); } });
    const gw2 = new ChatGateway(() => ({ delivered: true }), [inAppBinding("sess-B")], undefined, undefined, (sid) => (sid === "sess-B" ? { channel: IN_APP_CHANNEL, chatId: "sess-B" } : null));
    gw2.registerAdapter(throwingInApp.adapter);
    const { frames: frames2, client: client2 } = makeClient();
    throwingInApp.attach("sess-B", client2);
    let threw = false;
    const d2 = await gw2.deliverReply("sess-B", "still delivered despite a throwing recorder").catch(() => { threw = true; return null; });
    check("outbound record: a THROWING recorder never breaks delivery", threw === false && d2?.delivered === true && frames2.length === 1 && frames2[0].text === "still delivered despite a throwing recorder");
  }

  // ============ 3) CompanionController inbound record: accepted-only + contained ============
  {
    const inApp = new InAppChannel();
    const submitted = [];
    let deliverPosition; // undefined=delivered live, a number=queued (busy), null-ish=dead session
    const submitSpy = (sid, text) => {
      submitted.push({ sid, text });
      return deliverPosition === undefined ? { delivered: true } : { delivered: false, position: deliverPosition };
    };
    const buildGateway = (_cfg, submit) => {
      const gw = new ChatGateway(submit, [inAppBinding("sess-A")]);
      gw.registerAdapter(inApp.adapter);
      return gw;
    };
    const cfg = {
      botToken: "unused", allowedChatId: "sess-A", sessionId: "sess-A", chatScope: "dm",
      homeChannel: IN_APP_CHANNEL, homeChatId: "sess-A", heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
    };
    const recorded = [];
    let throwOnRecord = false;
    const dbStub = {
      listEnabledCompanionReminders: () => [],
      insertCompanionMessage: (m) => { if (throwOnRecord) throw new Error("db is down"); recorded.push(m); },
    };
    const controller = new CompanionController({
      db: dbStub, submitTurn: submitSpy, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks: { companionSessionIds: new Set() }, env: {}, inApp, buildGateway, resolveEffective: () => [cfg],
    });
    await controller.reconcile(); // OFF → ON

    // (a) Immediately-delivered inbound → recorded as author:"user".
    const r1 = await controller.handleInAppInbound("sess-A", "hello there");
    check("inbound record: an accepted+delivered turn is recorded as author:user", r1.accepted === true && recorded.length === 1 && recorded[0].author === "user" && recorded[0].text === "hello there" && recorded[0].sessionId === "sess-A" && recorded[0].channel === IN_APP_CHANNEL);

    // (b) A QUEUED (busy) inbound is STILL a real accepted turn — must still be recorded.
    deliverPosition = 3;
    const r2 = await controller.handleInAppInbound("sess-A", "queued while busy");
    check("inbound record: an accepted-but-QUEUED turn is ALSO recorded (it's still a real user message)", r2.accepted === true && r2.queued === true && recorded.length === 2 && recorded[1].text === "queued while busy");
    deliverPosition = undefined;

    // (c) A recognized slash-command never becomes a turn — must NOT be recorded.
    const r3 = await controller.handleInAppInbound("sess-A", "/lang en");
    check("inbound record: a recognized slash-command is NOT recorded (never became a turn)", r3.accepted === false && r3.reason === "command" && recorded.length === 2);

    // (d) An unbound/rejected chat is NOT recorded.
    const r4 = await controller.handleInAppInbound("sess-UNBOUND", "let me in");
    check("inbound record: a rejected (unbound) inbound is NOT recorded", r4.accepted === false && recorded.length === 2);

    // (e) Empty body → no-text, NOT recorded.
    const r5 = await controller.handleInAppInbound("sess-A", "");
    check("inbound record: an empty body is NOT recorded", r5.accepted === false && r5.reason === "no-text" && recorded.length === 2);

    // (f) A THROWING db.insertCompanionMessage must never break the inbound path — submitTurn still ran and
    // the caller still gets its normal accepted result.
    throwOnRecord = true;
    const beforeSubmitted = submitted.length;
    let threw = false;
    const r6 = await controller.handleInAppInbound("sess-A", "history db is down right now").catch(() => { threw = true; return null; });
    check("inbound record: a THROWING db insert never breaks the inbound path", threw === false && r6?.accepted === true && submitted.length === beforeSubmitted + 1 && recorded.length === 2 /* the throw meant nothing new was pushed */);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the companion chat-history store is chronological + per-(session,channel) isolated + bounded-growth pruned; the in-app outbound record fires unconditionally and is contained against a throwing recorder; the inbound record fires only on an ACCEPTED turn and is contained against a throwing db write."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
