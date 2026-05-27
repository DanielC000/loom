// Cron Scheduler test (PR #19a). NO claude — the Scheduler takes an injected startManager, so the
// tick tests use a RECORDING STUB. Two parts:
//   PART 1 (hermetic): in-process Scheduler + Db (its OWN temp .db, never the daemon's — else the
//     daemon's real Scheduler would fire these via real startManager → claude) + a stub start-fn.
//     Covers fires / disabled / pause-gate / no-double-fire / cron-math / restart-resume.
//   PART 2 (REST): create→list→disable→delete via the daemon's HTTP endpoints (far-future cron so
//     the daemon's own 60s tick never fires it during the test).
//
// RUN against a fresh isolated LOOM_HOME daemon (PART 2 needs the HTTP endpoints):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/scheduler.mjs        (SAME LOOM_HOME)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Db } from "../dist/db.js";
import { Scheduler } from "../dist/orchestration/scheduler.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { nextFireAt } from "../dist/orchestration/cron.js";

const BASE = "http://127.0.0.1:4317";
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- PART 1: hermetic (own temp DB + injected stub; no daemon, no claude) ---
function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `sp-${Math.random().toString(36).slice(2, 8)}`;
  const topicId = `st-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "Sched", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertTopic({ id: topicId, projectId: projId, name: "t", startupPrompt: "drain the board", position: 0 });
  const control = new OrchestrationControl();
  const calls = [];
  const startManager = (tid) => { const id = `mgr-${calls.length}`; calls.push({ topicId: tid, id }); return { id }; };
  return { dbFile, db, projId, topicId, control, calls, scheduler: new Scheduler({ db, control, startManager }) };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const seedSchedule = (e, id, over = {}) => e.db.insertSchedule({
  id, topicId: e.topicId, cron: "*/5 * * * *", enabled: true,
  nextFireAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: null, createdAt: new Date().toISOString(), ...over,
});

// Fires: a due, enabled schedule → start-fn called with the topic; event recorded; next_fire_at future.
{
  const e = makeEnv();
  seedSchedule(e, "sch-fire");
  const now = new Date();
  await e.scheduler.tick(now);
  check("Fires: stub start-fn called once with the schedule's topic", e.calls.length === 1 && e.calls[0].topicId === e.topicId);
  const evs = e.db.listEvents(e.calls[0].id);
  check("Fires: schedule_fired event recorded (managerSessionId = started manager)",
    evs.length === 1 && evs[0].kind === "schedule_fired" && evs[0].detail?.scheduleId === "sch-fire" && evs[0].detail?.cron === "*/5 * * * *");
  const after = e.db.getSchedule("sch-fire");
  check("Fires: next_fire_at advanced to the future", new Date(after.nextFireAt).getTime() > now.getTime());
  check("Fires: last_fired_at stamped with the tick's now", after.lastFiredAt === now.toISOString());
  cleanupEnv(e);
}

// Disabled: a due but disabled schedule → no fire, no event.
{
  const e = makeEnv();
  seedSchedule(e, "sch-dis", { enabled: false });
  await e.scheduler.tick(new Date());
  check("Disabled: start-fn NOT called", e.calls.length === 0);
  check("Disabled: schedule untouched (never fired)", e.db.getSchedule("sch-dis").lastFiredAt === null);
  cleanupEnv(e);
}

// Pause-gated: global pause latched → no fire; after resume → fires next tick (mirrors #17a).
{
  const e = makeEnv();
  e.control.pause("global");
  seedSchedule(e, "sch-pause");
  await e.scheduler.tick(new Date());
  check("Pause-gated: globally paused → does NOT fire", e.calls.length === 0 && e.db.getSchedule("sch-pause").lastFiredAt === null);
  e.control.resume("global");
  await e.scheduler.tick(new Date());
  check("Pause-gated: after resume → fires on the next tick", e.calls.length === 1 && e.calls[0].topicId === e.topicId);
  cleanupEnv(e);
}

// No double-fire: a second immediate tick after a fire does nothing (next_fire_at is now future).
{
  const e = makeEnv();
  seedSchedule(e, "sch-dbl");
  const now = new Date();
  await e.scheduler.tick(now);
  await e.scheduler.tick(now); // same instant, immediately again
  check("No double-fire: second immediate tick is a no-op (next_fire_at future)", e.calls.length === 1);
  cleanupEnv(e);
}

// Cron math: next_fire_at from a known expr is the correct future boundary (and strictly-after).
{
  const next = nextFireAt("*/5 * * * *", new Date("2026-05-28T01:02:30.000Z"));
  check("Cron math: */5 from 01:02:30 → 01:05:00", next === "2026-05-28T01:05:00.000Z");
  const atBoundary = nextFireAt("*/5 * * * *", new Date("2026-05-28T01:05:00.000Z"));
  check("Cron math: strictly-after a boundary → the NEXT slot 01:10:00", atBoundary === "2026-05-28T01:10:00.000Z");
}

// Restart-resume: a persisted schedule with a PAST next_fire_at recomputes forward on start()
// (no fire flood / catch-up).
{
  const e = makeEnv();
  seedSchedule(e, "sch-restart", { nextFireAt: new Date(Date.now() - 3_600_000).toISOString() });
  const now = new Date();
  e.scheduler.start(now); // reconciles missed fires forward + arms the interval
  e.scheduler.stop();     // clear the 60s timer right away (test drives nothing further)
  const after = e.db.getSchedule("sch-restart");
  check("Restart-resume: past next_fire_at recomputed forward on start()", new Date(after.nextFireAt).getTime() > now.getTime());
  check("Restart-resume: start() did NOT fire (no catch-up flood)", e.calls.length === 0);
  cleanupEnv(e);
}

// --- PART 2: REST round-trip via the daemon's endpoints ---
const rid = `rest-${Date.now()}`;
const rproj = `rp-${rid}`, rtopic = `rt-${rid}`;
{
  const seed = new Database(DB_FILE);
  const now = new Date().toISOString();
  seed.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(rproj, "RESTsched", rproj, rproj, "{}", now);
  seed.prepare("INSERT INTO topics (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run(rtopic, rproj, "t", "x");
  seed.close();
}
try {
  // Far-future cron ("0 0 1 1 *" = next Jan 1) so the daemon's own scheduler never fires it here.
  const created = await (await post("/api/schedules", { topicId: rtopic, cron: "0 0 1 1 *" })).json();
  check("REST create: 201 with id + a future next_fire_at + enabled", !!created.id && new Date(created.nextFireAt).getTime() > Date.now() && created.enabled === true);
  let list = await get("/api/schedules");
  check("REST list: includes the created schedule", list.some((s) => s.id === created.id));
  const updated = await (await post(`/api/schedules/${created.id}`, { enabled: false })).json();
  check("REST update: disable → enabled:false", updated.enabled === false);
  await fetch(`${BASE}/api/schedules/${created.id}`, { method: "DELETE" });
  list = await get("/api/schedules");
  check("REST delete: no longer listed", !list.some((s) => s.id === created.id));
  // Validation: a bad cron is rejected 400 (not inserted).
  const bad = await post("/api/schedules", { topicId: rtopic, cron: "not a cron" });
  check("REST create: invalid cron → 400", bad.status === 400);
} finally {
  const t = new Database(DB_FILE);
  t.prepare("DELETE FROM schedules WHERE topic_id = ?").run(rtopic);
  t.prepare("DELETE FROM topics WHERE id = ?").run(rtopic);
  t.prepare("DELETE FROM projects WHERE id = ?").run(rproj);
  t.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Scheduler fires due/enabled/non-paused schedules, advances next_fire_at (no double-fire), recomputes missed fires forward on start; REST CRUD round-trips."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
