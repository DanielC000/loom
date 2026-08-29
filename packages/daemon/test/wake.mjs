import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// WakeService test (wake_me primitive). NO claude — WakeService takes an injected pty-slice +
// resume fn, so the tick tests use RECORDING STUBS and drive tick()/start() directly. Hermetic:
// each env gets its OWN temp .db (never the daemon's). Covers: schedule validation (floor/horizon/
// cap/note/exactly-one), live-fire, non-due, not-live auto-resume, usage-limited defer, unresumable
// drop, cancel scoping, start() past-due fire-once reconcile, the route-aware fire path
// (companion-origin wake fires its [loom:reminder] back through the captured route; a non-companion
// wake fires [loom:wake], no route). Card 706cc6fb: every fire carries kind:"agent" (a scheduled
// wake-up is the agent's own arbitrary note-to-self / companion reminder — one-per-turn, never
// coalesced with anything else queued behind it). Card 61a012ce: a HELD fire (busy target) now
// dispatches through the injected `enqueueDurable` fn (prod: SessionService.enqueueSystemNudge)
// instead of a bare `pty.enqueueStdin` — the wake row is STILL deleted first (claim-before-act,
// anti-re-fire, unchanged), but the message itself is now durable independent of that row's
// lifecycle. `enqueueDurable`'s test stub mirrors enqueueDurableMessage's OWN contract (forward to
// enqueueStdin; on a held outcome, persist a `session_message_queued` record) closely enough to prove
// WakeService's delegation is correct; `wake-poll-durable-route.mjs` proves the REAL SessionService
// plumbing (route persistence + boot redrive) end-to-end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  const enqueued = [];          // { sessionId, text, source, route, kind }
  const resumed = [];           // sessionIds passed to resume
  let origin = opts.origin ?? null; // mutable: getActiveTurnOrigin() reads THIS at schedule time
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, source, onDeliver, route, kind) => {
      enqueued.push({ sessionId: id, text, source, route, kind });
      // opts.heldTarget simulates a busy recipient: enqueueStdin returns HELD (delivered:false) instead
      // of the default always-delivered stub — the exact branch the card 61a012ce bug lived in (a held
      // enqueue does NOT throw, so the old bare-enqueueStdin code had no durable trace of it at all).
      if (opts.heldTarget) return { delivered: false, position: 1 };
      return { delivered: true };
    },
    getActiveTurnOrigin: (id) => (id === sessId ? origin : null),
  };
  const resume = async (id) => {
    resumed.push(id);
    if (opts.resumeThrows) throw new Error("session is no longer resumable (engine transcript missing)");
    alive.add(id); // a successful resume brings the pty back
  };
  // enqueueDurable mirrors sessions/service.ts's real enqueueDurableMessage CONTRACT closely enough to
  // test WakeService's OWN delegation: forward to enqueueStdin, and on a held (delivered:false) outcome
  // persist a `session_message_queued` record (the durable inbox row a restart-recovery boot scan reads
  // via db.listUndeliveredQueuedMessages()) — NOT a re-implementation of the real give-up/redrive
  // machinery, which `wake-poll-durable-route.mjs` exercises against the REAL SessionService instead.
  const enqueueDurable = (id, text, ctx) => {
    const r = pty.enqueueStdin(id, text, "system", undefined, ctx.route, ctx.kind);
    if (!r.delivered) {
      db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId: "system", workerSessionId: id, taskId: null,
        kind: "session_message_queued",
        detail: { msgId: randomUUID(), text, sender: "system", kind: ctx.kind, route: ctx.route },
      });
    }
    return r;
  };
  // Card 90b9e904: RECORDING stub for the optional `enqueueDurableNudge` dep — mirrors
  // crash-recovery-watcher.mjs's (17a)/(17c) pattern. Only wired when the test opts in
  // (`opts.enqueueDurableNudge`); every other test above omits it, so `tick()` falls back to the
  // pre-90b9e904 `enqueueDurable` call, byte-identical.
  const durableCalls = [];
  const wakes = new WakeService({
    db, pty, resume, enqueueDurable,
    isUsageLimited: () => !!opts.usageLimited,
    ...(opts.enqueueDurableNudge ? {
      enqueueDurableNudge: (id, role, text, taskId, dOpts) => { durableCalls.push({ id, role, text, taskId, opts: dOpts }); },
    } : {}),
  });
  return {
    dbFile, db, projId, agentId, sessId, alive, enqueued, resumed, wakes, durableCalls,
    setOrigin: (o) => { origin = o; }, // flip the "current turn's route" between schedule() calls
  };
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

