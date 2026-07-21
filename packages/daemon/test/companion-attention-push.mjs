import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion attention-push WATCHER (daemon-owned per-companion fleet-alert tail-poll — NOT an MCP tool,
// NOT a capabilities.ts registry lever). NO claude, NO network, NO daemon — the watcher takes an injected
// pty-slice + a REAL Db on an explicit temp file, so every test drives tick() directly with RECORDING
// STUBS, mirroring companion-heartbeat.mjs's shape.
//
// Covers: DEFAULT-OFF (no grant ⇒ no-op fast path), baseline-seed fires nothing for pre-existing backlog,
// a subscribed in-scope event delivers once (framed [loom:alert] + companion_alert_pushed event), restart
// re-seed never re-pushes an already-pushed event, an out-of-scope project's event is dropped, an
// unsubscribed alert class is dropped, a gone session is skipped, not-live is skipped, rate-limit PARK
// defers (once per streak, watermark held), no-stacking defers (watermark held), union-merge of
// alertClasses/digestMinutes across granted projects (Lead fork 4), digest-mode accumulation + a single
// bundled flush (Lead fork 5, the re-scan-buffer v1), the watermark-stall fix (no-stall regressions in both
// modes), the seq cursor's immunity to sqlite rowid reuse after a hard delete (CR-caught correctness bug),
// the immediate-mode burst cap (CR fold-in [3]), and the alert-line length bound (CR fold-in [5]).
// Run: 1) build (turbo builds shared first), 2) node test/companion-attention-push.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Db } from "../dist/db.js";
import { AttentionPushWatcher, ALERT_TAG, classify, alertLine } from "../dist/companion/attention-push.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function seedProject(db, id, name) {
  const now = new Date().toISOString();
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role) {
  const now = new Date().toISOString();
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
}

function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);

  const projA = `pa-${randomUUID()}`;
  const projB = `pb-${randomUUID()}`;
  seedProject(db, projA, "Proj A");
  seedProject(db, projB, "Proj B");

  const sessId = `cs-${randomUUID()}`;
  seedSession(db, sessId, projA, "assistant");
  const mgrA = `mgr-a-${randomUUID()}`;
  seedSession(db, mgrA, projA, "manager");
  const mgrB = `mgr-b-${randomUUID()}`;
  seedSession(db, mgrB, projB, "manager");

  if (opts.grant !== false) {
    db.upsertCompanionCapabilityGrant({
      sessionId: sessId, capability: "attention-push", projectId: projA, mode: "read",
      config: opts.configA ?? { alertClasses: ["merge-gate", "worker-blocked"] },
    });
  }
  if (opts.configB) {
    db.upsertCompanionCapabilityGrant({ sessionId: sessId, capability: "attention-push", projectId: projB, mode: "read", config: opts.configB });
  }
  if (opts.parked) db.setRateLimitedUntil(sessId, new Date(Date.now() + 3_600_000).toISOString(), "usage limit");

  const alive = new Set(opts.notLive ? [] : [sessId]);
  const enqueued = []; // { sessionId, text, route }
  let pendingQueue = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, _source, _onDeliver, route) => { enqueued.push({ sessionId: id, text, route }); pendingQueue.push(text); return { delivered: false, position: pendingQueue.length }; },
    getPending: (id) => (id === sessId ? pendingQueue : []),
  };
  const watcher = new AttentionPushWatcher({ db, pty, sessionId: sessId });
  return {
    dbFile, db, projA, projB, sessId, mgrA, mgrB, alive, enqueued, watcher,
    clearPending: () => { pendingQueue = []; },
    freshWatcher: () => new AttentionPushWatcher({ db, pty, sessionId: sessId }),
  };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const events = (e, kind) => e.db.listEvents(e.sessId).filter((ev) => ev.kind === kind);
function fire(e, kind, managerSessionId, detail = {}, extra = {}) {
  e.db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(), managerSessionId,
    workerSessionId: extra.workerSessionId ?? null, taskId: extra.taskId ?? null, kind, detail,
  });
}

