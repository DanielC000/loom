import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 79e030d9 — the REST + controller wiring half of the Companion RECYCLE (the mechanics of the recycle
// itself live in companion-recycle.mjs). Hermetic like companion-upgrade-rest.mjs: a temp LOOM_HOME + a REAL
// Db + the REAL buildServer (app.inject) with pty/sessions stubbed out, and a REAL CompanionController driven
// by a FAKE `recycleCompanionSession` seam. NO network, NO real claude, NO daemon. Proves:
//   1. POST /api/companion/:sessionId/recycle → 200 with the session on success, 409 with the error on a refusal.
//   2. Same resolve-by-sessionId gating as every other companion writer: 404 unknown, 400 non-assistant — the
//      recycle primitive is never called for those.
//   3. 503 when no companion controller is wired.
//   4. recycle() is SERIALIZED on the SAME chain as reconcile(), and a REJECTED recycle never poisons it.
// Run: 1) build (turbo builds shared first), 2) node test/companion-recycle-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cmp-recycle-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { CompanionController } = await import("../dist/companion/controller.js");

const db = new Db(path.join(tmpHome, "loom.db"));
const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Recycle REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

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

{
  let nextOutcome = () => ({ session: { id: companionSessId, engineSessionId: null, processState: "live" } });
  const calls = [];
  const controller = new CompanionController({
    db,
    submitTurn: () => ({ delivered: true }),
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks: { companionSessionIds: new Set() },
    env: {},
    resolveEffective: () => [],
    recycleCompanionSession: async (sid) => {
      calls.push(`recycle:start:${sid}`);
      const outcome = nextOutcome();
      if (outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs));
      calls.push(`recycle:end:${sid}`);
      if (outcome.error) throw new Error(outcome.error);
      return outcome.session;
    },
  });
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: controller });
  try {
    // ---- 1. success + refusal ----
    {
      const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/recycle` });
      const body = JSON.parse(res.payload);
      check("(1) POST recycle: 200 on success", res.statusCode === 200);
      check("(1) POST recycle: echoes the sessionId + returns the session", body.sessionId === companionSessId && body.session?.id === companionSessId);
    }
    {
      nextOutcome = () => ({ error: "this companion's context is not exhausted" });
      const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/recycle` });
      const body = JSON.parse(res.payload);
      check("(1) POST recycle: 409 when the recycle is refused", res.statusCode === 409);
      check("(1) POST recycle: surfaces the refusal's error message", body.error === "this companion's context is not exhausted");
    }
    // ---- 2. gating ----
    {
      nextOutcome = () => ({ session: { id: companionSessId } });
      calls.length = 0;
      const notFound = await app.inject({ method: "POST", url: `/api/companion/${UNKNOWN_SESSION}/recycle` });
      check("(2) unknown sessionId → 404", notFound.statusCode === 404);
      const wrongRole = await app.inject({ method: "POST", url: `/api/companion/${workerSessId}/recycle` });
      check("(2) a non-assistant (worker) session → 400", wrongRole.statusCode === 400);
      check("(2) the recycle primitive was never called for either refused session", calls.length === 0);
    }
    // ---- 4. serialization + non-poisoning ----
    {
      calls.length = 0;
      nextOutcome = () => ({ session: { id: companionSessId }, delayMs: 30 });
      const recycleP = controller.recycle(companionSessId);
      const reconcileP = controller.reconcile(companionSessId).then(() => calls.push("reconcile:done"));
      await Promise.all([recycleP, reconcileP]);
      check("(4) reconcile() enqueued right after recycle() runs AFTER the recycle finishes (same chain)",
        calls.indexOf("recycle:end:" + companionSessId) !== -1 && calls.indexOf("recycle:end:" + companionSessId) < calls.indexOf("reconcile:done"));

      calls.length = 0;
      nextOutcome = () => ({ error: "boom" });
      const rejected = await controller.recycle(companionSessId);
      check("(4) a rejected recycle() resolves (never throws) with {ok:false}", rejected.ok === false && rejected.error === "boom");
      let ran = false;
      await controller.reconcile(companionSessId).then(() => { ran = true; });
      check("(4) reconcile() after a REJECTED recycle still runs (the chain wasn't poisoned)", ran === true);
      nextOutcome = () => ({ session: { id: companionSessId } });
      const again = await controller.recycle(companionSessId);
      check("(4) a recycle() after a rejected recycle() still runs", again.ok === true);
    }
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

// ---- 3. no companion controller wired ----
{
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  try {
    const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/recycle` });
    check("(3) no companion wired → 503, never a crash", res.statusCode === 503);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

db.close();
cleanupPathSync(tmpHome);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
