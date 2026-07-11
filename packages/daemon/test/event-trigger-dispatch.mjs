import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// EventTriggerService dispatcher test (Loom Event Triggers subsystem, card f5d07121 T2). NO claude, NO
// real network — resume/spawn are injected RECORDING STUBS, so the tick tests drive tick() directly.
// Hermetic: each env gets its OWN temp .db (never the daemon's). The sibling test/event-triggers.mjs
// (T1) covers the pure data layer; this covers the DISPATCHER: wake + spawn fires on a REAL emitted
// event, the trusted [loom:trigger] framing (NOT poll's untrusted-DATA wrapper), project scoping via the
// event's owning manager session, deleted-target auto-disable, per-trigger error isolation, the
// whole-tick usage-limit gate, and the load-bearing anti-loop guarantee — advance-before-fire plus the
// MIN_EVENT_TRIGGER_INTERVAL_MS floor bound a burst of matching events (including a genuinely
// self-retriggering one, e.g. worker_report -> spawn -> worker_report) to a SINGLE fire, never a cascade.
//
// Run: 1) build (turbo builds shared first), 2) node test/event-trigger-dispatch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Db } from "../dist/db.js";
import { EventTriggerService, MIN_EVENT_TRIGGER_INTERVAL_MS } from "../dist/orchestration/event-triggers.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-evtrig-disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `pp-${Math.random().toString(36).slice(2, 8)}`;
  const otherProjId = `pp2-${Math.random().toString(36).slice(2, 8)}`;
  const wakeAgentId = `pa-wake-${Math.random().toString(36).slice(2, 8)}`;
  const spawnAgentId = `pa-spawn-${Math.random().toString(36).slice(2, 8)}`;
  const sessId = `ps-${Math.random().toString(36).slice(2, 8)}`;
  const otherSessId = `ps2-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "EvTrig", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: otherProjId, name: "EvTrigOther", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: wakeAgentId, projectId: projId, name: "wake-target", startupPrompt: "", position: 0 });
  db.insertAgent({ id: spawnAgentId, projectId: projId, name: "spawn-target", startupPrompt: "You are Dev.", position: 1 });
  db.insertSession({
    id: sessId, projectId: projId, agentId: wakeAgentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  // A manager session in the OTHER project — its events must never match a projectId-scoped trigger.
  db.insertSession({
    id: otherSessId, projectId: otherProjId, agentId: wakeAgentId, engineSessionId: "eng-2", title: null, cwd: otherProjId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });

  const alive = new Set(opts.deadSession ? [] : [sessId]);
  const enqueued = [];   // { sessionId, text, source, route, kind }
  const resumed = [];
  const spawned = [];    // { agentId, kickoffPrompt, id }
  let nextSpawnId = 0;

  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, source, onDeliver, route, kind) => { enqueued.push({ sessionId: id, text, source, route, kind }); return { delivered: true }; },
  };
  const resume = async (id) => {
    resumed.push(id);
    if (opts.resumeThrows) throw new Error("session is no longer resumable");
    alive.add(id);
  };
  const spawn = async (agentId, kickoffPrompt) => {
    if (opts.spawnThrows) throw new Error("spawn failed (simulated)");
    const id = `spawned-${nextSpawnId++}`;
    spawned.push({ agentId, kickoffPrompt, id });
    return { id };
  };

  const control = new OrchestrationControl();
  if (opts.globalPaused) control.pause("global");

  const svc = new EventTriggerService({
    db, pty, control, resume, spawn,
    isUsageLimited: () => !!opts.usageLimited,
  });

  return {
    dbFile, db, projId, otherProjId, wakeAgentId, spawnAgentId, sessId, otherSessId, alive, enqueued, resumed, spawned,
    control, svc,
  };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const events = (e, kind) => e.db.listEvents("").filter((ev) => ev.kind === kind);
const seedWakeTrigger = (e, id, over = {}) => {
  const trigger = {
    id, eventKind: "worker_report", projectId: null, mode: "wake",
    targetSessionId: e.sessId, agentId: null, enabled: true, lastSeq: 0, lastFiredAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
  e.db.insertEventTrigger(trigger);
  return trigger;
};
const seedSpawnTrigger = (e, id, over = {}) => seedWakeTrigger(e, id, { mode: "spawn", targetSessionId: null, agentId: e.spawnAgentId, ...over });
/** Insert a trigger the way the (CR-fixed) REST create route now does: lastSeq seeded to the CURRENT bus
 *  max, NOT 0 — mirrors gateway/server.ts POST /api/event-triggers exactly, so a test using this helper
 *  exercises the real baseline-seed fix's dispatcher-side consequence (no historical replay). */
const seedWakeTriggerAtBaseline = (e, id, over = {}) => seedWakeTrigger(e, id, { lastSeq: e.db.getMaxEventSeq(), ...over });
const seedSpawnTriggerAtBaseline = (e, id, over = {}) => seedSpawnTrigger(e, id, { lastSeq: e.db.getMaxEventSeq(), ...over });
/** Emit a raw orchestration_events row FILED UNDER the given manager session (mirrors real PtyHost/
 *  worker_report emission) — this is how a trigger's project-scope resolves (via the event's own
 *  managerSessionId -> session -> projectId). */
const emitEvent = (e, kind, managerSessionId, detail = {}, taskId = null, workerSessionId = null) => {
  e.db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId, workerSessionId, taskId, kind, detail });
};

// --- No due triggers: a clean tick is a no-op ---
{
  const e = makeEnv();
  await e.svc.tick(new Date());
  check("no-triggers: nothing enqueued/spawned", e.enqueued.length === 0 && e.spawned.length === 0);
  cleanupEnv(e);
}

// ============================================================================================
// CR REGRESSION (①) — a FRESHLY-CREATED trigger must NEVER replay historical events. Before the fix,
// REST create seeded lastSeq:0, so a new trigger's first tick scanned from the OLDEST row on the bus and
// fired on days-old matches. seedWakeTriggerAtBaseline mirrors the fixed REST route's lastSeq seed
// (db.getMaxEventSeq()) exactly — this proves the fix's actual dispatcher-side effect: zero fires on
// PRE-EXISTING events, normal firing on events that land AFTER creation.
// ============================================================================================
{
  const e = makeEnv();
  // Pre-emit matching events BEFORE the trigger even exists — a naive lastSeq:0 trigger would replay
  // every one of these on its first tick.
  for (let i = 0; i < 5; i++) emitEvent(e, "worker_report", e.sessId, { status: "blocked", historical: i });
  seedWakeTriggerAtBaseline(e, "trig-no-replay");
  await e.svc.tick(new Date());
  check("no-history-replay: a freshly-created trigger fires ZERO times on pre-existing events", e.enqueued.length === 0);
  check("no-history-replay: watermark is already at the bus max (nothing left to scan)", e.db.getEventTrigger("trig-no-replay").lastSeq === e.db.getMaxEventSeq());
  // A genuinely NEW event (created AFTER the trigger) fires normally — the trigger isn't inert, it just
  // never looks backward.
  emitEvent(e, "worker_report", e.sessId, { status: "blocked", historical: false });
  await e.svc.tick(new Date());
  check("no-history-replay: a NEW event (post-creation) fires normally", e.enqueued.length === 1 && e.enqueued[0].text.includes('"historical": false'));
  cleanupEnv(e);
}

// --- CR REGRESSION (③) — same theme, the RE-ENABLE path: a trigger re-enabled after sitting disabled
// must not replay whatever accrued on the bus WHILE it was disabled. Mirrors the REST update route's
// disabled->enabled reseed (gateway/server.ts) by re-seeding lastSeq the same way here. ---
{
  const e = makeEnv();
  seedWakeTriggerAtBaseline(e, "trig-reenable", { enabled: false });
  // Events land WHILE the trigger sits disabled — listDueEventTriggers never even scans it.
  for (let i = 0; i < 5; i++) emitEvent(e, "worker_report", e.sessId, { status: "blocked", whileDisabled: i });
  await e.svc.tick(new Date());
  check("re-enable: a disabled trigger never scans (accrued events sit unseen)", e.enqueued.length === 0);
  // Re-enable, mirroring the REST route's fix: reseed lastSeq to the CURRENT bus max on the transition.
  e.db.updateEventTrigger("trig-reenable", { enabled: true, lastSeq: e.db.getMaxEventSeq() });
  await e.svc.tick(new Date());
  check("re-enable: reseeded on re-enable -> the WHOLE disabled-window backlog does NOT replay", e.enqueued.length === 0);
  // A new event after re-enabling fires normally.
  emitEvent(e, "worker_report", e.sessId, { status: "blocked", afterReenable: true });
  await e.svc.tick(new Date());
  check("re-enable: a NEW event after re-enabling fires normally", e.enqueued.length === 1 && e.enqueued[0].text.includes('"afterReenable": true'));
  cleanupEnv(e);
}

// --- Wake fire: a REAL emitted matching event wakes the live session, trusted-framed (NOT poll's
// untrusted-DATA wrapper) ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-wake");
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("wake-fire: enqueues exactly one turn to the live session", e.enqueued.length === 1 && e.enqueued[0].sessionId === e.sessId);
  check("wake-fire: did NOT resume an already-live session", e.resumed.length === 0);
  check("wake-fire: tagged [loom:trigger], kind 'agent' (own turn, never coalesced)", e.enqueued[0].text.startsWith("[loom:trigger]") && e.enqueued[0].kind === "agent");
  check("wake-fire: TRUSTED framing — no untrusted-DATA caveat (deliberate divergence from poll)", !e.enqueued[0].text.includes("DATA, not instructions"));
  check("wake-fire: carries the matched event's kind + detail", e.enqueued[0].text.includes("worker_report") && e.enqueued[0].text.includes('"status": "blocked"'));
  check("wake-fire: last_seq advanced past the matched event", e.db.getEventTrigger("trig-wake").lastSeq > 0);
  check("wake-fire: last_fired_at stamped (a real delivery)", e.db.getEventTrigger("trig-wake").lastFiredAt !== null);
  check("wake-fire: emits event_trigger_fired filed under the woken session", e.db.listEvents(e.sessId).some((ev) => ev.kind === "event_trigger_fired" && ev.detail.matchedCount === 1 && ev.detail.mode === "wake"));
  cleanupEnv(e);
}

// --- Spawn fire: mode 'spawn' hands the trusted block as a kickoff to the injected spawn() fn ---
{
  const e = makeEnv();
  seedSpawnTrigger(e, "trig-spawn");
  emitEvent(e, "worker_report", e.sessId, { status: "blocked", note: "needs a decision" });
  await e.svc.tick(new Date());
  check("spawn-fire: spawn() called once with the target agent", e.spawned.length === 1 && e.spawned[0].agentId === e.spawnAgentId);
  check("spawn-fire: kickoff carries the matched event, trusted-framed", e.spawned[0].kickoffPrompt.includes("needs a decision") && e.spawned[0].kickoffPrompt.startsWith("[loom:trigger]"));
  check("spawn-fire: emits event_trigger_fired under the freshly-spawned session id", e.db.listEvents(e.spawned[0].id).some((ev) => ev.kind === "event_trigger_fired" && ev.detail.mode === "spawn"));
  cleanupEnv(e);
}

// --- Non-matching kind and out-of-project events are ignored; the watermark still advances past them ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-scope", { projectId: e.projId });
  emitEvent(e, "merge_request", e.sessId);         // wrong kind
  emitEvent(e, "worker_report", e.otherSessId);     // right kind, WRONG project
  await e.svc.tick(new Date());
  check("scope: no fire on wrong kind or out-of-project event", e.enqueued.length === 0);
  const afterNoMatch = e.db.getEventTrigger("trig-scope");
  check("scope: watermark still advances past permanently-classified non-matching rows", afterNoMatch.lastSeq > 0);
  check("scope: lastFiredAt stays null (never fired)", afterNoMatch.lastFiredAt === null);
  // Now a real in-project matching event DOES fire.
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("scope: an in-project matching event fires", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- projectId scoping: a trigger scoped to projId does NOT fire on an identical-kind event from otherProjId ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-scoped-only", { projectId: e.projId, targetSessionId: e.sessId });
  emitEvent(e, "worker_report", e.otherSessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("projectId-scope: an out-of-scope project's event never fires the trigger", e.enqueued.length === 0);
  cleanupEnv(e);
}

// --- projectId null = every project: fires on an event from ANY project ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-global", { projectId: null, targetSessionId: e.sessId });
  emitEvent(e, "worker_report", e.otherSessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("projectId-null: a null-scoped trigger fires on ANY project's matching event", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- Wake resumes a stopped-but-resumable target before enqueuing ---
{
  const e = makeEnv({ deadSession: true });
  seedWakeTrigger(e, "trig-resume");
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("resume: a not-alive wake target is resumed before delivery", e.resumed.length === 1 && e.resumed[0] === e.sessId);
  check("resume: then the turn is enqueued", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- Structural disable: a trigger whose target session/agent no longer exists is DISABLED, not retried.
// The FK normally prevents this exact orphaning at the db layer — same defense-in-depth note as
// poll.mjs's deleted-target test — so we simulate "deleted out from under the trigger" via a raw FK-off
// delete, the state a future cascade-less delete (or an FK-off run) would produce. ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-no-sess");
  {
    const raw = new Database(e.dbFile);
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM sessions WHERE id = ?").run(e.sessId);
    raw.close();
  }
  await e.svc.tick(new Date());
  check("disable: deleted wake-target session -> trigger disabled", e.db.getEventTrigger("trig-no-sess").enabled === false);
  cleanupEnv(e);

  const e2 = makeEnv();
  seedSpawnTrigger(e2, "trig-no-agent");
  {
    const raw = new Database(e2.dbFile);
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM agents WHERE id = ?").run(e2.spawnAgentId);
    raw.close();
  }
  await e2.svc.tick(new Date());
  check("disable: deleted spawn-target agent -> trigger disabled", e2.db.getEventTrigger("trig-no-agent").enabled === false);
  cleanupEnv(e2);
}

// --- Disabled triggers are never scanned (listDueEventTriggers excludes them) ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-disabled", { enabled: false });
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("disabled: a disabled trigger is never even scanned", e.enqueued.length === 0 && e.db.getEventTrigger("trig-disabled").lastSeq === 0);
  cleanupEnv(e);
}

// --- Whole-tick usage-limit gate: every due trigger is deferred, none fire, watermark untouched ---
{
  const e = makeEnv({ usageLimited: true });
  seedWakeTrigger(e, "trig-limited");
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("usage-limit: no fire while limited", e.enqueued.length === 0);
  check("usage-limit: the trigger's watermark stays untouched (fully re-scanned next tick)", e.db.getEventTrigger("trig-limited").lastSeq === 0);
  cleanupEnv(e);
}

// --- CR fix (②) — the §17a GLOBAL PAUSE kill switch gates the whole tick too, mirroring Scheduler.tick():
// global pause is the master kill switch for every autonomous spawn/wake surface, and this is the most
// loop-prone one of all. ---
{
  const e = makeEnv({ globalPaused: true });
  seedWakeTrigger(e, "trig-paused");
  seedSpawnTrigger(e, "trig-paused-spawn");
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("global-pause: no wake fire while globally paused", e.enqueued.length === 0);
  check("global-pause: no spawn fire while globally paused", e.spawned.length === 0);
  check("global-pause: watermark stays untouched (fully re-scanned once the pause lifts)", e.db.getEventTrigger("trig-paused").lastSeq === 0);
  // Resume the global scope — the SAME matching event (still unconsumed) now fires normally.
  e.control.resume("global");
  await e.svc.tick(new Date());
  check("global-pause: once resumed, the previously-paused-over event fires normally", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- The global pause gate is genuinely SCOPED to "global" — a paused MANAGER-scoped id (not "global")
// never affects the event-trigger tick (mirrors Scheduler's own pausedScopes().includes("global") check,
// which is deliberately not `isPaused(someManagerId)`). ---
{
  const e = makeEnv();
  e.control.pause("some-manager-session-id"); // a non-global scope
  seedWakeTrigger(e, "trig-not-globally-paused");
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("global-pause-scope: a non-'global' paused scope never blocks the trigger tick", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- Per-trigger error isolation: a throwing spawn on one trigger never blocks a sibling ---
{
  const e = makeEnv({ spawnThrows: true });
  seedSpawnTrigger(e, "trig-throws");
  seedWakeTrigger(e, "trig-ok");
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(new Date());
  check("isolation: the throwing spawn trigger fired nothing (spawn threw)", e.spawned.length === 0);
  check("isolation: the sibling wake trigger STILL fired despite the other's throw", e.enqueued.length === 1);
  // The throwing trigger's watermark/lastFiredAt still ADVANCED (advance-before-fire — a crash/throw after
  // the advance drops the fire but never re-fires the same event; see the anti-loop tests below).
  check("isolation: the throwing trigger's watermark still advanced (advance-BEFORE-fire)", e.db.getEventTrigger("trig-throws").lastSeq > 0);
  check("isolation: the throwing trigger's lastFiredAt still stamped (never retried)", e.db.getEventTrigger("trig-throws").lastFiredAt !== null);
  cleanupEnv(e);
}

// ============================================================================================
// THE LOAD-BEARING ANTI-LOOP GUARANTEE: advance-before-fire + the MIN_EVENT_TRIGGER_INTERVAL_MS
// floor together bound ANY burst of matching events (including a genuinely self-retriggering one)
// to AT MOST ONE fire per floor window — never an unbounded cascade.
// ============================================================================================

// --- A burst of N matching events in ONE tick collapses into exactly ONE fire, not N ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-burst");
  for (let i = 0; i < 25; i++) emitEvent(e, "worker_report", e.sessId, { status: "blocked", i });
  await e.svc.tick(new Date());
  check("burst-in-one-tick: 25 matching events -> exactly ONE fire, not 25", e.enqueued.length === 1);
  check("burst-in-one-tick: the fire's block summarizes multiple matched events (capped)", (e.enqueued[0].text.match(/"kind": "worker_report"/g) || []).length > 1);
  cleanupEnv(e);
}

// --- A SELF-RETRIGGERING loop (spawn on worker_report -> spawned session itself emits worker_report,
// repeated) never produces unbounded fires: across many ticks spanning real elapsed time, fires are
// bounded by MIN_EVENT_TRIGGER_INTERVAL_MS, and within the SAME instant no amount of re-emission escapes
// the floor. This is the exact failure mode the card calls out — simulate it directly. ---
{
  const e = makeEnv();
  seedSpawnTrigger(e, "trig-loop");
  let t = new Date();
  // Simulate 10 "loop iterations": each tick, the (fake) prior spawn's worker_report lands, then tick().
  // Every iteration happens at the SAME instant (no real time elapses) — a genuine runaway loop would
  // otherwise hammer as fast as the event bus could produce events.
  for (let i = 0; i < 10; i++) {
    emitEvent(e, "worker_report", e.sessId, { status: "blocked", iteration: i });
    await e.svc.tick(t);
  }
  check("self-loop (no time elapsed): 10 loop iterations produce AT MOST ONE fire (the floor blocks the rest)", e.spawned.length <= 1);
  check("self-loop: throttled events were recorded (not silently vanished — visible for a human to investigate)", events(e, "event_trigger_throttled").length > 0);
  // Advance real time past the floor: exactly one MORE fire becomes possible, never a flood of the
  // 9 backlogged matches that were throttled away (they were DROPPED, not queued).
  t = new Date(t.getTime() + MIN_EVENT_TRIGGER_INTERVAL_MS + 1000);
  emitEvent(e, "worker_report", e.sessId, { status: "blocked", iteration: 99 });
  await e.svc.tick(t);
  check("self-loop: after the floor elapses, exactly ONE more fire (not a flood of the dropped backlog)", e.spawned.length <= 2);
  cleanupEnv(e);
}

// --- The floor is enforced strictly per-trigger: a second, independent trigger fires on its own schedule
// unaffected by a sibling's throttle state ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-a", { targetSessionId: e.sessId });
  seedSpawnTrigger(e, "trig-b");
  const t0 = new Date();
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(t0);
  check("per-trigger floor: both independent triggers fire on their FIRST match", e.enqueued.length === 1 && e.spawned.length === 1);
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(t0); // same instant — both should now be throttled
  check("per-trigger floor: neither fires again at the same instant (both throttled independently)", e.enqueued.length === 1 && e.spawned.length === 1);
  cleanupEnv(e);
}

// --- Crash-safety: advance-before-fire means a delivery throw does NOT leave the event re-deliverable —
// the watermark+lastFiredAt already moved, so a retry on the identical event never happens (deliberately
// the OPPOSITE tradeoff from PollService, which re-delivers on a throw) ---
{
  const e = makeEnv({ resumeThrows: true, deadSession: true });
  seedWakeTrigger(e, "trig-crash-safe");
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  const t0 = new Date();
  await e.svc.tick(t0);
  check("crash-safety: resume was attempted and threw", e.resumed.length === 1);
  check("crash-safety: nothing enqueued (the throw prevented delivery)", e.enqueued.length === 0);
  const afterThrow = e.db.getEventTrigger("trig-crash-safe");
  check("crash-safety: watermark ALREADY advanced despite the throw (advance-before-fire)", afterThrow.lastSeq > 0);
  check("crash-safety: lastFiredAt ALREADY stamped despite the throw (never retries the same event)", afterThrow.lastFiredAt !== null);
  // A later, genuinely NEW matching event (after the floor) fires normally — the subsystem self-heals,
  // it just never replays the one that was lost to the crash.
  e.alive.add(e.sessId);
  const t1 = new Date(t0.getTime() + MIN_EVENT_TRIGGER_INTERVAL_MS + 1000);
  emitEvent(e, "worker_report", e.sessId, { status: "blocked" });
  await e.svc.tick(t1);
  check("crash-safety: a later NEW event fires normally once the target is alive again", e.enqueued.length === 1);
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — EventTriggerService fires wake/spawn on a REAL matching orchestration_events row, frames the kickoff as TRUSTED [loom:trigger] data (not poll's untrusted-DATA wrapper), resolves project scope via the event's owning manager session, disables a structurally-dead target, isolates one trigger's failure from its siblings, defers the whole tick under a known usage limit OR a §17a global pause (scoped strictly to \"global\"), NEVER replays historical events on creation or re-enable (the CR-caught baseline-seed fix), and — the load-bearing property — advance-before-fire plus the per-trigger MIN_EVENT_TRIGGER_INTERVAL_MS floor together bound ANY burst (including a genuinely self-retriggering one) to at most one fire per floor window, dropping (never queueing) throttled matches so a runaway loop can never cascade."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
