import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b03e636c: `armKickoffConfirmRecheck`'s one-shot escalation timer (8882e2ca) is in-memory only and
// is lost across a daemon restart. A TASKED worker still gets caught eventually by `tickIdleWorkers`'
// own periodic cadence (unaffected by the lost timer), but a TASKLESS worker has NO periodic fallback at
// all — a kickoff that reached terminal PARK (give-up ladder exhausted) just before an unrelated restart
// can be stranded forever with zero manager signal. This drives the REAL
// `SessionService.escalateParkedKickoffAtBoot`/`resumeFleetOnBoot`/`handleKickoffGiveUpExhausted`/
// `armKickoffConfirmRecheck` against a real Db + a configurable PtyStub.
//
// (1) POSITIVE: a taskless worker with a durable, unresolved `origin:"kickoff"` parked chain and
//     turnSeq:0 gets re-armed at boot — the escalation notice reaches its manager, and a durable
//     `kickoff_confirm_escalated` record is appended.
// (2) NEGATIVE CONTROLS, each proving a DIFFERENT reason the re-arm must NOT fire:
//     (2a) tasked worker (tickIdleWorkers already covers it — never double-escalate);
//     (2b) a parked chain with NO `origin:"kickoff"` marker (a pre-upgrade event, or a generic
//          message's own park) — the documented "pre-upgrade events get no re-arm" behavior;
//     (2c) turnSeq already >0 (resolved via some other route);
//     (2d) a later `confirmed-after-park` event for the same rootMsgId (already resolved);
//     (2e) an existing `kickoff_confirm_escalated` record for the same rootMsgId (already escalated).
// (3) THE TRAP (manager's own framing): end-to-end through `resumeFleetOnBoot` itself, proving the
//     escalation fires INSTEAD OF (never alongside) the normal continuation nudge — the worker's own
//     queue gets NOTHING (so Loom's own dispatch can never be what starts its first turn and hides the
//     dead kickoff), while its manager's queue gets exactly the escalation.
// (4) NO-DOUBLE-NOTICE ACROSS TWO SIMULATED BOOTS: `resumeFleetOnBoot` called twice for the same
//     still-parked session — the second boot must not re-send the notice or append a second marker.
// (5) TIMER-PATH PARITY: the ORIGINAL in-memory one-shot timer (armKickoffConfirmRecheck, via
//     `mock.timers`) also appends `kickoff_confirm_escalated` (source:"timer") when it fires — and a
//     SUBSEQUENT boot for that same session recognizes it as already-escalated and skips, proving the
//     dedup works ACROSS the two mechanisms, not just within one of them.
// (6) Code Review ad92070b, BLOCKING fix 1: `handleKickoffGiveUpExhausted`'s IMMEDIATE-park branch
//     (window already elapsed at park time — the COMMONEST park shape for an ordinary-sized kickoff)
//     now records `kickoff_confirm_escalated(source:"immediate")` itself. A later boot must see that marker
//     and do NOTHING (no second notice) — crucially, with the nudge NOT suppressed, since
//     `escalateParkedKickoffAtBoot` correctly declines (already escalated) and falls through to the
//     worker's normal continuation nudge.
// (7) Code Review ad92070b, BLOCKING fix 2: discriminators protect a HEALTHY worker from being wrongly
//     escalated+silenced at boot (turnSeq only counts COMPLETED turns, so a kickoff that DID land reads
//     turnSeq:0 for its entire first turn) — each proven as its own case, with the real nudge running
//     and no escalation: (7a) a non-empty on-disk engine transcript; (7b) any `worker_report` ever
//     recorded; (7c) queued pending direction in the restart intent.
// (8) Code Review 397ff972: two MORE independent busy signals, same shape as (7) — (8a) the PERSISTED
//     `w.busy`; (8b) the CAPTURED `e.busy` (RestartResumeEntry.busy, restart.ts:79) with the session row
//     itself busy:false, the EXACT shape 397ff972 reproduced against real dist (resume entry busy:true →
//     worker queue empty, one broken notice — without this check).
// (9) Code Review 397ff972: a parked chain whose own notice was already SUPPRESSED as moot by the live
//     path (`detail.noticeSuppressed:true`, e.g. superseded by a newer directive) must never be
//     resurrected at boot — the live path already decided it shouldn't go out.
//
// Run: 1) build daemon (pnpm build), 2) node test/kickoff-confirm-boot-rearm.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
// Card 062fa934, Code Review CRITICAL — every resumeFleetOnBoot call below must inject this explicitly
// (deploy-staleness-fixture-guard.mjs enforces it); see that fixture's own doc for why.
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// resumeFleetOnBoot's OWN continuation nudges (e.g. the requester's "code is live" re-prompt) are
// deferred behind PtyHost.waitForMcpSeen — a real async hop. A macrotask flush after each
// resumeFleetOnBoot call (mirroring restart-fleet.mjs's own identical need) guarantees those settle
// before `db.close()` runs, or they fire later against an already-closed connection.
const flush = () => new Promise((r) => setTimeout(r, 0));

