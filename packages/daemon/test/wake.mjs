import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// WakeService test (wake_me primitive). NO claude — WakeService takes an injected pty-slice +
// resume fn, so the tick tests use RECORDING STUBS and drive tick()/start() directly. Hermetic:
// each env gets its OWN temp .db (never the daemon's). Covers: schedule validation (floor/horizon/
// cap/note/exactly-one), live-fire, non-due, not-live auto-resume, usage-limited defer, unresumable
// drop, cancel scoping, and start() past-due fire-once reconcile.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { WakeService } from "../dist/orchestration/wake.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `wp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `wt-${Math.random().toString(36).slice(2, 8)}`;
  const sessId = `ws-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "Wake", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });

  const alive = new Set(opts.deadSession ? [] : [sessId]); // isAlive source of truth
  const enqueued = [];          // { sessionId, text }
  const resumed = [];           // sessionIds passed to resume
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ sessionId: id, text }); return { delivered: true }; },
  };
  const resume = async (id) => {
    resumed.push(id);
    if (opts.resumeThrows) throw new Error("session is no longer resumable (engine transcript missing)");
    alive.add(id); // a successful resume brings the pty back
  };
  const wakes = new WakeService({
    db, pty, resume,
    isUsageLimited: () => !!opts.usageLimited,
  });
  return { dbFile, db, projId, agentId, sessId, alive, enqueued, resumed, wakes };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const events = (e, kind) => e.db.listEvents(e.sessId).filter((ev) => ev.kind === kind);

// --- schedule() validation ---
{
  const e = makeEnv();
  const now = new Date();
  const okRes = e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "check the render" }, now);
  check("schedule: returns wakeId + future wakeAt", !!okRes.wakeId && new Date(okRes.wakeAt).getTime() > now.getTime());
  check("schedule: persisted as one pending wake", e.db.countPendingWakes(e.sessId) === 1);
  check("schedule: emits a wake_scheduled event", events(e, "wake_scheduled").length === 1);

  const threw = (fn) => { try { fn(); return false; } catch { return true; } };
  check("schedule: below the 30s floor is rejected", threw(() => e.wakes.schedule(e.sessId, { delaySeconds: 10, note: "x" }, now)));
  check("schedule: beyond the 24h horizon is rejected", threw(() => e.wakes.schedule(e.sessId, { delaySeconds: 25 * 3600, note: "x" }, now)));
  check("schedule: empty note is rejected", threw(() => e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "   " }, now)));
  check("schedule: neither delaySeconds nor wakeAt is rejected", threw(() => e.wakes.schedule(e.sessId, { note: "x" }, now)));
  check("schedule: BOTH delaySeconds and wakeAt is rejected", threw(() => e.wakes.schedule(e.sessId, { delaySeconds: 60, wakeAt: now.toISOString(), note: "x" }, now)));
  check("schedule: unknown session is rejected", threw(() => e.wakes.schedule("nope", { delaySeconds: 60, note: "x" }, now)));
  cleanupEnv(e);
}

// Cap: an 11th pending wake is rejected (max 10/session).
{
  const e = makeEnv();
  const now = new Date();
  for (let i = 0; i < 10; i++) e.wakes.schedule(e.sessId, { delaySeconds: 60 + i, note: `w${i}` }, now);
  let capped = false;
  try { e.wakes.schedule(e.sessId, { delaySeconds: 200, note: "over" }, now); } catch { capped = true; }
  check("cap: the 11th pending wake is rejected", capped && e.db.countPendingWakes(e.sessId) === 10);
  cleanupEnv(e);
}

// Live fire: a due wake on a live session → enqueue the note, delete the wake, emit wake_fired.
{
  const e = makeEnv();
  const t0 = new Date();
  const { wakeId } = e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "the build should be done" }, t0);
  await e.wakes.tick(new Date(t0.getTime() + 30_000)); // not yet due
  check("live-fire: a not-yet-due wake does NOT fire", e.enqueued.length === 0 && !!e.db.getWake(wakeId));
  await e.wakes.tick(new Date(t0.getTime() + 61_000)); // now due
  check("live-fire: enqueues the nudge to the session", e.enqueued.length === 1 && e.enqueued[0].sessionId === e.sessId);
  check("live-fire: the nudge carries the note", e.enqueued[0].text.includes("the build should be done") && e.enqueued[0].text.startsWith("[loom:wake]"));
  check("live-fire: the wake is deleted (one-shot)", e.db.getWake(wakeId) === undefined);
  check("live-fire: did NOT resume an already-live session", e.resumed.length === 0);
  check("live-fire: emits a wake_fired event", events(e, "wake_fired").length === 1);
  cleanupEnv(e);
}

// Auto-resume: a due wake on a NOT-live session → resume() then enqueue.
{
  const e = makeEnv();
  const t0 = new Date();
  e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "wake up" }, t0);
  e.alive.delete(e.sessId); // session stopped after scheduling
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  check("auto-resume: resume() called for the stopped session", e.resumed.length === 1 && e.resumed[0] === e.sessId);
  check("auto-resume: nudge delivered after resume", e.enqueued.length === 1);
  check("auto-resume: wake_fired recorded", events(e, "wake_fired").length === 1);
  cleanupEnv(e);
}

// Usage-limited defer: not-live + usage-limited → DON'T resume; re-insert the wake for a later tick.
{
  const e = makeEnv({ usageLimited: true });
  const t0 = new Date();
  const { wakeId } = e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "later" }, t0);
  e.alive.delete(e.sessId);
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  check("usage-defer: did NOT resume into a known cap", e.resumed.length === 0 && e.enqueued.length === 0);
  check("usage-defer: the wake is preserved (re-inserted) for a later tick", !!e.db.getWake(wakeId));
  check("usage-defer: no wake_fired yet", events(e, "wake_fired").length === 0);
  cleanupEnv(e);
}

// Unresumable drop: not-live + resume throws → drop the wake, emit wake_dropped, no enqueue.
{
  const e = makeEnv({ resumeThrows: true });
  const t0 = new Date();
  const { wakeId } = e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "gone" }, t0);
  e.alive.delete(e.sessId);
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  check("unresumable: resume() attempted", e.resumed.length === 1);
  check("unresumable: nothing enqueued", e.enqueued.length === 0);
  check("unresumable: the wake is dropped (already claimed)", e.db.getWake(wakeId) === undefined);
  check("unresumable: emits a wake_dropped event", events(e, "wake_dropped").length === 1);
  cleanupEnv(e);
}

// Cancel is self-scoped: another session can't cancel this session's wake; the owner can.
{
  const e = makeEnv();
  const now = new Date();
  const { wakeId } = e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "mine" }, now);
  check("cancel: a foreign session cannot cancel it", e.wakes.cancel("someone-else", wakeId).cancelled === false && !!e.db.getWake(wakeId));
  check("cancel: the owner cancels it", e.wakes.cancel(e.sessId, wakeId).cancelled === true && e.db.getWake(wakeId) === undefined);
  check("cancel: list reflects the empty queue", e.wakes.list(e.sessId).length === 0);
  cleanupEnv(e);
}

// start() reconcile: a wake whose wake_at is already in the past fires on the first tick (once).
{
  const e = makeEnv();
  const t0 = new Date();
  // Schedule against a past `now` so wake_at lands before the real present (daemon-was-down case).
  e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "missed" }, new Date(t0.getTime() - 3_600_000));
  e.wakes.start(t0); // immediate reconcile tick + arms the interval
  e.wakes.stop();    // clear the interval right away
  // start()'s tick is fire-and-forget (void) — give the microtask a beat to settle.
  await new Promise((r) => setTimeout(r, 20));
  check("start-reconcile: a past-due wake fired once on start()", e.enqueued.length === 1);
  check("start-reconcile: it was consumed (no lingering row)", e.db.countPendingWakes(e.sessId) === 0);
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — WakeService validates+schedules, fires due wakes (live + auto-resume), defers under usage-limit, drops the unresumable, scopes cancel, and reconciles past-due on start."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
