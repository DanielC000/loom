import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the MULTI-COMPANION RUNTIME (card 340b2dfa, SECURITY-CRITICAL). Generalizes the
// hot-lifecycle controller (companion-lifecycle.mjs) from ONE companion to N concurrently-armed ones.
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL envelope key file, INJECTED fake gateway/
// heartbeat builders for Parts 1-2 (speed, no live Telegram), the REAL createCompanionGateway factory for
// Part 3 (proves the actual binding-scoping fix), the REAL InAppChannel hub + OrchestrationMcpRouter. NO
// network, NO real claude, NO daemon. Asserts the card DoD:
//   1. two enabled configs arm TWO CONCURRENT gateways (resolveAllEnabledConfigs picks up every enabled
//      row, not just the oldest) — both live at once, chat_reply gated in on BOTH sessions concurrently.
//   2. reconcile diffs per session: enabling a 2nd companion while the 1st is live STARTS the 2nd without
//      touching the 1st; disabling one STOPS only that one; changing one's config (token) RESTARTS only
//      that one's adapter — every other live companion's gateway/heartbeat is UNTOUCHED throughout.
//   3. NO CROSS-COMPANION LEAK (the security invariant): a reply from companion A's turn delivers ONLY to
//      A's own attached client/route, NEVER to B's — proven through the REAL factory (createCompanionGateway)
//      so the binding-scoping fix (factory.ts filters bindings to cfg.sessionId, not the global table) is
//      actually exercised: each gateway's OWN routing map holds ONLY its own session's binding, even though
//      both share the SAME stable in-app hub and the SAME global companion_bindings table.
//   4. single-companion byte-identical: an array-of-one enabled config drives the EXACT same start path as
//      companion-lifecycle.mjs already proves (re-asserted here as a sanity check on the shared diff code).
//   5. scoped rearm (cross-companion rearm-all fix): reconcile(sessionId) confines its diff — and any
//      resulting reminder-watcher rearm — to the ONE session known to have changed; an untouched sibling's
//      reminder watcher is never stopped/rebuilt by another companion's write. An unscoped reconcile (boot /
//      no known origin) still rearms every live session, preserving the historical full-diff fallback.
//   6. heartbeat home cross-delivery fix (task e849a487): with A + B both enabled (distinct sessions), each
//      one's proactive heartbeat carries ITS OWN configured home route — never a sibling's — because home is
//      now a PER-SESSION app_meta key (db.getCompanionHome(sessionId)), not a single daemon-GLOBAL value
//      every heartbeat used to read regardless of which companion armed it.
//   7. same-home re-arm on a winner's exit (card 134368ac): two LIVE same-home companions ⇒ the suppression
//      guard (store.ts's suppressDuplicateHomeHeartbeats) arms only the more-active WINNER's heartbeat and
//      zeroes the survivor's. When the winner's session EXITS, onSessionExit re-arms the still-live
//      survivor's heartbeat AS PART OF THE EXIT ITSELF — not deferred to the next boot or an unrelated config
//      write — while never re-starting the now-dead winner's own gateway. A solo exit (no same-home live
//      sibling) and a non-companion session's exit are both safe no-ops.
// Run: 1) build (turbo builds shared first), 2) node test/companion-multi.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-multi-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
for (const k of Object.keys(process.env)) if (k.startsWith("LOOM_COMPANION_")) delete process.env[k];

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createCompanionGateway } = await import("../dist/companion/factory.js");
const { resolveAllEnabledConfigs } = await import("../dist/companion/store.js");
const { CompanionHeartbeatWatcher } = await import("../dist/companion/heartbeat.js");
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const dbFile = (name) => path.join(tmpHome, name);
const TOKEN_A = "8111111111:AAtoken-A-secret";
const TOKEN_A2 = "8111111111:AAtoken-A-ROTATED";
const TOKEN_B = "9222222222:BBtoken-B-secret";

// A fake ChannelAdapter that records lifecycle + sends (no network). One is built per gateway build.
function makeFakeAdapter() {
  const adapter = {
    name: "telegram", maxMessageLength: 4096, started: 0, stopped: 0, sent: [],
    start() { adapter.started++; },
    async stop() { adapter.stopped++; },
    async send(chatId, text) { adapter.sent.push({ chatId, text }); },
  };
  return adapter;
}

