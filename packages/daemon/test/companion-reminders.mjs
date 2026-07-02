import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion RECURRING reminders (Companion Memory & Reminders Design, Surface 2 s3). NO claude, NO
// network, NO daemon — the watcher takes an injected pty-slice + a REAL Db on an explicit temp file, so
// the tick tests use RECORDING STUBS and drive tick() directly. Covers: a DUE cron reminder firing exactly
// ONE framed [loom:reminder] turn carrying its own route, not-live skip, rate-limit PARK defer (once per
// streak), no-stacking on a PER-REMINDER marker (two distinct reminders don't suppress each other),
// restart-seed (no double-fire across a fresh watcher), enabled=false never fires, and DEFAULT-OFF
// byte-identical behavior with zero rows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { CompanionReminderWatcher, REMINDER_TAG, reminderMarker } from "../dist/companion/reminders.js";
import { nextFireAt } from "../dist/orchestration/cron.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A cron that is "always due" relative to any `from` baseline we pass it: every minute.
const EVERY_MINUTE = "* * * * *";
// A cron far in the future relative to `now` in these tests (Dec 31, once a year) — never due.
const YEARLY = "0 0 31 12 *";
// The watcher's own next-fire boundary computation (orchestration/cron.ts) — reused here so every
// re-tick probe is anchored to the REAL next cron boundary rather than a fixed millisecond offset (a
// fixed offset like "+1000ms" is flaky: EVERY_MINUTE's true next boundary can be anywhere from just
// over 0ms to just under 60s after `from`, depending on where `from` falls within its minute).
const nextBoundary = (cron, from) => new Date(nextFireAt(cron, from));