const tmpHome = path.join(os.tmpdir(), `loom-kcbr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { withinKickoffConfirmWindow } = await import("../dist/pty/host.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const db = new Db();
const proj = `kcbr-proj-${sfx}`, agent = `kcbr-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });

// Same minimal, claude-free PtyStub shape as restart-fleet.mjs: a resumed pty is never ready this early,
// so every enqueueStdin QUEUES — exactly what both `resumeFleetOnBoot` and `enqueueSystemNudge` rely on.
class PtyStub {
  constructor() { this.q = new Map(); this.firstTurnStarted = new Set(); }
  isAlive() { return false; }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  isComposerDirty() { return false; }
  waitForMcpSeen() { return Promise.resolve(true); }
  hasFirstTurnStarted(id) { return this.firstTurnStarted.has(id); }
  getPendingEntries() { return []; }
  setFirstTurnStarted(id, on = true) { if (on) this.firstTurnStarted.add(id); else this.firstTurnStarted.delete(id); }
}

const mkProject2 = () => { /* reuse the one project above for every case */ };
let n = 0;
const mkSession = (o) => {
  n++;
  const id = o.id ?? `kcbr-s${n}-${sfx}`;
  db.insertSession({
    id, projectId: proj, agentId: agent, engineSessionId: o.engineSessionId ?? null, title: null, cwd: os.tmpdir(),
    processState: "live", resumability: "unknown", busy: o.busy ?? false, createdAt: now, lastActivity: now,
    lastError: null, role: o.role ?? "worker", parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
    worktreePath: null, branch: null,
  });
  return id;
};

/** Appends the durable `session_message_gave_up(outcome:"parked")` chain this card's re-arm reads,
 *  mirroring `handleKickoffGiveUpExhausted`'s own shape. `origin` defaults to "kickoff" (the post-card
 *  shape) — pass `null` to simulate a PRE-UPGRADE event (no marker at all) or a generic message's own
 *  park (same shape, no marker either). */
const appendParkedChain = (db, mgr, wkr, taskId, rootMsgId, { origin = "kickoff" } = {}) => {
  db.appendEvent({
    id: `evt-parked-${rootMsgId}`, ts: now, managerSessionId: mgr, workerSessionId: wkr, taskId: taskId ?? null,
    kind: "session_message_gave_up",
    detail: { msgId: rootMsgId, rootMsgId, chainDepth: 1, outcome: "parked", ...(origin ? { origin } : {}) },
  });
};

