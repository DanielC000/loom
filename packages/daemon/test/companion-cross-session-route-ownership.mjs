import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — BINDING OWNERSHIP at the outbound delivery chokepoint (card c7d7b43a, part A; from the
// ddf08614 delta review, reviewer 030f7f60; FIX ROUND after a second security review found the first pass
// exempted the one vector that's actually reachable in production).
//
// The first pass framed this as "ChatGateway.deliveryBlockReason resolves bindings via a GLOBAL
// (cross-session) lookup" and wrote the fix as a binding-ownership check that explicitly EXEMPTED the
// in-app channel. Both halves of that framing were wrong in production shape: every `ChatGateway` is built
// PER SESSION (controller.ts keys gateways by sessionId; factory.ts filters `db.listCompanionBindings()` to
// `cfg.sessionId`), so a route-foreign-session binding-ownership mismatch can never actually fire for
// Telegram — the binding a gateway resolves always already belongs to that gateway's own session. The ONE
// shared adapter is the in-app channel: a single `InAppChannel` instance (built once at boot) is registered
// on EVERY gateway (factory.ts), and in-app is treated as always-live with NO binding row to consult — so
// the old "exemption" left the only reachable cross-session vector wide open: session A's turn-origin
// resolving (a home/origin-resolution bug) to `{channel: in-app, chatId: sess-B}` would deliver A's reply
// into B's own history AND push it live to B's attached web client.
//
// Parts 1-5 below are rewritten against PRODUCTION-SHAPED wiring: two REAL per-session gateways
// (`createCompanionGateway`, the actual factory) built by a REAL `CompanionController`, sharing ONE REAL
// `InAppChannel` instance — exactly how `index.ts` wires it — rather than two bare, hand-built
// `ChatGateway`s. Part 6 covers the Telegram-channel ownership check (still true defense in depth, even
// though it's structurally unreachable given the per-session scoping above) at the pure-unit level, same
// shape as the first pass's own tests. Part 7 is the unit-level MINOR: the foreign check must run BEFORE
// the group-scope exemption. Part 8 is the unit-level NITPICK: sendToChannel's refusal now also warns +
// dedupes, same as deliverReply/deliverMedia.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME (mirrors companion-multi.mjs's Part 3 rig) + a REAL
// InAppChannel + the REAL factory/controller. NO real Telegram network, NO real claude, NO daemon.
//
// RED-then-GREEN: this file was run once against the UNFIXED `companionRouteBlockReason` (reconcile.ts
// restored to its pre-fix-round state via a captured patch, rebuilt, re-run) to confirm Part 1 below
// actually FAILS against the bug this card closes — see the worker's `done` report for the captured
// output. It is run normally (green) against the fixed code as the committed state.
//
// Run: 1) build (turbo builds shared first), 2) node test/companion-cross-session-route-ownership.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-xsession-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
for (const k of Object.keys(process.env)) if (k.startsWith("LOOM_COMPANION_")) delete process.env[k];

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createCompanionGateway } = await import("../dist/companion/factory.js");
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { companionRouteBlockReason } = await import("../dist/companion/reconcile.js");
const { buildServer } = await import("../dist/gateway/server.js");

const dbFile = (name) => path.join(tmpHome, name);