// --- 0. DEFAULT-OFF: no grant ⇒ a qualifying event never pushes ---
{
  const e = makeEnv({ grant: false });
  e.watcher.start(); e.watcher.stop();
  fire(e, "merge_rejected", e.mgrA);
  e.watcher.tick(new Date());
  check("default-off: no grant ⇒ nothing enqueued", e.enqueued.length === 0);
  check("default-off: no companion_alert_pushed event", events(e, "companion_alert_pushed").length === 0);
  cleanupEnv(e);
}

// --- 1. Baseline-seed: pre-existing backlog (before start()) never replays as a fresh alert ---
{
  const e = makeEnv();
  fire(e, "merge_rejected", e.mgrA); // backlog — exists BEFORE the watcher ever starts
  e.watcher.start(); e.watcher.stop(); // seeds the watermark to the current max seq
  e.watcher.tick(new Date());
  check("baseline-seed: pre-existing backlog fires nothing", e.enqueued.length === 0);
  cleanupEnv(e);
}

// --- 2. A subscribed in-scope event delivers ONCE: framed [loom:alert] + companion_alert_pushed ---
{
  const e = makeEnv();
  e.watcher.start(); e.watcher.stop();
  fire(e, "merge_rejected", e.mgrA, {}, { workerSessionId: "worker-session-12345678" });
  e.watcher.tick(new Date());
  check("deliver: enqueues ONE turn to the companion", e.enqueued.length === 1 && e.enqueued[0].sessionId === e.sessId);
  check("deliver: framed [loom:alert]", e.enqueued[0].text.startsWith(ALERT_TAG));
  check("deliver: chat line names the project + a who-slice", e.enqueued[0].text.includes("Proj A") && e.enqueued[0].text.includes("worker-s"));
  // BUG REPRO / FIX: this env's session has NO companion home configured (makeEnv never seeds one) — the
  // same in-app-only shape as an in-app companion with no external channel bound. Pre-fix the pushed alert
  // turn carried an undefined route (⇒ chat_reply later resolves `no-target`, silently vanishing); it must
  // now fall back to the session's own implicit in-app route (see in-app.ts's `inAppHomeRoute`).
  check("deliver: no home configured ⇒ falls back to the session's in-app route (never undefined)", JSON.stringify(e.enqueued[0].route) === JSON.stringify({ channel: "in-app", chatId: e.sessId }));
  const pushed = events(e, "companion_alert_pushed");
  check("deliver: emits ONE companion_alert_pushed event", pushed.length === 1);
  check("deliver: detail carries sourceSeq/alertClass/sourceKind", typeof pushed[0].detail.sourceSeq === "number" && pushed[0].detail.alertClass === "merge-gate" && pushed[0].detail.sourceKind === "merge_rejected");
  check("deliver: no deferred event on a clean push", events(e, "companion_alert_deferred").length === 0);
  // A 2nd tick with nothing new does not re-fire.
  e.clearPending();
  e.watcher.tick(new Date());
  check("deliver: watermark advanced — a 2nd tick with nothing new does not re-fire", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- 3. Restart re-seed: a FRESH watcher instance never re-pushes an already-pushed event ---
{
  const e = makeEnv();
  e.watcher.start(); e.watcher.stop();
  fire(e, "merge_rejected", e.mgrA);
  e.watcher.tick(new Date());
  check("restart-safety: first watcher pushes once", e.enqueued.length === 1);
  const fresh = e.freshWatcher();
  fresh.start(); fresh.stop(); // re-seeds from the durable companion_alert_pushed event
  fresh.tick(new Date());
  check("restart-safety: a fresh watcher instance does not re-push the same event", e.enqueued.length === 1);
  // A genuinely NEW event after restart still fires (clear the still-pending prior turn first — this
  // assertion is about restart re-seed, not a 2nd no-stacking test).
  e.clearPending();
  fire(e, "merge_rejected", e.mgrA);
  fresh.tick(new Date());
  check("restart-safety: a fresh watcher still reacts to a NEW event", e.enqueued.length === 2);
  cleanupEnv(e);
}

// --- 4. Out-of-scope project: an event from an UNGRANTED project is dropped ---
{
  const e = makeEnv(); // only projA is granted
  e.watcher.start(); e.watcher.stop();
  fire(e, "merge_rejected", e.mgrB); // project B — not granted
  e.watcher.tick(new Date());
  check("out-of-scope: an ungranted project's event is dropped", e.enqueued.length === 0);
  cleanupEnv(e);
}

// --- 5. Unsubscribed class: a signal outside the granted alertClasses is dropped ---
{
  const e = makeEnv({ configA: { alertClasses: ["merge-gate"] } }); // worker-blocked NOT subscribed
  e.watcher.start(); e.watcher.stop();
  fire(e, "worker_stuck", e.mgrA, { minutesBusy: 30 });
  e.watcher.tick(new Date());
  check("unsubscribed-class: a signal outside alertClasses is dropped", e.enqueued.length === 0);
  cleanupEnv(e);
}

// --- 6. Session gone: a watcher whose session row no longer exists is a no-op ---
{
  const e = makeEnv();
  e.watcher.start(); e.watcher.stop();
  e.db.deleteSession(e.sessId);
  fire(e, "merge_rejected", e.mgrA);
  e.watcher.tick(new Date());
  check("session-gone: nothing enqueued once the session row is deleted", e.enqueued.length === 0);
  cleanupEnv(e);
}

// --- 7. Not-live: a stopped companion is skipped (never resumed just to push an alert) ---
{
  const e = makeEnv({ notLive: true });
  e.watcher.start(); e.watcher.stop();
  fire(e, "merge_rejected", e.mgrA);
  e.watcher.tick(new Date());
  check("not-live: nothing enqueued", e.enqueued.length === 0);
  check("not-live: no deferred event (a plain skip, retried next tick)", events(e, "companion_alert_deferred").length === 0);
  cleanupEnv(e);
}

// --- 8. Rate-limit PARK: defers (once per streak), watermark held so the park-clear tick still fires ---
{
  const e = makeEnv({ parked: true });
  e.watcher.start(); e.watcher.stop();
  fire(e, "merge_rejected", e.mgrA);
  const t0 = new Date();
  e.watcher.tick(t0);
  e.watcher.tick(new Date(t0.getTime() + 60_000));
  e.watcher.tick(new Date(t0.getTime() + 120_000));
  check("park-defer: nothing enqueued while parked", e.enqueued.length === 0);
  check("park-defer: exactly ONE deferred event across the whole streak", events(e, "companion_alert_deferred").length === 1);
  check("park-defer: reason is rate-limited", events(e, "companion_alert_deferred")[0].detail.reason === "rate-limited");
  e.db.setRateLimitedUntil(e.sessId, null, null);
  e.watcher.tick(new Date(t0.getTime() + 180_000));
  check("park-defer: watermark was held — the SAME event fires once the park clears", e.enqueued.length === 1);
  cleanupEnv(e);
}

// --- 9. No-stacking: a 2nd qualifying event while one is still pending defers, watermark held ---
{
  const e = makeEnv();
  e.watcher.start(); e.watcher.stop();
  fire(e, "merge_rejected", e.mgrA);
  e.watcher.tick(new Date());
  check("no-stack: first tick pushes", e.enqueued.length === 1);
  fire(e, "merge_rejected", e.mgrA); // a 2nd qualifying event, but the first alert is still pending/unconsumed
  e.watcher.tick(new Date());
  check("no-stack: a 2nd alert is NOT stacked while one is pending", e.enqueued.length === 1);
  check("no-stack: the suppression is a deferred(pending) event", events(e, "companion_alert_deferred").some((ev) => ev.detail.reason === "pending"));
  // Consuming the pending turn lets the held 2nd event push on the next tick.
  e.clearPending();
  e.watcher.tick(new Date());
  check("no-stack: once consumed, the held event pushes", e.enqueued.length === 2);
  cleanupEnv(e);
}

// --- 10. Union-merge (Lead fork 4): alertClasses UNION across granted projects, distinct classes each ---
{
  const e = makeEnv({
    configA: { alertClasses: ["merge-gate"] },
    configB: { alertClasses: ["worker-blocked"] },
  });
  e.watcher.start(); e.watcher.stop();
  fire(e, "merge_rejected", e.mgrA);   // subscribed via project A's config
  fire(e, "worker_stuck", e.mgrB, { minutesBusy: 5 }); // subscribed via project B's config
  e.watcher.tick(new Date());
  check("union-merge: BOTH classes fire (union across granted projects, not session-level-only)", e.enqueued.length === 2);
  cleanupEnv(e);
}

// --- 11. Digest mode (Lead fork 5, re-scan buffer): 1st flush is immediate, later ones wait the MIN cadence ---
{
  const e = makeEnv({
    configA: { alertClasses: ["merge-gate"], digestMinutes: 30 },
    configB: { alertClasses: ["worker-blocked"], digestMinutes: 10 }, // MIN across granted projects ⇒ 10
  });
  e.watcher.start(); e.watcher.stop();
  const t0 = new Date();
  fire(e, "merge_rejected", e.mgrA);
  fire(e, "merge_request", e.mgrA);
  e.watcher.tick(t0); // first-ever flush is immediate (no prior lastDigestFlushAt to wait on)
  check("digest: first flush is immediate and bundles both events into ONE turn", e.enqueued.length === 1);
  check("digest: the digest turn is framed + bulleted", e.enqueued[0].text.startsWith(ALERT_TAG) && e.enqueued[0].text.includes("•"));
  check("digest: 2 companion_alert_pushed rows recorded (one per source, even though one turn was sent)", events(e, "companion_alert_pushed").length === 2);
  e.clearPending();

  // Within the MIN digestMinutes window (10) — accumulates, does not flush yet.
  fire(e, "worker_stuck", e.mgrB, { minutesBusy: 2 });
  e.watcher.tick(new Date(t0.getTime() + 5 * 60_000));
  check("digest: within the cadence window — accumulates, no flush", e.enqueued.length === 1);

  // A 2nd new event lands; still within the window from the FIRST flush.
  fire(e, "worker_stuck", e.mgrB, { minutesBusy: 3 });
  e.watcher.tick(new Date(t0.getTime() + 9 * 60_000));
  check("digest: still within the cadence window with 2 buffered — still no flush", e.enqueued.length === 1);

  // Past the MIN cadence (10 min) — flushes the accumulated buffer as ONE bundled turn.
  e.watcher.tick(new Date(t0.getTime() + 11 * 60_000));
  check("digest: past the cadence — flushes the buffered events as one turn", e.enqueued.length === 2);
  check("digest: total companion_alert_pushed rows now 4 (2 + 2)", events(e, "companion_alert_pushed").length === 4);
  cleanupEnv(e);
}

// --- 12. NO-STALL REGRESSION (immediate mode): ≥EVENT_TAIL_LIMIT leading non-qualifying events must NOT
//     permanently wedge the watermark — a build-review-caught bug where only DELIVERED rows advanced it,
//     so an all-non-qualifying 200-row scan window left `qualifying` empty and the watermark stuck forever,
//     silencing attention-push permanently once ≥200 unsubscribed events landed ahead of a real one. ---
{
  const e = makeEnv({ configA: { alertClasses: ["merge-gate"] } }); // worker/context signals NOT subscribed
  e.watcher.start(); e.watcher.stop();
  for (let i = 0; i < 250; i++) fire(e, "context_escalated", e.mgrA); // 250 > EVENT_TAIL_LIMIT (200), all dropped by classify()
  fire(e, "merge_rejected", e.mgrA); // the ONE subscribed event, landing AFTER the noise
  e.watcher.tick(new Date()); // tick 1: scans rows 1..200 — pure noise, nothing qualifies
  check("no-stall (immediate): a pure-noise first window pushes nothing", e.enqueued.length === 0);
  e.watcher.tick(new Date()); // tick 2: scans rows 201..251 — the watermark MUST have advanced past the noise
  check("no-stall (immediate): the watermark advanced past the noise — the subscribed alert now fires", e.enqueued.length === 1);
  check("no-stall (immediate): it's the right alert", e.enqueued[0]?.text.startsWith(ALERT_TAG) && e.enqueued[0]?.text.includes("merge rejected"));
  cleanupEnv(e);
}

// --- 13. NO-STALL REGRESSION (digest mode): the re-scan buffer must ALSO consume leading non-qualifying
//     rows past the tail limit, or a burst of unsubscribed noise ahead of a real signal would wedge the
//     digest buffer exactly like the immediate-mode case above. ---
{
  const e = makeEnv({ configA: { alertClasses: ["merge-gate"], digestMinutes: 10 } });
  e.watcher.start(); e.watcher.stop();
  for (let i = 0; i < 250; i++) fire(e, "context_escalated", e.mgrA); // leading noise past EVENT_TAIL_LIMIT
  fire(e, "merge_rejected", e.mgrA);
  e.watcher.tick(new Date()); // tick 1: pure-noise window — advances past it, nothing to buffer/flush yet
  check("no-stall (digest): a pure-noise first window flushes nothing", e.enqueued.length === 0);
  e.watcher.tick(new Date()); // tick 2: the qualifying row is now in range and flushes (first-ever ⇒ immediate)
  check("no-stall (digest): the watermark advanced past the noise — the buffered event now flushes", e.enqueued.length === 1);
  check("no-stall (digest): it's a bundled digest turn", e.enqueued[0]?.text.startsWith(ALERT_TAG) && e.enqueued[0]?.text.includes("•"));
  cleanupEnv(e);
}

// --- 14. HARD-DELETE-REUSE REGRESSION (the CR's blocking bug): sqlite REUSES a rowid once the row holding
//     the table's current max is hard-deleted (exactly what deleteProject/deleteSession cascades do). The
//     `seq` cursor (a separate, never-reused AUTOINCREMENT-backed column) must survive this — a real event
//     landing at a REUSED rowid must still be delivered, never silently dropped. Manipulates the SAME sqlite
//     file via a second raw better-sqlite3 connection (mirrors questions-legacy-boot.mjs's pattern) to force
//     the exact rowid-reuse sqlite performs on a real cascade delete. ---
{
  const e = makeEnv({ configA: { alertClasses: ["merge-gate"] } });
  e.watcher.start(); e.watcher.stop(); // baseline seed — this db has no events yet, watermark = 0

  fire(e, "merge_rejected", e.mgrA); // seq 1 / rowid 1 (fresh table, both start at 1 and stay in lockstep)
  fire(e, "merge_rejected", e.mgrA); // seq 2 / rowid 2
  fire(e, "merge_rejected", e.mgrA); // seq 3 / rowid 3 — the CURRENT max rowid AND max seq
  e.watcher.tick(new Date());
  check("hard-delete-reuse: all 3 pre-delete events deliver, watermark advances to seq 3", e.enqueued.length === 3);

  // Simulate a project/session cascade delete removing the row that happens to hold the table's max
  // rowid (deleteProject/deleteSession do exactly this — they don't know or care which row is the rowid
  // max; they just delete every event scoped to the deleted project/session).
  const raw = new Database(e.dbFile);
  raw.pragma("journal_mode = WAL");
  const maxRowidBefore = raw.prepare("SELECT MAX(rowid) AS m FROM orchestration_events").get().m;
  const deleted = raw.prepare("DELETE FROM orchestration_events WHERE rowid = ?").run(maxRowidBefore);
  check("hard-delete-reuse: setup — deleted exactly the row holding the max rowid", deleted.changes === 1);
  raw.close();

  // A genuinely NEW event lands after the delete — sqlite's rowid-selection algorithm REUSES a freed rowid
  // (it picks "one more than the largest ROWID CURRENTLY in the table", and the row that used to hold that
  // slot is gone now), but this event's `seq` comes from the separate, delete-immune
  // orchestration_event_seq counter, so it is still STRICTLY GREATER than the watermark (3), never
  // colliding with a value already handed out. Under the OLD (buggy) rowid-keyed cursor a reused rowid
  // could land at or below the watermark, so `listEventsSince` would NEVER return it — a silently,
  // permanently dropped alert. Clear the pending queue first — the no-stacking guard (a SEPARATE, correct
  // discipline) would otherwise defer this tick regardless of the seq fix, since the 3 turns delivered
  // above are still sitting unconsumed in the test's pty stub.
  e.clearPending();
  fire(e, "merge_rejected", e.mgrA);
  e.watcher.tick(new Date());
  check("hard-delete-reuse: the post-delete event STILL delivers despite landing at a REUSED rowid", e.enqueued.length === 4);
  cleanupEnv(e);
}

// --- 15. IMMEDIATE-MODE BURST CAP (CR fold-in [3]): a single tick with MORE than IMMEDIATE_BURST_CAP (10)
//     qualifying events coalesces into ONE turn instead of one companion turn PER event. ---
{
  const e = makeEnv({ configA: { alertClasses: ["merge-gate"] } });
  e.watcher.start(); e.watcher.stop();
  for (let i = 0; i < 11; i++) fire(e, "merge_rejected", e.mgrA); // 11 > IMMEDIATE_BURST_CAP (10)
  e.watcher.tick(new Date());
  check("burst-cap: >10 qualifying events in ONE tick coalesce into a SINGLE turn (not 11 separate turns)", e.enqueued.length === 1);
  check("burst-cap: the coalesced turn is bulleted (digest-shaped)", e.enqueued[0]?.text.startsWith(ALERT_TAG) && e.enqueued[0]?.text.includes("•") && e.enqueued[0]?.text.includes("11 alerts"));
  check("burst-cap: still ONE companion_alert_pushed row PER underlying source event", events(e, "companion_alert_pushed").length === 11);
  // A batch AT the cap (10, not over it) still delivers as separate per-event turns — the cap is "more than".
  const e2 = makeEnv({ configA: { alertClasses: ["merge-gate"] } });
  e2.watcher.start(); e2.watcher.stop();
  for (let i = 0; i < 10; i++) fire(e2, "merge_rejected", e2.mgrA);
  e2.watcher.tick(new Date());
  check("burst-cap: exactly 10 (at the cap, not over) still delivers as 10 separate turns", e2.enqueued.length === 10);
  cleanupEnv(e);
  cleanupEnv(e2);
}

// --- 16. ALERT-LINE LENGTH BOUND (CR fold-in [5]): an unbounded source field (question_ask's `title`) can
//     never produce a pathologically long chat line. ---
{
  const e = makeEnv({ configA: { alertClasses: ["decision-pending"] } });
  e.watcher.start(); e.watcher.stop();
  const hugeTitle = "x".repeat(5000);
  e.db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: e.mgrA, kind: "question_asked", detail: { questionId: "q1", title: hugeTitle } });
  e.watcher.tick(new Date());
  check("line-bound: a 5000-char title still produces ONE bounded turn", e.enqueued.length === 1);
  check("line-bound: the rendered line is capped well under the raw title length", e.enqueued[0].text.length < 300);
  cleanupEnv(e);
}

