import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BusyWorkerWatcher test (busy-worker LONG-TURN advisory — the inverse of IdleWatcher). NO claude — the
// watcher takes an injected pty-slice, so the tick tests use a RECORDING STUB and drive tick() directly.
// Hermetic like idle-watcher.mjs: each env gets its OWN temp .db, imports dist/* + @loom/shared, no daemon.
// Covers the DoD trio (busy+stale → fires ONCE with the softened advisory message; busy+progressing →
// no fire; idle → not our job) plus every silent skip (disabled / orphaned-manager / human-paused worker
// or manager), the once-per-episode guard (a second tick does NOT re-fire; a STALE prior-episode event
// does NOT suppress a new episode = re-arm), the raised default window (60m, not the old 30m), and the
// zod orchestrationOverride accepting `stuckWorkerMinutes`. Deliberately single-signal (lastActivity
// only) — see the class doc in busy-worker-watcher.ts for why a pty-output gate is unreachable dead code
// (PtyHost's healIfStuck already clears `busy` once output is stale ≥5min).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { BusyWorkerWatcher } from "../dist/orchestration/busy-worker-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-06-03T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv({ projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-busy-w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `bp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ba-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Busy", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const control = new OrchestrationControl();
  const watcher = new BusyWorkerWatcher({ db, pty, control });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher };
}

// A live MANAGER (the surface-to target). live by default.
function seedManager(e, id, { live = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  if (live) e.alive.add(id);
}
// A WORKER. Defaults make it eligible to flag: live, busy, last turn started 65m ago (> 60m default window).
function seedWorker(e, id, parentId, { busy = true, busyMin = 65, live = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy,
    createdAt: minutesAgo(busyMin), lastActivity: minutesAgo(busyMin), lastError: null, role: "worker",
    parentSessionId: parentId, taskId: "tk-" + id,
  });
  if (live) e.alive.add(id);
}
const stuckEvents = (e, workerId) => e.db.listEventsForWorker(workerId).filter((ev) => ev.kind === "worker_stuck");
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (1) FIRES ONCE — busy + stale, softened advisory message ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-1");
  seedWorker(e, "wkr-stuck", "mgr-1"); // busy, 65m in one turn (> 60m default window)
  e.watcher.tick(NOW);
  check("(1) busy+stale worker → ONE worker_stuck event filed under the owning manager", stuckEvents(e, "wkr-stuck").length === 1);
  const ev = stuckEvents(e, "wkr-stuck")[0];
  check("(1) event carries manager/worker/task + reason + minutesBusy", ev?.managerSessionId === "mgr-1" && ev?.workerSessionId === "wkr-stuck" && ev?.taskId === "tk-wkr-stuck" && ev?.detail?.reason === "busy_no_progress" && ev?.detail?.minutesBusy === 65);
  const text = e.enqueued[0]?.text ?? "";
  check("(1) nudge enqueued to the MANAGER (not the worker) + names the worker + steers to worker_status", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-1" && text.includes("worker_status") && text.includes("wkr-stuck".slice(0, 8)));
  check("(1) nudge is the softened [loom:worker-busy-long] advisory, not a hang alarm", text.startsWith("[loom:worker-busy-long]") && /long build\/test gate/i.test(text) && !/may be hung/i.test(text));
  check("(1) nudge is informational-only (NOT a hard kill)", /not auto-kill/i.test(text));
  // A SECOND tick in the SAME long turn must NOT re-fire (once per episode).
  e.watcher.tick(NOW);
  check("(1) a second tick (same episode) does NOT re-emit worker_stuck", stuckEvents(e, "wkr-stuck").length === 1);
  check("(1) a second tick enqueues no further nudge", e.enqueued.length === 1);
  cleanup(e);
}

