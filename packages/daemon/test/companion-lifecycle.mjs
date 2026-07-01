import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the HOT LIFECYCLE controller (Companion epic Phase 3 backend): the "no .env, no restart"
// half of the PL ruling. Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL envelope key file, an
// INJECTED fake gateway builder (a real ChatGateway wrapping a fake adapter — NO live Telegram / long-poll)
// + an INJECTED fake heartbeat builder (spy handles — no wall-clock interval) + the REAL OrchestrationMcpRouter
// (shared hooks) to observe the chat_reply gate, and the REAL buildServer (app.inject) for the integrated
// REST→reconcile smoke. NO network, NO real claude, NO daemon. Asserts the card DoD:
//   0. default-OFF byte-identical: no config ⇒ startInitial(null) leaves NO gateway, NO heartbeat, chat_reply
//      unregistered on the bound session's MCP surface.
//   1. create-live: an enabled config write + reconcile starts the adapter (once), registers the binding
//      (inbound routes to the bound session; outbound routes back to the chat — NOT cross-wired), flips
//      chat_reply ON for the bound session, and arms the heartbeat — all with NO rebuild/restart.
//   1b. no-reroute: BINDINGS own routing/authz — a config.allowedChatId change does NOT rebuild the adapter
//      and does NOT re-route the live gateway (the durable binding stays authoritative; no phantom route).
//   2. update-live: a cadence change re-arms/disarms the heartbeat (old watcher stopped, ≤1 armed) with NO
//      gateway rebuild; a token change RESTARTS the adapter (old stopped, exactly one new started) and does
//      NOT churn the heartbeat; a no-op reconcile rebuilds/re-arms NOTHING.
//   2b. token-only rebuild: the adapter rebuilds ONLY on a botToken change — sessionId/allowedChatId/
//      chatScope/cadence changes do NOT rebuild it (a sessionId change re-points the gate + heartbeat only).
//   3. delete-live: disable AND hard-delete each tear down to the SAME OFF state as an unconfigured boot
//      (adapter stopped, heartbeat disarmed, chat_reply OFF, snapshot == the Part-0 OFF snapshot).
//   4. toggle idempotency: repeated enable/disable never stacks a watcher or leaks a long-poll — every built
//      adapter/watcher ends stopped except the final live one, and each ENABLE builds exactly one adapter.
//   5. integrated smoke: the REAL buildServer REST (POST/PUT/DELETE /api/companion/config) drives the SAME
//      live controller — POST starts it + lights chat_reply, PUT(new token) restarts the adapter, DELETE
//      tears it to OFF — proving the wiring end-to-end with no restart.
//   6. cascade-on-delete: deleteCompanionConfig cascade-cleans the session's bindings + allowed-senders +
//      pairing codes in one txn (an unrelated session untouched); ONE-WAY (removing a binding never deletes
//      its config — provisioned-but-unarmed is valid).
// Run: 1) build (turbo builds shared first), 2) node test/companion-lifecycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-lifecycle-${Date.now()}-${process.pid}`);
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
const { encryptSecret } = await import("../dist/keys/envelope.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const dbFile = (name) => path.join(tmpHome, name);
const TOKEN_A = "8111111111:AAtoken-A-secret";
const TOKEN_B = "9222222222:BBtoken-B-secret";

// A fake ChannelAdapter that records lifecycle + sends (no network). One is built per gateway build.
function makeFakeAdapter() {
  const adapter = {
    name: "telegram",
    maxMessageLength: 4096,
    started: 0,
    stopped: 0,
    sent: [],
    start() { adapter.started++; },
    async stop() { adapter.stopped++; },
    async send(chatId, text) { adapter.sent.push({ chatId, text }); },
  };
  return adapter;
}

// A fake gateway builder: a REAL ChatGateway (so bind/route/deliver logic is real) wrapping a fake adapter.
// FAITHFUL to the real factory (createCompanionGateway) — routing comes from the DURABLE bindings store
// (db.listCompanionBindings), and cfg.allowedChatId/chatScope only seed the INITIAL binding when the store
// is empty (mirroring LOOM_COMPANION_CHAT_ID). Deriving routing from cfg would MASK a config↔binding
// desync; deriving it from the db is what proves the adapter must NOT be rebuilt on an allowedChatId change.
// Records every gateway built + its adapter so the test can assert start/stop counts + count restarts.
function makeGatewayBuilder(submitSpy) {
  const built = []; // { cfg, gw, adapter } per build
  const builder = (cfg, submitTurn, db) => {
    const adapter = makeFakeAdapter();
    let bindings = db.listCompanionBindings();
    if (bindings.length === 0) {
      db.upsertCompanionBinding({ sessionId: cfg.sessionId, channel: "telegram", chatId: cfg.allowedChatId, scope: cfg.chatScope });
      bindings = db.listCompanionBindings();
    }
    // Origin resolver stand-in for pty.getActiveTurnOrigin: this lifecycle test isn't about per-turn routing
    // nuance (that's covered in companion-multichannel/loop/heartbeat) — it just needs deliverReply to reach
    // the CURRENT gateway's adapter, so resolve a session to its bound route (as if an in-flight turn came
    // from that chat). Reads the SAME durable bindings, so it survives an adapter rebuild.
    const routeFor = (sid) => { const b = bindings.find((x) => x.sessionId === sid); return b ? { channel: b.channel, chatId: b.chatId } : null; };
    const gw = new ChatGateway(
      submitTurn ?? submitSpy,
      bindings.map((b) => ({ sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope })),
      undefined, undefined, routeFor,
    );
    gw.registerAdapter(adapter);
    built.push({ cfg, gw, adapter });
    return gw;
  };
  return { built, builder };
}

// Build a full CompanionConfig (the shape resolveEffectiveConfig returns) for the direct-diff test seam.
function cfgOf({ sessionId, botToken = TOKEN_A, allowedChatId = "chat-1", chatScope = "dm", cadence = 360 }) {
  return {
    botToken, allowedChatId, sessionId, chatScope,
    homeChannel: "telegram", homeChatId: allowedChatId,
    heartbeatIntervalMinutes: cadence, heartbeatPrompt: "PROACTIVE",
  };
}

// A fake heartbeat builder: spy handles recording start/stop so the test can prove no watcher is stacked or
// leaked (each armed watcher must be stopped before the next is armed).
function makeHeartbeatBuilder() {
  const built = []; // { cfg, started, stopped }
  const builder = (cfg) => {
    const h = { cfg, started: 0, stopped: 0, start() { h.started++; }, stop() { h.stopped++; } };
    built.push(h);
    return h;
  };
  return { built, builder };
}

// List the tool names on an orchestration MCP server for (sessionId, role) — used to observe the chat_reply gate.
async function listTools(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "lifecycle-test", version: "0" });
  await client.connect(clientT);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}

