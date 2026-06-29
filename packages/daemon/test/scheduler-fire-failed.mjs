import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Durable scheduler spawn-failure event — when a scheduled fire's spawn THROWS, the Scheduler used to
// ONLY stderr-log it, so a cadence could silently never run with no surfaced reason. It now records a
// `schedule_fire_failed` orchestration event (the queryable mirror of the schedule_fired success event).
// HERMETIC + CLAUDE-FREE + DAEMON-FREE (in-process Scheduler + Db with a THROWING injected start-fn; no
// HTTP, no real claude) so it runs in the gate (unlike scheduler.mjs, whose PART 2 needs a live daemon).
// Proves:
//   (1) a thrown spawn emits exactly ONE schedule_fire_failed event with an EMPTY managerSessionId (NOT the
//       schedule id — a session-less event must not overload the session field, or consumers treating
//       managerSessionId as a session foreign key mis-join);
//   (2) its detail carries scheduleId/cron/kind + the error message (the surfaced reason);
//   (3) NO schedule_fired event is recorded (the spawn never succeeded) and the slot is still claimed;
//   (4) the schedule stays ENABLED — a transient spawn failure must not permanently disable a cadence;
//   (5) the auditor path is covered too (a thrown startAuditor records the same event).
//
// Run: 1) build (turbo builds shared first), 2) node test/scheduler-fire-failed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireHermeticEnv } from "./_guard.mjs";
// Set a temp LOOM_HOME so the prod-guard is satisfied even though this test opens its OWN temp db.
if (!process.env.LOOM_HOME) process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-firefail-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/orchestration/scheduler.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// makeEnv with start-fns that THROW (to drive the failure path). `throwManager`/`throwAuditor` toggle which.
function makeEnv({ throwManager = false, throwAuditor = false } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-firefail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ff-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `fa-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "FireFail", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "x", position: 0 });
  const calls = [];
  const startManager = (tid) => {
    if (throwManager) throw new Error("startManager failed (simulated)");
    const id = `mgr-${calls.length}`; calls.push({ via: "manager", agentId: tid, id }); return { id };
  };
  const startAuditor = (tid) => {
    if (throwAuditor) throw new Error("startAuditor failed (simulated)");
    const id = `aud-${calls.length}`; calls.push({ via: "auditor", agentId: tid, id }); return { id };
  };
  const scheduler = new Scheduler({ db, control: new OrchestrationControl(), startManager, startAuditor });
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

// (1)+(2)+(3)+(4) — a thrown MANAGER spawn records the durable failure event (keyed by the schedule id).
{
  const e = makeEnv({ throwManager: true });
  seedSchedule(e, "sch-failevt"); // default kind "manager" → routed to startManager → throws this tick
  const now = new Date();
  await e.scheduler.tick(now);
  // The failure event is session-LESS (no manager session spawned), so it populates managerSessionId with
  // the empty-string sentinel — NOT the schedule id (which would mis-join a session-foreign-key consumer).
  const evs = e.db.listEvents(""); // session-less events key off the empty-string managerSessionId
  check("(1) a thrown spawn emits exactly one schedule_fire_failed event with an EMPTY managerSessionId",
    evs.length === 1 && evs[0].kind === "schedule_fire_failed" && evs[0].managerSessionId === "");
  check("(1b) the schedule id is NOT placed in the session-id field (no event keyed by the schedule id)",
    e.db.listEvents("sch-failevt").length === 0);
  check("(2) detail carries scheduleId + cron + kind + the error message (the surfaced reason)",
    evs[0]?.detail?.scheduleId === "sch-failevt" && evs[0]?.detail?.cron === "*/5 * * * *" &&
    evs[0]?.detail?.kind === "manager" && typeof evs[0]?.detail?.error === "string" && evs[0].detail.error.length > 0);
  check("(3) no schedule_fired event was recorded (the spawn never succeeded)",
    !evs.some((ev) => ev.kind === "schedule_fired") && e.calls.length === 0);
  check("(3b) the slot is still claimed (next_fire_at advanced despite the failure)",
    new Date(e.db.getSchedule("sch-failevt").nextFireAt).getTime() > now.getTime());
  check("(4) the schedule stays ENABLED (a transient spawn failure must not disable the cadence)",
    e.db.getSchedule("sch-failevt").enabled === true);
  cleanupEnv(e);
}

// (5) — the same durable record is emitted for a thrown AUDITOR spawn (kind="auditor" → startAuditor).
{
  const e = makeEnv({ throwAuditor: true });
  seedSchedule(e, "sch-aud-fail", { kind: "auditor" });
  await e.scheduler.tick(new Date());
  const evs = e.db.listEvents(""); // session-less, keyed off the empty-string managerSessionId
  check("(5) a thrown auditor spawn ALSO records schedule_fire_failed (kind=auditor in detail), session-less",
    evs.length === 1 && evs[0].kind === "schedule_fire_failed" && evs[0].managerSessionId === "" &&
    evs[0]?.detail?.kind === "auditor" && evs[0]?.detail?.scheduleId === "sch-aud-fail");
  cleanupEnv(e);
}

// (6) — a SUCCESSFUL fire records NO failure event (the negative control: failure path is failure-only).
{
  const e = makeEnv(); // neither start-fn throws
  seedSchedule(e, "sch-ok");
  await e.scheduler.tick(new Date());
  check("(6) a successful fire records schedule_fired (not schedule_fire_failed)",
    e.calls.length === 1 && !e.db.listEvents("sch-ok").some((ev) => ev.kind === "schedule_fire_failed"));
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a thrown scheduled spawn (manager OR auditor) records a durable, queryable schedule_fire_failed event (session-LESS: empty managerSessionId, NOT the schedule id; detail carries the scheduleId + surfaced error), claims the slot, leaves the schedule enabled, and a successful fire records none."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
