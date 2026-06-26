import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Auditor budget — the Scheduler lifts AUDITORS out of the manager concurrency cap (their own small
// budget). HERMETIC + CLAUDE-FREE + DAEMON-FREE (in-process Scheduler + Db with an injected recording
// stub; no HTTP, no real claude) so it runs in the gate (unlike scheduler.mjs, whose PART 2 needs a live
// daemon). Proves:
//   (1) an auditor-kind schedule FIRES even when the MANAGER cap is full (not blocked by it);
//   (2) a manager schedule FIRES even when the AUDITOR budget is full (the converse — independent budgets);
//   (3) the auditor budget BOUNDS auditor spawns (a burst over budget defers the rest);
//   (4) MIXED tick — an over-cap manager processed FIRST is `continue`-skipped (not `break`), so a later
//       auditor still fires.
//
// Run: 1) build (turbo builds shared first), 2) node test/scheduler-auditor-budget.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireHermeticEnv } from "./_guard.mjs";
// Set a temp LOOM_HOME so the prod-guard is satisfied even though this test opens its OWN temp db.
if (!process.env.LOOM_HOME) process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-audbudget-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/orchestration/scheduler.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-audbudget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ab-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `aa-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "AudBudget", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "x", position: 0 });
  const calls = [];
  const startManager = (tid) => { const id = `mgr-${calls.length}`; calls.push({ via: "manager", agentId: tid, id }); return { id }; };
  const startAuditor = (tid) => { const id = `aud-${calls.length}`; calls.push({ via: "auditor", agentId: tid, id }); return { id }; };
  const startWorkspaceAuditor = (tid) => { const id = `wsa-${calls.length}`; calls.push({ via: "workspace-auditor", agentId: tid, id }); return { id }; };
  const scheduler = new Scheduler({
    db, control: new OrchestrationControl(), startManager, startAuditor, startWorkspaceAuditor,
    maxConcurrentManagers: opts.cap, maxConcurrentAuditors: opts.auditorCap,
  });
  return { dbFile, db, projId, agentId, calls, scheduler };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const seedSchedule = (e, id, over = {}) => e.db.insertSchedule({
  id, agentId: e.agentId, cron: "*/5 * * * *", enabled: true,
  nextFireAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: null, createdAt: new Date().toISOString(), ...over,
});
const seedLiveSession = (e, id, role) => e.db.insertSession({
  id, projectId: e.projId, agentId: e.agentId, engineSessionId: null, title: null, cwd: e.projId,
  processState: "live", resumability: "unknown", busy: false,
  createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, role,
});

// (1) Auditor NOT blocked by a full manager cap.
{
  const e = makeEnv({ cap: 1, auditorCap: 2 });
  seedLiveSession(e, "mgr-at-cap", "manager"); // managers at cap 1
  seedSchedule(e, "sch-aud", { kind: "auditor" });
  await e.scheduler.tick(new Date());
  check("(1) auditor schedule FIRES even though the manager cap is full",
    e.calls.length === 1 && e.calls[0].via === "auditor");
  cleanupEnv(e);
}

// (1b) The same holds for the END-USER workspace-auditor kind (both kinds share the auditor budget).
{
  const e = makeEnv({ cap: 1, auditorCap: 2 });
  seedLiveSession(e, "mgr-at-cap2", "manager");
  seedSchedule(e, "sch-wsa", { kind: "workspace-auditor" });
  await e.scheduler.tick(new Date());
  check("(1b) workspace-auditor schedule FIRES even though the manager cap is full",
    e.calls.length === 1 && e.calls[0].via === "workspace-auditor");
  cleanupEnv(e);
}

// (2) Manager NOT blocked by a full auditor budget (the converse — independent budgets).
{
  const e = makeEnv({ cap: 3, auditorCap: 1 });
  seedLiveSession(e, "aud-at-budget", "auditor"); // auditors at budget 1
  seedSchedule(e, "sch-mgr-ok"); // default kind = manager
  await e.scheduler.tick(new Date());
  check("(2) manager schedule FIRES even though the auditor budget is full",
    e.calls.length === 1 && e.calls[0].via === "manager");
  cleanupEnv(e);
}

// (2b) A live workspace-auditor ALSO counts toward the auditor budget (both kinds share it).
{
  const e = makeEnv({ cap: 3, auditorCap: 1 });
  seedLiveSession(e, "wsa-at-budget", "workspace-auditor"); // budget 1 full via the user-auditor kind
  seedSchedule(e, "sch-aud-blocked", { kind: "auditor" });
  await e.scheduler.tick(new Date());
  check("(2b) a live workspace-auditor fills the shared auditor budget → an 'auditor' schedule is deferred",
    e.calls.length === 0 && e.db.getSchedule("sch-aud-blocked").lastFiredAt === null);
  cleanupEnv(e);
}

// (3) Auditor budget bounds auditor spawns: a 3-auditor burst with budget 1 fires only 1, defers 2.
{
  const e = makeEnv({ cap: 5, auditorCap: 1 });
  for (let i = 0; i < 3; i++) seedSchedule(e, `sch-aud-burst-${i}`, { kind: "auditor" });
  await e.scheduler.tick(new Date());
  check("(3) a 3-auditor burst with budget 1 fires only 1 this tick", e.calls.length === 1 && e.calls[0].via === "auditor");
  const deferred = ["sch-aud-burst-0", "sch-aud-burst-1", "sch-aud-burst-2"].filter((id) => e.db.getSchedule(id).lastFiredAt === null).length;
  check("(3) the other 2 auditor schedules are deferred (still unfired)", deferred === 2);
  cleanupEnv(e);
}

// (4) MIXED tick — an over-cap MANAGER processed FIRST (earlier next_fire_at) is `continue`-skipped, NOT
// `break`ing the loop, so the later AUDITOR still fires. (The continue-vs-break regression guard.)
{
  const e = makeEnv({ cap: 1, auditorCap: 2 });
  seedLiveSession(e, "mgr-full", "manager"); // manager cap (1) full
  seedSchedule(e, "sch-mgr-first", { nextFireAt: new Date(Date.now() - 120_000).toISOString() }); // earlier → processed first
  seedSchedule(e, "sch-aud-second", { kind: "auditor", nextFireAt: new Date(Date.now() - 60_000).toISOString() }); // later
  await e.scheduler.tick(new Date());
  check("(4) over-cap manager deferred (continue, not break) → the later auditor STILL fires",
    e.calls.length === 1 && e.calls[0].via === "auditor" && e.db.getSchedule("sch-mgr-first").lastFiredAt === null);
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — auditors draw from their own budget (independent of the manager cap), both auditor kinds share it, the budget bounds spawns, and an over-cap manager continue-skips so a later auditor still fires."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
