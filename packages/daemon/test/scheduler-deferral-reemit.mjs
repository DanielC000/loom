import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fast-follow coverage for card d027577b (CR a3715e68 on 53edd8d5's deferral-observability work).
// HERMETIC + CLAUDE-FREE + DAEMON-FREE (in-process Scheduler + Db with an injected stub start-fn; no
// HTTP, no real claude) so it runs in the gate (unlike scheduler.mjs, whose PART 2 needs a live daemon).
//
// Proves TWO things the existing scheduler.mjs deferral tests don't cover:
//   (1) REASON-CHANGE RE-EMIT: `markDeferred`/`schedule_fire_deferred` fire again — a fresh timestamp
//       AND a second durable event — when the deferral REASON changes between ticks (not just on the
//       first transition into deferred). Distinct from scheduler.mjs's "Transition-only" test, which
//       proves the OPPOSITE half (a SAME-reason repeat tick writes nothing).
//   (2) RECONCILE-CLEAR: Scheduler.start()'s missed-fire reconcile path (advancing a stale next_fire_at
//       forward on boot) is NOT a real fire — it never goes through markFired — so without an explicit
//       clear a schedule that was mid-deferral when the daemon went down would keep showing the amber
//       "deferred" badge indefinitely after restart. start() must clear last_deferred_at/reason too.
//
// Run: 1) build (turbo builds shared first), 2) node test/scheduler-deferral-reemit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { requireHermeticEnv } from "./_guard.mjs";
if (!process.env.LOOM_HOME) process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-defreemit-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/orchestration/scheduler.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { nextFireAt } = await import("../dist/orchestration/cron.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-defreemit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `dr-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `da-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "DefReemit", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "x", position: 0 });
  const calls = [];
  const startManager = (tid) => { const id = `mgr-${calls.length}`; calls.push({ via: "manager", agentId: tid, id }); return { id }; };
  const scheduler = new Scheduler({ db, control: new OrchestrationControl(), startManager, maxConcurrentManagers: opts.cap });
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
// A live SCHEDULER-SPAWNED manager row — counts against countLiveScheduledManagers (mirrors scheduler.mjs).
const seedLiveScheduledManager = (e, id) => e.db.insertSession({
  id, projectId: e.projId, agentId: e.agentId, engineSessionId: null, title: null, cwd: e.projId,
  processState: "live", resumability: "unknown", busy: false,
  createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, role: "manager",
  scheduledSpawn: true,
});

// (1) REASON-CHANGE RE-EMIT: cap 1, one scheduler-spawned manager already at the cap → first tick defers
// with reason "manager cap (1) reached". Bump the cap to 2 and add a second scheduler-spawned manager so
// the schedule is STILL fully blocked (2 live >= cap 2) but under a DIFFERENT reason string. The second
// tick must re-stamp lastDeferredAt (fresh timestamp) AND file a SECOND schedule_fire_deferred event —
// unlike a same-reason repeat tick, which (per scheduler.mjs's "Transition-only" test) writes nothing.
{
  const e = makeEnv({ cap: 1 });
  seedLiveScheduledManager(e, "mgr-a");
  seedSchedule(e, "sch-reason-change");
  await e.scheduler.tick(new Date());
  const afterFirst = e.db.getSchedule("sch-reason-change");
  check("(1) first tick defers with the cap-1 reason", afterFirst.lastDeferredReason === "manager cap (1) reached" && !!afterFirst.lastDeferredAt);

  await new Promise((r) => setTimeout(r, 5)); // ensure a distinguishable later timestamp
  e.scheduler.deps.maxConcurrentManagers = 2; // test seam (TS `private` erases to a plain field at runtime)
  seedLiveScheduledManager(e, "mgr-b"); // now 2 live scheduled managers, still fully at the NEW cap of 2
  await e.scheduler.tick(new Date());
  const afterSecond = e.db.getSchedule("sch-reason-change");
  check("(1) second tick re-stamps lastDeferredAt once the reason changes", afterSecond.lastDeferredAt !== afterFirst.lastDeferredAt);
  check("(1) second tick's reason reflects the NEW cap", afterSecond.lastDeferredReason === "manager cap (2) reached");
  check("(1) the schedule is still unfired (both ticks deferred, never spawned)", e.calls.length === 0 && afterSecond.lastFiredAt === null);

  const raw = new Database(e.dbFile);
  const evs = raw.prepare("SELECT * FROM orchestration_events WHERE kind = 'schedule_fire_deferred' ORDER BY ts").all();
  raw.close();
  check("(1) TWO schedule_fire_deferred events are filed (one per reason transition, not one total)", evs.length === 2);
  check("(1) the two events carry the two DISTINCT reasons", JSON.parse(evs[0].detail_json).reason === "manager cap (1) reached" && JSON.parse(evs[1].detail_json).reason === "manager cap (2) reached");
  cleanupEnv(e);
}

// (2) RECONCILE-CLEAR: a schedule that was mid-deferral when the daemon went down (its stale next_fire_at
// is also in the past) must have its deferral columns CLEARED when Scheduler.start()'s reconcile advances
// next_fire_at forward — that advance is not a real fire (never goes through markFired), so without an
// explicit clear the amber badge would linger past the episode's actual end.
{
  const e = makeEnv();
  const staleNextFireAt = new Date(Date.now() - 3_600_000).toISOString();
  seedSchedule(e, "sch-reconcile-clear", { nextFireAt: staleNextFireAt });
  e.db.markDeferred("sch-reconcile-clear", new Date(Date.now() - 1_800_000).toISOString(), "manager cap (3) reached");
  const before = e.db.getSchedule("sch-reconcile-clear");
  check("(2) setup: the schedule starts mid-deferral (both columns populated)", !!before.lastDeferredAt && before.lastDeferredReason === "manager cap (3) reached");

  const now = new Date();
  e.scheduler.start(now); // reconciles the stale next_fire_at forward
  e.scheduler.stop();
  const after = e.db.getSchedule("sch-reconcile-clear");
  check("(2) next_fire_at recomputed forward (unchanged base behavior)", new Date(after.nextFireAt).getTime() > now.getTime());
  check("(2) reconcile-advance did NOT fire (no catch-up spawn)", e.calls.length === 0);
  check("(2) lastDeferredAt/lastDeferredReason are CLEARED back to null by the reconcile advance", after.lastDeferredAt === null && after.lastDeferredReason === null);
  cleanupEnv(e);
}

// (2b) RECONCILE-CLEAR negative control: a schedule whose next_fire_at is still in the FUTURE is not
// touched by the reconcile loop at all, so a genuine in-flight deferral (a schedule still due, still
// blocked) must NOT be cleared just because start() ran.
{
  const e = makeEnv();
  seedSchedule(e, "sch-not-reconciled", { nextFireAt: new Date(Date.now() + 3_600_000).toISOString() });
  e.db.markDeferred("sch-not-reconciled", new Date().toISOString(), "manager cap (1) reached");
  e.scheduler.start(new Date());
  e.scheduler.stop();
  const after = e.db.getSchedule("sch-not-reconciled");
  check("(2b) a schedule NOT past-due is untouched by the reconcile loop — its deferral is left intact",
    after.lastDeferredReason === "manager cap (1) reached" && !!after.lastDeferredAt);
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a deferral reason CHANGE between ticks re-stamps lastDeferredAt and files a second schedule_fire_deferred event; Scheduler.start()'s missed-fire reconcile clears a stale deferral (it's not a real fire), leaving a still-due schedule's genuine in-flight deferral untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
