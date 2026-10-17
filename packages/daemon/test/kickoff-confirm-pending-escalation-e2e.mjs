import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Code Review f3fa9002 (card 8882e2ca) MAJOR 1, END-TO-END: after `handleKickoffGiveUpExhausted` sends
// the softer `[loom:kickoff-confirm-pending]` notice, nothing used to ever re-check — a TASKLESS worker
// gets NO periodic idle-watchdog coverage at all (`tickIdleWorkers` skips `!taskId`), and a TASKED
// worker's only other re-check is `idleWorkerMinutes` (default 45min), not the exact moment this
// worker's own window ends. The fix: a ONE-SHOT timer, armed at the window's end, that calls
// `notifyManagerOfIdleWorker` directly.
//
// This drives the REAL `SessionService.handleKickoffGiveUpExhausted`/`handleGiveUpConfirmed` against a
// real Db + a configurable PtyStub, using `node:test`'s `mock.timers` to fast-forward past the real
// `setTimeout` the one-shot re-check arms — no real wall-clock wait.
//
// (TASKED)   PARK (softer notice) -> advance the fake clock past the window -> the terminal
//            [loom:worker-spawn-broken] notice arrives, for a TASKED worker (classifyIdleWorker's own
//            board-column-based reconciliation).
// (TASKLESS) THE SAME, for a TASKLESS worker (`tickIdleWorkers` would never reach this one at all —
//            this proves the one-shot timer, not that periodic tick, is what fires it).
// (CONFIRMED-INSIDE-WINDOW) NEGATIVE CONTROL: the kickoff CONFIRMS (handleGiveUpConfirmed) BEFORE the
//            window elapses -> the one-shot timer is cleared -> advancing the fake clock past where it
//            would have fired produces NO terminal notice at all.
//
// Run: 1) build daemon (pnpm build from packages/daemon), 2) node test/kickoff-confirm-pending-escalation-e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-kcp-e2e-${Date.now()}-${process.pid}`);
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

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const db = new Db();
const proj = `kcpe-proj-${sfx}`, agent = `kcpe-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });

/** PtyStub: enqueueStdin records every dispatch; liveStartedAt/getComposerDirtyLen are the two reads
 *  withinKickoffConfirmWindow needs, both configurable per session. */
class PtyStub {
  constructor() {
    this.live = new Set(); this.sent = []; this.firstTurnStarted = new Set();
    this.liveStartedAtMap = new Map(); this.composerDirtyLenMap = new Map();
  }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setLiveStartedAt(id, ms) { this.liveStartedAtMap.set(id, ms); }
  liveStartedAt(id) { return this.liveStartedAtMap.has(id) ? this.liveStartedAtMap.get(id) : null; }
  setComposerDirtyLen(id, n) { this.composerDirtyLenMap.set(id, n); }
  getComposerDirtyLen(id) { return this.composerDirtyLenMap.has(id) ? this.composerDirtyLenMap.get(id) : undefined; }
  setFirstTurnStarted(id, on = true) { if (on) this.firstTurnStarted.add(id); else this.firstTurnStarted.delete(id); }
  hasFirstTurnStarted(id) { return this.firstTurnStarted.has(id); }
  getPendingEntries() { return []; }
  enqueueStdin(id, text, _source = "system", onDeliver, _route, _kind, _questionId, _ownerText, _proactive, _senderId, tail) {
    const isTailObject = typeof tail === "object" && tail !== null;
    const onGiveUpExhausted = isTailObject ? tail.onGiveUpExhausted : undefined;
    this.sent.push({ id, text, onGiveUpExhausted });
    if (!this.live.has(id)) return { delivered: false, reason: "session-dead", queued: false };
    return { delivered: true };
  }
}

const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: o.engineSessionId ?? null, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? "worker", parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});

const LARGE_KICKOFF = "x".repeat(69_000);

// `Date` MUST be faked alongside `setTimeout` — the one-shot re-check's OWN re-evaluation
// (withinKickoffConfirmWindow, invoked from inside the fired callback) computes sinceMs from a FRESH
// `Date.now()` call; without faking Date too, that fresh call would read the REAL (barely-advanced)
// wall clock and still see "within window", masking the exact escalation this test exists to prove.
mock.timers.enable({ apis: ["setTimeout", "Date"] });
try {
  // ================ (TASKED) PARK -> window elapses -> terminal notice arrives ========================
  {
    const mgr = `kcpe-mgr-tasked-${sfx}`, wkr = `kcpe-wkr-tasked-${sfx}`, task = `kcpe-task-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    db.insertTask({ id: task, projectId: proj, title: "T", body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
    mkSession({ id: wkr, parentSessionId: mgr, taskId: task, engineSessionId: `eng-${wkr}` });
    const pty = new PtyStub();
    pty.setLive(mgr);
    pty.setLiveStartedAt(wkr, Date.now() - 97_000);
    pty.setComposerDirtyLen(wkr, LARGE_KICKOFF.length);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const rootMsgId = `root-tasked-${sfx}`;

    const pending = withinKickoffConfirmWindow(pty, wkr, 0);
    check("(TASKED) setup: this worker genuinely reads as pending before the PARK call", !!pending);

    sessions.handleKickoffGiveUpExhausted(wkr, `msg-tasked-${sfx}`, rootMsgId, LARGE_KICKOFF, 1 /* TERMINAL_CHAIN_DEPTH */);
    const afterPark = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    check("(TASKED) PARK sent the softer notice, not the terminal one",
      afterPark.some((t) => t.startsWith("[loom:kickoff-confirm-pending]")) && !afterPark.some((t) => t.startsWith("[loom:worker-spawn-broken]")));

    // Advance the fake clock past exactly when this worker's own window ends (plus a buffer).
    mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

    const afterTick = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    check("(TASKED) THE FIX: the ONE-SHOT re-check fired the terminal [loom:worker-spawn-broken] notice once the window elapsed",
      afterTick.some((t) => t.startsWith("[loom:worker-spawn-broken]")));
  }

  // ================ (TASKLESS) THE SAME, for a worker tickIdleWorkers would never reach ================
  {
    const mgr = `kcpe-mgr-taskless-${sfx}`, wkr = `kcpe-wkr-taskless-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, parentSessionId: mgr, taskId: null, engineSessionId: `eng-${wkr}` }); // TASKLESS
    const pty = new PtyStub();
    pty.setLive(mgr);
    pty.setLiveStartedAt(wkr, Date.now() - 97_000);
    pty.setComposerDirtyLen(wkr, LARGE_KICKOFF.length);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const rootMsgId = `root-taskless-${sfx}`;

    const pending = withinKickoffConfirmWindow(pty, wkr, 0);
    sessions.handleKickoffGiveUpExhausted(wkr, `msg-taskless-${sfx}`, rootMsgId, LARGE_KICKOFF, 1);
    const afterPark = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    check("(TASKLESS) PARK sent the softer notice too", afterPark.some((t) => t.startsWith("[loom:kickoff-confirm-pending]")));

    mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

    const afterTick = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    check("(TASKLESS) THE FIX: the one-shot re-check ALSO escalates a taskless worker — tickIdleWorkers would never have reached this one",
      afterTick.some((t) => t.startsWith("[loom:worker-spawn-broken]")));
  }

  // ================ (CONFIRMED-INSIDE-WINDOW) NEGATIVE CONTROL: resolved before the window elapses =====
  {
    const mgr = `kcpe-mgr-confirmed-${sfx}`, wkr = `kcpe-wkr-confirmed-${sfx}`, task = `kcpe-task2-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    db.insertTask({ id: task, projectId: proj, title: "T2", body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
    mkSession({ id: wkr, parentSessionId: mgr, taskId: task, engineSessionId: `eng-${wkr}` });
    const pty = new PtyStub();
    pty.setLive(mgr);
    pty.setLiveStartedAt(wkr, Date.now() - 97_000);
    pty.setComposerDirtyLen(wkr, LARGE_KICKOFF.length);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const rootMsgId = `root-confirmed-${sfx}`;

    const pending = withinKickoffConfirmWindow(pty, wkr, 0);
    sessions.handleKickoffGiveUpExhausted(wkr, `msg-confirmed-${sfx}`, rootMsgId, LARGE_KICKOFF, 1);

    // The kickoff confirms (a real engine hook) WHILE still inside the window — this must clear the
    // one-shot timer so it never fires the terminal notice later.
    sessions.handleGiveUpConfirmed(wkr, rootMsgId, 45_000);
    const sentBeforeTick = pty.sent.filter((s) => s.id === mgr).length;

    mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

    const afterTick = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    check("(CONFIRMED-INSIDE-WINDOW) NEGATIVE CONTROL: no NEW notice after the tick — the timer was cleared on confirm",
      pty.sent.filter((s) => s.id === mgr).length === sentBeforeTick);
    check("(CONFIRMED-INSIDE-WINDOW) specifically, no terminal [loom:worker-spawn-broken] ever arrives",
      !afterTick.some((t) => t.startsWith("[loom:worker-spawn-broken]")));
  }

  // ================ (NON-RETRACTION-TASKED) Code Review 6a497b53 MAJOR 1: a turn can start WITHOUT ======
  // ================ handleGiveUpConfirmed ever firing (a mismatch/fusion echo, an ambiguous multi-batch ===
  // ================ match left unresolved, a manager message, a human Enter) — the CR reproduced a FALSE ==
  // ================ "[loom:worker-idle] ... did NOT call worker_report" notice firing into this exact =====
  // ================ shape. RED against c3b73d9d (the one-shot callback had no live-state re-check at all). =
  {
    const mgr = `kcpe-mgr-nonretr-${sfx}`, wkr = `kcpe-wkr-nonretr-${sfx}`, task = `kcpe-task3-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    db.insertTask({ id: task, projectId: proj, title: "T3", body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
    mkSession({ id: wkr, parentSessionId: mgr, taskId: task, engineSessionId: `eng-${wkr}` });
    const pty = new PtyStub();
    pty.setLive(mgr);
    pty.setLiveStartedAt(wkr, Date.now() - 97_000);
    pty.setComposerDirtyLen(wkr, LARGE_KICKOFF.length);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const rootMsgId = `root-nonretr-${sfx}`;

    const pending = withinKickoffConfirmWindow(pty, wkr, 0);
    sessions.handleKickoffGiveUpExhausted(wkr, `msg-nonretr-${sfx}`, rootMsgId, LARGE_KICKOFF, 1);
    const sentBeforeTick = pty.sent.filter((s) => s.id === mgr).length;

    // The turn starts via a NON-retraction path: hasFirstTurnStarted flips true and the row goes busy —
    // handleGiveUpConfirmed is NEVER called, so the timer is never explicitly cleared.
    pty.setFirstTurnStarted(wkr, true);
    db.setBusy(wkr, true);

    mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

    const afterTick = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    check("(NON-RETRACTION-TASKED) THE FIX: NO notice at all after the tick — not the terminal one, and not a false 'did NOT call worker_report' either",
      pty.sent.filter((s) => s.id === mgr).length === sentBeforeTick);
    check("(NON-RETRACTION-TASKED) specifically, no terminal [loom:worker-spawn-broken]",
      !afterTick.some((t) => t.startsWith("[loom:worker-spawn-broken]")));
  }

  // ================ (NON-RETRACTION-TASKLESS) THE SAME for a taskless worker — the CR reproduced a FALSE =
  // ================ neverCompletedTurn ("started its first turn but has NOT completed one") notice here. ==
  {
    const mgr = `kcpe-mgr-nonretrl-${sfx}`, wkr = `kcpe-wkr-nonretrl-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, parentSessionId: mgr, taskId: null, engineSessionId: `eng-${wkr}` }); // TASKLESS
    const pty = new PtyStub();
    pty.setLive(mgr);
    pty.setLiveStartedAt(wkr, Date.now() - 97_000);
    pty.setComposerDirtyLen(wkr, LARGE_KICKOFF.length);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const rootMsgId = `root-nonretrl-${sfx}`;

    const pending = withinKickoffConfirmWindow(pty, wkr, 0);
    sessions.handleKickoffGiveUpExhausted(wkr, `msg-nonretrl-${sfx}`, rootMsgId, LARGE_KICKOFF, 1);
    const sentBeforeTick = pty.sent.filter((s) => s.id === mgr).length;

    pty.setFirstTurnStarted(wkr, true);
    db.setBusy(wkr, true);

    mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

    const afterTick = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    check("(NON-RETRACTION-TASKLESS) THE FIX: NO notice at all after the tick — not the terminal one, and not a false neverCompletedTurn either",
      pty.sent.filter((s) => s.id === mgr).length === sentBeforeTick);
    check("(NON-RETRACTION-TASKLESS) specifically, no terminal [loom:worker-spawn-broken]",
      !afterTick.some((t) => t.startsWith("[loom:worker-spawn-broken]")));
  }
} finally {
  mock.timers.reset();
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 8882e2ca (Code Review f3fa9002, Major 1), end-to-end: the one-shot re-check " +
    "timer armed by handleKickoffGiveUpExhausted's softer PARK notice fires notifyManagerOfIdleWorker " +
    "exactly when the plausible-confirm window ends, escalating to the terminal [loom:worker-spawn-broken] " +
    "notice for BOTH a tasked worker (classifyIdleWorker's own reconciliation) and a taskless one " +
    "(tickIdleWorkers would never have reached it at all) — and a genuine confirm landing inside the " +
    "window clears the timer, so it never fires a stale escalation afterward. Code Review 6a497b53 " +
    "Major 1: a turn that starts via a NON-retraction path (hasFirstTurnStarted/busy set directly, " +
    "handleGiveUpConfirmed never called) produces NO notice at all once the timer fires, for both a " +
    "tasked and a taskless worker — the fired callback's own live-state re-check, not just the explicit " +
    "clear sites, is what closes this."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