// A fake gateway builder (mirrors companion-lifecycle.mjs's) — a REAL ChatGateway wrapping a fake adapter,
// keyed per build so Parts 1-2 can assert PER-SESSION start/stop counts without touching real Telegram.
function makeGatewayBuilder() {
  const built = []; // { cfg, gw, adapter } per build, in build order
  const builder = (cfg, submitTurn, db) => {
    const adapter = makeFakeAdapter();
    let bindings = db.listCompanionBindings().filter((b) => b.sessionId === cfg.sessionId);
    if (bindings.length === 0) {
      db.upsertCompanionBinding({ sessionId: cfg.sessionId, channel: "telegram", chatId: cfg.allowedChatId, scope: cfg.chatScope });
      bindings = db.listCompanionBindings().filter((b) => b.sessionId === cfg.sessionId);
    }
    const routeFor = (sid) => { const b = bindings.find((x) => x.sessionId === sid); return b ? { channel: b.channel, chatId: b.chatId } : null; };
    const gw = new ChatGateway(submitTurn, bindings.map((b) => ({ sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope })), undefined, undefined, routeFor);
    gw.registerAdapter(adapter);
    built.push({ cfg, gw, adapter });
    return gw;
  };
  return { built, builder, forSession: (sid) => built.filter((b) => b.cfg.sessionId === sid) };
}

function makeHeartbeatBuilder() {
  const built = [];
  const builder = (cfg) => {
    const h = { cfg, started: 0, stopped: 0, start() { h.started++; }, stop() { h.stopped++; } };
    built.push(h);
    return h;
  };
  return { built, builder, forSession: (sid) => built.filter((b) => b.cfg.sessionId === sid) };
}

// A fake reminder-watcher builder (mirrors makeHeartbeatBuilder) — records start()/stop() calls per BUILD so
// Part 5 can tell a rearm (stop the old, build+start a new) apart from "left completely alone".
function makeReminderBuilder() {
  const built = []; // { sessionId, startCalls, stopCalls } per build, in build order
  const builder = (sessionId) => {
    const rec = { sessionId, startCalls: 0, stopCalls: 0 };
    built.push(rec);
    return { start() { rec.startCalls++; }, stop() { rec.stopCalls++; } };
  };
  return { built, builder, forSession: (sid) => built.filter((b) => b.sessionId === sid) };
}

function writeConfig(db, { sessionId, token = TOKEN_A, chatId = "chat-1", scope = "dm", cadence = 0, enabled = true }) {
  db.upsertCompanionConfig({
    sessionId, botTokenBlob: encryptSecret(token), channel: "telegram", allowedChatId: chatId,
    chatScope: scope, heartbeatIntervalMinutes: cadence, heartbeatPrompt: null, enabled,
  });
}

