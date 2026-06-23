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

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv({ port: true }); // prod-guard: abort unless LOOM_HOME=<temp> + LOOM_PORT != 4317
const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const DB_FILE = path.join(LOOM, "loom.db");
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- PART 1: hermetic (own temp DB + injected stub; no daemon, no claude) ---
function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `sp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `st-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "Sched", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "drain the board", position: 0 });
  const control = new OrchestrationControl();
  const calls = [];
  // opts.failFirstN: throw on the first N startManager calls (to exercise claim-before-spawn).
  let failsLeft = opts.failFirstN ?? 0;
  const startManager = (tid) => {
    if (failsLeft > 0) { failsLeft--; throw new Error("startManager failed (simulated)"); }
    const id = `mgr-${calls.length}`; calls.push({ via: "manager", agentId: tid, id }); return { id };
  };
  // B6: a recording stub for the workspace-auditor spawn (the kind="workspace-auditor" route). Tagged
  // via:"workspace-auditor" so a test can assert the Scheduler dispatched THIS fn, not startManager.
  const startWorkspaceAuditor = (tid) => {
    const id = `wsa-${calls.length}`; calls.push({ via: "workspace-auditor", agentId: tid, id }); return { id };
  };
  const scheduler = new Scheduler({ db, control, startManager, startWorkspaceAuditor, maxConcurrentManagers: opts.cap });
  return { dbFile, db, projId, agentId, control, calls, scheduler };
}
// Seed a live MANAGER session row directly (for the manager-cap DB-count axis).
const seedLiveManager = (e, id) => e.db.insertSession({
  id, projectId: e.projId, agentId: e.agentId, engineSessionId: null, title: null, cwd: e.projId,
  processState: "live", resumability: "unknown", busy: false,
  createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, role: "manager",
});
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const seedSchedule = (e, id, over = {}) => e.db.insertSchedule({
  id, agentId: e.agentId, cron: "*/5 * * * *", enabled: true,
  nextFireAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: null, createdAt: new Date().toISOString(), ...over,
});

// Fires: a due, enabled schedule → start-fn called with the agent; event recorded; next_fire_at future.
{
  const e = makeEnv();
  seedSchedule(e, "sch-fire");
  const now = new Date();
  await e.scheduler.tick(now);
  check("Fires: stub start-fn called once with the schedule's agent", e.calls.length === 1 && e.calls[0].agentId === e.agentId);
  const evs = e.db.listEvents(e.calls[0].id);
  check("Fires: schedule_fired event recorded (managerSessionId = started manager)",
    evs.length === 1 && evs[0].kind === "schedule_fired" && evs[0].detail?.scheduleId === "sch-fire" && evs[0].detail?.cron === "*/5 * * * *");
  const after = e.db.getSchedule("sch-fire");
  check("Fires: next_fire_at advanced to the future", new Date(after.nextFireAt).getTime() > now.getTime());
  check("Fires: last_fired_at stamped with the tick's now", after.lastFiredAt === now.toISOString());
  cleanupEnv(e);
}

// B6 — kind routing: a due "workspace-auditor" schedule dispatches the injected startWorkspaceAuditor
// stub (NOT startManager), counts against the cap, and logs kind in the schedule_fired event.
{
  const e = makeEnv();
  seedSchedule(e, "sch-wsa", { kind: "workspace-auditor" });
  const now = new Date();
  await e.scheduler.tick(now);
  check("Workspace-auditor kind: routed to startWorkspaceAuditor (not startManager)",
    e.calls.length === 1 && e.calls[0].via === "workspace-auditor" && e.calls[0].agentId === e.agentId);
  const evs = e.db.listEvents(e.calls[0].id);
  check("Workspace-auditor kind: schedule_fired event records kind=workspace-auditor",
    evs.length === 1 && evs[0].kind === "schedule_fired" && evs[0].detail?.kind === "workspace-auditor");
  check("Workspace-auditor kind: next_fire_at advanced (slot claimed)", new Date(e.db.getSchedule("sch-wsa").nextFireAt).getTime() > now.getTime());
  cleanupEnv(e);
}

