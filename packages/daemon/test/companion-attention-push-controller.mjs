import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion attention-push — CONTROLLER WIRING integration test (Lead build sequence step 8). Fully
// hermetic: a REAL Db on a temp LOOM_HOME + a REAL CompanionController (env-free `resolveEffective` seam,
// injected fake gateway builder, and a REAL AttentionPushWatcher wrapped so the test drives tick() directly
// instead of waiting on a real setInterval — mirrors companion-reminder-tools.mjs's ARM-ON-CREATE shape).
// NO network, NO real claude, NO daemon.
//
// Covers the build spec's step 8 DoD:
//   (a) granting attention-push to a live companion + a `merge_rejected` in the granted project → ONE
//       [loom:alert] turn lands on the session (the REST grants-writer's new `reconcile(sessionId)` call
//       simulated directly against the controller, exactly as gateway/server.ts's three /grants routes do).
//   (b) a `merge_rejected` in a NON-granted project → no new turn.
//   (c) revoking the grant + reconcile → the watcher DISARMS (stopped, no successor built) — the LIVE,
//       no-respawn re-arm this lever adds on top of the existing MCP-tool levers (which need a respawn).
// Run: 1) build (turbo builds shared first), 2) node test/companion-attention-push-controller.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-attention-push-controller-${Date.now()}-${process.pid}`);
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
const { AttentionPushWatcher, ALERT_TAG } = await import("../dist/companion/attention-push.js");

const SESS = "companion-sess";
const MGR_A = "mgr-a";
const MGR_B = "mgr-b";

function seedProject(db, id, name) {
  const now = new Date().toISOString();
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role) {
  const now = new Date().toISOString();
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
}

// Fixed CompanionConfig for the `resolveEffective` seam — sidesteps needing a real companion_config row.
function cfgOf(sessionId) {
  return {
    botToken: "x", allowedChatId: "chat-1", sessionId, chatScope: "dm",
    homeChannel: "telegram", homeChatId: "chat-1",
    heartbeatIntervalMinutes: 0, heartbeatPrompt: "PROACTIVE",
  };
}

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

// A REAL AttentionPushWatcher per built session — start()/stop() clear the real setInterval immediately
// (the test drives tick() directly for determinism, mirroring companion-reminder-tools.mjs).
function makeAttentionPushBuilder(db, pty) {
  const built = []; // { sessionId, watcher, startCalls, stopCalls }
  const builder = (sessionId) => {
    const watcher = new AttentionPushWatcher({ db, pty, sessionId });
    const rec = { sessionId, watcher, startCalls: 0, stopCalls: 0 };
    built.push(rec);
    return {
      start() { rec.startCalls++; watcher.start(); watcher.stop(); },
      stop() { rec.stopCalls++; watcher.stop(); },
    };
  };
  return { built, builder };
}

try {
  const db = new Db(path.join(tmpHome, "attention-push.db"));
  const projA = "proj-a";
  const projB = "proj-b";
  seedProject(db, projA, "Proj A");
  seedProject(db, projB, "Proj B");
  seedSession(db, SESS, projA, "assistant");
  seedSession(db, MGR_A, projA, "manager");
  seedSession(db, MGR_B, projB, "manager");

  const alive = new Set([SESS]);
  const enqueued = []; // { sessionId, text, route }
  let pendingQueue = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, _source, _onDeliver, route) => { enqueued.push({ sessionId: id, text, route }); pendingQueue.push(text); return { delivered: false, position: pendingQueue.length }; },
    getPending: (id) => (id === SESS ? pendingQueue : []),
  };
  const clearPending = () => { pendingQueue = []; };

  const gwBuilder = makeGatewayBuilder();
  const apBuilder = makeAttentionPushBuilder(db, pty);
  const companionHooks = { companionSessionIds: new Set([SESS]), deliverReply: async () => ({ delivered: true }) };
  const controller = new CompanionController({
    db,
    submitTurn: (sid, text, route) => pty.enqueueStdin(sid, text, "system", undefined, route),
    pty,
    hooks: companionHooks,
    env: {},
    buildGateway: gwBuilder.builder,
    buildAttentionPush: apBuilder.builder,
    resolveEffective: () => [cfgOf(SESS)],
  });

  // Bring the companion live with NO attention-push grant yet (the realistic precondition).
  await controller.startInitial([cfgOf(SESS)]);
  check("boot: no grant ⇒ no attention-push watcher built", apBuilder.built.length === 0);

  // ============ (a) grant attention-push → LIVE re-arm (no respawn) → a granted-project event pushes ============
  db.upsertCompanionCapabilityGrant({ sessionId: SESS, capability: "attention-push", projectId: projA, mode: "read", config: { alertClasses: ["merge-gate"] } });
  await controller.reconcile(SESS); // simulates gateway/server.ts's POST /api/companion/:sessionId/grants writer
  check("grant: reconcile() live-arms a REAL attention-push watcher for this session (no respawn)", apBuilder.built.length === 1 && apBuilder.built[0].sessionId === SESS && apBuilder.built[0].startCalls === 1);

  const watcher = () => apBuilder.built[apBuilder.built.length - 1].watcher; // the currently-armed one
  watcher().tick(new Date()); // seeds the watermark to "now" (baseline — no backlog to replay)

  db.appendEvent({ id: "evt-1", ts: new Date().toISOString(), managerSessionId: MGR_A, kind: "merge_rejected", detail: {} });
  watcher().tick(new Date());
  check("granted project: a merge_rejected in the granted project pushes ONE [loom:alert] turn", enqueued.length === 1 && enqueued[0].sessionId === SESS && enqueued[0].text.startsWith(ALERT_TAG));

  // ============ (b) an event in a NON-granted project pushes nothing ============
  clearPending();
  db.appendEvent({ id: "evt-2", ts: new Date().toISOString(), managerSessionId: MGR_B, kind: "merge_rejected", detail: {} });
  watcher().tick(new Date());
  check("ungranted project: no new turn", enqueued.length === 1);

  // ============ (c) revoke → live DISARM (no successor watcher built) ============
  const builtBefore = apBuilder.built.length;
  db.deleteCompanionCapabilityGrant(SESS, "attention-push", projA);
  await controller.reconcile(SESS); // simulates gateway/server.ts's DELETE /api/companion/:sessionId/grants writer
  check("revoke: no successor watcher built (the grant is gone — rearmAttentionPushFor's build gate short-circuits)", apBuilder.built.length === builtBefore);
  check("revoke: the live watcher was stopped", apBuilder.built[apBuilder.built.length - 1].stopCalls === 1);

  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — granting attention-push live-arms a REAL watcher (no companion respawn), a granted-project fleet signal pushes a framed [loom:alert] turn, an ungranted project's signal is dropped, and revoking the grant live-disarms the watcher (stopped, no successor built)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