// --- 17. classify()/alertLine() sanity — the exported helpers used by the tick loop above ---
{
  check("classify: worker_report(blocked) → worker-blocked", classify("worker_report", { status: "blocked" }) === "worker-blocked");
  check("classify: worker_report(other status) → null (not subscribed)", classify("worker_report", { status: "done" }) === null);
  check("classify: idle_report(waiting) → null (not a manager-idle alert)", classify("idle_report", { state: "waiting" }) === null);
  check("classify: idle_report(done) → manager-idle", classify("idle_report", { state: "done" }) === "manager-idle");
  check("classify: platform_escalate → escalation", classify("platform_escalate", { title: "x" }) === "escalation");
  check("classify: an unrelated kind → null", classify("spawn_worker", {}) === null);
  const line = alertLine({ id: "x", ts: new Date().toISOString(), managerSessionId: "mgr-12345678", kind: "context_escalated", detail: {} }, "context-overflow", "Proj Z");
  check("alertLine: terse, names the project + an m: id slice", line.includes("Proj Z") && line.includes("m:mgr-1234"));
  cleanupEnv({ db: { close() {} }, dbFile: "" }); // no-op cleanup (nothing to remove) — keeps the block shape uniform
}

// --- 18. FIX: platform_escalate carries a READABLE payload (title/summary), not an opaque line ---
{
  const detail = { originProjectId: "pOrd", severity: "high", platformProjectId: "pHome", title: "worker_merge gate hangs on a slow build" };
  const line = alertLine({ id: "x", ts: new Date().toISOString(), managerSessionId: "mgr-abcdef01", kind: "platform_escalate", detail }, "escalation", "Proj A");
  check("platform_escalate alert line: non-empty", line.length > 0);
  check("platform_escalate alert line: carries the escalation's title (not just 'escalated to platform')", line.includes("worker_merge gate hangs on a slow build"));
  check("platform_escalate alert line: still names the project + a manager id slice", line.includes("Proj A") && line.includes("m:mgr-abcd"));
  // A missing/malformed title degrades to a labeled placeholder rather than throwing or going blank.
  const lineNoTitle = alertLine({ id: "x", ts: new Date().toISOString(), managerSessionId: "mgr-abcdef01", kind: "platform_escalate", detail: {} }, "escalation", "Proj A");
  check("platform_escalate alert line: a missing title degrades to 'untitled', never blank", lineNoTitle.includes("untitled") && lineNoTitle.length > 0);
  // Companion re-delivery card: the FULL taskId (not an 8-char slice) so a board-reach-granted companion
  // can board_get the exact card for the full body — symptom (c), title-only leaks.
  const lineWithTask = alertLine({ id: "x", ts: new Date().toISOString(), managerSessionId: "mgr-abcdef01", taskId: "task-full-uuid-1234", kind: "platform_escalate", detail }, "escalation", "Proj A");
  check("platform_escalate alert line: carries the FULL taskId for board_get, not a truncated slice", lineWithTask.includes("task:task-full-uuid-1234"));
  const lineNoTask = alertLine({ id: "x", ts: new Date().toISOString(), managerSessionId: "mgr-abcdef01", kind: "platform_escalate", detail }, "escalation", "Proj A");
  check("platform_escalate alert line: a missing taskId omits the ref rather than throwing", !lineNoTask.includes("task:") && lineNoTask.length > 0);
}