// minutes/reason aliases (card: wake_me should accept the intuitive minutes/reason args).
{
  const e = makeEnv();
  const now = new Date();
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  const viaMinutes = e.wakes.schedule(e.sessId, { minutes: 2, reason: "check the render" }, now);
  const viaDelay = e.wakes.schedule(e.sessId, { delaySeconds: 120, note: "check the render" }, now);
  check("minutes: schedules the SAME fire instant as the equivalent delaySeconds", viaMinutes.wakeAt === viaDelay.wakeAt);
  e.wakes.cancel(e.sessId, viaMinutes.wakeId);
  e.wakes.cancel(e.sessId, viaDelay.wakeId);

  const viaReason = e.wakes.schedule(e.sessId, { delaySeconds: 60, reason: "reason maps to note" }, now);
  check("reason: maps onto note", e.db.getWake(viaReason.wakeId).note === "reason maps to note");
  e.wakes.cancel(e.sessId, viaReason.wakeId);

  const both = e.wakes.schedule(e.sessId, { delaySeconds: 90, minutes: 2, note: "explicit wins" }, now);
  check("minutes+delaySeconds together: the explicit delaySeconds wins", new Date(both.wakeAt).getTime() === now.getTime() + 90_000);
  e.wakes.cancel(e.sessId, both.wakeId);

  check("existing {delaySeconds, note} path still works unchanged", e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "still works" }, now).wakeId !== undefined);

  check("minutes + wakeAt together is rejected (still exactly-one)", threw(() => e.wakes.schedule(e.sessId, { minutes: 2, wakeAt: now.toISOString(), note: "x" }, now)));
  check("neither note nor reason is rejected", threw(() => e.wakes.schedule(e.sessId, { delaySeconds: 60 }, now)));
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

// Card 90b9e904: with `enqueueDurableNudge` wired (production shape — index.ts passes
// sessions.enqueueDurableNudge), a not-live wake fire's nudge routes through IT — MCP-seen-gated (on top
// of enqueueDurable's existing durability) — instead of straight to `enqueueDurable`. POSITIVE CONTROL:
// RED against pre-90b9e904 code, where `enqueueDurableNudge` was never provided as a dep at all, so this
// call would have gone straight to `enqueueDurable` regardless of what's wired here.
{
  const e = makeEnv({ enqueueDurableNudge: true });
  const t0 = new Date();
  e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "wake up" }, t0);
  e.alive.delete(e.sessId); // session stopped after scheduling
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  check("durable-dispatch: resumed the not-alive target first", e.resumed.length === 1 && e.resumed[0] === e.sessId);
  check("durable-dispatch: the fire routes through enqueueDurableNudge, not raw enqueueDurable",
    e.durableCalls.length === 1 && e.durableCalls[0].id === e.sessId && e.durableCalls[0].role === "manager"
    && e.durableCalls[0].taskId === null && e.durableCalls[0].opts?.kind === "agent" && e.durableCalls[0].opts?.route === undefined
    && e.durableCalls[0].text.includes("wake up"));
  check("durable-dispatch: enqueueDurable (and so pty.enqueueStdin) is NOT also called for this same nudge (no double-dispatch)",
    e.enqueued.length === 0);
  check("durable-dispatch: wake_fired still recorded", events(e, "wake_fired").length === 1);
  cleanupEnv(e);
}

// REGRESSION GUARD: with NO `enqueueDurableNudge` dep (every test above), the not-live path still falls
// back to the pre-90b9e904 `enqueueDurable` call, byte-identical.
{
  const e = makeEnv(); // no enqueueDurableNudge — the default every other test uses
  const t0 = new Date();
  e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "wake up" }, t0);
  e.alive.delete(e.sessId);
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  check("fallback: with no enqueueDurableNudge dep, the not-live fire still lands via enqueueDurable",
    e.enqueued.length === 1 && e.enqueued[0].sessionId === e.sessId && e.enqueued[0].kind === "agent");
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
  // start()'s tick is fire-and-forget (void) — poll for the enqueue landing instead of a blind sleep.
  // TIMING-GUARD-SAFE: poll-observes-prior-step — wake.ts's tick() deletes the fired wake's row (claim
  // the slot first) strictly BEFORE the dispatch this poll observes; see fixed-wait-negative-guard.mjs's
  // own doc on this reason for the source citation.
  { const d = Date.now() + 2_000; while (e.enqueued.length === 0 && Date.now() < d) await new Promise((r) => setTimeout(r, 5)); }
  check("start-reconcile: a past-due wake fired once on start()", e.enqueued.length === 1);
  check("start-reconcile: it was consumed (no lingering row)", e.db.countPendingWakes(e.sessId) === 0);
  cleanupEnv(e);
}

