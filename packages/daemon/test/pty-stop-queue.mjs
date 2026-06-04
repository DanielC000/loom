// Deterministic regression guard: a Stop intent must NOT be defeated by a queued inbound turn
// re-arming busy (the "sticky stop" QA bug — stopping a BUSY-BOOTING session with a queued composer
// turn took ~3 clicks / ~13s because each graceful Ctrl-C fired a Stop hook that DRAINED the next
// queued message → re-armed busy → the session looked busy again → the next Ctrl-C just interrupted
// the freshly-drained turn, and so on). The fix (pty/host.ts): stop() sets a `stopping` flag that
// SUPPRESSES drainPending/enqueue-submit and CLEARS the held queue, so no queued turn re-arms busy
// past the stop; and pending is emptied on exit so a stale "Queued (N)" can't linger.
//
// Exercises the real PtyHost state machine against a FAKE pty (the createPty seam) — no real claude,
// no daemon, no network. Sibling to pty-busy-drain.mjs (which guards the normal drain still works).
//
// RUN (no daemon needed): node test/pty-stop-queue.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-stopqueue-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

// A fake IPty that ALSO captures the onExit handler so the test can fire a synthetic exit (host.ts's
// onExit clears the pending queue — the stale-"Queued (N)" fix). kill() fires exit(0) like a real kill.
const fakes = [];
function makeFakePty() {
  const writes = [];
  let exitCb = null;
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { exitCb?.({ exitCode: 0, signal: undefined }); },
    resize: () => {},
    writes,
    fireExit: (code = 0) => exitCb?.({ exitCode: code, signal: undefined }),
  };
  fakes.push(fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

const busyLog = [];
const exitLog = [];
const events = {
  onEngineSessionId() {},
  onBusy(_id, busy) { busyLog.push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit(_id, code) { exitLog.push(code); },
};

const host = new TestPtyHost(events);
const ALPHA = "ALPHA_MSG", BETA = "BETA_MSG", GAMMA = "GAMMA_MSG";
const ETX = "\x03"; // Ctrl-C

try {
  // ===================== Scenario 1: stop suppresses the queued-turn re-arm =====================
  const SID = "sess-stop";
  host.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes[0];
  host.deliverHook(SID, { hook_event_name: "SessionStart" }); // → ready

  const written = () => fake.writes.join("");
  const countOf = (m) => written().split(m).length - 1;
  const lastBusy = () => busyLog[busyLog.length - 1];

  // A turn in flight (the "busy-booting" turn) + a queued composer turn ("sends when turn ends").
  const r1 = host.enqueueStdin(SID, ALPHA);
  const r2 = host.enqueueStdin(SID, BETA);
  check("setup: ALPHA delivered (turn in flight), BETA queued", r1.delivered === true && r2.delivered === false && r2.position === 1);
  check("setup: busy armed, queue holds [BETA]", lastBusy() === true && JSON.stringify(host.getPending(SID)) === JSON.stringify([BETA]));

  // STOP (graceful). Must clear the queue immediately and mark stopping.
  host.stop(SID, "graceful");
  check("stop: queue CLEARED on stop (no queued turn left to re-arm busy)", host.getPending(SID).length === 0);
  check("stop: graceful wrote a Ctrl-C interrupt", countOf(ETX) >= 1);

  // The interrupt ends the turn → claude fires a Stop hook. Pre-fix this drained BETA and re-armed
  // busy. Post-fix: busy falls and STAYS false; BETA is never submitted.
  const betaBefore = countOf(BETA);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("STOP HOOK: busy fell to false and was NOT re-armed by a queued turn", lastBusy() === false);
  check("STOP HOOK: the queued BETA was NOT drained/submitted", countOf(BETA) === betaBefore && countOf(BETA) === 0);

  // A second interrupt's Stop hook (the escalation that USED to be needed) still doesn't re-arm.
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("2nd STOP HOOK: still idle, still no queued-turn submit", lastBusy() === false && countOf(BETA) === 0);

  // A turn arriving DURING the stop window must not sneak in via the idle-submit path either.
  const r3 = host.enqueueStdin(SID, GAMMA);
  check("during stop: a new enqueue does NOT submit (held, not delivered)", r3.delivered === false && countOf(GAMMA) === 0);

  // reconcile (the periodic safety-net drain) must also respect the stop.
  host.reconcile();
  check("during stop: reconcile does NOT drain a queued turn", countOf(BETA) === 0 && countOf(GAMMA) === 0);

  // ===================== Scenario 2: pending emptied on exit (no stale "Queued (N)") =====================
  const SID2 = "sess-exit";
  host.spawn({
    sessionId: SID2, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake2 = fakes[fakes.length - 1];
  host.deliverHook(SID2, { hook_event_name: "SessionStart" });
  host.enqueueStdin(SID2, ALPHA); // in-flight turn
  host.enqueueStdin(SID2, BETA);  // queued
  check("exit-setup: queue holds [BETA] before exit", JSON.stringify(host.getPending(SID2)) === JSON.stringify([BETA]));
  // The pty exits (crash / clean end / kill) WITHOUT a prior stop() — onExit must still empty the queue
  // so getPending (what the web "Queued (N)" indicator reads) returns [] for the dead session.
  fake2.fireExit(0);
  check("exit: session no longer alive", host.isAlive(SID2) === false);
  check("exit: pending emptied on exit — no stale 'Queued (N)'", host.getPending(SID2).length === 0);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a Stop is not defeated by a queued turn re-arming busy; queue cleared on stop + on exit."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
