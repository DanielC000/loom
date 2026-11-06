import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bba7a8ec (Code Review round 2, S2) — the Scheduler's deploy-staleness pre-read must not open a window
// between the per-schedule cap/pause/agent checks and the spawn they guard. Main's tick() had no await; the
// first cut put a ~1 s (up to 10-30 s) git await INSIDE the startManager dep, so overlapping setInterval ticks
// could exceed maxConcurrentManagers and a pause toggled mid-await no longer stopped the spawn.
// HERMETIC + CLAUDE-FREE + DAEMON-FREE (in-process Scheduler + Db with injected recording stubs).
//   (1) two DUE manager schedules, cap 1, TWO OVERLAPPING ticks over a slow pre-read: exactly ONE spawn total
//       (the second tick re-lists due after its own await; the cap check sees the first spawn's row).
//   (1c) CONTROL (the check can fail): the OLD wiring shape — a slow ASYNC startManager and no pre-read dep —
//       with the same overlapping ticks DOES exceed the cap (2 spawns), so (1) is not vacuous.
//   (2) a global pause toggled WHILE the pre-read is in flight stops every spawn (the gate runs after the await).
//   (3) the pre-read runs ONCE per tick (not per schedule) and its value reaches every manager spawn.
//   (4) an auditor-only due list makes NO pre-read and its spawn gets no staleness.
// Run: 1) build (turbo builds shared first), 2) node test/scheduler-staleness-preread-no-overlap.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireHermeticEnv } from "./_guard.mjs";
if (!process.env.LOOM_HOME) process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-spo-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/orchestration/scheduler.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { STAMPED_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ_MS = 150;

function makeEnv({ cap, asyncStartManager = false, withPreRead = true }) {
  const dbFile = path.join(os.tmpdir(), `loom-spo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `sp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `sa-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "SPO", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "x", position: 0 });
  const control = new OrchestrationControl();
  const spawns = [];
  const preReads = { n: 0 };
  // The stub records a LIVE scheduler-spawned manager row, as the real startManager does, so the DB-derived cap
  // count (countLiveScheduledManagers) sees a spawn that already happened.
  const record = (opts, kind) => {
    const id = `mgr-${spawns.length}`;
    spawns.push({ id, kind, deployStaleness: opts?.deployStaleness });
    db.insertSession({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", scheduledSpawn: true });
    return { id };
  };
  const startManager = asyncStartManager
    ? async (_a, _p, opts) => { await sleep(READ_MS); return record(opts, "manager"); }
    : (_a, _p, opts) => record(opts, "manager");
  const startAuditor = (_a, _p, opts) => { const id = `aud-${spawns.length}`; spawns.push({ id, kind: "auditor", deployStaleness: opts?.deployStaleness }); return { id }; };
  const scheduler = new Scheduler({
    db, control, startManager, startAuditor, maxConcurrentManagers: cap,
    ...(withPreRead ? { preReadDeployStaleness: async () => { preReads.n++; await sleep(READ_MS); return STAMPED_STALENESS; } } : {}),
  });
  return { dbFile, db, agentId, control, spawns, preReads, scheduler };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const seedSchedule = (e, id, over = {}) => e.db.insertSchedule({
  id, agentId: e.agentId, cron: "*/5 * * * *", enabled: true,
  nextFireAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: null, createdAt: new Date().toISOString(), ...over,
});

// (1) two due schedules, cap 1, two overlapping ticks over the slow pre-read ⇒ exactly one spawn.
{
  const e = makeEnv({ cap: 1 });
  seedSchedule(e, "sch-a"); seedSchedule(e, "sch-b");
  await Promise.all([e.scheduler.tick(new Date()), e.scheduler.tick(new Date())]);
  check(`(1) overlapping ticks over a slow pre-read respect maxConcurrentManagers=1 (spawns=${e.spawns.length})`, e.spawns.length === 1);
  cleanupEnv(e);
}
// (1b) a cap far above the due count (so the cap cannot mask a double-fire): each due schedule fires exactly once
// — only the post-await re-list of `due` keeps the second tick from re-firing what the first already claimed.
{
  const e = makeEnv({ cap: 10 });
  seedSchedule(e, "sch-a"); seedSchedule(e, "sch-b");
  await Promise.all([e.scheduler.tick(new Date()), e.scheduler.tick(new Date())]);
  check(`(1b) cap 10: each due schedule fires exactly once across two overlapping ticks (spawns=${e.spawns.length})`, e.spawns.length === 2);
  cleanupEnv(e);
}
// (1c) CONTROL: the OLD wiring (slow async startManager, no pre-read dep) exceeds the cap under overlap.
{
  const e = makeEnv({ cap: 1, asyncStartManager: true, withPreRead: false });
  seedSchedule(e, "sch-a"); seedSchedule(e, "sch-b");
  await Promise.all([e.scheduler.tick(new Date()), e.scheduler.tick(new Date())]);
  check(`(1c) CONTROL — an await between the cap check and the spawn DOES exceed the cap under overlap (spawns=${e.spawns.length} > 1)`, e.spawns.length > 1);
  cleanupEnv(e);
}
// (2) a pause toggled while the pre-read is in flight stops every spawn.
{
  const e = makeEnv({ cap: 3 });
  seedSchedule(e, "sch-a"); seedSchedule(e, "sch-b");
  const ticking = e.scheduler.tick(new Date());
  await sleep(READ_MS / 3); // inside the pre-read
  e.control.pause("global");
  await ticking;
  check(`(2) a global pause toggled mid-pre-read stops the spawns (spawns=${e.spawns.length})`, e.spawns.length === 0);
  cleanupEnv(e);
}
// (3) one pre-read per tick, value passed to every manager spawn.
{
  const e = makeEnv({ cap: 3 });
  seedSchedule(e, "sch-a"); seedSchedule(e, "sch-b");
  await e.scheduler.tick(new Date());
  check(`(3) the pre-read ran ONCE for a two-schedule tick (n=${e.preReads.n})`, e.preReads.n === 1);
  check("(3) both manager spawns received the pre-read staleness", e.spawns.length === 2 && e.spawns.every((s) => s.deployStaleness === STAMPED_STALENESS));
  cleanupEnv(e);
}
// (4) auditor-only ⇒ no pre-read, no staleness on the spawn.
{
  const e = makeEnv({ cap: 3 });
  seedSchedule(e, "sch-aud", { kind: "auditor" });
  await e.scheduler.tick(new Date());
  check(`(4) an auditor-only tick makes no pre-read (n=${e.preReads.n})`, e.preReads.n === 0);
  check("(4) the auditor spawn received no staleness", e.spawns.length === 1 && e.spawns[0].kind === "auditor" && e.spawns[0].deployStaleness === undefined);
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the scheduler pre-reads once per tick, and the checks → spawn span stays synchronous."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