function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-rem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `rp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ra-${Math.random().toString(36).slice(2, 8)}`;
  const sessId = `rs-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "REM", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "companion", startupPrompt: "", position: 0 });
  db.insertSession({
    id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  });
  if (opts.parked) db.setRateLimitedUntil(sessId, new Date(Date.now() + 3_600_000).toISOString(), "usage limit");

  const alive = new Set(opts.notLive ? [] : [sessId]); // isAlive source of truth
  const enqueued = [];   // { sessionId, text, route } — permanent record of every enqueue (route = 5th arg)
  let pendingQueue = []; // mutable "unconsumed" FIFO getPending returns; a test clears it to simulate consumption
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, _source, _onDeliver, route) => { enqueued.push({ sessionId: id, text, route }); pendingQueue.push(text); return { delivered: false, position: pendingQueue.length }; },
    getPending: (id) => (id === sessId ? pendingQueue : []),
  };
  const watcher = new CompanionReminderWatcher({ db, pty, sessionId: sessId });
  return {
    dbFile, db, projId, agentId, sessId, alive, enqueued, watcher,
    clearPending: () => { pendingQueue = []; },
  };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const events = (e, kind) => e.db.listEvents(e.sessId).filter((ev) => ev.kind === kind);

function addReminder(e, over = {}) {
  const id = over.id ?? randomUUID();
  const createdAt = over.createdAt ?? new Date(Date.now() - 3_600_000).toISOString(); // an hour ago by default
  e.db.insertCompanionReminder({
    id, sessionId: e.sessId, cron: over.cron ?? EVERY_MINUTE, prompt: over.prompt ?? "CHECK_IN",
    label: over.label ?? null, route: over.route ?? null, enabled: over.enabled ?? true, createdAt,
  });
  return id;
}

// --- 1. Due tick, LIVE + non-parked → enqueues ONE framed reminder + records lastFiredAt + fired-event ---
{
  const e = makeEnv();
  const id = addReminder(e);
  const t0 = new Date();
  e.watcher.tick(t0);
  check("live-fire: enqueues ONE turn to the companion", e.enqueued.length === 1 && e.enqueued[0].sessionId === e.sessId);
  check("live-fire: framed [loom:reminder] carrying the prompt + per-reminder marker", e.enqueued[0].text.startsWith(REMINDER_TAG) && e.enqueued[0].text.startsWith(reminderMarker(id)) && e.enqueued[0].text.includes("CHECK_IN"));
  check("live-fire: emits a companion_reminder_fired event with the reminderId", events(e, "companion_reminder_fired").length === 1 && events(e, "companion_reminder_fired")[0].detail.reminderId === id);
  check("live-fire: no deferred event on a clean fire", events(e, "companion_reminder_deferred").length === 0);
  // lastFiredAt recorded: a tick strictly BEFORE the next real cron boundary does NOT re-fire; a tick AT
  // that boundary fires again. Anchored to the watcher's own nextFireAt computation (not a fixed
  // millisecond offset) so this never flakes near a real minute boundary.
  e.clearPending();
  const boundary = nextBoundary(EVERY_MINUTE, t0);
  e.watcher.tick(new Date(boundary.getTime() - 1));
  check("live-fire: lastFiredAt recorded (a tick just before the next boundary does not re-fire)", e.enqueued.length === 1);
  e.watcher.tick(boundary);
  check("live-fire: fires again once its next cron boundary is reached", e.enqueued.length === 2);
  cleanupEnv(e);
}

// --- 2. A YEARLY-cron reminder created "now" is NOT due on the very next tick (waits for its real boundary) ---
{
  const e = makeEnv();
  addReminder(e, { cron: YEARLY, createdAt: new Date().toISOString() });
  e.watcher.tick(new Date());
  check("not-due: a fresh yearly-cron reminder does not fire on its very first tick", e.enqueued.length === 0);
  cleanupEnv(e);
}

// --- 3. Rate-limit PARKED → DEFERS (no enqueue; state preserved; deferred-event carries reminderId) ---
{
  const e = makeEnv({ parked: true });
  const id = addReminder(e);
  const t0 = new Date();
  e.watcher.tick(t0);
  check("park-defer: nothing enqueued while parked", e.enqueued.length === 0);
  check("park-defer: emits a companion_reminder_deferred event", events(e, "companion_reminder_deferred").length === 1);
  check("park-defer: reason is rate-limited, scoped to this reminder", events(e, "companion_reminder_deferred")[0].detail.reason === "rate-limited" && events(e, "companion_reminder_deferred")[0].detail.reminderId === id);
  check("park-defer: no fired event", events(e, "companion_reminder_fired").length === 0);
  // State preserved: clearing the park → the SAME due tick now fires (lastFiredAt was never advanced —
  // the due-ness is still anchored to createdAt, an hour in the past, so ANY later `now` stays due).
  e.db.setRateLimitedUntil(e.sessId, null, null);
  e.watcher.tick(new Date(t0.getTime() + 1_000));
  check("park-defer: the held cadence fires once the park clears", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- 4. Session NOT live → skip (no enqueue, no resume, no event) ---
{
  const e = makeEnv({ notLive: true });
  addReminder(e);
  e.watcher.tick(new Date());
  check("not-live: nothing enqueued (stopped companion is NOT resumed to remind)", e.enqueued.length === 0);
  check("not-live: no fired event", events(e, "companion_reminder_fired").length === 0);
  check("not-live: no deferred event (a plain skip, retried next due)", events(e, "companion_reminder_deferred").length === 0);
  cleanupEnv(e);
}

// --- 5. No-stacking on a PER-REMINDER marker: two distinct reminders don't suppress each other ---
{
  const e = makeEnv();
  const idA = addReminder(e, { prompt: "A" });
  const idB = addReminder(e, { prompt: "B" });
  const t0 = new Date();
  e.watcher.tick(t0); // both fire; both stay in the pending queue (never consumed)
  check("no-stack: both distinct reminders fire on the same tick", e.enqueued.length === 2);
  // Both share the SAME cron, fired at the SAME t0, so they share the same next real boundary — anchor
  // the re-tick there (not a fixed millisecond offset) so this can never flake near a minute boundary.
  const boundary = nextBoundary(EVERY_MINUTE, t0);
  e.watcher.tick(boundary); // due again for both, but both prior turns are still pending
  check("no-stack: neither reminder is stacked while its OWN turn is still pending", e.enqueued.length === 2);
  check("no-stack: the suppression is a deferred(pending) event for EACH reminder", events(e, "companion_reminder_deferred").filter((ev) => ev.detail.reason === "pending").length === 2);
  check("no-stack: deferred events are correctly attributed per-reminder id", new Set(events(e, "companion_reminder_deferred").map((ev) => ev.detail.reminderId)).size === 2 && [idA, idB].every((id) => events(e, "companion_reminder_deferred").some((ev) => ev.detail.reminderId === id)));
  // Consuming both turns (simulate the session draining its queue) lets BOTH re-fire independently.
  e.clearPending();
  e.watcher.tick(new Date(boundary.getTime() + 1));
  check("no-stack: clearing pending lets BOTH re-fire independently once due again", e.enqueued.length === 4);
  cleanupEnv(e);
}

// --- 6. Restart safety (start()/seedLastFired): a durable prior fire seeds lastFiredAt PER REMINDER
// across restart. Two reminders: one with a recent durable fire (should NOT re-fire), one with none
// (should fire on the very next due tick, since its createdAt anchor is in the past). ---
{
  const e = makeEnv();
  const idA = addReminder(e);
  const idB = addReminder(e);
  const t0 = new Date();
  // idA's durable prior fire is EXACTLY at t0 — nextFireAt is always STRICTLY after its `from`, so
  // isDue(idA, t0) is guaranteed false regardless of where t0 falls within its cron minute (no flake).
  e.db.appendEvent({ id: randomUUID(), ts: t0.toISOString(), managerSessionId: e.sessId, kind: "companion_reminder_fired", detail: { reminderId: idA } });
  e.watcher.start(t0); // seeds lastFiredAt for idA from the durable event; idB has none to seed
  e.watcher.stop();    // clear the interval immediately (no real timer)
  e.watcher.tick(t0);
  const firedIds = e.enqueued.map((en) => (en.text.startsWith(reminderMarker(idA)) ? idA : en.text.startsWith(reminderMarker(idB)) ? idB : null));
  check("restart-safety: the recently-fired reminder does NOT double-fire on restart", !firedIds.includes(idA));
  check("restart-safety: the never-fired reminder DOES fire on its first due tick after restart", firedIds.includes(idB));
  check("restart-safety: exactly one turn enqueued (only idB)", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- 7. enabled=false never fires ---
{
  const e = makeEnv();
  addReminder(e, { enabled: false });
  e.watcher.tick(new Date());
  check("disabled: a disabled reminder never fires", e.enqueued.length === 0);
  check("disabled: no events of either kind", events(e, "companion_reminder_fired").length === 0 && events(e, "companion_reminder_deferred").length === 0);
  cleanupEnv(e);
}

// --- 8. DEFAULT-OFF: zero companion_reminders rows ⇒ every tick is byte-identical to no watcher armed ---
{
  const e = makeEnv();
  e.watcher.tick(new Date());
  e.watcher.start(new Date());
  e.watcher.tick(new Date());
  e.watcher.stop();
  check("default-off: zero rows never enqueues, across tick/start/tick/stop", e.enqueued.length === 0);
  check("default-off: zero rows emits no events of either kind", events(e, "companion_reminder_fired").length === 0 && events(e, "companion_reminder_deferred").length === 0);
  cleanupEnv(e);
}

// --- 9. The reminder carries ITS OWN route on its submitted turn (route-carry, per-row not per-config) ---
{
  const e = makeEnv();
  const route = { channel: "telegram", chatId: "reminder-chat" };
  addReminder(e, { route });
  e.watcher.tick(new Date());
  check("route-carry: the fired reminder carries its OWN configured route", e.enqueued.length === 1 && JSON.stringify(e.enqueued[0].route) === JSON.stringify(route));
  cleanupEnv(e);
}
{
  const e = makeEnv();
  addReminder(e); // no route
  e.watcher.tick(new Date());
  check("route-carry: no route configured on the row ⇒ the reminder carries no route", e.enqueued.length === 1 && e.enqueued[0].route === undefined);
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — CompanionReminderWatcher fires each due/live/enabled reminder exactly once (carrying its own route), defers under park (once per streak, per reminder), skips a stopped companion, never stacks a reminder against its OWN unconsumed turn (distinct reminders don't cross-suppress), restart-seeds per reminder id (no double-fire), never fires a disabled row, and stays fully inert with zero rows."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
