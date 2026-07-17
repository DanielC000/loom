import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7edd420b (Code Reviewer finding, reviewing d88163b7 round 2 — pre-existing, not caused by that
// card): PtyHost.resumeAfterRateLimit is one of the pty's turn-starting submit() sites, but pre-fix it
// guarded on `alive` only — not `stopping`, not `drainHeld`. A PARKED (rateLimited) session is alive but
// idle, not dying, so an UNRELATED stop can overlap it: a plain pty.stop() (live.stopping) or a companion
// upgrade's holdDrain window (live.drainHeld — see card d88163b7) can both be mid-flight the instant the
// rate-limit-watcher's 60s tick (or a human clearing the park via REST) calls resumeAfterRateLimit. Pre-fix
// this wrote the replayed turn straight into that dying/held pty — never recorded in `pending`, so
// flushPending can't recover it, and the message is lost.
//
// Fully hermetic — a REAL PtyHost driven against a FAKE pty via the same SeamHost seam
// companion-live-upgrade.mjs uses (createPty() capture, kill() fires the real onExit synchronously) — no
// real claude, no daemon, no network.
//
// Proves:
//   1. STOPPING gate (isolated): resumeAfterRateLimit firing while live.stopping is true does NOT submit
//      into the pty (busy stays false) — it holds the prompt in `pending` instead.
//   2. DRAIN-HELD gate (isolated, separately from stopping): resumeAfterRateLimit firing while
//      live.drainHeld is true (companion-upgrade hold, stopping still false) ALSO does not submit — same
//      hold-in-pending behavior.
//   3. The NORMAL (unblocked) case is byte-identical to before: resumeAfterRateLimit still submits
//      immediately (busy becomes true) when neither flag is set.
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-after-rate-limit-stop-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rate-limit-stop-gate-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { PtyHost } = await import("../dist/pty/host.js");

// Mirrors companion-live-upgrade.mjs's SeamHost: captures every SpawnOpts and wires kill() to fire the
// REAL onExit callback the base PtyHost.spawn() registers, so alive/dead tracking is real, not stubbed.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    let exitCb = null;
    return {
      pid: 4242 + this.capture.length,
      write() {}, // graceful stop's Ctrl-C write is a no-op here — nothing auto-exits the fake pty
      onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) exitCb({ exitCode: 0 }); },
      resize() {},
    };
  }
}
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
};

const cwd = path.join(tmpHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });

/** Spawns a fresh session, marks it ready, submits a turn, then parks it on a rate-limit StopFailure —
 *  leaving it alive, busy:false, rateLimited:true, lastPrompt:"PRIMER_TURN". */
function makeParkedSession(host, label) {
  const sessionId = `${label}-${randomUUID()}`;
  host.spawn({
    sessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
    resumeId: null, role: "worker", browserTesting: false, documentConversion: false,
    capabilities: [], restrictedTools: false, skills: null,
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const primer = host.enqueueStdin(sessionId, "PRIMER_TURN", "system");
  if (!primer.delivered) throw new Error(`${label}: setup primer turn did not submit immediately`);
  host.deliverHook(sessionId, { hook_event_name: "StopFailure", error: "rate_limit" });
  return sessionId;
}

try {
  // ===================== (1) STOPPING gate, isolated =====================
  {
    const host = new SeamHost(events);
    const sessionId = makeParkedSession(host, "stopping");
    check("setup: parked session is alive", host.isAlive(sessionId));
    check("setup: parked session is idle (busy false)", host.isBusy(sessionId) === false);

    host.stop(sessionId, "graceful"); // sets live.stopping = true; the pty stays alive (no real kill fired)
    check("setup: the pty is still alive right after a graceful stop() call (stopping window, not yet dead)", host.isAlive(sessionId));

    const resumed = host.resumeAfterRateLimit(sessionId);
    check("(1) resumeAfterRateLimit still reports success while stopping (unparked, just deferred)", resumed === true);
    check(
      "(1) STOPPING: the killed turn is NOT submitted into the dying pty — busy stays false",
      host.isBusy(sessionId) === false,
    );
    check(
      "(1) STOPPING: the prompt is instead HELD in pending, recoverable, not silently written into the pty",
      host.getPending(sessionId).includes("PRIMER_TURN"),
    );
  }

  // ===================== (2) DRAIN-HELD gate, isolated (stopping stays FALSE here) =====================
  {
    const host = new SeamHost(events);
    const sessionId = makeParkedSession(host, "drainheld");
    check("setup: parked session is alive", host.isAlive(sessionId));

    host.holdDrain(sessionId); // companion-upgrade hold window — stopping is NOT set by this alone
    check("setup: holdDrain alone does not set stopping", host.isAlive(sessionId));

    const resumed = host.resumeAfterRateLimit(sessionId);
    check("(2) resumeAfterRateLimit still reports success while drain-held", resumed === true);
    check(
      "(2) DRAIN-HELD: the killed turn is NOT submitted into the held pty — busy stays false",
      host.isBusy(sessionId) === false,
    );
    check(
      "(2) DRAIN-HELD: the prompt is instead HELD in pending",
      host.getPending(sessionId).includes("PRIMER_TURN"),
    );
    host.releaseDrain(sessionId); // don't leave the hold dangling
  }

  // ===================== (3) the NORMAL (unblocked) case is unchanged =====================
  {
    const host = new SeamHost(events);
    const sessionId = makeParkedSession(host, "normal");
    check("setup: parked session is alive", host.isAlive(sessionId));
    check("setup: neither stopping nor drainHeld is set", host.isAlive(sessionId));

    const resumed = host.resumeAfterRateLimit(sessionId);
    check("(3) resumeAfterRateLimit reports success", resumed === true);
    check(
      "(3) NORMAL: with no stop/hold in flight, the turn still submits immediately (busy becomes true) — unchanged behavior",
      host.isBusy(sessionId) === true,
    );
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resumeAfterRateLimit no longer submits a rate-limit-reset replay into a dying (stopping) or held (drainHeld) pty; both gates independently verified; the normal unblocked case is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