// Write a companion config row directly (the durable half of a REST write) — the controller.reconcile then
// picks it up via resolveEffectiveConfig (env empty ⇒ first-enabled row).
function writeConfig(db, { sessionId, token = TOKEN_A, chatId = "chat-1", scope = "dm", cadence = 360, enabled = true }) {
  db.upsertCompanionConfig({
    sessionId, botTokenBlob: encryptSecret(token), channel: "telegram", allowedChatId: chatId,
    chatScope: scope, heartbeatIntervalMinutes: cadence, heartbeatPrompt: null, enabled,
  });
}

// Build a controller + a shared hooks object + an orchMcp that reads the SAME hooks (so chat_reply reflects
// the controller's live gate). Returns everything the assertions need. `resolveEffective` (optional) drives
// applyDesired's diff directly (bypassing resolveEffectiveConfig's single-companion row pick) so a test can
// exercise an ON→ON change of ANY single field in isolation.
function makeRig(db, resolveEffective) {
  const submitted = [];
  const submitSpy = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
  const gw = makeGatewayBuilder(submitSpy);
  const hb = makeHeartbeatBuilder();
  const hooks = { companionSessionId: null, deliverReply: (sid, text) => controller.deliverReply(sid, text) };
  const controller = new CompanionController({
    db,
    submitTurn: submitSpy,
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks,
    env: {},
    buildGateway: gw.builder,
    buildHeartbeat: hb.builder,
    ...(resolveEffective ? { resolveEffective } : {}),
  });
  const orch = new OrchestrationMcpRouter(db, {}, hooks);
  return { submitted, gw, hb, hooks, controller, orch };
}

