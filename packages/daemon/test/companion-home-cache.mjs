import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — home-cache staleness fix (card af12f808, surfaced by the 134368ac CR). Fully hermetic: a
// REAL Db on a temp LOOM_HOME + a REAL CompanionController (injected fake gateway/heartbeat builders — no
// live Telegram) + the REAL buildServer (app.inject) for the actual PUT/DELETE /api/companion/home routes.
// NO network, NO real claude, NO daemon. Asserts the card DoD:
//   1. PUT /api/companion/home on a LIVE session refreshes the controller's cached `cfgs` entry
//      (homeChannel/homeChatId) to the NEW home — not the value cached at the last applyDesired visit.
//   2. DELETE /api/companion/home likewise refreshes the cache — a subsequent read reflects the FALLBACK
//      home (the config row's own channel/allowedChatId), never the just-cleared value.
//   3. a home write for a session with NO live companion (never armed) is a safe no-op — no throw, and the
//      durable DB write still lands (the REST response is unaffected by whether reconcile finds it live).
// Run: 1) build (turbo builds shared first), 2) node test/companion-home-cache.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-home-cache-${Date.now()}-${process.pid}`);
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
const { buildServer } = await import("../dist/gateway/server.js");

const dbFile = (name) => path.join(tmpHome, name);

// A fake gateway builder — a REAL ChatGateway wrapping a fake (no-network) adapter, mirroring the shape used
// by companion-lifecycle.mjs/companion-multi.mjs. Home isn't consumed by the gateway build itself; this only
// needs to arm the session LIVE so the controller's `cfgs` cache gets populated for it.
function makeGatewayBuilder() {
  const built = [];
  const builder = (cfg, submitTurn, db) => {
    let bindings = db.listCompanionBindings().filter((b) => b.sessionId === cfg.sessionId);
    if (bindings.length === 0) {
      db.upsertCompanionBinding({ sessionId: cfg.sessionId, channel: "in-app", chatId: cfg.sessionId, scope: cfg.chatScope });
      bindings = db.listCompanionBindings().filter((b) => b.sessionId === cfg.sessionId);
    }
    const gw = new ChatGateway(submitTurn, bindings.map((b) => ({ sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope })));
    built.push({ cfg, gw });
    return gw;
  };
  return { built, builder };
}

function makeRig(db) {
  const gw = makeGatewayBuilder();
  const hooks = { companionSessionIds: new Set() };
  const controller = new CompanionController({
    db,
    submitTurn: () => ({ delivered: true }),
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks,
    env: {},
    buildGateway: gw.builder,
    buildHeartbeat: (cfg) => ({ cfg, start() {}, stop() {} }),
  });
  return { gw, hooks, controller };
}

function writeConfig(db, { sessionId, channel = "telegram", chatId = "chat-default", enabled = true }) {
  db.upsertCompanionConfig({
    sessionId, botTokenBlob: "", channel, allowedChatId: chatId,
    chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled,
  });
}

try {
  // ============ Part 1 — PUT /api/companion/home refreshes a LIVE session's cached home ============
  {
    const db = new Db(dbFile("p1.db"));
    const rig = makeRig(db);
    writeConfig(db, { sessionId: "assist-1", channel: "telegram", chatId: "chat-default" });
    db.setCompanionHome("assist-1", { channel: "telegram", chatId: "chat-old" });
    await rig.controller.reconcile(); // boot-equivalent: arm the live set from the DB
    check("precondition: session is live", rig.controller.liveSessionIds().includes("assist-1"));
    check("precondition: cache holds the OLD home", rig.controller.configFor("assist-1")?.homeChannel === "telegram" && rig.controller.configFor("assist-1")?.homeChatId === "chat-old");

    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: rig.controller, requestShutdown: () => {} });

    const put = await app.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "assist-1", channel: "discord", chatId: "chat-new" } });
    check("REST PUT home: → 200", put.statusCode === 200);
    check("REST PUT home: durable row reflects the new home", JSON.stringify(JSON.parse(put.payload)) === JSON.stringify({ channel: "discord", chatId: "chat-new" }));
    // THE FIX: the controller's live cfgs cache is refreshed by the SAME write — no boot / unrelated config
    // write required. Before the fix this stayed "telegram"/"chat-old" until some other reconcile happened.
    const afterPut = rig.controller.configFor("assist-1");
    check("cache refreshed on PUT: homeChannel now discord", afterPut?.homeChannel === "discord");
    check("cache refreshed on PUT: homeChatId now chat-new", afterPut?.homeChatId === "chat-new");
    check("PUT: still exactly one live session (no spurious start/stop)", rig.controller.liveSessionIds().length === 1);

    await app.close();
    db.close();
  }

  // ============ Part 2 — DELETE /api/companion/home refreshes the cache to the FALLBACK home ============
  {
    const db = new Db(dbFile("p2.db"));
    const rig = makeRig(db);
    writeConfig(db, { sessionId: "assist-2", channel: "telegram", chatId: "chat-default-2" });
    db.setCompanionHome("assist-2", { channel: "discord", chatId: "chat-set" });
    await rig.controller.reconcile();
    check("precondition: cache holds the SET home", rig.controller.configFor("assist-2")?.homeChannel === "discord" && rig.controller.configFor("assist-2")?.homeChatId === "chat-set");

    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: rig.controller, requestShutdown: () => {} });

    const del = await app.inject({ method: "DELETE", url: "/api/companion/home?sessionId=assist-2" });
    check("REST DELETE home: → 200", del.statusCode === 200);
    check("REST DELETE home: app_meta home cleared", db.getCompanionHome("assist-2") === null);
    // THE FIX: the cache falls back to the config row's OWN channel/allowedChatId (buildConfigFromRow's
    // `home?.channel ?? row.channel` / `home?.chatId ?? row.allowedChatId`) — never the just-cleared value.
    const afterDelete = rig.controller.configFor("assist-2");
    check("cache refreshed on DELETE: homeChannel falls back to the row's own channel", afterDelete?.homeChannel === "telegram");
    check("cache refreshed on DELETE: homeChatId falls back to the row's own allowedChatId", afterDelete?.homeChatId === "chat-default-2");
    check("cache refreshed on DELETE: NOT the stale cleared value", afterDelete?.homeChannel !== "discord" && afterDelete?.homeChatId !== "chat-set");

    await app.close();
    db.close();
  }

  // ============ Part 3 — a home write for a session with NO live companion is a safe no-op ============
  {
    const db = new Db(dbFile("p3.db"));
    const rig = makeRig(db);
    // No config row / no reconcile — "never-armed" has no live cfgs entry at all.
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: rig.controller, requestShutdown: () => {} });

    const put = await app.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "never-armed", channel: "telegram", chatId: "chat-x" } });
    check("not-live PUT: still → 200 (durable write unaffected by live reconcile)", put.statusCode === 200);
    check("not-live PUT: no session was spuriously started", rig.controller.liveSessionIds().length === 0);
    const del = await app.inject({ method: "DELETE", url: "/api/companion/home?sessionId=never-armed" });
    check("not-live DELETE: still → 200", del.statusCode === 200);

    await app.close();
    db.close();
  }
} catch (err) {
  console.error("FATAL:", err);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