try {
  // ====== PRODUCTION-SHAPED RIG (mirrors companion-multi.mjs Part 3 and index.ts's real wiring) ==========
  // Two in-app-only companions, each with its own real gateway built by the real factory, sharing ONE real
  // InAppChannel instance. `originResolver` is the SAME single shared closure production uses (index.ts's
  // `(sid) => pty.getActiveTurnOrigin(sid)`) — here backed by a plain per-session-route map so a test can
  // rig a session's turn-origin to anything, including a FOREIGN route (the exact shape a home/turn-origin
  // bug would produce).
  function buildRig(dbName) {
    const db = new Db(dbFile(dbName));
    const inApp = new InAppChannel();
    db.upsertCompanionBinding({ sessionId: "sess-A", channel: IN_APP_CHANNEL, chatId: "sess-A", scope: "dm" });
    db.upsertCompanionBinding({ sessionId: "sess-B", channel: IN_APP_CHANNEL, chatId: "sess-B", scope: "dm" });
    const origins = new Map(); // sessionId -> CompanionRoute | null, mutable per-test
    const originResolver = (sid) => origins.get(sid) ?? null;
    const built = new Map(); // sessionId -> the REAL gateway createCompanionGateway built for it
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
    hooks.deliverReply = (sid, text, voice) => controller.deliverReply(sid, text, voice);
    hooks.deliverMedia = (sid, filePath) => controller.deliverMedia(sid, filePath);
    db.upsertCompanionConfig({ sessionId: "sess-A", botTokenBlob: "", channel: IN_APP_CHANNEL, allowedChatId: "sess-A", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    db.upsertCompanionConfig({ sessionId: "sess-B", botTokenBlob: "", channel: IN_APP_CHANNEL, allowedChatId: "sess-B", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    return { db, inApp, controller, built, origins };
  }

  // ============ 1 — THE EXPLOIT: session A's turn-origin resolves to session B's OWN in-app route ========
  // This is the reproduction the review demanded: production-shaped wiring (two REAL per-session gateways
  // sharing ONE REAL InAppChannel), a forged turn-origin naming a DIFFERENT session's chatId, delivered via
  // the SAME controller.deliverReply path chat_reply itself uses — never the gateway constructed by hand.
  {
    const rig = buildRig("p1.db");
    await rig.controller.startInitial(null);
    await rig.controller.reconcile();
    rig.origins.set("sess-A", { channel: IN_APP_CHANNEL, chatId: "sess-B" }); // the forged cross-session route

    const framesA = []; const framesB = [];
    rig.inApp.attach("sess-A", { deliver: (f) => framesA.push(f) });
    rig.inApp.attach("sess-B", { deliver: (f) => framesB.push(f) });

    const r = await rig.controller.deliverReply("sess-A", "should never reach session B's chat");
    check("1: deliverReply refuses with route-foreign-session", r.delivered === false && r.reason === "route-foreign-session");
    check("1: session B's attached web client received NOTHING", framesB.length === 0);
    check("1: session A's own attached web client also received nothing (the reply was refused, not redirected)", framesA.length === 0);

    rig.db.close();
  }

  // ============ 2 — POSITIVE CONTROL: the SAME rig, session A replying on its OWN in-app route ============
  {
    const rig = buildRig("p2.db");
    await rig.controller.startInitial(null);
    await rig.controller.reconcile();
    rig.origins.set("sess-A", { channel: IN_APP_CHANNEL, chatId: "sess-A" }); // A's own, genuine route

    const framesA = []; const framesB = [];
    rig.inApp.attach("sess-A", { deliver: (f) => framesA.push(f) });
    rig.inApp.attach("sess-B", { deliver: (f) => framesB.push(f) });

    const r = await rig.controller.deliverReply("sess-A", "this is my own route");
    check("2 (control): delivering to one's own in-app route still succeeds", r.delivered === true);
    check("2 (control): session A's own client received EXACTLY this reply", framesA.length === 1 && framesA[0].text === "this is my own route");
    check("2 (control): session B's client received nothing", framesB.length === 0);

    rig.db.close();
  }

  // ============ 3 — deliverMedia ALSO refuses the same forged in-app cross-session route =================
  {
    const rig = buildRig("p3.db");
    await rig.controller.startInitial(null);
    await rig.controller.reconcile();
    rig.origins.set("sess-A", { channel: IN_APP_CHANNEL, chatId: "sess-B" });

    const framesB = [];
    rig.inApp.attach("sess-B", { deliver: (f) => framesB.push(f) });

    const r = await rig.controller.deliverMedia("sess-A", "C:/tmp/whatever.png");
    check("3: deliverMedia refuses a foreign-session in-app route", r.delivered === false && r.reason === "route-foreign-session");
    check("3: nothing reached session B's client", framesB.length === 0);

    rig.db.close();
  }

  // ============ 4 — sendVia's per-chunk recheck: a Telegram route reassigned mid-stream still refuses =====
  // Kept at the hand-built ChatGateway level (unlike 1-3 above) because this exercises an in-process
  // mid-flight re-bind race that the production rig has no seam to inject deterministically — same shape
  // as the first pass's own mid-flight test, retained as true defense in depth for the Telegram channel.
  {
    const bindingA = { sessionId: "sess-A4", channel: "telegram", chatId: "333333333", scope: "dm" };
    const gw = new ChatGateway(
      () => ({ delivered: true }), [bindingA], undefined, undefined,
      (sid) => (sid === "sess-A4" ? { channel: "telegram", chatId: "333333333" } : null),
    );
    const chunkSent = [];
    const chunkyAdapter = {
      name: "telegram", maxMessageLength: 10, start() {}, async stop() {},
      async send(chatId, text) {
        chunkSent.push({ chatId, text });
        if (chunkSent.length === 1) {
          gw.unbind("sess-A4", "telegram");
          gw.bind({ sessionId: "sess-B4", channel: "telegram", chatId: "333333333", scope: "dm" });
        }
      },
    };
    gw.registerAdapter(chunkyAdapter);
    const r = await gw.deliverReply("sess-A4", "one two three four five six");
    check("4: mid-flight Telegram ownership flip stops sendVia after the chunk already in flight", r.delivered === false && r.reason === "route-foreign-session");
    check("4: exactly ONE chunk reached the adapter", chunkSent.length === 1);
  }

  // ============ 5 — the shared `warnedForeignSessionRoutes` dedupe fires once per (session, channel) ======
  {
    const rig = buildRig("p5.db");
    await rig.controller.startInitial(null);
    await rig.controller.reconcile();
    rig.origins.set("sess-A", { channel: IN_APP_CHANNEL, chatId: "sess-B" });

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      await rig.controller.deliverReply("sess-A", "attempt 1");
      await rig.controller.deliverReply("sess-A", "attempt 2");
    } finally {
      console.warn = origWarn;
    }
    const securityWarnings = warnings.filter((w) => w.includes("route-foreign-session") || w.includes("SECURITY"));
    check("5: exactly ONE foreign-session warning logged across two refused attempts (deduped)", securityWarnings.length === 1);

    rig.db.close();
  }

  // ============ 6 — UNIT LEVEL: the Telegram-channel ownership check (true defense in depth) =============
  // Structurally unreachable in production (every gateway is built per-session — see the header above), but
  // kept as the SAME cheap insurance the first pass added: a binding naming a foreign session still refuses
  // even for a non-in-app route.
  {
    const route = { channel: "telegram", chatId: "777777777" };
    const binding = { sessionId: "sess-SOMEONE-ELSE", scope: "dm" };
    check("6a: a non-in-app binding naming a foreign session refuses", companionRouteBlockReason(route, binding, "sess-A6") === "route-foreign-session");
    check("6b: the SAME route/binding owned by the requester is unaffected", companionRouteBlockReason(route, { sessionId: "sess-A6", scope: "dm" }, "sess-A6") === undefined);
    // Every per-session-scoped caller (validateHomeTarget, warnStaleStoredHomes, the reply status) now
    // PASSES its own sessionId (card c7d7b43a, fix round) — prove that's still a no-op for the Telegram
    // ownership check when the binding, by construction, already belongs to that same session.
    check("6c: a caller passing its OWN sessionId against its OWN binding is unaffected", companionRouteBlockReason(route, { sessionId: "sess-A6", scope: "dm" }, "sess-A6") === undefined);
  }

  // ============ 7 — MINOR: the foreign-session check runs BEFORE the group-scope exemption ================
  // A foreign session's own GROUP-scoped binding must still refuse as "foreign" — never fall through to the
  // group-scope exemption (which would otherwise wave a negative/`@handle`-shaped chatId through just
  // because `binding.scope === "group"`).
  {
    const route = { channel: "telegram", chatId: "-100555666" };
    const foreignGroupBinding = { sessionId: "sess-SOMEONE-ELSE7", scope: "group" };
    check("7: a foreign session's OWN group-scope binding still refuses as foreign, not waved through", companionRouteBlockReason(route, foreignGroupBinding, "sess-A7") === "route-foreign-session");
    // Positive control: the SAME group binding, owned by the requester, correctly exempts via group-scope.
    check("7 (control): the SAME route/binding owned by the requester is exempt via group-scope", companionRouteBlockReason(route, { sessionId: "sess-A7", scope: "group" }, "sess-A7") === undefined);
  }

  // ============ 8 — NITPICK: sendToChannel's refusal also warns + dedupes, same as deliverReply ===========
  {
    const bindingA = { sessionId: "sess-A8", channel: "telegram", chatId: "888888888", scope: "dm" };
    const bindingB = { sessionId: "sess-B8", channel: "telegram", chatId: "999999999", scope: "dm" };
    const gw = new ChatGateway(() => ({ delivered: true }), [bindingA, bindingB]);
    const tg = { name: "telegram", maxMessageLength: 4096, start() {}, async stop() {}, sent: [], async send(chatId, text) { tg.sent.push({ chatId, text }); } };
    gw.registerAdapter(tg);

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    let r1, r2;
    try {
      r1 = await gw.sendToChannel("sess-A8", "telegram", "999999999", "mirrored turn 1");
      r2 = await gw.sendToChannel("sess-A8", "telegram", "999999999", "mirrored turn 2");
    } finally {
      console.warn = origWarn;
    }
    check("8a: sendToChannel refuses a foreign-session route", r1.delivered === false && r1.reason === "route-foreign-session" && tg.sent.length === 0);
    const securityWarnings = warnings.filter((w) => w.includes("route-foreign-session") || w.includes("SECURITY"));
    check("8b: sendToChannel's refusal logs the SAME warning deliverReply does, deduped across two calls", securityWarnings.length === 1);
    check("8c (sanity): the second call was also refused (not somehow re-admitted)", r2.delivered === false && r2.reason === "route-foreign-session");
  }

  // ============ 9 — PROVISION PRE-SPAWN: an in-app home is refused outright, no session id to check =======
  // `companionRouteBlockReason`'s new in-app ownership check needs a real sessionId to compare against — the
  // provision endpoint doesn't have one yet (the session is minted AFTER this validation). It must refuse an
  // in-app `home` outright rather than pass `undefined` and let the no-binding-required "always live" path
  // silently admit a home that could otherwise pre-target an EXISTING different session's own in-app route.
  {
    const db = new Db(dbFile("p9.db"));
    const now = new Date().toISOString();
    db.insertProject({ id: "verify-proj", name: "verify", repoPath: "verify-proj", vaultPath: "verify-proj", config: {}, createdAt: now, archivedAt: null });
    db.insertProfile({ id: "verify-profile", name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
    db.insertAgent({ id: "verify-agent", projectId: "verify-proj", name: "Companion Rig", startupPrompt: "P", position: 0, profileId: "verify-profile" });
    let startNewCalls = 0;
    const sessionsStub = { startNew: () => { startNewCalls++; return { id: `fake-session-${startNewCalls}` }; } };
    const otherStub = {};
    const companionStub = { bind: () => {}, unbind: () => {}, reconcile: async () => {} };
    const app = await buildServer({ db, pty: otherStub, sessions: sessionsStub, mcp: otherStub, orchMcp: otherStub, platformMcp: otherStub, auditMcp: otherStub, userAuditMcp: otherStub, setupMcp: otherStub, runMcp: otherStub, control: otherStub, usageStatus: otherStub, companion: companionStub });

    const rBad = await app.inject({ method: "POST", url: "/api/companion/provision", payload: { agentId: "verify-agent", home: { channel: IN_APP_CHANNEL, chatId: "sess-victim" } } });
    check("9a: provision refuses a home targeting the in-app channel → 400", rBad.statusCode === 400);
    check("9a: no session was spawned for the refused attempt", startNewCalls === 0);
    check("9a: no config row was written for the refused attempt", db.listCompanionConfigs().length === 0);

    const rControl = await app.inject({ method: "POST", url: "/api/companion/provision", payload: { agentId: "verify-agent" } });
    check("9 (control): provision with NO home still succeeds → 201", rControl.statusCode === 201 && startNewCalls === 1);

    db.close();
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — against PRODUCTION-SHAPED wiring (two real per-session gateways sharing ONE real InAppChannel, built the way factory.ts/controller.ts actually build them), a session's turn-origin resolving to a DIFFERENT session's in-app route is refused (route-foreign-session) by deliverReply/deliverMedia and never reaches the foreign session's attached web client, with the SAME refusal deduped and logged exactly once; the Telegram-channel ownership check remains as true defense-in-depth even though it's structurally unreachable given per-session gateway scoping, is checked BEFORE the group-scope exemption, and is a no-op for every per-session-scoped caller delivering to its own binding; sendToChannel's refusal now also warns + dedupes, matching deliverReply/deliverMedia."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