// Route-aware fire, non-companion case: with NO active turn origin at schedule time, the wake carries
// no route and fires [loom:wake], kind:"agent" (card 706cc6fb — one-per-turn, never coalesced).
{
  const e = makeEnv(); // origin defaults to null
  const t0 = new Date();
  e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "ordinary" }, t0);
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  check("non-companion: fires with no route", e.enqueued.length === 1 && e.enqueued[0].route === undefined);
  check("non-companion: fires as a 'system' source turn", e.enqueued[0].source === "system");
  check("non-companion: tagged [loom:wake], not [loom:reminder]", e.enqueued[0].text.startsWith("[loom:wake]"));
  check("non-companion: kind is 'agent' (one-per-turn, never coalesced)", e.enqueued[0].kind === "agent");
  cleanupEnv(e);
}

// Route-aware fire, companion-origin case: an active turn origin at schedule time is captured onto the
// wake and, on fire, delivered back through that SAME route as a [loom:reminder] "system" turn.
{
  const e = makeEnv();
  const route = { channel: "telegram", chatId: "12345" };
  e.setOrigin(route);
  const t0 = new Date();
  const { wakeId } = e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "check back with them" }, t0);
  check("companion-origin: the route is persisted on the wake row", JSON.stringify(e.db.getWake(wakeId).route) === JSON.stringify(route));
  e.setOrigin(null); // the scheduling turn has long since ended by fire time — must not matter
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  check("companion-origin: fires carrying the CAPTURED route", e.enqueued.length === 1 && JSON.stringify(e.enqueued[0].route) === JSON.stringify(route));
  check("companion-origin: fires as a 'system' turn", e.enqueued[0].source === "system");
  check("companion-origin: tagged [loom:reminder], not [loom:wake]", e.enqueued[0].text.startsWith("[loom:reminder]") && e.enqueued[0].text.includes("check back with them"));
  check("companion-origin: kind is 'agent' (one-per-turn, never coalesced)", e.enqueued[0].kind === "agent");
  check("companion-origin: emits a wake_fired event same as any wake", events(e, "wake_fired").length === 1);
  cleanupEnv(e);
}

// Card 61a012ce — HELD fire is now DURABLE: a busy target still gets the wake row deleted (claim-first,
// anti-re-fire unchanged) but the dispatch now goes through enqueueDurable, which persists a
// session_message_queued record instead of vanishing with no trace when a restart hits before drain.
{
  const e = makeEnv({ heldTarget: true });
  const t0 = new Date();
  const { wakeId } = e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "check the deploy" }, t0);
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  check("held-fire: the wake row is STILL deleted (claim-first preserved — no re-fire loop)", e.db.getWake(wakeId) === undefined);
  check("held-fire: wake_fired is still emitted (fire is attempted regardless of delivery outcome)", events(e, "wake_fired").length === 1);
  check("held-fire: dispatched via enqueueDurable (recorded in the enqueue log)", e.enqueued.length === 1 && e.enqueued[0].sessionId === e.sessId);
  const undelivered = e.db.listUndeliveredQueuedMessages();
  check("held-fire: a durable session_message_queued record now exists (the actual fix — nothing existed here before)",
    undelivered.length === 1 && undelivered[0].detail.text.includes("check the deploy"));
  check("held-fire: the durable record carries kind:\"agent\"", undelivered[0].detail.kind === "agent");
  cleanupEnv(e);
}

// Card 61a012ce — companion-origin HELD fire: the durable record carries the ROUTE too (not just the
// note), so a restart-recovery redrive of a companion reminder still lands back on the right chat.
{
  const e = makeEnv({ heldTarget: true });
  const route = { channel: "telegram", chatId: "999" };
  e.setOrigin(route);
  const t0 = new Date();
  e.wakes.schedule(e.sessId, { delaySeconds: 60, note: "circle back" }, t0);
  e.setOrigin(null);
  await e.wakes.tick(new Date(t0.getTime() + 61_000));
  const undelivered = e.db.listUndeliveredQueuedMessages();
  check("held-fire+route: the durable record's OWN detail carries the captured route (not dropped)",
    undelivered.length === 1 && JSON.stringify(undelivered[0].detail.route) === JSON.stringify(route));
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — WakeService validates+schedules, fires due wakes (live + auto-resume), defers under usage-limit, drops the unresumable, scopes cancel, reconciles past-due on start, routes a companion-origin wake's [loom:reminder] back through its captured route, every fire carries kind:\"agent\" (card 706cc6fb), and a HELD fire (busy target) is now durably recorded (route included) instead of vanishing on a restart before drain (card 61a012ce)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
