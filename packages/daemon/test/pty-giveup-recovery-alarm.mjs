// Hermetic regression test for card c00231e2 — "alert the owner on repeated manager submit give-up
// recovery".
//
// ROOT CAUSE being guarded: a MANAGER/platform-lead session's own submit GIVE-UP RECOVERY (pty/host.ts's
// `fireEnterAndVerify` give-up branch — an Enter write that never confirmed after SUBMIT_MAX_ATTEMPTS) used
// to show up ONLY as `[submit] ... GIVE-UP RECOVERY ...` console lines. A real production session fired
// dozens of these over ~4h and the owner learned of it only once the fleet went visibly quiet (card
// 347b3584's investigation).
//
// THE FIX: `PtyHost.maybeFireGiveUpRecoveryAlarm` (called from the GIVE-UP RECOVERY branch, gated on
// `live.role === "manager" || live.role === "platform"`) keeps a rolling in-memory timestamp list per
// session (`Live.giveUpRecoveryFiredAt`), pruned to `GIVE_UP_RECOVERY_ALARM_WINDOW_MS` on every fire. Once
// pruning+push reaches `GIVE_UP_RECOVERY_ALARM_THRESHOLD` fires and the episode hasn't already alarmed
// (`Live.giveUpRecoveryAlarmed`), it invokes `PtyHostEvents.onGiveUpRecoveryAlarm` exactly once — PtyHost
// has no DB, so the implementer (SessionService.handleGiveUpRecoveryAlarm) appends the durable
// `give_up_recovery_escalated` orchestration event the owner-facing surfaces (web attention.ts,
// AlertWebhookEmitter) derive their alert from.
//
// This suite proves, against a fake pty that never emits output (so every give-up is a genuine drop, same
// shape as pty-giveup-requeue.mjs's own silent fake):
//   (1) N-1 (2) give-ups on a MANAGER session ⇒ the alarm callback never fires.
//   (2) the Nth (3rd) give-up on that SAME manager session ⇒ the alarm fires EXACTLY ONCE, with the
//       resolved {count, windowMs} — and two MORE give-ups inside the same window do NOT fire it again
//       (one alarm per episode, not per cycle).
//   (3) the IDENTICAL N-give-up sequence on a WORKER session never fires the alarm at all (role-gated at
//       the source, before any counting even starts).
//   (4) a quiet gap of at least the alarm window, with zero further give-ups, then a fresh N-give-up burst
//       on the ORIGINAL manager session ⇒ a SECOND, independent alarm fires — proving the episode latch
//       resets rather than staying permanently tripped.
//
// RUN (no daemon needed): node test/pty-giveup-recovery-alarm.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-giveupalarm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// Shrink every give-up timing constant the same way pty-giveup-requeue.mjs does, so a full give-up cycle
// takes tens of ms instead of the real ~900ms*4 production defaults.
const ENTER_DELAY = 10;
const VERIFY_TIMEOUT = 60;   // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 2;      // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 5;
const SETTLE_MAX_POLLS = 3;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 6; // bound = 60ms
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
// Generous — this suite drives several cycles of the SAME message on purpose and must never let the
// requeue budget drop it before the scenario has finished driving its own cycle count.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "20";
const HOLD_MS = 10;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
const HOLD_WAIT = HOLD_MS + 20;
process.env.LOOM_MODE_LOG_POLL_MS = "5";

// The bounds THIS suite is guarding — pinned explicitly so a future re-tune of the production defaults
// doesn't silently change what this test proves.
const THRESHOLD = 3;
const WINDOW_MS = 2500;
process.env.LOOM_GIVE_UP_RECOVERY_ALARM_THRESHOLD = String(THRESHOLD);
process.env.LOOM_GIVE_UP_RECOVERY_ALARM_WINDOW_MS = String(WINDOW_MS);

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const alarmCalls = [];
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
  onGiveUpRecoveryAlarm(sessionId, info) { alarmCalls.push({ sessionId, ...info }); },
};