const chatReplyOn = async (orch, sessionId) => (await listTools(orch.buildServer(sessionId, "assistant"))).includes("chat_reply");

try {
  // ============ Part 0 — default-OFF byte-identical ============
  {
    const db = new Db(dbFile("p0.db"));
    const rig = makeRig(db);
    await rig.controller.startInitial(null); // no config at boot
    const snap = rig.controller.snapshot();
    check("off: startInitial(null) built NO gateway", rig.gw.built.length === 0 && snap.running === false);
    check("off: NO heartbeat armed", rig.hb.built.length === 0 && snap.heartbeatArmed === false);
    check("off: chat_reply gate is null (companionSessionId)", rig.hooks.companionSessionId === null);
    check("off: chat_reply NOT registered on any session's MCP surface", (await chatReplyOn(rig.orch, "assist-1")) === false);
    db.close();
  }

  // ============ Part 1 — create-live ============
  const OFF_SNAP = JSON.stringify({ running: false, sessionId: null, heartbeatArmed: false });
  {
    const db = new Db(dbFile("p1.db"));
    const rig = makeRig(db);
    await rig.controller.startInitial(null);
    check("create: OFF before the config write", JSON.stringify(rig.controller.snapshot()) === OFF_SNAP);

    writeConfig(db, { sessionId: "assist-1", cadence: 360 });
    await rig.controller.reconcile(); // the hot path — no restart

    check("create: adapter built + started exactly once (no restart)", rig.gw.built.length === 1 && rig.gw.built[0].adapter.started === 1 && rig.gw.built[0].adapter.stopped === 0);
    check("create: heartbeat armed (cadence>0)", rig.hb.built.length === 1 && rig.hb.built[0].started === 1 && rig.controller.snapshot().heartbeatArmed === true);
    check("create: chat_reply gate ON for the bound session", rig.hooks.companionSessionId === "assist-1" && (await chatReplyOn(rig.orch, "assist-1")) === true);
    check("create: chat_reply still OFF for a DIFFERENT session (single-session gate)", (await chatReplyOn(rig.orch, "other-sess")) === false);
    // Binding registered: INBOUND routes to the bound session via submitTurn (NOT the outbound path).
    const inb = await rig.gw.built[0].gw.handleInbound({ channel: "telegram", chatId: "chat-1", body: "hello" });
    check("create: inbound to the bound chat submits a TURN (binding registered, inbound=submitTurn)", inb.accepted === true && rig.submitted.length === 1 && rig.submitted[0].sid === "assist-1" && rig.submitted[0].text === "hello");
    // OUTBOUND routes back to the chat via the adapter — NEVER submits a turn (not cross-wired).
    const out = await rig.controller.deliverReply("assist-1", "hi back");
    check("create: chat_reply/deliverReply routes OUT to the chat (outbound=deliverReply, no extra turn)", out.delivered === true && rig.gw.built[0].adapter.sent.length === 1 && rig.gw.built[0].adapter.sent[0].chatId === "chat-1" && rig.submitted.length === 1);
    db.close();
  }

  // ============ Part 1b — a config write does NOT silently re-route (bindings are authoritative) ============
  // BINDINGS (companion_bindings) own routing/authz; config.allowedChatId only SEEDS the initial binding.
  // Changing config.allowedChatId must NOT re-route the live gateway (and must NOT rebuild the adapter) —
  // otherwise a config edit would silently claim a new route the bindings layer never granted.
  {
    const db = new Db(dbFile("p1b.db"));
    const rig = makeRig(db);
    writeConfig(db, { sessionId: "assist-1", chatId: "chat-1", cadence: 0 });
    await rig.controller.startInitial(null);
    await rig.controller.reconcile();
    check("no-reroute: seeded binding routes chat-1", (await rig.gw.built[0].gw.handleInbound({ channel: "telegram", chatId: "chat-1", body: "a" })).accepted === true);

    // Change ONLY config.allowedChatId → chat-2. No rebuild; routing UNCHANGED (still chat-1, not chat-2).
    writeConfig(db, { sessionId: "assist-1", chatId: "chat-2", cadence: 0 });
    await rig.controller.reconcile();
    check("no-reroute: allowedChatId change did NOT rebuild the adapter", rig.gw.built.length === 1 && rig.gw.built[0].adapter.stopped === 0);
    const stillOld = await rig.gw.built[0].gw.handleInbound({ channel: "telegram", chatId: "chat-1", body: "b" });
    const newRejected = await rig.gw.built[0].gw.handleInbound({ channel: "telegram", chatId: "chat-2", body: "c" });
    check("no-reroute: the DURABLE binding (chat-1) still routes — config did not silently re-route", stillOld.accepted === true);
    check("no-reroute: the new config chatId (chat-2) is NOT routed (no phantom route from a config write)", newRejected.accepted === false && newRejected.reason === "chat-not-allowlisted");
    db.close();
  }

  // ============ Part 2 — update-live ============
  {
    const db = new Db(dbFile("p2.db"));
    const rig = makeRig(db);
    writeConfig(db, { sessionId: "assist-1", token: TOKEN_A, cadence: 360 });
    await rig.controller.startInitial(null);
    await rig.controller.reconcile();
    check("update: baseline — 1 adapter, 1 watcher", rig.gw.built.length === 1 && rig.hb.built.length === 1);
    const adapter0 = rig.gw.built[0].adapter;
    const watcher0 = rig.hb.built[0];

    // (2a) cadence → 0 disarms the heartbeat; NO gateway rebuild.
    writeConfig(db, { sessionId: "assist-1", token: TOKEN_A, cadence: 0 });
    await rig.controller.reconcile();
    check("update(cadence→0): old watcher STOPPED, none re-armed", watcher0.stopped === 1 && rig.hb.built.length === 1 && rig.controller.snapshot().heartbeatArmed === false);
    check("update(cadence→0): NO gateway rebuild (same adapter, still live)", rig.gw.built.length === 1 && adapter0.started === 1 && adapter0.stopped === 0);

    // (2b) cadence 0 → 120 re-arms a FRESH watcher; NO gateway rebuild.
    writeConfig(db, { sessionId: "assist-1", token: TOKEN_A, cadence: 120 });
    await rig.controller.reconcile();
    check("update(cadence→120): a FRESH watcher armed (exactly one live)", rig.hb.built.length === 2 && rig.hb.built[1].started === 1 && rig.hb.built[1].stopped === 0 && rig.controller.snapshot().heartbeatArmed === true);
    check("update(cadence→120): STILL no gateway rebuild", rig.gw.built.length === 1);
    const watcher1 = rig.hb.built[1];

    // (2c) token change RESTARTS the adapter (old stopped, one new started); heartbeat NOT churned (cadence same).
    writeConfig(db, { sessionId: "assist-1", token: TOKEN_B, cadence: 120 });
    await rig.controller.reconcile();
    check("update(token): OLD adapter stopped (no leaked long-poll)", adapter0.stopped === 1);
    check("update(token): exactly ONE new adapter built + started", rig.gw.built.length === 2 && rig.gw.built[1].adapter.started === 1 && rig.gw.built[1].adapter.stopped === 0);
    check("update(token): heartbeat NOT churned (cadence unchanged — same watcher still live)", rig.hb.built.length === 2 && watcher1.stopped === 0);
    check("update(token): chat_reply still ON, still routes via the CURRENT gateway", (await chatReplyOn(rig.orch, "assist-1")) === true && (await rig.controller.deliverReply("assist-1", "x")).delivered === true && rig.gw.built[1].adapter.sent.length === 1);

    // (2d) a no-op reconcile (identical config) rebuilds/re-arms NOTHING.
    await rig.controller.reconcile();
    check("update(no-op): identical reconcile builds no adapter + re-arms no watcher", rig.gw.built.length === 2 && rig.hb.built.length === 2 && watcher1.stopped === 0);
    db.close();
  }

  // ============ Part 2b — the adapter rebuilds ONLY on a botToken change (direct applyDesired diff) ============
  // Drive applyDesired's diff via the resolveEffective seam so each field can change in ISOLATION (the
  // single-companion row-pick can't produce an ON→ON sessionId change). Proves the adapter/long-poll is
  // rebuilt ONLY on a token change, while sessionId/allowedChatId/chatScope/cadence changes do NOT rebuild
  // it (they either no-op or re-point the chat_reply gate + heartbeat, which routing/authz do NOT depend on).
  {
    const db = new Db(dbFile("p2b.db"));
    let desired = cfgOf({ sessionId: "s1", botToken: TOKEN_A, allowedChatId: "c1", chatScope: "dm", cadence: 360 });
    const rig = makeRig(db, () => desired);
    await rig.controller.reconcile(); // OFF → ON (build #1)
    check("diff: initial build", rig.gw.built.length === 1 && rig.hb.built.length === 1 && rig.hooks.companionSessionId === "s1");

    desired = { ...desired, allowedChatId: "c2" };
    await rig.controller.reconcile();
    check("diff: allowedChatId change → NO adapter rebuild", rig.gw.built.length === 1);

    desired = { ...desired, chatScope: "group" };
    await rig.controller.reconcile();
    check("diff: chatScope change → NO adapter rebuild", rig.gw.built.length === 1);

    desired = { ...desired, heartbeatIntervalMinutes: 120 };
    await rig.controller.reconcile();
    check("diff: cadence change → NO adapter rebuild (heartbeat re-armed only)", rig.gw.built.length === 1 && rig.hb.built.length === 2);

    desired = { ...desired, sessionId: "s2" };
    await rig.controller.reconcile();
    check("diff: sessionId change → NO adapter rebuild, but gate + heartbeat re-point to s2", rig.gw.built.length === 1 && rig.hooks.companionSessionId === "s2" && rig.hb.built.length === 3 && rig.hb.built[2].cfg.sessionId === "s2");

    desired = { ...desired, botToken: TOKEN_B };
    await rig.controller.reconcile();
    check("diff: botToken change → REBUILD (old adapter stopped, exactly one new started)", rig.gw.built.length === 2 && rig.gw.built[0].adapter.stopped === 1 && rig.gw.built[1].adapter.started === 1 && rig.gw.built[1].adapter.stopped === 0);
    db.close();
  }

  // ============ Part 3 — delete-live (disable AND hard-delete → OFF) ============
  {
    const db = new Db(dbFile("p3.db"));
    const rig = makeRig(db);
    writeConfig(db, { sessionId: "assist-1", cadence: 360 });
    await rig.controller.startInitial(null);
    await rig.controller.reconcile();
    check("delete: live before teardown", rig.controller.snapshot().running === true);
    const adapter0 = rig.gw.built[0].adapter;
    const watcher0 = rig.hb.built[0];

    // (3a) DISABLE (enabled:false) → OFF.
    writeConfig(db, { sessionId: "assist-1", cadence: 360, enabled: false });
    await rig.controller.reconcile();
    check("delete(disable): adapter stopped (long-poll released)", adapter0.stopped === 1);
    check("delete(disable): heartbeat disarmed", watcher0.stopped === 1 && rig.controller.snapshot().heartbeatArmed === false);
    check("delete(disable): chat_reply OFF (gate cleared)", rig.hooks.companionSessionId === null && (await chatReplyOn(rig.orch, "assist-1")) === false);
    check("delete(disable): snapshot byte-identical to the OFF state", JSON.stringify(rig.controller.snapshot()) === OFF_SNAP);

    // (3b) re-enable then HARD-DELETE the row → OFF again (no leak across the re-enable).
    writeConfig(db, { sessionId: "assist-1", cadence: 360, enabled: true });
    await rig.controller.reconcile();
    check("delete(re-enable): back live, fresh adapter", rig.controller.snapshot().running === true && rig.gw.built.length === 2 && rig.gw.built[1].adapter.started === 1);
    db.deleteCompanionConfig("assist-1");
    await rig.controller.reconcile();
    check("delete(hard): row gone → adapter stopped + OFF snapshot", rig.gw.built[1].adapter.stopped === 1 && JSON.stringify(rig.controller.snapshot()) === OFF_SNAP);
    check("delete(hard): chat_reply OFF", (await chatReplyOn(rig.orch, "assist-1")) === false);
    db.close();
  }

  // ============ Part 4 — toggle idempotency (no stacked watcher / leaked long-poll) ============
  {
    const db = new Db(dbFile("p4.db"));
    const rig = makeRig(db);
    await rig.controller.startInitial(null);
    for (let i = 0; i < 4; i++) {
      writeConfig(db, { sessionId: "assist-1", cadence: 360, enabled: true });
      await rig.controller.reconcile(); // enable
      writeConfig(db, { sessionId: "assist-1", cadence: 360, enabled: false });
      await rig.controller.reconcile(); // disable
    }
    // 4 enable transitions ⇒ exactly 4 adapters + 4 watchers built; every one stopped (ended OFF).
    check("toggle: exactly one adapter built per ENABLE (no double-start)", rig.gw.built.length === 4);
    check("toggle: every built adapter started once and is now stopped (no leaked long-poll)", rig.gw.built.every((b) => b.adapter.started === 1 && b.adapter.stopped === 1));
    check("toggle: exactly one watcher built per ENABLE, all stopped (no stacked watcher)", rig.hb.built.length === 4 && rig.hb.built.every((h) => h.started === 1 && h.stopped === 1));
    check("toggle: ends in the OFF state (gate cleared)", JSON.stringify(rig.controller.snapshot()) === OFF_SNAP && rig.hooks.companionSessionId === null);
    // A redundant enable while ALREADY live must not stack a second adapter.
    writeConfig(db, { sessionId: "assist-1", cadence: 360, enabled: true });
    await rig.controller.reconcile();
    const builtAfterEnable = rig.gw.built.length; // 5
    await rig.controller.reconcile(); // identical — no-op
    await rig.controller.reconcile(); // identical — no-op
    check("toggle: redundant enable/reconcile does NOT stack a second live adapter", rig.gw.built.length === builtAfterEnable && rig.gw.built[builtAfterEnable - 1].adapter.stopped === 0);
    db.close();
  }

  // ============ Part 5 — integrated smoke: the REAL buildServer REST drives the SAME live controller ============
  {
    const db = new Db(dbFile("p5.db"));
    const rig = makeRig(db);
    await rig.controller.startInitial(null);
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: rig.controller, requestShutdown: () => {} });

    // POST create → 201, and the LIVE controller started (no restart), chat_reply lit.
    const create = await app.inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "assist-1", botToken: TOKEN_A, allowedChatId: "chat-1", chatScope: "dm", heartbeatIntervalMinutes: 360,
    } });
    check("REST create: → 201", create.statusCode === 201);
    check("REST create: controller went live via reconcile (adapter started, heartbeat armed)", rig.controller.snapshot().running === true && rig.gw.built.length === 1 && rig.gw.built[0].adapter.started === 1 && rig.controller.snapshot().heartbeatArmed === true);
    check("REST create: chat_reply lit for the bound session", (await chatReplyOn(rig.orch, "assist-1")) === true);

    // PUT a new token → the adapter restarts live (old stopped, one new started).
    const put = await app.inject({ method: "PUT", url: "/api/companion/config/assist-1", payload: { botToken: TOKEN_B } });
    check("REST put(token): → 200", put.statusCode === 200);
    check("REST put(token): adapter RESTARTED live (old stopped, new started)", rig.gw.built.length === 2 && rig.gw.built[0].adapter.stopped === 1 && rig.gw.built[1].adapter.started === 1 && rig.gw.built[1].adapter.stopped === 0);

    // DELETE → torn down to OFF, chat_reply gone.
    const del = await app.inject({ method: "DELETE", url: "/api/companion/config/assist-1" });
    check("REST delete: → 200", del.statusCode === 200);
    check("REST delete: controller torn down to OFF (adapter stopped, gate cleared)", rig.gw.built[1].adapter.stopped === 1 && JSON.stringify(rig.controller.snapshot()) === OFF_SNAP);
    check("REST delete: chat_reply gone", (await chatReplyOn(rig.orch, "assist-1")) === false);

    await app.close();
    db.close();
  }

  // ============ Part 6 — deleteCompanionConfig CASCADES routing/authz cleanup (one-way, data-integrity) ============
  // Deleting a config must cascade-clean its bindings + allowed-senders + pairing codes in ONE txn so no
  // stale row routes to a torn-down companion. ONE-WAY: an unrelated session is untouched, and removing a
  // BINDING never deletes a config (provisioned-but-unarmed is a valid state). pairing_attempts (keyed by
  // channel+sender, self-expiring) is deliberately NOT cascaded.
  {
    const db = new Db(dbFile("p6.db"));
    for (const s of ["A", "B"]) {
      writeConfig(db, { sessionId: `sess-${s}`, chatId: `chat-${s}`, scope: "group" });
      db.upsertCompanionBinding({ sessionId: `sess-${s}`, channel: "telegram", chatId: `chat-${s}`, scope: "group" });
      db.addAllowedSender({ sessionId: `sess-${s}`, channel: "telegram", senderId: `sender-${s}`, label: null });
    }
    const codeA = db.mintPairingCode({ sessionId: "sess-A", channel: "telegram", grantType: "dm-bind", ttlMs: 600_000 }, 1000);
    const codeB = db.mintPairingCode({ sessionId: "sess-B", channel: "telegram", grantType: "dm-bind", ttlMs: 600_000 }, 1000);
    check("cascade: preconditions — both sessions fully provisioned (config+binding+sender+code)",
      !!db.getCompanionConfig("sess-A") && db.listCompanionBindings().length === 2 && db.listAllowedSenders("sess-A").length === 1 && !!db.getPairingCodeById(codeA.codeId));

    db.deleteCompanionConfig("sess-A");

    check("cascade: config row for A removed", db.getCompanionConfig("sess-A") === undefined);
    check("cascade: A's binding removed", db.listCompanionBindings().every((b) => b.sessionId !== "sess-A"));
    check("cascade: A's allowed-senders removed", db.listAllowedSenders("sess-A").length === 0);
    check("cascade: A's pairing code removed", db.getPairingCodeById(codeA.codeId) === undefined);
    // Isolation: the unrelated session B is fully intact (the cascade is session-scoped).
    check("cascade: unrelated session B config intact", !!db.getCompanionConfig("sess-B"));
    check("cascade: B's binding intact", db.listCompanionBindings().some((b) => b.sessionId === "sess-B"));
    check("cascade: B's allowed-senders intact", db.listAllowedSenders("sess-B").length === 1);
    check("cascade: B's pairing code intact", !!db.getPairingCodeById(codeB.codeId));
    // Idempotent + ONE-WAY: deleting a nonexistent config is a no-op; removing a BINDING does NOT delete its config.
    db.deleteCompanionConfig("sess-nonexistent");
    db.deleteCompanionBinding("sess-B");
    check("cascade: one-way — removing B's binding did NOT delete B's config (provisioned-but-unarmed is valid)", !!db.getCompanionConfig("sess-B"));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the hot lifecycle controller drives the running companion LIVE from config writes: create starts the adapter + binding + chat_reply + heartbeat with no restart, cadence changes re-arm/disarm the heartbeat, token changes restart the adapter with no leaked long-poll, disable/delete tear down to the OFF state, repeated toggles never stack a watcher or leak a poll, and the REAL REST drives the same live controller end-to-end."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
