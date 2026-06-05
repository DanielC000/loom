// Deterministic regression guard: a GRACEFUL stop must ALWAYS end with the session EXITED — even when
// the session is BUSY (mid-turn) at stop time. The board bug (316d0ecc): graceful = double Ctrl-C, which
// EXITS an idle claude but only INTERRUPTS a mid-turn one (the 2nd Ctrl-C exits only from an idle prompt).
// The pty then stayed ALIVE and — with no Stop hook firing after the interrupt — busy stayed stale, so a
// "stopped" session was actually still live+busy (only a follow-up hard stop cleaned it up). The fix
// (pty/host.ts escalateGracefulStop): after the interrupt sequence, RE-SEND the exit sequence if still
// alive, then HARD-KILL within a bounded timeout if it still refuses to exit. An idle session exits on the
// first sequence, so its stop is unchanged (the escalation timers find !alive and do nothing).
//
// Exercises the real PtyHost state machine against a FAKE pty (the createPty seam) — no real claude, no
// daemon, no network. Sibling to pty-stop-queue.mjs / pty-busy-drain.mjs.
//
// RUN (no daemon needed): node test/graceful-stop.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-gracefulstop-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

// Shrink the escalation timings so the whole staged escalation runs in ~hundreds of ms (the consts are
// read at host.js import time, like LOOM_HOME). Keep RETRY+GAP < KILL so the re-sent exit sequence gets a
// full window to land before the hard-kill backstop. Set BEFORE importing host.js.
process.env.LOOM_GRACEFUL_GAP_MS = "20";
process.env.LOOM_GRACEFUL_RETRY_MS = "80";
process.env.LOOM_GRACEFUL_KILL_MS = "300";

const { PtyHost } = await import("../dist/pty/host.js");

const ETX = "\x03"; // Ctrl-C

// A fake IPty parameterised by how many Ctrl-C writes it takes before it "exits" (models claude exiting
// at an idle prompt). `exitOnCtrlC = Infinity` → it NEVER exits on Ctrl-C (a wedged/mid-turn session that
// swallows the interrupt) — only kill() ends it. Tracks whether kill() was called, so a test can assert
// whether the session exited cleanly via Ctrl-C or had to be hard-killed by the escalation.
const fakes = [];
function makeFakePty(exitOnCtrlC) {
  let exitCb = null;
  let ctrlCs = 0;
  let exited = false;
  const fireExit = (code) => { if (exited) return; exited = true; exitCb?.({ exitCode: code, signal: undefined }); };
  const fake = {
    pid: 4242,
    write: (d) => {
      // Count Ctrl-C bytes in this write; once the threshold is crossed, the (idle) pty exits — exactly
      // how a real claude exits when the double Ctrl-C lands at an empty prompt.
      for (const ch of d) if (ch === ETX) { ctrlCs++; if (ctrlCs >= exitOnCtrlC) fireExit(0); }
    },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { fake.killCalled = true; fireExit(0); },
    resize: () => {},
    killCalled: false,
    ctrlCCount: () => ctrlCs,
  };
  fakes.push(fake);
  return fake;
}

// host.spawn() pulls the NEXT queued fake from here (set per-scenario before spawn).
let nextExitOnCtrlC = Infinity;
class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(nextExitOnCtrlC); }
}

const exitLog = [];
const busyLog = [];
const events = {
  onEngineSessionId() {},
  onBusy(_id, busy) { busyLog.push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit(_id, code) { exitLog.push(code); }, // index.ts wires this → setProcessState("exited") + setBusy(false)
};

const host = new TestPtyHost(events);
const PERM = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };
const GEO = { cols: 120, rows: 40 };

// Spawn a ready session and mark it busy (mid-turn), returning its fake pty.
function spawnReady(sid, exitOnCtrlC) {
  nextExitOnCtrlC = exitOnCtrlC;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: PERM, geometry: GEO, sessionEnv: {} });
  const fake = fakes[fakes.length - 1];
  host.deliverHook(sid, { hook_event_name: "SessionStart" }); // → ready
  return fake;
}

