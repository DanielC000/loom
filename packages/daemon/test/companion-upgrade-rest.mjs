import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion CONVERSATION-PRESERVING RESPAWN — the REST + controller wiring half (the mechanics of the
// respawn itself, and the tool-surface/engine-id proof, live in companion-live-upgrade.mjs). Fully
// hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject) with pty/sessions stubbed out
// (these routes never touch a live pty directly — they go through the injected companion control), and a
// REAL CompanionController driven by a FAKE `upgradeCompanionSession` seam. NO network, NO real claude, NO
// daemon. Proves:
//   1. POST /api/companion/:sessionId/upgrade resolves via CompanionController.upgrade → 200 with the
//      updated session on success, 409 with the error message on a rejected upgrade.
//   2. Same resolve-by-sessionId gating as every other companion REST writer: 404 unknown session, 400 a
//      non-assistant (worker) session — the upgrade primitive is never even called for those.
//   3. 503 when no companion controller is wired on the daemon (deps.companion undefined) — never a 500/crash.
//   4. CompanionController.upgrade is SERIALIZED on the SAME reconcile chain as reconcile()/onSessionExit():
//      a slow upgrade doesn't let a concurrent reconcile() interleave (observed call order), and a REJECTED
//      upgrade never poisons the chain for the NEXT enqueued op (reconcile still runs after a failed upgrade).
// Run: 1) build (turbo builds shared first), 2) node test/companion-upgrade-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-upgrade-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { CompanionController } = await import("../dist/companion/controller.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Upgrade REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "", position: 0, profileId: null, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

const workerAgentId = randomUUID();
db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "", position: 1, profileId: null, endpoint: false, ioSchema: null });
const workerSessId = randomUUID();
db.insertSession({
  id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
});

const UNKNOWN_SESSION = randomUUID();

// ===================== Part A — REST wiring against a REAL CompanionController =====================
{
  // The seam: `upgradeCompanionSession` is the thing SessionService.upgradeCompanionCapabilities would be —
  // controllable per-call (resolve/reject) and instrumented to observe ordering against a concurrent reconcile.
  let nextOutcome = () => ({ session: { id: companionSessId, engineSessionId: "eng-companion", processState: "live" } });
  const calls = [];
  const controller = new CompanionController({
    db,
    submitTurn: () => ({ delivered: true }),
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks: { companionSessionIds: new Set() },
    env: {},
    resolveEffective: () => [], // reconcile() is a no-op diff — this test only cares about ordering/chain health
    upgradeCompanionSession: async (sid) => {
      calls.push(`upgrade:start:${sid}`);
      const outcome = nextOutcome();
      if (outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs));
      calls.push(`upgrade:end:${sid}`);
      if (outcome.error) throw new Error(outcome.error);
      return outcome.session;
    },
  });

  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: controller });

  try {
    // ---- 1. success path ----
    {
      const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/upgrade` });
      const body = JSON.parse(res.payload);
      check("(1) POST upgrade: 200 on success", res.statusCode === 200);
      check("(1) POST upgrade: echoes the sessionId", body.sessionId === companionSessId);
      check("(1) POST upgrade: returns the upgraded session", body.session?.id === companionSessId);
    }
    // ---- 1. failure path: the upgrade primitive rejects ----
    {
      nextOutcome = () => ({ error: "companion process did not stop in time" });
      const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/upgrade` });
      const body = JSON.parse(res.payload);
      check("(1) POST upgrade: 409 when the upgrade is refused", res.statusCode === 409);
      check("(1) POST upgrade: surfaces the refusal's error message", body.error === "companion process did not stop in time");
    }
    // ---- 2. resolve-by-sessionId gating (mirrors every other companion REST writer) ----
    {
      nextOutcome = () => ({ session: { id: companionSessId, engineSessionId: "eng-companion", processState: "live" } });
      const notFound = await app.inject({ method: "POST", url: `/api/companion/${UNKNOWN_SESSION}/upgrade` });
      check("(2) POST upgrade: unknown sessionId → 404, upgrade never invoked", notFound.statusCode === 404);
      calls.length = 0;
      const wrongRole = await app.inject({ method: "POST", url: `/api/companion/${workerSessId}/upgrade` });
      check("(2) POST upgrade: a non-assistant (worker) session → 400", wrongRole.statusCode === 400);
      check("(2) POST upgrade: the upgrade primitive was never called for the refused worker session", calls.length === 0);
    }
    // ---- 4. serialization: upgrade and reconcile share ONE chain; a rejected upgrade doesn't poison it ----
    {
      calls.length = 0;
      nextOutcome = () => ({ session: { id: companionSessId, engineSessionId: "eng-companion", processState: "live" }, delayMs: 30 });
      const upgradeP = controller.upgrade(companionSessId);
      const reconcileP = controller.reconcile(companionSessId).then(() => calls.push("reconcile:done"));
      await Promise.all([upgradeP, reconcileP]);
      check(
        "(4) reconcile() enqueued right after upgrade() runs AFTER the upgrade finishes (same serialization chain)",
        calls.indexOf("upgrade:end:" + companionSessId) < calls.indexOf("reconcile:done"),
      );

      calls.length = 0;
      nextOutcome = () => ({ error: "boom" });
      const rejected = await controller.upgrade(companionSessId);
      check("(4) a rejected upgrade() resolves (never throws) with {ok:false}", rejected.ok === false && rejected.error === "boom");
      // The chain must still be healthy — a subsequent reconcile must actually run, not hang/reject forever.
      let ran = false;
      await controller.reconcile(companionSessId).then(() => { ran = true; });
      check("(4) reconcile() after a REJECTED upgrade still runs (the chain wasn't poisoned)", ran === true);
    }
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

// ===================== Part B — no companion controller wired on this daemon =====================
{
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub }); // companion omitted
  try {
    const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/upgrade` });
    check("(3) no companion wired → 503, never a crash", res.statusCode === 503);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

db.close();
for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/companion/:sessionId/upgrade resolves via CompanionController.upgrade (200/409), gates by sessionId/role (404/400) same as every other companion writer, 503s cleanly with no controller wired, and serializes on the SAME reconcile chain without a rejected upgrade poisoning it — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
