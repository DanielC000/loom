import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Anti-dodge invariant coverage for card d027577b (CR a3715e68 on 53edd8d5's manager-cap narrowing).
// Card 53edd8d5 narrowed the Scheduler's manager-cap budget to count ONLY scheduler-spawned managers
// (`scheduled_spawn = 1`), specifically so a standing human/Lead-spawned fleet can never starve a cadence.
// SessionService.recycleManager already carries `scheduledSpawn: old.scheduledSpawn ?? false` onto the
// fresh successor row (service.ts) — the point of THIS test is to prove that carry deterministically,
// end-to-end through recycleManager, so a scheduler-spawned manager can't quietly DODGE its own budget by
// self-recycling (a recycle that dropped the flag would let an unbounded number of scheduler-spawned
// managers cycle through recycle_me and each escape the cap as a "fresh", uncounted row).
//
// NO claude, NO live daemon — in-process Db + SessionService with a contract-faithful PtyStub (mirrors
// recycle-pending-carry.mjs's own harness).
//
// Run: 1) build daemon (turbo builds shared first), 2) node test/scheduler-recycle-carry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing db.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-schedrc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A minimal contract-faithful PtyStub — only the surface recycleManager touches (spawn/flushPending/stop).
class PtyStub {
  constructor() { this.spawned = []; this.stopped = []; }
  enqueueStdin() { return { delivered: false }; }
  flushPending() { return []; }
  getPending() { return []; }
  spawn(opts) { this.spawned.push(opts); }
  stop(id) { this.stopped.push(id); }
  isAlive() { return true; }
}

const db = new Db();
const proj = `sr-proj-${sfx}`, agent = `sr-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "BRIEF", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, scheduledSpawn: o.scheduledSpawn ?? false,
});

try {
  const pty = new PtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const oldMgr = `sr-mgr-${sfx}`;
  mkSession({ id: oldMgr, role: "manager", scheduledSpawn: true }); // a real Scheduler.tick() spawn

  check("setup: the scheduler-spawned manager counts against the budget BEFORE recycling", db.countLiveScheduledManagers() === 1);

  const fresh = await sessions.recycleManager(oldMgr, "successor: 2 workers in review, drain the queue");

  check("recycleManager carries scheduledSpawn=true onto the fresh successor row", db.getSession(fresh.id)?.scheduledSpawn === true);

  // The predecessor's own pty exit (and the resulting DB retirement) happens asynchronously in the real
  // system (host.ts's onExit → setProcessState) — recycleManager itself only defers the hard pty.stop by
  // 3s. Simulate that eventual retirement here (deterministically, without waiting on a real timer) to
  // isolate what this test is actually proving: that the SUCCESSOR, not the predecessor, is what keeps the
  // budget count alive across a self-recycle.
  db.setProcessState(oldMgr, "exited");

  check("the successor ALONE still counts against countLiveScheduledManagers post-recycle (no budget dodge)",
    db.countLiveScheduledManagers() === 1);

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a scheduler-spawned manager's recycle successor carries scheduledSpawn forward and still counts against the Scheduler's own manager-cap budget (countLiveScheduledManagers) — self-recycle cannot be used to dodge the cap."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