try {
  // ============================ (1) POSITIVE: taskless, marked, turnSeq:0 ============================
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    const root = `root-pos-${sfx}`;
    appendParkedChain(db, mgr, wkr, null, root);
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
    check("(1) POSITIVE: a taskless, marked, unresolved parked kickoff IS re-armed at boot", fired === true);
    const mgrq = pty.getPending(mgr);
    check("(1) the escalation notice reaches the manager", mgrq.some((t) => t.startsWith("[loom:worker-spawn-broken]")));
    const escalated = db.listEventsForWorker(wkr).filter((e) => e.kind === "kickoff_confirm_escalated" && e.detail?.rootMsgId === root);
    check("(1) a durable kickoff_confirm_escalated(source:\"boot\") record was appended", escalated.length === 1 && escalated[0].detail?.source === "boot");
  }

  // ============================ (2a) NEGATIVE: tasked worker — never double-escalate ============================
  {
    const mgr = mkSession({ role: "manager" });
    const task = `kcbr-task-${sfx}`;
    db.insertTask({ id: task, projectId: proj, title: "T", body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: task });
    appendParkedChain(db, mgr, wkr, task, `root-tasked-${sfx}`);
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
    check("(2a) NEGATIVE CONTROL: a TASKED worker is never re-armed here — tickIdleWorkers already covers it", fired === false);
    check("(2a) no notice sent", pty.getPending(mgr).length === 0);
  }

  // ============================ (2b) NEGATIVE: no origin marker (pre-upgrade shape) ============================
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    appendParkedChain(db, mgr, wkr, null, `root-noorigin-${sfx}`, { origin: null });
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
    check("(2b) NEGATIVE CONTROL: a parked chain with NO origin:\"kickoff\" marker is never re-armed (pre-upgrade behavior, unchanged)", fired === false);
    check("(2b) no notice sent", pty.getPending(mgr).length === 0);
  }

  // ============================ (2c) NEGATIVE: turnSeq already >0 ============================
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    appendParkedChain(db, mgr, wkr, null, `root-turnseq-${sfx}`);
    db.incrementTurnSeq(wkr);
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const row = db.getSession(wkr);
    check("(2c) setup: turnSeq is now >0", (row?.turnSeq ?? 0) > 0);

    const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
    check("(2c) NEGATIVE CONTROL: turnSeq already >0 (resolved via some other route) is never re-armed", fired === false);
    check("(2c) no notice sent", pty.getPending(mgr).length === 0);
  }

  // ============================ (2d) NEGATIVE: confirmed-after-park already resolved it ============================
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    const root = `root-confafter-${sfx}`;
    appendParkedChain(db, mgr, wkr, null, root);
    db.appendEvent({
      id: `evt-confafter-${sfx}`, ts: now, managerSessionId: mgr, workerSessionId: wkr, taskId: null,
      kind: "session_message_gave_up", detail: { msgId: root, rootMsgId: root, outcome: "confirmed-after-park", latencyMs: 45_000 },
    });
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
    check("(2d) NEGATIVE CONTROL: a later confirmed-after-park for the same root is never re-armed", fired === false);
    check("(2d) no notice sent", pty.getPending(mgr).length === 0);
  }

  // ============================ (2e) NEGATIVE: already escalated — no second notice ============================
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    const root = `root-already-${sfx}`;
    appendParkedChain(db, mgr, wkr, null, root);
    db.appendEvent({
      id: `evt-already-${sfx}`, ts: now, managerSessionId: mgr, workerSessionId: wkr, taskId: null,
      kind: "kickoff_confirm_escalated", detail: { rootMsgId: root, source: "timer" },
    });
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
    check("(2e) NEGATIVE CONTROL: an already-escalated root (here, by the ORIGINAL timer) is never re-escalated", fired === false);
    check("(2e) no second notice sent", pty.getPending(mgr).length === 0);
  }

  // ============================ (3) THE TRAP — end-to-end via resumeFleetOnBoot ============================
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    const root = `root-trap-${sfx}`;
    appendParkedChain(db, mgr, wkr, null, root);
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const resumeSet = [
      { sessionId: mgr, role: "manager", parentSessionId: null },
      { sessionId: wkr, role: "worker", parentSessionId: mgr },
    ];
    // `pending: {}` — no queued direction for this worker, so discriminator (7c) (hasQueuedPending)
    // does NOT block the escalation here. See case (7c) below for the case where it DOES.
    const intent = { reason: "deploy merged daemon code", managerSessionId: mgr, resume: resumeSet, pending: {}, requestedAt: now };
    const resumeOne = () => true;
    sessions.resumeFleetOnBoot(intent, { resumeOne, deployStaleness: CLEAN_STALENESS });
    await flush();

    const wkrq = pty.getPending(wkr);
    // Code Review ad92070b: this holds BY DESIGN (discriminator 7c reads the intent's own `pending`
    // snapshot and finds nothing queued for this worker) — not merely because the fixture happens to
    // leave `pending` empty. Case (7c) below is the same fixture shape WITH queued pending, proving the
    // discriminator — not an accident of this fixture — is what decides it either way.
    check("(3) THE TRAP: the worker's OWN queue gets NOTHING — the normal continuation nudge never ran, so Loom's own dispatch can never start a turn that would hide the dead kickoff", wkrq.length === 0);
    const mgrq = pty.getPending(mgr);
    const escalationCount = mgrq.filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length;
    check("(3) the manager's queue gets exactly the escalation", escalationCount === 1);
    // Code Review 397ff972: dropped the old "(3) and NEVER the generic worker-continuation text"
    // check here — it filtered the MANAGER's own queue for "Continue your assigned task", text that
    // never routes to the manager at all (only to the worker), so it could never fail. The real
    // assertion that the normal nudge never ran is the worker-queue-empty check above.
  }

  // ============================ (4) NO-DOUBLE-NOTICE ACROSS TWO SIMULATED BOOTS ============================
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    const root = `root-twoboots-${sfx}`;
    appendParkedChain(db, mgr, wkr, null, root);
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const resumeSet = [
      { sessionId: mgr, role: "manager", parentSessionId: null },
      { sessionId: wkr, role: "worker", parentSessionId: mgr },
    ];
    const resumeOne = () => true;

    // Boot #1.
    sessions.resumeFleetOnBoot({ reason: "boot 1", managerSessionId: mgr, resume: resumeSet, pending: {}, requestedAt: now }, { resumeOne, deployStaleness: CLEAN_STALENESS });
    await flush();
    const afterBoot1 = pty.getPending(mgr).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length;
    check("(4) boot #1 escalates exactly once", afterBoot1 === 1);

    // Boot #2 — the SAME session, still parked, nothing resolved in between (simulates another restart
    // before anyone acted on it).
    sessions.resumeFleetOnBoot({ reason: "boot 2", managerSessionId: mgr, resume: resumeSet, pending: {}, requestedAt: now }, { resumeOne, deployStaleness: CLEAN_STALENESS });
    await flush();
    const afterBoot2 = pty.getPending(mgr).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length;
    check("(4) NO-DOUBLE-NOTICE: boot #2 does NOT re-send the same notice", afterBoot2 === 1);
    const escalatedEvents = db.listEventsForWorker(wkr).filter((e) => e.kind === "kickoff_confirm_escalated" && e.detail?.rootMsgId === root);
    check("(4) exactly one durable kickoff_confirm_escalated record exists across both boots", escalatedEvents.length === 1);
  }

  // ============================ (5) TIMER-PATH PARITY ============================
  // Same `db`/LOOM_HOME as every section above — `paths.ts`'s LOOM_HOME is a module-level const read
  // ONCE at first import, so a second `process.env.LOOM_HOME` reassignment this late would be silently
  // ignored and a fresh `new Db()` would still resolve to THIS process's one real DB_PATH; a separate Db
  // instance here would just reopen the same file, not isolate anything.
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, engineSessionId: `eng-timer-${sfx}` });

    class TimerPtyStub {
      constructor(liveMgr) {
        this.sent = []; this.live = new Set([liveMgr]);
        this.liveStartedAtMap = new Map(); this.composerDirtyLenMap = new Map(); this.firstTurnStarted = new Set();
      }
      setLiveStartedAt(id, ms) { this.liveStartedAtMap.set(id, ms); }
      liveStartedAt(id) { return this.liveStartedAtMap.has(id) ? this.liveStartedAtMap.get(id) : null; }
      setComposerDirtyLen(id, n) { this.composerDirtyLenMap.set(id, n); }
      getComposerDirtyLen(id) { return this.composerDirtyLenMap.has(id) ? this.composerDirtyLenMap.get(id) : undefined; }
      hasFirstTurnStarted(id) { return this.firstTurnStarted.has(id); }
      getPendingEntries() { return []; }
      enqueueStdin(id, text, _source, _onDeliver, _route, _kind, _q, _o, _p, _senderId, tail) {
        const isTailObject = typeof tail === "object" && tail !== null;
        this.sent.push({ id, text, onGiveUpExhausted: isTailObject ? tail.onGiveUpExhausted : undefined });
        if (!this.live.has(id)) return { delivered: false, reason: "session-dead", queued: false };
        return { delivered: true };
      }
    }

    const LARGE_KICKOFF = "x".repeat(69_000);
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      const pty = new TimerPtyStub(mgr);
      pty.setLiveStartedAt(wkr, Date.now() - 97_000);
      pty.setComposerDirtyLen(wkr, LARGE_KICKOFF.length);
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const root = `root-timer-${sfx}`;

      const pending = withinKickoffConfirmWindow(pty, wkr, 0);
      sessions.handleKickoffGiveUpExhausted(wkr, `msg-timer-${sfx}`, root, LARGE_KICKOFF, 1);
      mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

      const afterTick = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
      check("(5) the ORIGINAL in-memory timer still fires the terminal notice (unchanged behavior)", afterTick.some((t) => t.startsWith("[loom:worker-spawn-broken]")));
      const escalated = db.listEventsForWorker(wkr).filter((e) => e.kind === "kickoff_confirm_escalated" && e.detail?.rootMsgId === root);
      check("(5) TIMER-PATH PARITY: the timer's own fire ALSO appends kickoff_confirm_escalated(source:\"timer\")", escalated.length === 1 && escalated[0].detail?.source === "timer");

      // A later boot for this same (still-parked) session must recognize it as already-escalated — the
      // dedup works ACROSS mechanisms (timer fired it; boot must not re-fire it).
      const firedAtBoot = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
      check("(5) a SUBSEQUENT boot-reconcile pass does NOT re-escalate a root the TIMER already fired for", firedAtBoot === false);
    } finally {
      mock.timers.reset();
    }
  }

  // ============================ (6) PARK-IMMEDIATE MARKER (Code Review ad92070b, BLOCKING fix 1) ========
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    const root = `root-parkimm-${sfx}`;
    const pty = new PtyStub(); // no liveStartedAt/getComposerDirtyLen → withinKickoffConfirmWindow
    const sessions = new SessionService(db, pty, new OrchestrationControl()); // always reads "unmeasurable" (null) — the IMMEDIATE-park shape (window already elapsed by park time), the COMMONEST case for an ordinary-sized kickoff.
    sessions.handleKickoffGiveUpExhausted(wkr, `msg-parkimm-${sfx}`, root, "short kickoff text", 1);
    const afterPark = pty.getPending(mgr);
    check("(6) setup: the immediate-park branch sends the terminal notice right away",
      afterPark.filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length === 1);
    const parkMarker = db.listEventsForWorker(wkr).filter((e) => e.kind === "kickoff_confirm_escalated" && e.detail?.rootMsgId === root);
    check("(6) THE FIX: the immediate-park branch now records kickoff_confirm_escalated(source:\"immediate\") itself",
      parkMarker.length === 1 && parkMarker[0].detail?.source === "immediate");

    // A later boot for this still-parked session: must NOT re-send the notice, and — because the
    // escalation correctly declines (already escalated) — the worker's NORMAL continuation nudge must
    // run (NOT suppressed). This is the exact double-notice-and-silenced-nudge bug the CR reproduced.
    const resumeSet = [
      { sessionId: mgr, role: "manager", parentSessionId: null },
      { sessionId: wkr, role: "worker", parentSessionId: mgr },
    ];
    const intent = { reason: "boot after park-immediate", managerSessionId: mgr, resume: resumeSet, pending: {}, requestedAt: now };
    sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    await flush();
    const afterBoot = pty.getPending(mgr).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length;
    check("(6) NO-DOUBLE-NOTICE: the later boot does not re-send the terminal notice", afterBoot === 1);
    const wkrq = pty.getPending(wkr);
    check("(6) the worker's continuation nudge is NOT suppressed this time (escalation correctly declined — already escalated)",
      wkrq.some((t) => t.includes("Continue your assigned task")));
  }

  // ============================ (7) HEALTHY-WORKER DISCRIMINATORS (Code Review ad92070b, BLOCKING fix 2) =
  // turnSeq only counts COMPLETED turns — a kickoff that DID land, whose confirming hook simply never
  // arrived, also reads turnSeq:0 for the whole duration of its (possibly long) first turn. Each case
  // below holds EVERYTHING ELSE constant (taskless, turnSeq:0, an unresolved origin:"kickoff" parked
  // chain) and flips exactly ONE discriminator, proving it alone is what stands the escalation down —
  // with the real continuation nudge running instead.
  {
    // Each discriminator gets TWO INDEPENDENT workers (separate rootMsgId, separate rows) — one for the
    // direct unit-level `escalateParkedKickoffAtBoot` call, one FRESH for the end-to-end
    // `resumeFleetOnBoot` call. Sharing one worker across both would let the first call's own side
    // effect (the `kickoff_confirm_escalated` marker it writes on success) mask a bug in the second —
    // the SAME marker that "already escalated" (2e) checks for would make the second call correctly
    // decline for the WRONG reason, hiding a discriminator that was never actually consulted.

    // (7a) non-empty on-disk engine transcript.
    {
      const mgr = mkSession({ role: "manager" });
      const eng = `eng-7a-unit-${sfx}`;
      const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null, engineSessionId: eng });
      appendParkedChain(db, mgr, wkr, null, `root-7a-unit-${sfx}`);
      const tFile = engineTranscriptPath(os.tmpdir(), eng);
      fs.mkdirSync(path.dirname(tFile), { recursive: true });
      fs.writeFileSync(tFile, JSON.stringify({ type: "user", message: { content: "a real turn actually ran" } }) + "\n");
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
      check("(7a) NEGATIVE CONTROL (unit-level): a non-empty on-disk engine transcript stands the escalation down — the kickoff actually landed", fired === false);
    }
    {
      const mgr2 = mkSession({ role: "manager" });
      const eng2 = `eng-7a-e2e-${sfx}`;
      const wkr2 = mkSession({ role: "worker", parentSessionId: mgr2, taskId: null, engineSessionId: eng2 });
      appendParkedChain(db, mgr2, wkr2, null, `root-7a-e2e-${sfx}`);
      const tFile2 = engineTranscriptPath(os.tmpdir(), eng2);
      fs.mkdirSync(path.dirname(tFile2), { recursive: true });
      fs.writeFileSync(tFile2, JSON.stringify({ type: "user", message: { content: "a real turn actually ran" } }) + "\n");
      const pty2 = new PtyStub();
      const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
      const resumeSet2 = [{ sessionId: mgr2, role: "manager", parentSessionId: null }, { sessionId: wkr2, role: "worker", parentSessionId: mgr2 }];
      sessions2.resumeFleetOnBoot({ reason: "boot", managerSessionId: mgr2, resume: resumeSet2, pending: {}, requestedAt: now }, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
      await flush();
      check("(7a) end-to-end: the real continuation nudge runs instead (never suppressed)", pty2.getPending(wkr2).some((t) => t.includes("Continue your assigned task")));
      check("(7a) end-to-end: no escalation notice is sent to the manager", pty2.getPending(mgr2).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length === 0);
    }

    // (7b) any worker_report ever recorded.
    {
      const mgr = mkSession({ role: "manager" });
      const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
      appendParkedChain(db, mgr, wkr, null, `root-7b-unit-${sfx}`);
      db.appendEvent({ id: `evt-7b-unit-${sfx}`, ts: now, managerSessionId: mgr, workerSessionId: wkr, taskId: null, kind: "worker_report", detail: { status: "progress", summary: "still going" } });
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
      check("(7b) NEGATIVE CONTROL (unit-level): any worker_report ever recorded stands the escalation down — the worker has engaged at least once", fired === false);
    }
    {
      const mgr2 = mkSession({ role: "manager" });
      const wkr2 = mkSession({ role: "worker", parentSessionId: mgr2, taskId: null });
      appendParkedChain(db, mgr2, wkr2, null, `root-7b-e2e-${sfx}`);
      db.appendEvent({ id: `evt-7b-e2e-${sfx}`, ts: now, managerSessionId: mgr2, workerSessionId: wkr2, taskId: null, kind: "worker_report", detail: { status: "progress", summary: "still going" } });
      const pty2 = new PtyStub();
      const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
      const resumeSet2 = [{ sessionId: mgr2, role: "manager", parentSessionId: null }, { sessionId: wkr2, role: "worker", parentSessionId: mgr2 }];
      sessions2.resumeFleetOnBoot({ reason: "boot", managerSessionId: mgr2, resume: resumeSet2, pending: {}, requestedAt: now }, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
      await flush();
      check("(7b) end-to-end: the real continuation nudge runs instead (never suppressed)", pty2.getPending(wkr2).some((t) => t.includes("Continue your assigned task")));
      check("(7b) end-to-end: no escalation notice is sent to the manager", pty2.getPending(mgr2).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length === 0);
    }

    // (7c) queued pending direction in the restart intent.
    {
      const mgr = mkSession({ role: "manager" });
      const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
      appendParkedChain(db, mgr, wkr, null, `root-7c-unit-${sfx}`);
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, true, false); // hasQueuedPending=true, unit-level
      check("(7c) NEGATIVE CONTROL (unit-level): queued pending direction stands the escalation down", fired === false);
    }
    {
      const mgr2 = mkSession({ role: "manager" });
      const wkr2 = mkSession({ role: "worker", parentSessionId: mgr2, taskId: null });
      appendParkedChain(db, mgr2, wkr2, null, `root-7c-e2e-${sfx}`);
      const pty2 = new PtyStub();
      const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
      const resumeSet2 = [{ sessionId: mgr2, role: "manager", parentSessionId: null }, { sessionId: wkr2, role: "worker", parentSessionId: mgr2 }];
      const pendingSnap2 = { [wkr2]: ["queued manager direction, about to drain"] };
      sessions2.resumeFleetOnBoot({ reason: "boot", managerSessionId: mgr2, resume: resumeSet2, pending: pendingSnap2, requestedAt: now }, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
      await flush();
      const wkrq2 = pty2.getPending(wkr2);
      check("(7c) end-to-end: the queued direction is replayed, THEN the real continuation nudge runs (never suppressed)",
        wkrq2[0] === pendingSnap2[wkr2][0] && wkrq2.some((t) => t.includes("Continue your assigned task")));
      check("(7c) end-to-end: no escalation notice is sent to the manager", pty2.getPending(mgr2).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length === 0);
    }
  }

  // ============================ (8) BUSY-AT-CAPTURE DISCRIMINATORS (Code Review 397ff972) =============
  // Reproduced by 397ff972 against real dist: a resume entry with `busy:true` still got wrongly
  // escalated (worker queue empty, one broken-spawn notice) without this check. TWO independent busy
  // signals, each proven on its own, independent worker.
  {
    // (8a) the PERSISTED `w.busy` (the session row's own busy flag, as read fresh at boot).
    {
      const mgr = mkSession({ role: "manager" });
      const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null, busy: true });
      appendParkedChain(db, mgr, wkr, null, `root-8a-unit-${sfx}`);
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
      check("(8a) NEGATIVE CONTROL (unit-level): the PERSISTED w.busy stands the escalation down", fired === false);
    }
    {
      const mgr2 = mkSession({ role: "manager" });
      const wkr2 = mkSession({ role: "worker", parentSessionId: mgr2, taskId: null, busy: true });
      appendParkedChain(db, mgr2, wkr2, null, `root-8a-e2e-${sfx}`);
      const pty2 = new PtyStub();
      const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
      const resumeSet2 = [{ sessionId: mgr2, role: "manager", parentSessionId: null }, { sessionId: wkr2, role: "worker", parentSessionId: mgr2 }];
      sessions2.resumeFleetOnBoot({ reason: "boot", managerSessionId: mgr2, resume: resumeSet2, pending: {}, requestedAt: now }, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
      await flush();
      check("(8a) end-to-end: the real continuation nudge runs instead (never suppressed)", pty2.getPending(wkr2).some((t) => t.includes("Continue your assigned task")));
      check("(8a) end-to-end: no escalation notice is sent to the manager", pty2.getPending(mgr2).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length === 0);
    }

    // (8b) the CAPTURED `e.busy` (RestartResumeEntry's own flag, restart.ts:79) — session row itself is
    // busy:false, proving this signal matters INDEPENDENTLY of the persisted one. This is the EXACT
    // shape 397ff972 reproduced: a resume entry with busy:true, worker queue empty, one broken notice.
    {
      const mgr2 = mkSession({ role: "manager" });
      const wkr2 = mkSession({ role: "worker", parentSessionId: mgr2, taskId: null }); // busy:false (default)
      appendParkedChain(db, mgr2, wkr2, null, `root-8b-e2e-${sfx}`);
      const pty2 = new PtyStub();
      const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
      const resumeSet2 = [{ sessionId: mgr2, role: "manager", parentSessionId: null }, { sessionId: wkr2, role: "worker", parentSessionId: mgr2, busy: true }];
      sessions2.resumeFleetOnBoot({ reason: "boot", managerSessionId: mgr2, resume: resumeSet2, pending: {}, requestedAt: now }, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
      await flush();
      check("(8b) THE REPRODUCTION: a resume entry with busy:true gets the real continuation nudge (never suppressed)", pty2.getPending(wkr2).some((t) => t.includes("Continue your assigned task")));
      check("(8b) no escalation notice is sent to the manager", pty2.getPending(mgr2).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length === 0);
    }
  }

  // ============================ (9) SUPPRESSED-PARK SKIPPED (Code Review 397ff972) ====================
  // The live path (`suppressMootParkNotice`) deliberately marks a parked event's OWN detail
  // `noticeSuppressed:true` when its notice was decided moot (e.g. superseded by a newer directive) and
  // skips sending it. Boot must never resurrect a notice the live path already declined to send.
  {
    const mgr = mkSession({ role: "manager" });
    const wkr = mkSession({ role: "worker", parentSessionId: mgr, taskId: null });
    const root = `root-9-unit-${sfx}`;
    db.appendEvent({
      id: `evt-9-unit-${sfx}`, ts: now, managerSessionId: mgr, workerSessionId: wkr, taskId: null,
      kind: "session_message_gave_up",
      detail: { msgId: root, rootMsgId: root, chainDepth: 1, outcome: "parked", origin: "kickoff", noticeSuppressed: true, noticeSuppressedReason: "superseded-by-newer-directive" },
    });
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const fired = sessions.escalateParkedKickoffAtBoot(wkr, false, false, false);
    check("(9) NEGATIVE CONTROL (unit-level): a park whose notice was already suppressed as moot is never resurrected at boot", fired === false);
  }
  {
    const mgr2 = mkSession({ role: "manager" });
    const wkr2 = mkSession({ role: "worker", parentSessionId: mgr2, taskId: null });
    const root2 = `root-9-e2e-${sfx}`;
    db.appendEvent({
      id: `evt-9-e2e-${sfx}`, ts: now, managerSessionId: mgr2, workerSessionId: wkr2, taskId: null,
      kind: "session_message_gave_up",
      detail: { msgId: root2, rootMsgId: root2, chainDepth: 1, outcome: "parked", origin: "kickoff", noticeSuppressed: true, noticeSuppressedReason: "superseded-by-newer-directive" },
    });
    const pty2 = new PtyStub();
    const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
    const resumeSet2 = [{ sessionId: mgr2, role: "manager", parentSessionId: null }, { sessionId: wkr2, role: "worker", parentSessionId: mgr2 }];
    sessions2.resumeFleetOnBoot({ reason: "boot", managerSessionId: mgr2, resume: resumeSet2, pending: {}, requestedAt: now }, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    await flush();
    check("(9) end-to-end: the real continuation nudge runs instead (never suppressed)", pty2.getPending(wkr2).some((t) => t.includes("Continue your assigned task")));
    check("(9) end-to-end: no escalation notice is sent to the manager", pty2.getPending(mgr2).filter((t) => t.startsWith("[loom:worker-spawn-broken]")).length === 0);
  }
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card b03e636c: `escalateParkedKickoffAtBoot` re-arms the kickoff-confirm escalation " +
    "at boot-reconcile for a taskless worker whose kickoff reached terminal park before an unrelated " +
    "restart, scoped correctly (tasked workers excluded, pre-upgrade/unmarked events excluded, an " +
    "already-resolved or already-escalated chain excluded), ordered BEFORE resumeFleetOnBoot's own " +
    "continuation nudge so the trap (that nudge starting a turn and permanently hiding the dead kickoff) " +
    "cannot occur, durably auditable via kickoff_confirm_escalated, and never double-notifies across " +
    "repeated restarts or between the original in-memory timer and the boot path. Code Review ad92070b " +
    "fixes verified: the immediate-park branch now records its own marker (source:\"immediate\", never " +
    "a second notice, never a wrongly-suppressed nudge on a later boot); discriminators (non-empty " +
    "transcript, any worker_report, queued pending direction) protect a HEALTHY worker whose turnSeq:0 " +
    "merely reflects an in-flight first turn, not a dead kickoff. Code Review 397ff972 fixes verified: " +
    "two more independent busy signals (persisted w.busy, captured e.busy) stand the escalation down the " +
    "same way, and a park whose own notice the live path already suppressed as moot is never resurrected " +
    "at boot."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