// ============================ (2) NO FIRE — busy but progressing (fresh lastActivity) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-2");
  seedWorker(e, "wkr-fresh", "mgr-2", { busy: true, busyMin: 5 }); // 5m < 60m window → still working
  e.watcher.tick(NOW);
  check("(2) busy worker that started its turn only 5m ago is NOT flagged", stuckEvents(e, "wkr-fresh").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (2b) NO FIRE — busy 55m, below the RAISED 60m default window ============================
{
  // Regression guard for the raised default (30m → 60m): a worker mid-gate for less than an hour
  // must not be flagged, confirming the default actually moved and isn't still 30.
  const e = makeEnv();
  seedManager(e, "mgr-2b");
  seedWorker(e, "wkr-55", "mgr-2b", { busyMin: 55 }); // 55m < 60m default window
  e.watcher.tick(NOW);
  check("(2b) busy 55m (< raised 60m default) is NOT flagged", stuckEvents(e, "wkr-55").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (3) NO FIRE — idle worker (not this watchdog's job) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-3");
  seedWorker(e, "wkr-idle", "mgr-3", { busy: false, busyMin: 99 }); // not busy (e.g. awaiting review)
  e.watcher.tick(NOW);
  check("(3) an IDLE worker (busy=false), however long, is NOT flagged by THIS watcher", stuckEvents(e, "wkr-idle").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (4) SILENT — disabled (stuckWorkerMinutes = 0) ============================
{
  const e = makeEnv({ projectConfig: { orchestration: { stuckWorkerMinutes: 0 } } });
  seedManager(e, "mgr-4");
  seedWorker(e, "wkr-disabled", "mgr-4", { busyMin: 999 });
  e.watcher.tick(NOW);
  check("(4) stuckWorkerMinutes=0 disables the watcher for that project", stuckEvents(e, "wkr-disabled").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (5) SILENT — orphaned worker (manager not live) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-dead", { live: false }); // exited manager
  seedWorker(e, "wkr-orphan", "mgr-dead");
  e.watcher.tick(NOW);
  check("(5) worker whose manager is NOT live is NOT flagged (orphan → boot-reconcile's job)", stuckEvents(e, "wkr-orphan").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (6) SILENT — human-paused (worker scope, manager scope, or global) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-6");
  seedWorker(e, "wkr-paused-self", "mgr-6");
  seedWorker(e, "wkr-paused-mgr", "mgr-6");
  seedWorker(e, "wkr-live-6", "mgr-6"); // sibling, not paused → still flagged
  e.control.pause("wkr-paused-self"); // worker's own scope
  e.watcher.tick(NOW);
  check("(6) worker paused in its OWN scope is NOT flagged", stuckEvents(e, "wkr-paused-self").length === 0);
  check("(6) sibling (unpaused) worker IS flagged", stuckEvents(e, "wkr-live-6").length === 1);
  // pausing the MANAGER scope shields its workers (don't nudge a paused manager).
  const e2 = makeEnv();
  seedManager(e2, "mgr-6b");
  seedWorker(e2, "wkr-mgr-paused", "mgr-6b");
  e2.control.pause("mgr-6b");
  e2.watcher.tick(NOW);
  check("(6) worker whose MANAGER is paused is NOT flagged", stuckEvents(e2, "wkr-mgr-paused").length === 0 && e2.enqueued.length === 0);
  // global pause silences all.
  const e3 = makeEnv();
  seedManager(e3, "mgr-6c");
  seedWorker(e3, "wkr-global", "mgr-6c");
  e3.control.pause("global");
  e3.watcher.tick(NOW);
  check("(6) global pause silences ALL workers", stuckEvents(e3, "wkr-global").length === 0);
  cleanup(e); cleanup(e2); cleanup(e3);
}

// ============================ (7) RE-ARM — a STALE prior-episode event does NOT suppress a new episode ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-7");
  seedWorker(e, "wkr-rearm", "mgr-7"); // busy, turn started 65m ago (lastActivity = NOW-65m)
  // A prior worker_stuck stamped 90m ago — BEFORE the current turn began (the worker has since
  // progressed and gone long again). The guard (event.ts > lastActivity) must NOT suppress this episode.
  e.db.appendEvent({
    id: randomUUID(), ts: minutesAgo(90), managerSessionId: "mgr-7", workerSessionId: "wkr-rearm",
    taskId: "tk-wkr-rearm", kind: "worker_stuck", detail: { reason: "busy_no_progress", minutesBusy: 61 },
  });
  e.watcher.tick(NOW);
  check("(7) a worker_stuck OLDER than the current turn's start does NOT suppress → fires this episode", stuckEvents(e, "wkr-rearm").length === 2 && e.enqueued.length === 1);
  cleanup(e);
}
// ...and the converse guard: an event stamped AFTER the turn start (same episode) DOES suppress.
{
  const e = makeEnv();
  seedManager(e, "mgr-7b");
  seedWorker(e, "wkr-same-ep", "mgr-7b"); // lastActivity = NOW-65m
  e.db.appendEvent({
    id: randomUUID(), ts: minutesAgo(40), managerSessionId: "mgr-7b", workerSessionId: "wkr-same-ep",
    taskId: "tk-wkr-same-ep", kind: "worker_stuck", detail: { reason: "busy_no_progress", minutesBusy: 25 },
  });
  e.watcher.tick(NOW);
  check("(7b) a worker_stuck stamped AFTER the turn start (same episode) suppresses → no re-fire", stuckEvents(e, "wkr-same-ep").length === 1 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (8) per-project override honored (stuckWorkerMinutes:45) ============================
{
  const e = makeEnv({ projectConfig: { orchestration: { stuckWorkerMinutes: 45 } } });
  seedManager(e, "mgr-8");
  seedWorker(e, "wkr-30", "mgr-8", { busyMin: 30 }); // 30 < 45 → not yet
  e.watcher.tick(NOW);
  check("(8) per-project stuckWorkerMinutes=45 → 30m-busy worker NOT yet flagged", stuckEvents(e, "wkr-30").length === 0 && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (9) only LIVE workers; manager sessions ignored ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-9");
  // a busy, long-idle MANAGER must be ignored (listLiveWorkers is worker-only — managers are the idle watcher's).
  e.db.insertSession({
    id: "mgr-busy-9", projectId: e.projId, agentId: e.agentId, engineSessionId: "em9", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: true, createdAt: minutesAgo(99), lastActivity: minutesAgo(99),
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add("mgr-busy-9");
  // an EXITED worker is not live → ignored.
  seedWorker(e, "wkr-exited-9", "mgr-9", { live: false });
  e.watcher.tick(NOW);
  check("(9) a busy manager is NOT flagged by the worker watchdog; an exited worker is ignored", e.enqueued.length === 0 && stuckEvents(e, "wkr-exited-9").length === 0);
  cleanup(e);
}

// ============================ (10) zod orchestrationOverride accepts stuckWorkerMinutes ============================
{
  const full = validateProjectConfigOverride({ orchestration: { stuckWorkerMinutes: 30 } });
  check("(10) REST validator accepts stuckWorkerMinutes", full.ok === true && full.value.orchestration?.stuckWorkerMinutes === 30);
  const agent = validateAgentProjectConfigOverride({ orchestration: { stuckWorkerMinutes: 0 } });
  check("(10) agent (loom-platform MCP) validator accepts stuckWorkerMinutes (incl. 0 = disable)", agent.ok === true && agent.value.orchestration?.stuckWorkerMinutes === 0);
  const bad = validateProjectConfigOverride({ orchestration: { stuckWorkerMinutes: -5 } });
  check("(10) a negative stuckWorkerMinutes is rejected", bad.ok === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — BusyWorkerWatcher surfaces a LIVE worker busy past the per-project window (lastActivity not advancing, the ONLY signal — a pty-output gate is unreachable dead code given healIfStuck) EXACTLY ONCE per long turn (one worker_stuck event under the owning manager + one softened [loom:worker-busy-long] advisory nudge — informational, never a kill or hang alarm); is SILENT when the worker is progressing / idle / disabled(0) / orphaned(no live manager) / human-paused (worker, manager, or global); confirms the raised 60m default (55m busy is NOT flagged); re-arms when the worker makes progress (a stale prior-episode event doesn't suppress a new one, a same-episode one does); honors a per-project stuckWorkerMinutes override; ignores managers; and the zod orchestrationOverride accepts stuckWorkerMinutes (negatives rejected)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