// --- 19. END-TO-END: a real platform_escalate event ticks through the watcher and pushes a turn whose
//     body carries the escalation's title (not just an opaque "escalated to platform" line). ---
{
  const e = makeEnv({ configA: { alertClasses: ["escalation"] } });
  e.watcher.start(); e.watcher.stop();
  fire(e, "platform_escalate", e.mgrA, { originProjectId: e.projA, severity: "high", platformProjectId: "pHome", title: "worker_merge gate hangs on a slow build" }, { taskId: "task-xyz" });
  e.watcher.tick(new Date());
  check("platform_escalate e2e: enqueues ONE turn", e.enqueued.length === 1);
  check("platform_escalate e2e: framed [loom:alert]", e.enqueued[0].text.startsWith(ALERT_TAG));
  check("platform_escalate e2e: the pushed turn carries the escalation's title", e.enqueued[0].text.includes("worker_merge gate hangs on a slow build"));
  check("platform_escalate e2e: the pushed turn carries the taskId for board_get", e.enqueued[0].text.includes("task:task-xyz"));
  cleanupEnv(e);
}

// --- 20. ESCALATION RE-DELIVERY SUPPRESSION (companion re-delivery card, defense-in-depth): a SECOND
//     platform_escalate event for the SAME taskId with an UNCHANGED title+severity is suppressed (never
//     pushed again to this recipient) — but a genuinely changed one (different title/severity) for the
//     SAME taskId still pushes, and it's per-recipient (survives a restart via the durable log). ---
{
  const e = makeEnv({ configA: { alertClasses: ["escalation"] } });
  e.watcher.start(); e.watcher.stop();
  const detail = { originProjectId: e.projA, severity: "high", platformProjectId: "pHome", title: "same issue, still open" };
  fire(e, "platform_escalate", e.mgrA, detail, { taskId: "task-dup-1" });
  e.watcher.tick(new Date());
  check("escalation-dedup: first occurrence pushes", e.enqueued.length === 1);
  e.clearPending();

  // A second, genuinely distinct orchestration_event for the SAME taskId with the SAME title+severity
  // (simulates whatever future/edge path might re-fire for an already-open escalation) — must be suppressed.
  fire(e, "platform_escalate", e.mgrA, detail, { taskId: "task-dup-1" });
  e.watcher.tick(new Date());
  check("escalation-dedup: an unchanged repeat for the SAME taskId is suppressed, not re-pushed", e.enqueued.length === 1);
  check("escalation-dedup: no companion_alert_pushed row for the suppressed repeat", events(e, "companion_alert_pushed").length === 1);

  // A genuinely CHANGED escalation for the SAME taskId (different severity) is NOT suppressed.
  fire(e, "platform_escalate", e.mgrA, { ...detail, severity: "critical" }, { taskId: "task-dup-1" });
  e.watcher.tick(new Date());
  check("escalation-dedup: a genuinely changed escalation (severity bump) for the same taskId still pushes", e.enqueued.length === 2);
  e.clearPending();

  // Restart-safety: a FRESH watcher instance (re-seeded from the durable log) still suppresses the
  // now-unchanged (critical severity) repeat — the per-recipient map survives a restart via
  // companion_alert_pushed's escalationTaskId/escalationSignature, mirroring the watermark's own reseed.
  const fresh = e.freshWatcher();
  fresh.start(); fresh.stop();
  fire(e, "platform_escalate", e.mgrA, { ...detail, severity: "critical" }, { taskId: "task-dup-1" });
  fresh.tick(new Date());
  check("escalation-dedup: a fresh (restarted) watcher still suppresses an unchanged repeat via the durable log", e.enqueued.length === 2);

  // A DIFFERENT taskId with the exact same title/severity is its OWN escalation — never suppressed by
  // another task's signature (the map is keyed by taskId, not by title/severity alone).
  fire(e, "platform_escalate", e.mgrA, { ...detail, severity: "critical" }, { taskId: "task-dup-2" });
  fresh.tick(new Date());
  check("escalation-dedup: a different taskId with the same content is NOT suppressed", e.enqueued.length === 3);
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — AttentionPushWatcher stays DEFAULT-OFF with no grant, never replays backlog, pushes exactly the granted-project/subscribed-class events once each, survives a restart without re-pushing, respects rate-limit park + no-stacking (watermark held, one deferred event per streak), union-merges alertClasses/digestMinutes across granted projects, bundles a digest under its MIN cadence, and renders a platform_escalate alert with a readable title instead of an opaque line."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
