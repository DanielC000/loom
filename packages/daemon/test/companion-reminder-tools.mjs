import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion Reminders (Memory & Reminders Design, Surface 2 s4) — the reminder_create/reminder_list/
// reminder_cancel MCP surface. Fully hermetic: a REAL Db on a temp LOOM_HOME + a REAL CompanionController
// (env-free `resolveEffective` seam, injected fake gateway builder, and a REAL CompanionReminderWatcher
// wrapped so the test drives tick() directly instead of waiting on a real setInterval) + the REAL
// OrchestrationMcpRouter. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   1. companion-session gate: the tools exist ONLY on the single bound companion session's MCP surface —
//      a different assistant session and a manager both get NONE of them.
//   2. cron-validation reject: an invalid cron is rejected AT THE BOUNDARY (never relying on the watcher's
//      defensive catch) — no row written, no rearm triggered.
//   3. server-derived route capture: reminder_create NEVER takes a route param; the row's route is whatever
//      the injected getActiveTurnOrigin hook returns for the CURRENT turn (or null when it returns none).
//   4. ARM-ON-CREATE (load-bearing): creating a reminder via the tool (re)arms the live reminder watcher for
//      that session WITHOUT any other config write — proven by building a REAL watcher, then driving its
//      tick() to a due boundary and observing the fired turn.
//   5. cancel scoping: reminder_cancel can never touch another session's reminder (scoped read-before-delete),
//      and disarms (rearms to zero) the watcher once the reminder set empties.
// Run: 1) build (turbo builds shared first), 2) node test/companion-reminder-tools.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-reminder-tools-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { CompanionReminderWatcher, reminderMarker } = await import("../dist/companion/reminders.js");
const { nextFireAt } = await import("../dist/orchestration/cron.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const SESS = "companion-sess";
const OTHER_ASSISTANT = "other-assistant-sess";
const MANAGER = "mgr-sess";
const EVERY_MINUTE = "* * * * *";

function seedSession(db, id, role = "assistant") {
  const projId = `p-${id}`;
  const agentId = `a-${id}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "REM", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "companion", startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
}

// Fixed CompanionConfig for the `resolveEffective` seam — sidesteps needing a real companion_config row /
// envelope-encrypted token. cadence 0 ⇒ no heartbeat noise in this test (reminders are the concern here).
function cfgOf(sessionId) {
  return {
    botToken: "x", allowedChatId: "chat-1", sessionId, chatScope: "dm",
    homeChannel: "telegram", homeChatId: "chat-1",
    heartbeatIntervalMinutes: 0, heartbeatPrompt: "PROACTIVE",
  };
}

// A minimal fake ChatGateway builder — this test never exercises chat routing, only reminders.
function makeGatewayBuilder() {
  const built = [];
  const builder = (cfg) => {
    const gw = {
      start() { gw.started = (gw.started ?? 0) + 1; },
      async stop() { gw.stopped = (gw.stopped ?? 0) + 1; },
      bind() {}, unbind() {},
      async deliverReply() { return { delivered: true }; },
      async handleInbound() { return { accepted: false, reason: "no-text" }; },
    };
    built.push({ cfg, gw });
    return gw;
  };
  return { built, builder };
}

// A REAL CompanionReminderWatcher per built session — start()/stop() clear any real setInterval
// immediately (this test drives tick() directly for determinism, mirroring companion-reminders.mjs's
// restart-safety test), so nothing here waits on wall-clock time.
function makeReminderBuilder(db, pty) {
  const built = []; // { sessionId, watcher, startCalls, stopCalls }
  const builder = (sessionId) => {
    const watcher = new CompanionReminderWatcher({ db, pty, sessionId });
    const rec = { sessionId, watcher, startCalls: 0, stopCalls: 0 };
    built.push(rec);
    return {
      start() { rec.startCalls++; watcher.start(); watcher.stop(); },
      stop() { rec.stopCalls++; watcher.stop(); },
    };
  };
  return { built, builder };
}

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-reminder-tools-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

try {
  const db = new Db(path.join(tmpHome, "reminders.db"));
  seedSession(db, SESS, "assistant");
  seedSession(db, OTHER_ASSISTANT, "assistant");

  const alive = new Set([SESS]);
  const enqueued = []; // { sessionId, text, route }
  let pendingQueue = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, _source, _onDeliver, route) => { enqueued.push({ sessionId: id, text, route }); pendingQueue.push(text); return { delivered: false, position: pendingQueue.length }; },
    getPending: (id) => (id === SESS ? pendingQueue : []),
    getActiveTurnOrigin: () => null, // overridden per-test below via companionHooks.getActiveTurnOrigin
  };

  const gwBuilder = makeGatewayBuilder();
  const remBuilder = makeReminderBuilder(db, pty);
  let originRoute = null; // the test flips this to simulate "the current turn's origin"
  const reconcileCalls = { n: 0 };
  const companionHooks = {
    companionSessionIds: new Set([SESS]),
    deliverReply: async () => ({ delivered: true }),
    getActiveTurnOrigin: () => originRoute,
    // Wraps controller.reconcile() so tests can also assert HOW MANY TIMES arm-on-create actually reconciled.
    rearmReminders: () => { reconcileCalls.n++; return controller.reconcile(); },
  };
  const controller = new CompanionController({
    db,
    submitTurn: (sid, text, route) => pty.enqueueStdin(sid, text, "system", undefined, route),
    pty,
    hooks: companionHooks,
    env: {},
    buildGateway: gwBuilder.builder,
    buildReminders: remBuilder.builder,
    resolveEffective: () => [cfgOf(SESS)],
  });
  const orch = new OrchestrationMcpRouter(db, {}, companionHooks);

  // Bring the companion live with ZERO reminders (the realistic precondition — reminder_create/cancel only
  // ever reach a session that already has the tools registered, i.e. an already-live companion).
  await controller.reconcile();
  check("setup: companion is live", gwBuilder.built.length === 1 && controller.snapshot().running === true);
  check("setup: no reminder watcher armed yet (zero rows)", remBuilder.built.length === 0);

  // ============ 1. companion-session gate ============
  {
    const companionTools = await listOf(orch.buildServer(SESS, "assistant"));
    const REM_TOOLS = ["reminder_create", "reminder_list", "reminder_cancel"];
    check("gate: the bound companion HAS all three reminder tools", REM_TOOLS.every((t) => companionTools.includes(t)));

    const otherTools = await listOf(orch.buildServer(OTHER_ASSISTANT, "assistant"));
    check("gate: a DIFFERENT assistant session has NONE of the reminder tools", REM_TOOLS.every((t) => !otherTools.includes(t)));

    const mgrTools = await listOf(orch.buildServer(MANAGER, "manager"));
    check("gate: a non-companion manager has NONE of the reminder tools", REM_TOOLS.every((t) => !mgrTools.includes(t)));
  }

  // ============ 2. cron-validation reject (boundary validation, not the watcher's defensive catch) ============
  {
    const c = await connect(orch.buildServer(SESS, "assistant"));
    const before = reconcileCalls.n;
    const r = await call(c, "reminder_create", { cron: "not-a-cron", prompt: "x" });
    check("cron-reject: an invalid cron is rejected with an {error}", typeof r.error === "string" && /invalid cron/i.test(r.error));
    check("cron-reject: no row was written", db.listCompanionRemindersForSession(SESS).length === 0);
    check("cron-reject: rearm was NEVER triggered for a rejected create", reconcileCalls.n === before);
    await c.close();
  }

  // ============ 3. server-derived route capture ============
  let reminderIdWithRoute, reminderIdNoRoute;
  {
    const c = await connect(orch.buildServer(SESS, "assistant"));
    // (a) the current turn HAS an origin → the created row carries it, verbatim, with NO route param passed.
    originRoute = { channel: "telegram", chatId: "chat-1" };
    const withRoute = await call(c, "reminder_create", { cron: EVERY_MINUTE, prompt: "CHECK route-carry" });
    reminderIdWithRoute = withRoute.reminderId;
    check("route-capture: reminder_create returns a reminderId + nextFireAt", typeof withRoute.reminderId === "string" && typeof withRoute.nextFireAt === "string");
    const rowWithRoute = db.getCompanionReminder(reminderIdWithRoute);
    check("route-capture: the row's route is EXACTLY the server-derived origin (never agent-supplied)", JSON.stringify(rowWithRoute.route) === JSON.stringify(originRoute));

    // (b) no current-turn origin → the created row carries NO route.
    originRoute = null;
    const noRoute = await call(c, "reminder_create", { cron: EVERY_MINUTE, prompt: "CHECK no-route" });
    reminderIdNoRoute = noRoute.reminderId;
    const rowNoRoute = db.getCompanionReminder(reminderIdNoRoute);
    check("route-capture: no origin ⇒ the row's route is null", rowNoRoute.route === null);
    await c.close();
  }

  // ============ 4. ARM-ON-CREATE (load-bearing): create → watcher armed → a due tick fires ============
  // NOTE: rearmReminders (controller.ts) stop+rebuilds the watcher on EVERY reconcile (a documented
  // trade-off — see its comment), so the 2 creates above each drove ONE reconcile ⇒ 2 watchers were built
  // in TOTAL, the first torn down when the second reminder landed. The point under test is the LATEST
  // (currently live) one: it was built as a DIRECT effect of reminder_create, with NO other config write.
  {
    check("arm-on-create: reminder_create alone drove exactly one reconcile per call (2 creates ⇒ 2)", reconcileCalls.n === 2);
    check("arm-on-create: a REAL reminder watcher was (re)built + started for this session on each create", remBuilder.built.length === 2 && remBuilder.built.every((r) => r.sessionId === SESS && r.startCalls === 1));
    check("arm-on-create: the FIRST watcher was torn down once the 2nd reminder landed (rebuilt, not reused)", remBuilder.built[0].stopCalls === 1);
    check("arm-on-create: the LATEST watcher is still live (not yet stopped)", remBuilder.built[1].stopCalls === 0);
    const watcher = remBuilder.built[remBuilder.built.length - 1].watcher; // the currently-armed one
    // Both reminders created above are EVERY_MINUTE — advance to the LATER of their two real next cron
    // boundaries (not a fixed millisecond offset, so this can't flake near a minute boundary) so BOTH are
    // genuinely due, then tick the REAL watcher (which re-reads the DB live, independent of when it was built).
    const rowWithRoute = db.getCompanionReminder(reminderIdWithRoute);
    const rowNoRoute = db.getCompanionReminder(reminderIdNoRoute);
    const b1 = new Date(nextFireAt(rowWithRoute.cron, new Date(rowWithRoute.createdAt)));
    const b2 = new Date(nextFireAt(rowNoRoute.cron, new Date(rowNoRoute.createdAt)));
    const boundary = b1.getTime() >= b2.getTime() ? b1 : b2;
    watcher.tick(boundary);
    check("arm-on-create: the due tick fires BOTH reminders created via the tool", enqueued.filter((en) => en.text.startsWith(`${reminderMarker(reminderIdWithRoute)} `) || en.text.startsWith(`${reminderMarker(reminderIdNoRoute)} `)).length === 2);
    check("arm-on-create: the route-carrying reminder's fired turn carries its captured route", enqueued.find((en) => en.text.startsWith(`${reminderMarker(reminderIdWithRoute)} `)).route.chatId === "chat-1");
    // No captured route ⇒ CompanionReminderWatcher.fire() falls back to the session's implicit in-app route
    // (in-app.ts's `inAppHomeRoute`, the same fallback heartbeat.ts/attention-push.ts already use) instead
    // of carrying no route at all — otherwise this reminder's chat_reply would resolve `no-target`.
    check("arm-on-create: the no-route reminder's fired turn falls back to the in-app route", JSON.stringify(enqueued.find((en) => en.text.startsWith(`${reminderMarker(reminderIdNoRoute)} `)).route) === JSON.stringify({ channel: "in-app", chatId: SESS }));
  }

  // ============ 5. reminder_list reflects both created reminders ============
  {
    const c = await connect(orch.buildServer(SESS, "assistant"));
    const listed = await call(c, "reminder_list", {});
    check("list: returns both of this session's reminders", listed.length === 2 && listed.every((r) => typeof r.nextFireAt === "string"));
    check("list: entries carry {id, cron, prompt, label, enabled, nextFireAt}", listed.every((r) => "id" in r && "cron" in r && "prompt" in r && "label" in r && "enabled" in r && "nextFireAt" in r));
    await c.close();
  }

  // ============ 6. cancel scoping: can never touch another session's reminder ============
  {
    // A reminder belonging to a DIFFERENT (non-bound) session — inserted directly, as if left over from a
    // past companion binding.
    const foreignId = "foreign-rem-1";
    db.insertCompanionReminder({ id: foreignId, sessionId: OTHER_ASSISTANT, cron: EVERY_MINUTE, prompt: "not yours", label: null, route: null, enabled: true, createdAt: new Date().toISOString() });

    const c = await connect(orch.buildServer(SESS, "assistant"));
    const before = reconcileCalls.n;
    const rejected = await call(c, "reminder_cancel", { reminderId: foreignId });
    check("cancel-scoping: cancelling ANOTHER session's reminder returns cancelled:false", rejected.cancelled === false);
    check("cancel-scoping: the foreign reminder is UNTOUCHED", !!db.getCompanionReminder(foreignId));
    check("cancel-scoping: no rearm was triggered for a rejected cancel", reconcileCalls.n === before);

    // Cancelling one's OWN reminder succeeds and (once the set empties) disarms the watcher.
    const ok1 = await call(c, "reminder_cancel", { reminderId: reminderIdWithRoute });
    check("cancel: cancelling YOUR OWN reminder returns cancelled:true", ok1.cancelled === true);
    check("cancel: the row is gone", db.getCompanionReminder(reminderIdWithRoute) === undefined);
    check("cancel: rearm WAS triggered (arm-on-cancel path re-reconciles)", reconcileCalls.n === before + 1);

    const ok2 = await call(c, "reminder_cancel", { reminderId: reminderIdNoRoute });
    check("cancel: cancelling the LAST reminder also succeeds", ok2.cancelled === true);
    check("cancel: the reminder set for this session is now empty", db.listCompanionRemindersForSession(SESS).length === 0);
    // ok1's cancel re-armed a 3rd watcher (one row still enabled); ok2's cancel — the set now empty — tears
    // THAT one down and builds NO successor (the disarm half of ARM-ON-CREATE/CANCEL).
    check("cancel: ok1's cancel re-armed a successor watcher (one reminder still left)", remBuilder.built.length === 3 && remBuilder.built[2].startCalls === 1);
    check("cancel: the watcher was DISARMED once the set emptied (stopped, no further watcher built)", remBuilder.built[2].stopCalls >= 1 && remBuilder.built.length === 3);
    await c.close();
  }

  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — reminder_create/reminder_list/reminder_cancel are gated to the single bound companion session, an invalid cron is rejected at the boundary with no row written and no rearm, the route is captured SERVER-SIDE (never agent-supplied), a fresh create ARMS a real reminder watcher with no other config write (and a due tick fires it), and cancel is scoped to the caller's OWN session (disarming the watcher once the set empties)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