// B6 — fallback: a "workspace-auditor" schedule with startWorkspaceAuditor UNWIRED falls back to
// startManager (mirrors the auditor fallback — the manager path stays correct when the spawn is absent).
{
  const e = makeEnv();
  // Re-wire a scheduler WITHOUT the workspace-auditor stub to exercise the fallback branch.
  e.scheduler = new Scheduler({ db: e.db, control: e.control, startManager: (tid) => { const id = `mgr-${e.calls.length}`; e.calls.push({ via: "manager", agentId: tid, id }); return { id }; } });
  seedSchedule(e, "sch-wsa-fallback", { kind: "workspace-auditor" });
  await e.scheduler.tick(new Date());
  check("Workspace-auditor fallback: unwired startWorkspaceAuditor → falls back to startManager",
    e.calls.length === 1 && e.calls[0].via === "manager");
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
  check("Pause-gated: after resume → fires on the next tick", e.calls.length === 1 && e.calls[0].agentId === e.agentId);
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

// === §19a hardening (3 findings) ===

// Finding 1 — deleted agent: a due schedule whose agent no longer exists is DISABLED (so it stops
// re-firing every tick), not fired. (Note: the `agent_id REFERENCES agents(id)` FK normally PREVENTS
// orphaning — so this is defense-in-depth. We simulate "agent deleted out from under the schedule"
// via a raw FK-off delete, the state a future cascade-less agent-delete or FK-off run would produce.)
{
  const e = makeEnv();
  seedSchedule(e, "sch-orphan"); // valid agent (e.agentId)
  const raw = new Database(e.dbFile);
  raw.pragma("foreign_keys = OFF");
  raw.prepare("DELETE FROM agents WHERE id = ?").run(e.agentId);
  raw.close();
  await e.scheduler.tick(new Date());
  check("Deleted-agent: a schedule whose agent was deleted does NOT fire", e.calls.length === 0);
  check("Deleted-agent: the schedule is auto-DISABLED (self-heal — no re-fire every tick)", e.db.getSchedule("sch-orphan").enabled === false);
  await e.scheduler.tick(new Date()); // a now-disabled schedule is not even due
  check("Deleted-agent: a second tick still does nothing", e.calls.length === 0);
  cleanupEnv(e);
}

// Finding 2 — claim-before-spawn: when startManager throws, next_fire_at is ALREADY advanced (slot
// claimed first), so the failed schedule does NOT double-fire on the next tick.
{
  const e = makeEnv({ failFirstN: 1 });
  seedSchedule(e, "sch-claim");
  const now = new Date();
  await e.scheduler.tick(now); // the spawn throws — but the slot was claimed first
  check("Claim-before-spawn: the throwing spawn recorded NO schedule_fired event", e.calls.length === 0);
  const after = e.db.getSchedule("sch-claim");
  check("Claim-before-spawn: next_fire_at was advanced despite the failure (slot consumed)", new Date(after.nextFireAt).getTime() > now.getTime());
  await e.scheduler.tick(now); // immediately again: NOT due (slot already advanced) → no double-spawn
  check("Claim-before-spawn: no double-fire on the next tick", e.calls.length === 0);
  cleanupEnv(e);
}

// Finding 3a — manager cap (in-tick burst): with cap=2, a burst of 5 simultaneously-due schedules
// fires only 2 this tick; the rest are deferred (still due) and fire on later ticks.
{
  const e = makeEnv({ cap: 2 });
  for (let i = 0; i < 5; i++) seedSchedule(e, `sch-burst-${i}`);
  await e.scheduler.tick(new Date());
  check("Manager-cap: a 5-schedule burst with cap 2 fires only 2 this tick", e.calls.length === 2);
  const deferred = ["sch-burst-0", "sch-burst-1", "sch-burst-2", "sch-burst-3", "sch-burst-4"]
    .filter((id) => e.db.getSchedule(id).lastFiredAt === null).length;
  check("Manager-cap: the other 3 are deferred (still unfired, next_fire_at left in the past)", deferred === 3);
  cleanupEnv(e);
}

// Finding 3b — manager cap (DB count axis): pre-existing LIVE managers count toward the cap, so a
// due schedule does NOT fire while the account already has `cap` live managers.
{
  const e = makeEnv({ cap: 2 });
  seedLiveManager(e, "mgr-existing-1");
  seedLiveManager(e, "mgr-existing-2"); // already at the cap of 2
  seedSchedule(e, "sch-capped");
  await e.scheduler.tick(new Date());
  check("Manager-cap (DB count): at the cap from existing live managers → a due schedule does NOT fire", e.calls.length === 0);
  check("Manager-cap (DB count): the deferred schedule is left due (not advanced, not disabled)",
    e.db.getSchedule("sch-capped").lastFiredAt === null && e.db.getSchedule("sch-capped").enabled === true);
  cleanupEnv(e);
}

// --- PART 2: REST round-trip via the daemon's endpoints ---
const rid = `rest-${Date.now()}`;
const rproj = `rp-${rid}`, ragent = `rt-${rid}`;
{
  const seed = new Database(DB_FILE);
  const now = new Date().toISOString();
  seed.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
    .run(rproj, "RESTsched", rproj, rproj, "{}", now);
  seed.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run(ragent, rproj, "t", "x");
  seed.close();
}
try {
  // Far-future cron ("0 0 1 1 *" = next Jan 1) so the daemon's own scheduler never fires it here.
  const created = await (await post("/api/schedules", { agentId: ragent, cron: "0 0 1 1 *" })).json();
  check("REST create: 201 with id + a future next_fire_at + enabled", !!created.id && new Date(created.nextFireAt).getTime() > Date.now() && created.enabled === true);
  let list = await get("/api/schedules");
  check("REST list: includes the created schedule", list.some((s) => s.id === created.id));
  const updated = await (await post(`/api/schedules/${created.id}`, { enabled: false })).json();
  check("REST update: disable → enabled:false", updated.enabled === false);
  await fetch(`${BASE}/api/schedules/${created.id}`, { method: "DELETE" });
  list = await get("/api/schedules");
  check("REST delete: no longer listed", !list.some((s) => s.id === created.id));
  // Validation: a bad cron is rejected 400 (not inserted).
  const bad = await post("/api/schedules", { agentId: ragent, cron: "not a cron" });
  check("REST create: invalid cron → 400", bad.status === 400);
  // B6 — kind round-trip: create with kind="workspace-auditor" persists it on the row (create→row).
  const wsa = await (await post("/api/schedules", { agentId: ragent, cron: "0 0 1 1 *", kind: "workspace-auditor" })).json();
  check("REST create: kind=workspace-auditor round-trips onto the row", wsa.kind === "workspace-auditor" && !!wsa.id);
  const wsaList = await get("/api/schedules");
  check("REST list: the workspace-auditor schedule shows its kind", wsaList.some((s) => s.id === wsa.id && s.kind === "workspace-auditor"));
  const wsaDisabled = await (await post(`/api/schedules/${wsa.id}`, { enabled: false })).json();
  check("REST update: disable a workspace-auditor schedule (kind preserved)", wsaDisabled.enabled === false && wsaDisabled.kind === "workspace-auditor");
  await fetch(`${BASE}/api/schedules/${wsa.id}`, { method: "DELETE" });
  // Validation: an unknown kind is rejected 400 (not coerced).
  const badKind = await post("/api/schedules", { agentId: ragent, cron: "0 0 1 1 *", kind: "bogus" });
  check("REST create: invalid kind → 400", badKind.status === 400);
} finally {
  const t = new Database(DB_FILE);
  t.prepare("DELETE FROM schedules WHERE agent_id = ?").run(ragent);
  t.prepare("DELETE FROM agents WHERE id = ?").run(ragent);
  t.prepare("DELETE FROM projects WHERE id = ?").run(rproj);
  t.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Scheduler fires due/enabled/non-paused schedules, advances next_fire_at (no double-fire), recomputes missed fires forward on start; REST CRUD round-trips."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
