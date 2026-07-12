import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion proactive HEARTBEAT (card 9488951e). NO claude, NO network, NO daemon — the watcher takes an
// injected pty-slice + a REAL Db on an explicit temp file, so the tick tests use RECORDING STUBS and drive
// tick() directly. Covers: due live-fire (framed [loom:heartbeat] + lastFiredAt + fired-event), cadence
// not-due, rate-limit PARK defer, not-live skip (never resumes), no pending-heartbeat stacking, DEFAULT-OFF
// (0 cadence never fires + config default), the heartbeat CARRYING the HOME route on its submitted turn, and
// the per-turn-route deliverReply (route present → delivered there; no route → no-target).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { CompanionHeartbeatWatcher, HEARTBEAT_TAG } from "../dist/companion/heartbeat.js";
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { readCompanionConfig, DEFAULT_HEARTBEAT_PROMPT } from "../dist/companion/config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const PROMPT = "PROACTIVE_CHECK";
const INTERVAL_MIN = 360; // 6h — a conservative example cadence
const INTERVAL_MS = INTERVAL_MIN * 60_000;

function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-hb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `hp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ha-${Math.random().toString(36).slice(2, 8)}`;
  const sessId = `hs-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "HB", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "companion", startupPrompt: "", position: 0 });
  db.insertSession({
    id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  });
  if (opts.parked) db.setRateLimitedUntil(sessId, new Date(Date.now() + 3_600_000).toISOString(), "usage limit");
  if (opts.home) db.setCompanionHome(sessId, opts.home); // configure THIS session's proactive HOME the heartbeat pins as its route

  const alive = new Set(opts.notLive ? [] : [sessId]); // isAlive source of truth
  const enqueued = [];   // { sessionId, text, route } — permanent record of every enqueue (route = 5th arg)
  let pendingQueue = []; // mutable "unconsumed" FIFO getPending returns; a test clears it to simulate consumption
  const pty = {
    isAlive: (id) => alive.has(id),
    // Mirror PtyHost.enqueueStdin's shape (source, onDeliver, route); the watcher passes ("system", undefined, home).
    enqueueStdin: (id, text, _source, _onDeliver, route) => { enqueued.push({ sessionId: id, text, route }); pendingQueue.push(text); return { delivered: false, position: pendingQueue.length }; },
    getPending: (id) => (id === sessId ? pendingQueue : []),
  };
  const watcher = new CompanionHeartbeatWatcher({ db, pty, sessionId: sessId, intervalMinutes: opts.intervalMinutes ?? INTERVAL_MIN, prompt: PROMPT });
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

// --- 1. Due tick, LIVE + non-parked → enqueues ONE framed heartbeat + records lastFiredAt + fired-event ---
{
  const e = makeEnv();
  const t0 = new Date();
  e.watcher.tick(t0);
  check("live-fire: enqueues ONE turn to the companion", e.enqueued.length === 1 && e.enqueued[0].sessionId === e.sessId);
  check("live-fire: framed [loom:heartbeat] carrying the prompt", e.enqueued[0].text.startsWith(HEARTBEAT_TAG) && e.enqueued[0].text.includes(PROMPT));
  check("live-fire: emits a companion_heartbeat_fired event", events(e, "companion_heartbeat_fired").length === 1);
  check("live-fire: no deferred event on a clean fire", events(e, "companion_heartbeat_deferred").length === 0);
  // lastFiredAt recorded: an immediate 2nd tick (well within the cadence), AFTER the queue drains, does NOT re-fire.
  e.clearPending();
  e.watcher.tick(new Date(t0.getTime() + 60_000));
  check("live-fire: lastFiredAt recorded (a within-cadence tick does not re-fire)", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- 2. Cadence NOT due → no enqueue ---
{
  const e = makeEnv();
  const t0 = new Date();
  e.watcher.tick(t0); // first fire arms lastFiredAt
  e.clearPending();
  e.watcher.tick(new Date(t0.getTime() + INTERVAL_MS - 60_000)); // 1 min before due
  check("not-due: a pre-cadence tick does not enqueue", e.enqueued.length === 1);
  e.watcher.tick(new Date(t0.getTime() + INTERVAL_MS + 1_000)); // now due again
  check("not-due: fires once the cadence elapses", e.enqueued.length === 2);
  cleanupEnv(e);
}

// --- 3. Rate-limit PARKED → DEFERS (no enqueue; state preserved; deferred-event) ---
{
  const e = makeEnv({ parked: true });
  const t0 = new Date();
  e.watcher.tick(t0);
  check("park-defer: nothing enqueued while parked", e.enqueued.length === 0);
  check("park-defer: emits a companion_heartbeat_deferred event", events(e, "companion_heartbeat_deferred").length === 1);
  check("park-defer: reason is rate-limited", events(e, "companion_heartbeat_deferred")[0].detail.reason === "rate-limited");
  check("park-defer: no fired event", events(e, "companion_heartbeat_fired").length === 0);
  // State preserved: clearing the park → the SAME due tick now fires (lastFiredAt was never advanced).
  e.db.setRateLimitedUntil(e.sessId, null, null);
  e.watcher.tick(new Date(t0.getTime() + 1_000));
  check("park-defer: the held cadence fires once the park clears", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- 4. Session NOT live → skip (no enqueue, no resume, no event) ---
{
  const e = makeEnv({ notLive: true });
  e.watcher.tick(new Date());
  check("not-live: nothing enqueued (stopped companion is NOT resumed to heartbeat)", e.enqueued.length === 0);
  check("not-live: no fired event", events(e, "companion_heartbeat_fired").length === 0);
  check("not-live: no deferred event (a plain skip, retried next due)", events(e, "companion_heartbeat_deferred").length === 0);
  cleanupEnv(e);
}

// --- 5. No pending-heartbeat stacking (a 2nd due tick while one is still queued does NOT enqueue a 2nd) ---
{
  const e = makeEnv();
  const t0 = new Date();
  e.watcher.tick(t0); // fires; the heartbeat stays in the pending queue (session "busy", never consumed)
  check("no-stack: first tick enqueues", e.enqueued.length === 1);
  e.watcher.tick(new Date(t0.getTime() + INTERVAL_MS + 1_000)); // due again, but the prior heartbeat is still pending
  check("no-stack: a 2nd heartbeat is NOT stacked while one is pending", e.enqueued.length === 1);
  check("no-stack: the suppression is a deferred(pending) event", events(e, "companion_heartbeat_deferred").some((ev) => ev.detail.reason === "pending"));
  cleanupEnv(e);
}

// --- 5b. Defer-emit-once: repeated defer ticks in ONE streak emit a single event; a fire re-arms it ---
{
  const e = makeEnv({ parked: true });
  const t0 = new Date();
  e.watcher.tick(t0);
  e.watcher.tick(new Date(t0.getTime() + 60_000));
  e.watcher.tick(new Date(t0.getTime() + 120_000));
  check("defer-once: 3 park ticks in one streak emit only ONE deferred event", events(e, "companion_heartbeat_deferred").length === 1);
  check("defer-once: nothing enqueued across the streak", e.enqueued.length === 0);
  // A real fire ends the streak: clear the park → the still-due tick fires (lastFiredAt never advanced).
  e.db.setRateLimitedUntil(e.sessId, null, null);
  e.watcher.tick(new Date(t0.getTime() + 180_000));
  check("defer-once: the held cadence fires once the park clears", e.enqueued.length === 1 && events(e, "companion_heartbeat_fired").length === 1);
  // Re-park AFTER a fire and come due again → a FRESH deferred event (the fire re-armed the one-emit).
  e.clearPending();
  e.db.setRateLimitedUntil(e.sessId, new Date(Date.now() + 3_600_000).toISOString(), "usage limit");
  e.watcher.tick(new Date(t0.getTime() + 180_000 + INTERVAL_MS + 1_000));
  check("defer-once: a fire re-arms the deferred emit (a later park streak emits again)", events(e, "companion_heartbeat_deferred").length === 2);
  cleanupEnv(e);
}

// --- 5c. Restart safety (start()/seedLastFired): a durable prior fire seeds lastFiredAt across restart ---
{
  // Recent prior fire (within cadence) → a fresh watcher must NOT re-fire immediately on restart.
  const e = makeEnv();
  const t0 = new Date();
  e.db.appendEvent({ id: randomUUID(), ts: new Date(t0.getTime() - 60_000).toISOString(), managerSessionId: e.sessId, kind: "companion_heartbeat_fired", detail: {} });
  e.watcher.start(t0); // seeds lastFiredAt from the durable event
  e.watcher.stop();    // clear the interval immediately (no real timer)
  e.watcher.tick(t0);
  check("restart-safety: a recent durable fire seeds lastFiredAt → an immediate tick does NOT re-fire", e.enqueued.length === 0);
  cleanupEnv(e);

  // Stale prior fire (older than the cadence) → a fresh watcher SHOULD fire on the next due tick.
  const e2 = makeEnv();
  const t1 = new Date();
  e2.db.appendEvent({ id: randomUUID(), ts: new Date(t1.getTime() - (INTERVAL_MS + 60_000)).toISOString(), managerSessionId: e2.sessId, kind: "companion_heartbeat_fired", detail: {} });
  e2.watcher.start(t1);
  e2.watcher.stop();
  e2.watcher.tick(t1);
  check("restart-safety: a STALE durable fire (older than the cadence) fires on the next due tick", e2.enqueued.length === 1);
  cleanupEnv(e2);
}

// --- 6. DEFAULT-OFF: 0 cadence never fires; config default is 0 + the default prompt ---
{
  const e = makeEnv({ intervalMinutes: 0 });
  e.watcher.tick(new Date());
  check("default-off: a 0-cadence watcher never enqueues", e.enqueued.length === 0);
  check("default-off: a 0-cadence watcher emits no events", events(e, "companion_heartbeat_fired").length === 0 && events(e, "companion_heartbeat_deferred").length === 0);
  cleanupEnv(e);

  const base = { LOOM_COMPANION_BOT_TOKEN: "t", LOOM_COMPANION_CHAT_ID: "c", LOOM_COMPANION_SESSION_ID: "s" };
  check("default-off: no heartbeat env → intervalMinutes 0 (watcher never armed)", readCompanionConfig({ ...base }).heartbeatIntervalMinutes === 0);
  check("default-off: blank/non-numeric cadence → 0", readCompanionConfig({ ...base, LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES: "abc" }).heartbeatIntervalMinutes === 0);
  check("default-off: negative cadence → 0", readCompanionConfig({ ...base, LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES: "-5" }).heartbeatIntervalMinutes === 0);
  check("opt-in: positive cadence is carried through", readCompanionConfig({ ...base, LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES: "360" }).heartbeatIntervalMinutes === 360);
  check("prompt: defaults to DEFAULT_HEARTBEAT_PROMPT", readCompanionConfig({ ...base }).heartbeatPrompt === DEFAULT_HEARTBEAT_PROMPT);
  check("prompt: an env override wins", readCompanionConfig({ ...base, LOOM_COMPANION_HEARTBEAT_PROMPT: "hi" }).heartbeatPrompt === "hi");
}

// --- 7. The heartbeat carries the HOME route on its turn → per-turn-route deliverReply → HOME ---
{
  const fakeAdapter = (name, sent) => ({ name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } });
  const noopSubmit = () => ({ delivered: true });
  const home = { channel: "telegram", chatId: "home-chat" };

  // (a) With a configured HOME, a fired heartbeat carries it as the turn's ROUTE (so the turn's chat_reply
  //     later resolves to home via the pty's per-turn origin — no special-case in deliverReply).
  {
    const e = makeEnv({ home });
    e.watcher.tick(new Date());
    check("home-route: the fired heartbeat carries the HOME route", e.enqueued.length === 1 && JSON.stringify(e.enqueued[0].route) === JSON.stringify(home));
    cleanupEnv(e);
  }

  // (b) BUG REPRO / FIX: with NO home configured (the in-app-only companion case — no external channel
  //     ever bound), the heartbeat must NOT carry an undefined route (pre-fix: a proactive reply then had
  //     nowhere to go — chat_reply resolved `no-target` and silently vanished). It now falls back to the
  //     session's own implicit in-app route ({channel:"in-app", chatId: sessionId} — see in-app.ts's
  //     `inAppHomeRoute`), which is ALWAYS deliverable (every gateway registers the in-app adapter
  //     unconditionally).
  {
    const e = makeEnv(); // no home
    e.watcher.tick(new Date());
    const expected = { channel: "in-app", chatId: e.sessId };
    check("home-route: no home configured ⇒ falls back to the session's in-app route (never undefined)", e.enqueued.length === 1 && JSON.stringify(e.enqueued[0].route) === JSON.stringify(expected));
    cleanupEnv(e);
  }

  // (c) deliverReply for that turn routes to the pinned origin (home): the injected origin resolver returns
  //     the home route ⇒ delivered there. No route ⇒ no-target, nothing sent.
  {
    const sent = [];
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, (sid) => (sid === "hb-sess" ? home : null));
    gw.registerAdapter(fakeAdapter("telegram", sent));
    const res = await gw.deliverReply("hb-sess", "proactive hello");
    check("per-turn-route: a proactive reply on the home-routed turn lands on the HOME chat", res.delivered === true && sent.length === 1 && sent[0].chatId === "home-chat" && sent[0].text === "proactive hello");
    const none = await gw.deliverReply("no-route-sess", "x");
    check("per-turn-route: a turn with no route → no-target, nothing sent", none.delivered === false && none.reason === "no-target" && sent.length === 1);
  }

  // (d) BUG REPRO / FIX, end-to-end through deliverReply: an in-app-only companion (no home bound) fires a
  //     proactive heartbeat turn, and the reply lands on the in-app channel instead of no-target. Mirrors
  //     what the real daemon wires: the pty pins the heartbeat's carried route as the turn's origin, and
  //     the gateway resolves it via originResolver exactly like a home-bound companion's turn does.
  {
    const inAppSent = [];
    const sid = "in-app-only-sess";
    const inAppRoute = { channel: "in-app", chatId: sid };
    const gw = new ChatGateway(noopSubmit, [], undefined, undefined, (queried) => (queried === sid ? inAppRoute : null));
    gw.registerAdapter(fakeAdapter("in-app", inAppSent));
    const res = await gw.deliverReply(sid, "proactive check-in");
    check("in-app fallback E2E: a home-less proactive turn's reply delivers via the in-app channel", res.delivered === true && inAppSent.length === 1 && inAppSent[0].chatId === sid && inAppSent[0].text === "proactive check-in");
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — CompanionHeartbeatWatcher fires due/live, defers under park, skips stopped, never stacks, stays OFF at 0 cadence, and carries the configured HOME route (or the in-app fallback route when unconfigured) on its proactive turn so its chat_reply always has somewhere to go via the per-turn-route path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