try {
  // ============ Scenario 1: BUSY session that SWALLOWS Ctrl-C → bounded hard-kill escalation ============
  // The whole point of the board bug: a mid-turn session whose turn is only interrupted, not exited. With
  // a fake pty that never exits on Ctrl-C, graceful stop MUST still drive it to exited via the hard-kill
  // backstop (Stage 3) within the bounded timeout — not leave it stuck live+busy.
  {
    const SID = "sess-busy-stuck";
    const fake = spawnReady(SID, Infinity);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" }); // busy = true (turn in flight)
    check("busy-stuck: session is busy+alive before stop", host.isAlive(SID) === true && busyLog[busyLog.length - 1] === true);

    host.stop(SID, "graceful");
    check("busy-stuck: graceful wrote the interrupt Ctrl-C immediately", fake.ctrlCCount() >= 1);
    // Right after stop it is NOT yet exited (the interrupt didn't kill it) — exactly the stuck state.
    check("busy-stuck: still live immediately after stop (interrupt only)", host.isAlive(SID) === true && fake.killCalled === false);

    await sleep(450); // > KILL_MS (300) — let the full escalation run
    check("busy-stuck: ESCALATED to hard kill (pty.kill called)", fake.killCalled === true);
    check("busy-stuck: session reached EXITED (onExit fired)", host.isAlive(SID) === false && exitLog.length >= 1);
  }

  // ============ Scenario 2: IDLE session exits on the FIRST sequence — unchanged, no hard kill ============
  // An idle claude exits on the double Ctrl-C. The fake exits after 2 Ctrl-Cs (Stage 1), so the escalation
  // timers all find !alive: kill() must NEVER be called and only the 2 original Ctrl-Cs are written.
  {
    const SID = "sess-idle";
    const fake = spawnReady(SID, 2); // exits on the 2nd Ctrl-C, like a real idle claude
    host.stop(SID, "graceful");
    await sleep(60); // past GAP (20) so the second Ctrl-C has landed; well before RETRY (80)
    check("idle: exited cleanly via the double Ctrl-C (Stage 1)", host.isAlive(SID) === false);
    check("idle: NOT hard-killed (escalation never fired)", fake.killCalled === false);

    await sleep(400); // let the (now no-op) escalation timers fire — they must stay no-ops
    check("idle: still no hard kill after the escalation window", fake.killCalled === false);
    check("idle: exactly the original two Ctrl-Cs were written (byte-for-byte unchanged)", fake.ctrlCCount() === 2);
  }

  // ============ Scenario 3: BUSY session exits on the RE-SENT exit sequence (Stage 2, no hard kill) ============
  // Models the common busy case: the first double Ctrl-C INTERRUPTS the turn (2 Ctrl-Cs, no exit), then the
  // turn unwinds to idle and the RE-SENT double Ctrl-C (Stage 2) exits it — so it should NOT need the
  // hard-kill backstop. Fake exits only after 4 Ctrl-Cs (2 interrupt + 2 re-sent).
  {
    const SID = "sess-busy-retry";
    const fake = spawnReady(SID, 4);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" }); // busy = true
    host.stop(SID, "graceful");
    await sleep(60); // after Stage 1's two Ctrl-Cs (gap 20), before Stage 2 (retry 80)
    check("busy-retry: NOT yet exited after the interrupt sequence (turn only interrupted)", host.isAlive(SID) === true);

    await sleep(120); // past RETRY (80) + GAP (20) — Stage 2's re-sent sequence lands the 3rd+4th Ctrl-C
    check("busy-retry: exited via the RE-SENT exit sequence (Stage 2)", host.isAlive(SID) === false);
    check("busy-retry: did NOT need the hard-kill backstop", fake.killCalled === false);

    await sleep(250); // let Stage 3 (kill 300) fire — must be a no-op now (already exited)
    check("busy-retry: hard-kill backstop stayed a no-op after a clean Stage-2 exit", fake.killCalled === false);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — graceful stop is deterministic: a busy session always reaches exited (re-send → hard-kill), an idle session's stop is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