class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId, role) {
  host.spawn({
    sessionId, cwd: tmpHome, role,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

/** Drive exactly ONE give-up cycle to completion (busy true→false) on an already-stuck, already-requeued
 *  session, by waiting past the requeue hold and firing the daemon's own periodic reconcile tick
 *  (simulated directly, mirroring pty-giveup-requeue.mjs — never waiting the real ~10s). */
async function driveNextCycle(sessionId) {
  await sleepPast(HOLD_WAIT, HOLD_MS, `${sessionId} past requeue hold`);
  host.reconcile();
  check(`${sessionId}: reconcile re-armed busy for the next cycle`, busyLog[sessionId].at(-1) === true);
  await sharedWaitUntil(() => busyLog[sessionId].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2, label: `${sessionId} give-up cycle settle` });
}

try {
  // ===================== (1)+(2) manager: N-1 give-ups ⇒ no alarm; Nth ⇒ exactly one, with the resolved
  // ===================== {count, windowMs}; further give-ups in the SAME episode never re-fire it ========
  {
    const SID = "sess-giveup-alarm-manager";
    const TEXT = "MANAGER_SUBMIT_KEEPS_GIVING_UP";
    spawnReady(SID, "manager");
    host.enqueueStdin(SID, TEXT);
    check("(1) setup: immediate idle-submit delivered, busy armed", busyLog[SID].at(-1) === true);

    // Cycle 1 (first give-up — the ORIGINAL submit, no reconcile needed to trigger it).
    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2, label: `${SID} cycle 1 settle` });
    check("(1) cycle 1: no alarm yet (1 < threshold)", alarmCalls.length === 0);

    // Cycle 2.
    await driveNextCycle(SID);
    check("(1) cycle 2: still no alarm (2 < threshold)", alarmCalls.length === 0);

    // Cycle 3 — crosses THRESHOLD (3) inside WINDOW_MS ⇒ exactly one alarm, with the resolved values.
    await driveNextCycle(SID);
    check("(2) cycle 3: the alarm fired exactly once", alarmCalls.length === 1);
    check("(2) the alarm carries the resolved count/windowMs",
      alarmCalls[0]?.sessionId === SID && alarmCalls[0]?.count === THRESHOLD && alarmCalls[0]?.windowMs === WINDOW_MS);

    // Cycles 4 and 5 — still well inside the window. ONE alarm per episode: must NOT fire again.
    await driveNextCycle(SID);
    await driveNextCycle(SID);
    check("(2) cycles 4-5: still only ONE alarm total — one per episode, not per cycle", alarmCalls.length === 1);
  }

  // ===================== (3) the IDENTICAL sequence on a WORKER session never alarms — gated at the =====
  // ===================== source (their manager already sees composerDirtyLen) ============================
  {
    const SID = "sess-giveup-alarm-worker";
    const TEXT = "WORKER_SUBMIT_KEEPS_GIVING_UP_TOO";
    const callsBefore = alarmCalls.length;
    spawnReady(SID, "worker");
    host.enqueueStdin(SID, TEXT);
    check("(3) setup: immediate idle-submit delivered, busy armed", busyLog[SID].at(-1) === true);

    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2, label: `${SID} cycle 1 settle` });
    await driveNextCycle(SID);
    await driveNextCycle(SID); // 3 cycles total — same count that alarmed the manager above
    check("(3) a worker's give-ups NEVER alarm, no matter the count", alarmCalls.length === callsBefore);
  }

  // ===================== (4) a quiet gap >= the window, with zero further give-ups, then a FRESH burst ===
  // ===================== on the ORIGINAL manager session ⇒ a SECOND, independent alarm ====================
  {
    const SID = "sess-giveup-alarm-manager"; // reuse — same session, fresh episode
    const callsBefore = alarmCalls.length;

    // Quiet period: no reconcile() call for strictly longer than WINDOW_MS. Asserted, not guessed —
    // sleepPast throws synchronously if the margin given doesn't genuinely exceed the threshold.
    await sleepPast(WINDOW_MS + 300, WINDOW_MS, `${SID} quiet gap exceeds the alarm window`);

    await driveNextCycle(SID); // cycle 1 of the new episode
    check("(4) new episode cycle 1: no alarm yet", alarmCalls.length === callsBefore);
    await driveNextCycle(SID); // cycle 2
    check("(4) new episode cycle 2: still no alarm", alarmCalls.length === callsBefore);
    await driveNextCycle(SID); // cycle 3 — crosses THRESHOLD again
    check("(4) new episode cycle 3: a SECOND, independent alarm fired", alarmCalls.length === callsBefore + 1);
    check("(4) the second alarm is its own entry (count resets to THRESHOLD, not a running total)",
      alarmCalls[alarmCalls.length - 1]?.count === THRESHOLD);
  }
} finally {
  for (const sid of ["sess-giveup-alarm-manager", "sess-giveup-alarm-worker"]) {
    try { host.stop(sid, "hard"); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
