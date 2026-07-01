import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the one-shot human-only PROVISION endpoint (card cbc9fa68): POST /api/companion/provision.
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL envelope key file, the REAL SessionService driven
// against a FAKE pty (PtyHost.createPty() seam — NO real claude), the REAL CompanionController with an INJECTED
// faithful gateway builder (registers the Telegram adapter ONLY when a token exists, mirroring the real
// factory) + an INJECTED heartbeat builder, and the REAL buildServer (app.inject). NO network, NO real claude,
// NO daemon. Proves the card DoD:
//   1. DEFAULT provision (NO token) → spawns a session + a config row (provisioned) + the in-app binding, arms
//      the in-app gateway but NO Telegram adapter, and returns the masked companion (tokenConfigured:false).
//   2. Provision WITH botToken+allowedChatId → ALSO writes the Telegram dm binding + arms the Telegram adapter;
//      the token is stored ENCRYPTED and the response masks to the last-4.
//   3. ROLLBACK: a post-spawn write failure tears the spawned session DOWN (no orphan session/config/binding).
//   4. Provenance: the provision sets provisioned:true; deleting the companion RETIRES a provisioned session
//      but NOT a manually-bound (provisioned:false) pre-existing session.
// Run: 1) build (turbo builds shared first), 2) node test/companion-provision.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-provision-${Date.now()}-${process.pid}`);
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
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createCompanionGateway } = await import("../dist/companion/factory.js");
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { decryptSecret, encryptSecret } = await import("../dist/keys/envelope.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { SETUP_PROJECT_NAME, COMPANION_AGENT_NAME } = await import("../dist/setup/seed.js");

const TELEGRAM = "telegram";
const TOKEN = "8111111111:AAprovision-token-secret";

// A real temp git repo backs the reserved home project (a spawn reads settings from cwd — mirror assistant-role).
const repo = path.join(os.tmpdir(), `loom-provision-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# provision test\n");
execSync(`git init -q && git -c user.email=a@loom -c user.name=a add . && git -c user.email=a@loom -c user.name=a commit -q -m init`, { cwd: repo });

// A fake ChannelAdapter that records lifecycle + sends (no network).
function makeFakeAdapter(name) {
  const a = { name, maxMessageLength: name === TELEGRAM ? 4096 : undefined, started: 0, stopped: 0, sent: [],
    start() { a.started++; }, async stop() { a.stopped++; }, async send(chatId, text) { a.sent.push({ chatId, text }); } };
  return a;
}

// A FAITHFUL gateway builder: a REAL ChatGateway over the DURABLE bindings, an in-app adapter ALWAYS, and a
// Telegram adapter ONLY when cfg.botToken exists — exactly the token guard the real createCompanionGateway
// applies. Records every build so the test can assert which adapters were armed.
function makeGatewayBuilder(submitSpy) {
  const built = [];
  const builder = (cfg, submitTurn, db) => {
    const inApp = makeFakeAdapter(IN_APP_CHANNEL);
    const telegram = cfg.botToken ? makeFakeAdapter(TELEGRAM) : null;
    const bindings = db.listCompanionBindings();
    const gw = new ChatGateway(submitTurn ?? submitSpy, bindings.map((b) => ({ sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope })));
    gw.registerAdapter(inApp);
    if (telegram) gw.registerAdapter(telegram);
    built.push({ cfg, gw, inApp, telegram });
    return gw;
  };
  return { built, builder };
}

function makeHeartbeatBuilder() {
  const built = [];
  const builder = (cfg) => { const h = { cfg, started: 0, stopped: 0, start() { h.started++; }, stop() { h.stopped++; } }; built.push(h); return h; };
  return { built, builder };
}

// The fake-pty PtyHost that captures every SpawnOpts via the createPty() seam (mirrors assistant-role.mjs).
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
  }
}

// Build a full rig on its OWN Db file: reserved "Platform" home + a Companion (assistant) rig, the REAL
// SessionService over a fake pty, the REAL controller (faithful builders), and the REAL buildServer. startNew /
// stopSession are wrapped to record spawns + retires. Returns everything the assertions need.
async function makeRig(name) {
  const db = new Db(path.join(tmpHome, name));
  const now = new Date().toISOString();
  // Reserved "Platform" home + the bundled "Companion" assistant rig, so the no-agentId default resolves.
  const home = { id: randomUUID(), name: SETUP_PROJECT_NAME, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true };
  db.insertProject(home);
  const profId = randomUUID();
  db.insertProfile({ id: profId, name: "Companion", role: "assistant", description: "the standing companion rig", allowDelta: [], skills: null, model: null, icon: "💬" });
  const companionAgentId = randomUUID();
  db.insertAgent({ id: companionAgentId, projectId: home.id, name: COMPANION_AGENT_NAME, startupPrompt: "COMPANION_PERSONA", position: 0, profileId: profId });

  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());

  const spawned = [];
  const realStart = svc.startNew.bind(svc);
  svc.startNew = (agentId, opts) => { const s = realStart(agentId, opts); spawned.push(s.id); return s; };
  const stopped = [];
  const realStop = svc.stopSession.bind(svc);
  svc.stopSession = (id, mode) => { stopped.push({ id, mode }); return realStop(id, mode); };

  const submitSpy = () => ({ delivered: true });
  const gw = makeGatewayBuilder(submitSpy);
  const hb = makeHeartbeatBuilder();
  const hooks = { companionSessionId: null };
  const controller = new CompanionController({
    db, submitTurn: submitSpy,
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks, env: {}, inApp: new InAppChannel(),
    buildGateway: gw.builder, buildHeartbeat: hb.builder,
  });
  await controller.startInitial(null); // OFF at boot

  const stub = {};
  const app = await buildServer({ db, pty: host, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: controller, requestShutdown: () => {} });
  return { db, svc, host, controller, gw, hb, hooks, app, spawned, stopped, companionAgentId };
}

const rigs = [];
try {
  // ============ Part 1 — DEFAULT provision (NO token) ⇒ in-app-only companion ============
  {
    const rig = await makeRig("p1.db"); rigs.push(rig);
    const res = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: {} });
    const body = JSON.parse(res.payload);
    check("default: → 201", res.statusCode === 201);
    check("default: spawned exactly one session on the default Companion rig", rig.spawned.length === 1 && rig.host.capture.length === 1);
    const sid = rig.spawned[0];
    check("default: the spawned session is an assistant (default rig), persisted live", rig.db.getSession(sid)?.role === "assistant" && rig.db.getSession(sid)?.processState === "live");
    check("default: response session id is the NEW spawned session", body.sessionId === sid);

    const row = rig.db.getCompanionConfig(sid);
    check("default: a config row is bound to the new session, marked provisioned", !!row && row.provisioned === true && row.enabled === true);
    check("default: NO token stored (empty blob) — in-app-only", row.botTokenBlob === "");
    check("default: config channel is in-app (no telegram transport)", row.channel === IN_APP_CHANNEL);

    const binds = rig.db.listCompanionBindings();
    const inAppBind = binds.find((b) => b.channel === IN_APP_CHANNEL);
    check("default: the in-app binding is auto-provisioned { sessionId, in-app, chatId==sessionId, dm }",
      !!inAppBind && inAppBind.sessionId === sid && inAppBind.chatId === sid && inAppBind.scope === "dm");
    check("default: NO Telegram binding written (in-app-only)", !binds.some((b) => b.channel === TELEGRAM));

    check("default: the in-app gateway is armed (running), gate points at the session", rig.controller.snapshot().running === true && rig.hooks.companionSessionId === sid);
    check("default: exactly one gateway built, in-app adapter started, NO Telegram adapter", rig.gw.built.length === 1 && rig.gw.built[0].telegram === null && rig.gw.built[0].inApp.started === 1);

    check("default: masked response — configured, tokenConfigured:false, empty last-4, provisioned", body.configured === true && body.tokenConfigured === false && body.tokenLast4 === "" && body.provisioned === true);
    check("default: masked response never carries a plaintext/blob token", !JSON.stringify(body).includes("botToken") && !JSON.stringify(body).includes("v1:"));
  }

  // ============ Part 2 — provision WITH botToken + allowedChatId ⇒ Telegram ALSO wired ============
  {
    const rig = await makeRig("p2.db"); rigs.push(rig);
    const res = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: { botToken: TOKEN, allowedChatId: "chat-9", cadence: 360 } });
    const body = JSON.parse(res.payload);
    check("telegram: → 201", res.statusCode === 201);
    const sid = rig.spawned[0];

    const row = rig.db.getCompanionConfig(sid);
    check("telegram: token stored ENCRYPTED at rest (v1 envelope)", !!row && row.botTokenBlob.startsWith("v1:"));
    check("telegram: the stored blob decrypts internally back to the exact token", decryptSecret(row.botTokenBlob) === TOKEN);
    check("telegram: config row provisioned + enabled + telegram channel", row.provisioned === true && row.enabled === true && row.channel === TELEGRAM);

    // MULTI-CHANNEL (companion_bindings keyed on (session_id, channel)): a Telegram companion is reachable
    // over Telegram AND the in-app cockpit at once, so provision-with-token writes BOTH bindings — the
    // in-app one is NOT clobbered by the Telegram write.
    const binds = rig.db.listCompanionBindings().filter((b) => b.sessionId === sid);
    check("telegram: the session has BOTH bindings (in-app + telegram)", binds.length === 2);
    const tgBind = binds.find((b) => b.channel === TELEGRAM);
    const inAppBind = binds.find((b) => b.channel === IN_APP_CHANNEL);
    check("telegram: the Telegram dm binding is written { telegram, chat-9, dm }", !!tgBind && tgBind.chatId === "chat-9" && tgBind.scope === "dm");
    check("telegram: the in-app binding coexists (not clobbered) { in-app, chatId==sessionId, dm }", !!inAppBind && inAppBind.chatId === sid && inAppBind.scope === "dm");

    check("telegram: the Telegram adapter is ARMED (started)", rig.gw.built.length === 1 && rig.gw.built[0].telegram && rig.gw.built[0].telegram.started === 1);
    check("telegram: heartbeat armed (cadence>0)", rig.hb.built.length === 1 && rig.hb.built[0].started === 1);
    check("telegram: masked response — tokenConfigured:true, last-4 of the token, provisioned", body.tokenConfigured === true && body.tokenLast4 === TOKEN.slice(-4) && body.provisioned === true);
    check("telegram: masked response never carries the plaintext token", !JSON.stringify(body).includes(TOKEN));
  }

  // ============ Part 3 — ROLLBACK on a post-spawn write failure (no orphan) ============
  {
    const rig = await makeRig("p3.db"); rigs.push(rig);
    // Inject a failure AFTER the config write (the in-app binding write throws), so the spawn + config are
    // already in flight and the rollback must clean BOTH plus the session.
    rig.db.upsertCompanionBinding = () => { throw new Error("injected binding-write failure"); };
    const res = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: {} });
    check("rollback: → 500 (provision failed)", res.statusCode === 500);
    check("rollback: a session WAS spawned (there is something to roll back)", rig.spawned.length === 1);
    const sid = rig.spawned[0];
    check("rollback: the spawned session was hard-stopped (retired)", rig.stopped.some((s) => s.id === sid && s.mode === "hard"));
    check("rollback: NO orphan session row survives", rig.db.getSession(sid) === undefined);
    check("rollback: NO orphan config row survives", rig.db.getCompanionConfig(sid) === undefined);
    check("rollback: NO orphan binding survives for the session", !rig.db.listCompanionBindings().some((b) => b.sessionId === sid));
    check("rollback: the live companion is OFF (reconciled to the rolled-back DB)", rig.controller.snapshot().running === false && rig.hooks.companionSessionId === null);
  }

  // ============ Part 4 — provenance-scoped teardown on delete ============
  {
    const rig = await makeRig("p4.db"); rigs.push(rig);
    // (4a) a PROVISIONED companion → delete RETIRES its session.
    const prov = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: {} });
    const provSid = JSON.parse(prov.payload).sessionId;
    check("provenance(4a): provisioned companion created + session live", rig.db.getSession(provSid)?.processState === "live" && rig.db.getCompanionConfig(provSid)?.provisioned === true);
    rig.stopped.length = 0;
    const del = await rig.app.inject({ method: "DELETE", url: `/api/companion/config/${provSid}` });
    const delBody = JSON.parse(del.payload);
    check("provenance(4a): delete → 200, retiredSession:true", del.statusCode === 200 && delBody.retiredSession === true);
    check("provenance(4a): the provisioned session was RETIRED (graceful stop)", rig.stopped.some((s) => s.id === provSid && s.mode === "graceful"));
    check("provenance(4a): the config row is gone (cascade delete)", rig.db.getCompanionConfig(provSid) === undefined);

    // (4b) a MANUALLY-bound pre-existing session (provisioned:false) → delete does NOT retire it.
    const manualSid = rig.svc.startNew(rig.companionAgentId).id; // a real, human-owned session
    rig.db.upsertCompanionConfig({ sessionId: manualSid, botTokenBlob: encryptSecret(TOKEN), channel: TELEGRAM, allowedChatId: "chat-m", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true }); // no `provisioned` ⇒ false
    check("provenance(4b): the manual config row is provisioned:false", rig.db.getCompanionConfig(manualSid)?.provisioned === false);
    rig.stopped.length = 0;
    const delM = await rig.app.inject({ method: "DELETE", url: `/api/companion/config/${manualSid}` });
    const delMBody = JSON.parse(delM.payload);
    check("provenance(4b): delete → 200, retiredSession:false", delM.statusCode === 200 && delMBody.retiredSession === false);
    check("provenance(4b): the pre-existing session was NOT retired", !rig.stopped.some((s) => s.id === manualSid));
    check("provenance(4b): the pre-existing session row still exists (outlives the config)", !!rig.db.getSession(manualSid));
    check("provenance(4b): its config row IS gone (delete still unarms the companion)", rig.db.getCompanionConfig(manualSid) === undefined);
  }

  // ============ Part 6 — fail-closed pre-spawn guards ============
  // (6a) single-companion precondition: a 2nd provision while one is enabled → 409, and NO 2nd session spawned.
  {
    const rig = await makeRig("p6a.db"); rigs.push(rig);
    const first = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: {} });
    check("guard(6a): first provision succeeds", first.statusCode === 201 && rig.spawned.length === 1);
    const second = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: {} });
    check("guard(6a): a 2nd provision while one is enabled → 409", second.statusCode === 409);
    check("guard(6a): NO 2nd session was spawned (guard is pre-spawn)", rig.spawned.length === 1);
    check("guard(6a): the 409 names the single-companion limitation", /already active|multi-companion/.test(JSON.parse(second.payload).error));
  }
  // (6b) botToken without allowedChatId → 400 (a token with nowhere to reach).
  {
    const rig = await makeRig("p6b.db"); rigs.push(rig);
    const res = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: { botToken: TOKEN } });
    check("guard(6b): botToken without allowedChatId → 400", res.statusCode === 400 && /allowedChatId is required/.test(JSON.parse(res.payload).error));
    check("guard(6b): NO session spawned on the rejected provision", rig.spawned.length === 0);
  }
  // (6c) a non-assistant rig → 400 (chat_reply is gated on role=assistant; a non-assistant rig is broken +
  // a blast-radius escalation for a chat-reachable agent).
  {
    const rig = await makeRig("p6c.db"); rigs.push(rig);
    // Seed a MANAGER-role rig in the same home and try to provision onto it.
    const home = rig.db.getReservedProjectByName(SETUP_PROJECT_NAME);
    const mgrProf = randomUUID();
    rig.db.insertProfile({ id: mgrProf, name: "Orchestrator", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
    const mgrAgent = randomUUID();
    rig.db.insertAgent({ id: mgrAgent, projectId: home.id, name: "Manager", startupPrompt: "MGR", position: 1, profileId: mgrProf });
    const res = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: { agentId: mgrAgent } });
    check("guard(6c): a non-assistant rig → 400", res.statusCode === 400 && /assistant-role/.test(JSON.parse(res.payload).error));
    check("guard(6c): NO session spawned on the rejected provision", rig.spawned.length === 0);
    // And the assistant default rig still provisions fine (guard admits assistant).
    const ok = await rig.app.inject({ method: "POST", url: "/api/companion/provision", payload: {} });
    check("guard(6c): the assistant default rig still provisions (201)", ok.statusCode === 201 && rig.spawned.length === 1);
  }

  // ============ Part 5 — the REAL factory applies the SAME token guard (no injected builder) ============
  // Prove createCompanionGateway itself registers the Telegram adapter ONLY when a token exists: a tokenless
  // gateway routes an in-app reply but returns `no-adapter` for a Telegram target (no long-poll constructed).
  {
    const db = new Db(path.join(tmpHome, "p5.db"));
    const inApp = new InAppChannel();
    const sid = "sess-factory";
    // A tokenless in-app companion: an in-app binding + a stray telegram binding to probe adapter presence.
    db.upsertCompanionBinding({ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "dm" });
    db.upsertCompanionBinding({ sessionId: "sess-tg", channel: TELEGRAM, chatId: "chat-x", scope: "dm" });
    const cfg = { botToken: null, allowedChatId: "", sessionId: sid, chatScope: "dm", homeChannel: IN_APP_CHANNEL, homeChatId: sid, heartbeatIntervalMinutes: 0, heartbeatPrompt: "x" };
    // 5th arg = the per-turn origin resolver (stands in for pty.getActiveTurnOrigin): each session's turn came
    // in on its own route, so deliverReply targets that channel — proving adapter PRESENCE (in-app yes, telegram no).
    const originResolver = (s) => (s === sid ? { channel: IN_APP_CHANNEL, chatId: sid } : s === "sess-tg" ? { channel: TELEGRAM, chatId: "chat-x" } : null);
    const gw = createCompanionGateway(cfg, () => ({ delivered: true }), db, inApp, originResolver);
    const inAppOut = await gw.deliverReply(sid, "hi"); // in-app adapter registered ⇒ delivered
    const tgOut = await gw.deliverReply("sess-tg", "hi"); // NO telegram adapter ⇒ no-adapter
    check("factory: tokenless gateway registers the in-app adapter (reply delivered)", inAppOut.delivered === true);
    check("factory: tokenless gateway registers NO Telegram adapter (deliver → no-adapter)", tgOut.delivered === false && tgOut.reason === "no-adapter");
    db.close();
  }
} finally {
  for (const r of rigs) { try { await r.app.close(); } catch { /* ignore */ } try { r.db.close(); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/companion/provision one-shot provisions a companion: a DEFAULT (no-token) provision spawns a session + config + in-app binding and arms the in-app gateway with NO Telegram adapter, a botToken provision ALSO writes the Telegram dm binding + arms the adapter (token encrypted, masked to last-4), a post-spawn write failure tears the spawned session down with no orphan, and delete retires a PROVISIONED session but leaves a manually-bound one running — human-only, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
