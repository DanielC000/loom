import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e7a9a884 item 3 — test gap: POST /api/sessions/:id/stop (gateway/server.ts) calls
// `deps.sessions.retireWorkerSessionIfWorker(id, "human_stop")` after a successful pty.stop (@decision
// 4ee527d1). Every EXISTING test that drives this route through buildServer stubs `sessions` with a
// bare `retireWorkerSessionIfWorker: () => {}` no-op (see shell-terminal-rest-refusal.mjs) — real,
// but it never actually exercises the role gate `retireWorkerSessionIfWorker` applies internally
// (`session?.role === "worker"`). Nobody has proven, through the REAL route against a REAL
// SessionService, that a worker-role stop files worker_retired(reason:human_stop) and a manager-role
// stop does not.
//
// Proves, via a REAL Fastify app (buildServer) + REAL Db + REAL SessionService + a fake-pty PtyHost,
// driven only through app.inject() (no bound port):
//   (1) POST /stop on a WORKER session files worker_retired with reason "human_stop" (and the
//       retirement epoch reads active afterward).
//   (2) POST /stop on a MANAGER session files NO worker_retired event at all.
//   (3) POST /stop on a PLAIN (role-less) session also files none (the role check, not merely
//       "not a manager").
//
// HERMETIC — no claude, no network (app.inject binds no port), no git.
//
// Run: 1) build (turbo builds shared first), 2) node test/stop-route-worker-retirement-role.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-stoprole-");
process.env.LOOM_HOME = TMP;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Fake pty whose kill() fires onExit synchronously (mirrors worker-retired-cancels-wakes.mjs) — "hard"
// stop therefore settles within the SAME synchronous call the route handler makes.
const exitCbs = new Map();
class TestPtyHost extends PtyHost {
  sweepOrphanedDescendants(_rootPid) {}
  createPty(opts) {
    const writes = [];
    return {
      pid: 4242,
      write: (d) => { writes.push(d); },
      onData: () => ({ dispose() {} }),
      onExit(cb) { exitCbs.set(opts.sessionId, cb); return { dispose() {} }; },
      kill() { const cb = exitCbs.get(opts.sessionId); if (cb) cb({ exitCode: 0 }); },
      resize: () => {},
      writes,
    };
  }
  reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  async captureRootCreationRow(_pid) { return null; }
}

const db = new Db(path.join(TMP, "loom.db"));
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onContextStats() {}, onRateLimited() {}, onBusy(id, busy) { db.setBusy(id, busy); },
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new TestPtyHost(events);
const sessions = new SessionService(db, host, new OrchestrationControl());

const now = new Date().toISOString();
const P = "stoprole-p";
const repoDir = path.join(TMP, "repo");
fs.mkdirSync(repoDir, { recursive: true });
db.insertProject({ id: P, name: P, repoPath: repoDir, vaultPath: repoDir, config: {}, createdAt: now, archivedAt: null });
const agentId = `${P}-agent`;
db.insertAgent({ id: agentId, projectId: P, name: "Agent", startupPrompt: "", position: 0 });

const spawnLive = (id, role) => {
  db.insertSession({
    id, projectId: P, agentId, engineSessionId: null, title: null, cwd: repoDir,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role,
  });
  host.spawn({ sessionId: id, cwd: repoDir, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
};

const stub = {};
const app = await buildServer({
  db, pty: host, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  requestShutdown: () => {},
});

try {
  // ==================== (1) worker-role stop files worker_retired(reason:human_stop) ====================
  {
    const wkr = "stoprole-wkr";
    spawnLive(wkr, "worker");
    check("(1 pre) worker is alive", host.isAlive(wkr));
    const r = await app.inject({ method: "POST", url: `/api/sessions/${wkr}/stop`, payload: { mode: "hard" } });
    check("(1) 200 OK", r.statusCode === 200);
    check("(1) the pty was actually killed", host.isAlive(wkr) === false);
    const retired = db.listEventsForWorker(wkr).find((e) => e.kind === "worker_retired");
    check("(1) a worker_retired event IS filed via the REAL route", !!retired);
    check("(1) with the specific reason human_stop", retired?.detail?.reason === "human_stop");
    check("(1) the retirement epoch reads ACTIVE afterward", db.isWorkerRetirementActive(wkr) === true);
  }

  // ==================== (2) manager-role stop files NO worker_retired event ====================
  {
    const mgr = "stoprole-mgr";
    spawnLive(mgr, "manager");
    check("(2 pre) manager is alive", host.isAlive(mgr));
    const r = await app.inject({ method: "POST", url: `/api/sessions/${mgr}/stop`, payload: { mode: "hard" } });
    check("(2) 200 OK", r.statusCode === 200);
    check("(2) the pty was actually killed", host.isAlive(mgr) === false);
    check("(2) NO worker_retired event is filed for a manager-role stop", !db.listEventsForWorker(mgr).some((e) => e.kind === "worker_retired"));
    check("(2) the retirement epoch reads NOT active (there was never a worker to retire)", db.isWorkerRetirementActive(mgr) === false);
  }

  // ==================== (3) a plain (role-less) stop also files none — the gate is role==="worker", not merely !=="manager" ====================
  {
    const plain = "stoprole-plain";
    spawnLive(plain, null);
    check("(3 pre) plain session is alive", host.isAlive(plain));
    const r = await app.inject({ method: "POST", url: `/api/sessions/${plain}/stop`, payload: { mode: "hard" } });
    check("(3) 200 OK", r.statusCode === 200);
    check("(3) NO worker_retired event is filed for a role-less stop", !db.listEventsForWorker(plain).some((e) => e.kind === "worker_retired"));
  }
} finally {
  await app.close();
  db.close();
}
await finishAndExit(failures === 0 ? 0 : 1);