// companion_reminders.session_id REFERENCES sessions(id) — Part 5 needs a real session row per companion
// (unlike companion_config, which carries no such FK) before it can insert a reminder row for it.
function seedSession(db, id) {
  const projId = `p-${id}`;
  const agentId = `a-${id}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "REM", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "companion", startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  });
}

async function listTools(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "multi-test", version: "0" });
  await client.connect(clientT);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}
const chatReplyOn = async (orch, sessionId) => (await listTools(orch.buildServer(sessionId, "assistant"))).includes("chat_reply");

try {
  // ============ Part 1 — two enabled configs arm TWO CONCURRENT gateways ============
  {
    const db = new Db(dbFile("p1.db"));
    const gw = makeGatewayBuilder();
    const hb = makeHeartbeatBuilder();
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: () => ({ delivered: true }),
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, buildGateway: gw.builder, buildHeartbeat: hb.builder,
    });
    const orch = new OrchestrationMcpRouter(db, {}, hooks);
    await controller.startInitial(null); // OFF at boot

    writeConfig(db, { sessionId: "A", token: TOKEN_A, chatId: "chat-A", cadence: 360 });
    await controller.reconcile();
    check("1a: config A alone arms exactly one gateway", gw.built.length === 1 && controller.liveSessionIds().join(",") === "A");
    check("1a: A's heartbeat armed (cadence>0)", hb.built.length === 1 && hb.built[0].cfg.sessionId === "A");

    writeConfig(db, { sessionId: "B", token: TOKEN_B, chatId: "chat-B", cadence: 360 });
    await controller.reconcile();
    check("1b: enabling B arms a SECOND, DISTINCT gateway — A's is untouched", gw.built.length === 2 && controller.liveSessionIds().sort().join(",") === "A,B");
    check("1b: A's adapter was NEVER restarted (still started once, stopped never)", gw.forSession("A")[0].adapter.started === 1 && gw.forSession("A")[0].adapter.stopped === 0);
    check("1b: A's heartbeat was NEVER re-armed (still the one watcher, never stopped)", hb.forSession("A").length === 1 && hb.forSession("A")[0].stopped === 0);
    check("1b: B got its OWN heartbeat too (independent of A's)", hb.forSession("B").length === 1 && hb.forSession("B")[0].started === 1);

    check("1c: chat_reply gate holds BOTH sessions concurrently", hooks.companionSessionIds.has("A") && hooks.companionSessionIds.has("B") && hooks.companionSessionIds.size === 2);
    check("1c: chat_reply is registered on A's OWN MCP server build", await chatReplyOn(orch, "A"));
    check("1c: chat_reply is registered on B's OWN MCP server build, CONCURRENTLY with A's", await chatReplyOn(orch, "B"));
    check("1c: chat_reply is still OFF for an unrelated 3rd session", (await chatReplyOn(orch, "C")) === false);
    db.close();
  }

  // ============ Part 2 — reconcile diffs PER SESSION: start/stop/restart never cross-touches ============
  {
    const db = new Db(dbFile("p2.db"));
    const gw = makeGatewayBuilder();
    const hb = makeHeartbeatBuilder();
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: () => ({ delivered: true }),
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, buildGateway: gw.builder, buildHeartbeat: hb.builder,
    });
    writeConfig(db, { sessionId: "A", token: TOKEN_A, chatId: "chat-A" });
    writeConfig(db, { sessionId: "B", token: TOKEN_B, chatId: "chat-B" });
    await controller.startInitial(null);
    await controller.reconcile();
    check("2 setup: both A and B live", controller.liveSessionIds().sort().join(",") === "A,B");
    const adapterA0 = gw.forSession("A")[0].adapter;

    // (2a) DISABLE B → stops ONLY B; A's live adapter object is untouched (never stopped/rebuilt).
    writeConfig(db, { sessionId: "B", token: TOKEN_B, chatId: "chat-B", enabled: false });
    await controller.reconcile();
    check("2a: disabling B stops B only — A stays live", controller.liveSessionIds().join(",") === "A" && gw.forSession("B")[0].adapter.stopped === 1);
    check("2a: A's adapter was NEVER stopped by B's teardown", adapterA0.stopped === 0);
    check("2a: chat_reply dropped for B, still ON for A", hooks.companionSessionIds.has("A") && !hooks.companionSessionIds.has("B"));

    // (2b) RE-ENABLE B → starts a FRESH gateway for B; A still untouched.
    writeConfig(db, { sessionId: "B", token: TOKEN_B, chatId: "chat-B", enabled: true });
    await controller.reconcile();
    check("2b: re-enabling B builds a FRESH (2nd) gateway for B", gw.forSession("B").length === 2 && gw.forSession("B")[1].adapter.started === 1);
    check("2b: A's original adapter is STILL the same live one (no rebuild)", gw.forSession("A").length === 1 && adapterA0.started === 1 && adapterA0.stopped === 0);

    // (2c) change A's TOKEN → restarts ONLY A's adapter; B's live gateway is untouched.
    const adapterB1 = gw.forSession("B")[1].adapter;
    writeConfig(db, { sessionId: "A", token: TOKEN_A2, chatId: "chat-A" });
    await controller.reconcile();
    check("2c: A's token change rebuilds ONLY A (old A stopped, new A started)", gw.forSession("A").length === 2 && adapterA0.stopped === 1 && gw.forSession("A")[1].adapter.started === 1);
    check("2c: B's adapter was NEVER touched by A's token rotation", adapterB1.started === 1 && adapterB1.stopped === 0);
    check("2c: both still live, both still gated", controller.liveSessionIds().sort().join(",") === "A,B" && hooks.companionSessionIds.size === 2);
    db.close();
  }

  // ============ Part 3 — NO CROSS-COMPANION LEAK (the security heart of this card) ============
  // Uses the REAL createCompanionGateway factory (not an injected fake) so the binding-scoping fix is
  // ACTUALLY exercised: each companion's gateway must load ONLY its own session's bindings from the shared
  // companion_bindings table, and a chat_reply/deliverReply for one session must reach ONLY that session's
  // own attached client — never the other's — even though both share the SAME stable in-app hub.
  {
    const db = new Db(dbFile("p3.db"));
    const inApp = new InAppChannel();
    // Each session's in-app binding is minted directly (mirrors the provision endpoint) — NOT auto-seeded by
    // the factory (which only bootstrap-seeds a TELEGRAM binding, and only when a botToken is present).
    db.upsertCompanionBinding({ sessionId: "sess-A", channel: IN_APP_CHANNEL, chatId: "sess-A", scope: "dm" });
    db.upsertCompanionBinding({ sessionId: "sess-B", channel: IN_APP_CHANNEL, chatId: "sess-B", scope: "dm" });

    const built = new Map(); // sessionId -> the REAL gateway createCompanionGateway built for it
    const originResolver = (sid) => (sid === "sess-A" ? { channel: IN_APP_CHANNEL, chatId: "sess-A" } : sid === "sess-B" ? { channel: IN_APP_CHANNEL, chatId: "sess-B" } : null);
    const buildGateway = (cfg, submitTurn, dbArg) => {
      const gw = createCompanionGateway(cfg, submitTurn, dbArg, inApp, originResolver);
      built.set(cfg.sessionId, gw);
      return gw;
    };

    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: () => ({ delivered: true }),
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, inApp, buildGateway,
    });
    // Wire deliverReply the SAME way index.ts does — through the controller, so chat_reply (registered on
    // the shared `hooks`) actually routes via the by-sessionId dispatch under test.
    hooks.deliverReply = (sid, text, voice) => controller.deliverReply(sid, text, voice);

    // Two IN-APP-ONLY companions (botTokenBlob:"" — no Telegram adapter is ever registered, so `.start()`
    // touches no network) — both enabled concurrently.
    db.upsertCompanionConfig({ sessionId: "sess-A", botTokenBlob: "", channel: IN_APP_CHANNEL, allowedChatId: "sess-A", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    db.upsertCompanionConfig({ sessionId: "sess-B", botTokenBlob: "", channel: IN_APP_CHANNEL, allowedChatId: "sess-B", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    await controller.startInitial(null);
    await controller.reconcile();

    check("3 setup: both companions armed via the REAL factory", built.size === 2 && controller.liveSessionIds().sort().join(",") === "sess-A,sess-B");
    const gwA = built.get("sess-A");
    const gwB = built.get("sess-B");
    check("3 setup: A and B got DISTINCT gateway instances (never shared)", gwA !== gwB);

    // --- The factory-level assertion: A's routing map holds ONLY A's binding; B's holds ONLY B's. ---
    // Before the fix, createCompanionGateway loaded db.listCompanionBindings() UNFILTERED — every gateway
    // would have seen BOTH sessions' bindings. This is the regression test for that fix.
    check("no-leak(factory): A's gateway does NOT know about B's binding", gwA.bindingsForSession("sess-B").length === 0);
    check("no-leak(factory): A's gateway DOES know about its own binding", gwA.bindingsForSession("sess-A").length === 1);
    check("no-leak(factory): B's gateway does NOT know about A's binding", gwB.bindingsForSession("sess-A").length === 0);
    check("no-leak(factory): B's gateway DOES know about its own binding", gwB.bindingsForSession("sess-B").length === 1);

    // --- The controller-dispatch assertion: deliverReply(sessionId) reaches ONLY that session's client. ---
    const framesA = []; const framesB = [];
    inApp.attach("sess-A", { deliver: (f) => framesA.push(f) });
    inApp.attach("sess-B", { deliver: (f) => framesB.push(f) });

    const outA = await controller.deliverReply("sess-A", "hello from A's turn");
    check("no-leak(deliver): A's reply delivered", outA.delivered === true);
    check("no-leak(deliver): A's client received EXACTLY the A reply", framesA.length === 1 && framesA[0].text === "hello from A's turn" && framesA[0].chatId === "sess-A");
    check("no-leak(deliver): B's client received NOTHING from A's reply", framesB.length === 0);

    const outB = await controller.deliverReply("sess-B", "hello from B's turn");
    check("no-leak(deliver): B's reply delivered", outB.delivered === true);
    check("no-leak(deliver): B's client received EXACTLY the B reply", framesB.length === 1 && framesB[0].text === "hello from B's turn" && framesB[0].chatId === "sess-B");
    check("no-leak(deliver): A's client is STILL only holding its own earlier reply (B's reply never reached it)", framesA.length === 1 && framesA[0].text === "hello from A's turn");

    // --- The tool-surface assertion: chat_reply's inputSchema carries no target/sessionId the agent could
    // redirect — the sessionId the handler acts on is the MCP server's OWN closed-over session, always. ---
    const orch = new OrchestrationMcpRouter(db, {}, hooks);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await orch.buildServer("sess-A", "assistant").connect(serverT);
    const mcpClient = new Client({ name: "no-leak-test", version: "0" });
    await mcpClient.connect(clientT);
    const chatReplyTool = (await mcpClient.listTools()).tools.find((t) => t.name === "chat_reply");
    check("no-leak(schema): chat_reply's inputSchema has NO sessionId/target field an agent could redirect with", !!chatReplyTool && !("sessionId" in (chatReplyTool.inputSchema?.properties ?? {})) && !("target" in (chatReplyTool.inputSchema?.properties ?? {})));
    // Calling chat_reply on A's OWN connected server must still resolve to A alone.
    const callResult = await mcpClient.callTool({ name: "chat_reply", arguments: { text: "via the real tool call" } });
    const parsed = JSON.parse(callResult.content[0].text);
    check("no-leak(schema): chat_reply called on A's server delivers to A ONLY", parsed.delivered === true && framesA.length === 2 && framesA[1].text === "via the real tool call" && framesB.length === 1);
    await mcpClient.close();

    db.close();
  }

  // ============ Part 4 — single-companion case stays byte-identical (sanity re-check) ============
  {
    const db = new Db(dbFile("p4.db"));
    const gw = makeGatewayBuilder();
    const hb = makeHeartbeatBuilder();
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: () => ({ delivered: true }),
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, buildGateway: gw.builder, buildHeartbeat: hb.builder,
    });
    await controller.startInitial(null);
    writeConfig(db, { sessionId: "solo", token: TOKEN_A, chatId: "chat-solo", cadence: 60 });
    await controller.reconcile();
    check("4: a single enabled config arms exactly one gateway (array-of-one == the old single-companion path)", gw.built.length === 1 && controller.liveSessionIds().join(",") === "solo");
    check("4: chat_reply on solo's session, gate holds exactly one entry", hooks.companionSessionIds.has("solo") && hooks.companionSessionIds.size === 1);
    check("4: snapshot() mirrors the legacy shape for the single-companion case", JSON.stringify(controller.snapshot()) === JSON.stringify({ running: true, sessionId: "solo", heartbeatArmed: true }));
    db.close();
  }

  // ============ Part 5 — reconcile(sessionId) scopes the rearm: a sibling's reminder watcher is untouched ============
  // Regression test for the cross-companion rearm-all bug: applyDesired used to call updateOne() — and its
  // UNCONDITIONAL rearmRemindersFor — for EVERY live+desired session on EVERY reconcile, so a reminder_create/
  // cancel or config write for ONE companion reset every OTHER live companion's reminder watcher tick phase.
  // reconcile/rearmReminders now carry the ONE session known to have changed (the REST route's own :sessionId,
  // the reminder tool's own bound session), and applyDesired's `onlySessionId` scoping confines the diff to it.
  {
    const db = new Db(dbFile("p5.db"));
    const gw = makeGatewayBuilder();
    const rem = makeReminderBuilder();
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: () => ({ delivered: true }),
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, buildGateway: gw.builder, buildReminders: rem.builder,
    });
    seedSession(db, "A");
    seedSession(db, "B");
    writeConfig(db, { sessionId: "A", token: TOKEN_A, chatId: "chat-A" });
    writeConfig(db, { sessionId: "B", token: TOKEN_B, chatId: "chat-B" });
    // Both sessions start with an ENABLED reminder row so the initial reconcile arms a watcher for each.
    db.insertCompanionReminder({ id: "rem-A", sessionId: "A", cron: "* * * * *", prompt: "a", label: null, route: null, enabled: true, createdAt: new Date().toISOString() });
    db.insertCompanionReminder({ id: "rem-B", sessionId: "B", cron: "* * * * *", prompt: "b", label: null, route: null, enabled: true, createdAt: new Date().toISOString() });
    await controller.startInitial(null);
    await controller.reconcile(); // unscoped boot-style reconcile — arms BOTH watchers
    check("5 setup: both A and B armed exactly one reminder watcher", rem.forSession("A").length === 1 && rem.forSession("B").length === 1);
    const recB0 = rem.forSession("B")[0];
    const recA0 = rem.forSession("A")[0];

    // A reminder_create-style write for A ALONE, reconciled SCOPED to "A" — mirrors rearmReminders(sessionId).
    db.insertCompanionReminder({ id: "rem-A2", sessionId: "A", cron: "* * * * *", prompt: "a2", label: null, route: null, enabled: true, createdAt: new Date().toISOString() });
    await controller.reconcile("A");
    check("5a: A's OWN reminder watcher WAS rearmed (its own write)", recA0.stopCalls === 1 && rem.forSession("A").length === 2 && rem.forSession("A")[1].startCalls === 1);
    check("5a: B's reminder watcher was NEVER rearmed by A's scoped reconcile — no sibling rearm-all", recB0.stopCalls === 0 && rem.forSession("B").length === 1);
    check("5a: both companions stay live throughout (no teardown either)", controller.liveSessionIds().sort().join(",") === "A,B");

    // Sanity: an UNSCOPED reconcile (no known origin, e.g. boot) still visits every session, preserving the
    // historical full-diff fallback — the scoping is additive, not a behavior change for that path.
    await controller.reconcile();
    check("5b: an unscoped reconcile still rearms B too (legacy full-diff fallback preserved)", recB0.stopCalls === 1 && rem.forSession("B").length === 2);
    db.close();
  }

  // ============ Part 6 — heartbeat home cross-delivery fix (task e849a487) ============
  // Regression test for the bug: heartbeat.ts's tick() used to read db.getCompanionHome() — a SINGLE
  // daemon-GLOBAL app_meta key — while the controller arms ONE heartbeat watcher PER enabled companion. With
  // ≥2 enabled companions, every heartbeat carried the SAME global route regardless of which companion armed
  // it, so B's proactive chat_reply resolved to A's home and was sent through B's own bot. Home is now a
  // PER-SESSION app_meta key (db.getCompanionHome(sessionId)) — this proves each session's heartbeat carries
  // ONLY its own configured route, using the REAL resolveAllEnabledConfigs + CompanionHeartbeatWatcher (not
  // the fake builders above), so the actual per-row home resolution in store.ts is exercised end to end.
  {
    const db = new Db(dbFile("p6.db"));
    seedSession(db, "hbA");
    seedSession(db, "hbB");
    writeConfig(db, { sessionId: "hbA", token: TOKEN_A, chatId: "chat-A", cadence: 60 });
    writeConfig(db, { sessionId: "hbB", token: TOKEN_B, chatId: "chat-B", cadence: 60 });
    // Both A and B armed CONCURRENTLY — mirrors the card's repro ("enable A + B, distinct bots/owner chats").
    db.setCompanionHome("hbA", { channel: "telegram", chatId: "home-A" });
    db.setCompanionHome("hbB", { channel: "telegram", chatId: "home-B" });

    const resolved = resolveAllEnabledConfigs(db, {});
    const cfgA = resolved.find((c) => c.sessionId === "hbA");
    const cfgB = resolved.find((c) => c.sessionId === "hbB");
    check("6 setup: both hbA and hbB resolve as enabled configs", !!cfgA && !!cfgB);

    const enqueued = []; // { sessionId, route } — one entry per fired heartbeat turn
    const pty = {
      isAlive: () => true,
      enqueueStdin: (id, _text, _source, _onDeliver, route) => { enqueued.push({ sessionId: id, route }); return { delivered: false, position: 1 }; },
      getPending: () => [],
    };
    const hbWatcherA = new CompanionHeartbeatWatcher({ db, pty, sessionId: "hbA", intervalMinutes: cfgA.heartbeatIntervalMinutes, prompt: cfgA.heartbeatPrompt });
    const hbWatcherB = new CompanionHeartbeatWatcher({ db, pty, sessionId: "hbB", intervalMinutes: cfgB.heartbeatIntervalMinutes, prompt: cfgB.heartbeatPrompt });

    const now = new Date();
    hbWatcherA.tick(now);
    hbWatcherB.tick(now);
    const fireA = enqueued.find((e) => e.sessionId === "hbA");
    const fireB = enqueued.find((e) => e.sessionId === "hbB");
    check("6a: A's heartbeat carries A's OWN home route", !!fireA && JSON.stringify(fireA.route) === JSON.stringify({ channel: "telegram", chatId: "home-A" }));
    check("6b: B's heartbeat carries B's OWN home route while A is enabled — never A's", !!fireB && JSON.stringify(fireB.route) === JSON.stringify({ channel: "telegram", chatId: "home-B" }));
    check("6c: the exact cross-delivery bug — B's route is NOT A's home", JSON.stringify(fireB.route) !== JSON.stringify(fireA.route));

    // The narrower repro as literally stated on the card: ONLY A's home is ever configured (B's is left
    // unset) — B must NOT inherit A's home (no route at all, same as an unconfigured single companion).
    const db2 = new Db(dbFile("p6b.db"));
    seedSession(db2, "hbC");
    seedSession(db2, "hbD");
    writeConfig(db2, { sessionId: "hbC", token: TOKEN_A, chatId: "chat-C", cadence: 60 });
    writeConfig(db2, { sessionId: "hbD", token: TOKEN_B, chatId: "chat-D", cadence: 60 });
    db2.setCompanionHome("hbC", { channel: "telegram", chatId: "home-C" }); // only hbC has a configured home
    const resolved2 = resolveAllEnabledConfigs(db2, {});
    const cfgD = resolved2.find((c) => c.sessionId === "hbD");
    const enqueued2 = [];
    const pty2 = {
      isAlive: () => true,
      enqueueStdin: (id, _text, _source, _onDeliver, route) => { enqueued2.push({ sessionId: id, route }); return { delivered: false, position: 1 }; },
      getPending: () => [],
    };
    const hbWatcherD = new CompanionHeartbeatWatcher({ db: db2, pty: pty2, sessionId: "hbD", intervalMinutes: cfgD.heartbeatIntervalMinutes, prompt: cfgD.heartbeatPrompt });
    hbWatcherD.tick(new Date());
    const fireD = enqueued2.find((e) => e.sessionId === "hbD");
    check("6d: with ONLY hbC's home configured, hbD's heartbeat carries NO route (never inherits hbC's home)", !!fireD && fireD.route === undefined);
    db2.close();

    db.close();
  }

  // ============ Part 7 — same-home re-arm on a winner's exit (card 134368ac) ============
  // Regression test for the store.ts "KNOWN RESIDUAL LATENCY" gap: two LIVE same-home companions ⇒ the
  // suppression guard arms only the more-active WINNER's heartbeat and zeroes the survivor's. Without this
  // fix, the survivor stayed silently disarmed until the next boot or an unrelated config write once the
  // winner exited. onSessionExit must now re-arm the survivor AS PART OF THE EXIT ITSELF, while never
  // re-starting the now-dead winner's own gateway (that's exactly why onSessionExit bypasses reconcile()).
  {
    const db = new Db(dbFile("p7.db"));
    const gw = makeGatewayBuilder();
    const hb = makeHeartbeatBuilder();
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: () => ({ delivered: true }),
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, buildGateway: gw.builder, buildHeartbeat: hb.builder,
    });
    seedSession(db, "winner");
    seedSession(db, "survivor");
    // Each session has its OWN bound chat (companion_bindings enforces one session per channel+chatId), but
    // both are explicitly configured to deliver proactive messages to the SAME home route — the real-world
    // collision this guard exists for (e.g. two companions, both told to heartbeat the same owner chat).
    writeConfig(db, { sessionId: "winner", token: TOKEN_A, chatId: "chat-winner", cadence: 60 });
    writeConfig(db, { sessionId: "survivor", token: TOKEN_B, chatId: "chat-survivor", cadence: 90 });
    db.setCompanionHome("winner", { channel: "telegram", chatId: "shared-home" });
    db.setCompanionHome("survivor", { channel: "telegram", chatId: "shared-home" });
    // Give "winner" more real activity so the suppression guard's most-active pick is deterministic.
    db.setContextCounters("winner", { ctxInputTokens: 1000, ctxTurns: 50 });
    db.setContextCounters("survivor", { ctxInputTokens: 100, ctxTurns: 5 });
    await controller.startInitial(null);
    await controller.reconcile();
    check("7 setup: both winner and survivor are live", controller.liveSessionIds().sort().join(",") === "survivor,winner");
    check("7 setup: winner's heartbeat is armed (the group's winner)", hb.forSession("winner").length === 1 && hb.forSession("winner")[0].started === 1);
    check("7 setup: survivor's heartbeat is SUPPRESSED (zeroed by the same-home guard)", hb.forSession("survivor").length === 0);

    // The winner's session EXITS — mirrors index.ts's onExit ordering (processState -> exited, then
    // archived, THEN companionController.onSessionExit) — the survivor stays live throughout.
    db.setProcessState("winner", "exited");
    db.archiveSession("winner");
    await controller.onSessionExit("winner");

    check("7a: winner's gateway is torn down and never re-started", gw.forSession("winner").length === 1 && gw.forSession("winner")[0].adapter.stopped === 1);
    check("7a: winner's heartbeat is disarmed", hb.forSession("winner")[0].stopped === 1);
    check("7a: winner is no longer live", controller.liveSessionIds().join(",") === "survivor");
    check("7a: survivor's heartbeat WAS re-armed by the exit itself — not deferred to the next boot/write", hb.forSession("survivor").length === 1 && hb.forSession("survivor")[0].started === 1);
    check("7a: survivor's gateway was never touched (no rebuild)", gw.forSession("survivor").length === 1 && gw.forSession("survivor")[0].adapter.stopped === 0);
    check("7a: chat_reply still gated for survivor, dropped for the exited winner", hooks.companionSessionIds.has("survivor") && !hooks.companionSessionIds.has("winner"));
    db.close();
  }

  // ============ Part 7c — a THREE-way same-home group converges on exactly ONE armed survivor ============
  // With ≥2 surviving siblings after the winner exits, the re-arm must not blanket-arm every sibling — the
  // re-resolved set's own suppression pass picks exactly ONE new winner among them; re-arming every sibling
  // here must converge on that single winner armed, the other(s) still suppressed.
  {
    const db = new Db(dbFile("p7c.db"));
    const gw = makeGatewayBuilder();
    const hb = makeHeartbeatBuilder();
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: () => ({ delivered: true }),
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, buildGateway: gw.builder, buildHeartbeat: hb.builder,
    });
    seedSession(db, "winner3");
    seedSession(db, "runnerUp3");
    seedSession(db, "lastPlace3");
    writeConfig(db, { sessionId: "winner3", token: TOKEN_A, chatId: "chat-winner3", cadence: 60 });
    writeConfig(db, { sessionId: "runnerUp3", token: TOKEN_B, chatId: "chat-runnerup3", cadence: 70 });
    writeConfig(db, { sessionId: "lastPlace3", token: "7333333333:CCtoken-C-secret", chatId: "chat-lastplace3", cadence: 80 });
    db.setCompanionHome("winner3", { channel: "telegram", chatId: "shared-home-3" });
    db.setCompanionHome("runnerUp3", { channel: "telegram", chatId: "shared-home-3" });
    db.setCompanionHome("lastPlace3", { channel: "telegram", chatId: "shared-home-3" });
    // Deterministic ranking: winner3 > runnerUp3 > lastPlace3 by ctxTurns.
    db.setContextCounters("winner3", { ctxInputTokens: 1000, ctxTurns: 50 });
    db.setContextCounters("runnerUp3", { ctxInputTokens: 500, ctxTurns: 20 });
    db.setContextCounters("lastPlace3", { ctxInputTokens: 100, ctxTurns: 5 });
    await controller.startInitial(null);
    await controller.reconcile();
    check("7c setup: all three are live", controller.liveSessionIds().sort().join(",") === "lastPlace3,runnerUp3,winner3");
    check("7c setup: only winner3's heartbeat is armed", hb.forSession("winner3").length === 1 && hb.forSession("runnerUp3").length === 0 && hb.forSession("lastPlace3").length === 0);

    // winner3 exits — among the two survivors, runnerUp3 is now the most active and should become the
    // sole NEW winner; lastPlace3 must stay suppressed (never armed).
    db.setProcessState("winner3", "exited");
    db.archiveSession("winner3");
    await controller.onSessionExit("winner3");

    check("7c: winner3 is no longer live and its gateway was never re-started", controller.liveSessionIds().sort().join(",") === "lastPlace3,runnerUp3" && gw.forSession("winner3").length === 1 && gw.forSession("winner3")[0].adapter.stopped === 1);
    check("7c: EXACTLY ONE survivor (runnerUp3, the new most-active) is armed", hb.forSession("runnerUp3").length === 1 && hb.forSession("runnerUp3")[0].started === 1);
    check("7c: the other survivor (lastPlace3) stays suppressed — never armed", hb.forSession("lastPlace3").length === 0);
    db.close();
  }

  // ============ Part 7b — a solo exit / a non-companion exit are both safe no-ops ============
  {
    const db = new Db(dbFile("p7b.db"));
    const gw = makeGatewayBuilder();
    const hb = makeHeartbeatBuilder();
    const hooks = { companionSessionIds: new Set() };
    const controller = new CompanionController({
      db, submitTurn: () => ({ delivered: true }),
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks, env: {}, buildGateway: gw.builder, buildHeartbeat: hb.builder,
    });
    seedSession(db, "solo7b");
    writeConfig(db, { sessionId: "solo7b", token: TOKEN_A, chatId: "solo-chat", cadence: 60 });
    await controller.startInitial(null);
    await controller.reconcile();
    db.setProcessState("solo7b", "exited");
    db.archiveSession("solo7b");
    await controller.onSessionExit("solo7b");
    check("7b: a solo exit (no same-home live sibling) tears down cleanly with no crash", controller.liveSessionIds().length === 0 && gw.forSession("solo7b")[0].adapter.stopped === 1);

    // A non-companion session's exit (never in cfgs — nothing to re-arm) is a safe no-op too.
    await controller.onSessionExit("never-a-companion");
    check("7b: a non-companion session's exit is a safe no-op", controller.liveSessionIds().length === 0);
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — multi-companion runtime: N enabled configs arm N concurrent gateways (not just the oldest), reconcile diffs start/stop/restart per session without cross-touching any other live companion, a reply/binding for one companion can NEVER reach another's client/route/gateway (proven through the REAL factory's per-session binding scoping), a reconcile scoped to the session that actually changed never rearms an untouched sibling's reminder watcher (the unscoped/boot fallback still rearms everyone, as before), each companion's proactive heartbeat carries ONLY its own configured home route — never a sibling's, and never inherited when only one companion has a home configured — and a same-home winner's exit re-arms its still-live survivor's heartbeat promptly, as part of the exit itself, without ever re-starting the exited session's own gateway."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
