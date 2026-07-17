import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 81f9c887 (verified reachable by 710c10c4 while fixing sibling 7edd420b, merged as b9c7ea7):
// PtyHost.resumeAfterRateLimit had NO `busy` check anywhere. `POST /api/sessions/:id/rate-limit/clear`
// (gateway/server.ts) calls it unconditionally for ANY live session id — no server-side busy/parked
// guard. `live.lastPrompt` is set by ANY submit() (not just a rate-limit kill), so it's populated on a
// perfectly ordinary, never-parked session too.
//
// Result pre-fix: hitting that REST route (or calling resumeAfterRateLimit directly) against a session
// that is BUSY with an ordinary in-flight turn falls straight through the 7edd420b `stopping`/`drainHeld`
// gate (both false — the session was never parked) into a DIRECT submit() — re-arming a SECOND turn on
// top of the one already running. That's the double-turn hazard the M1/M2 busy-gate ordering exists to
// prevent.
//
// Fix: resumeAfterRateLimit itself now also gates on `live.busy` (defense-in-depth, mirroring
// enqueueStdin's own idle-submit gate re-checking rather than trusting its caller) and skips the replay
// entirely (no submit, no queue) when the session is busy — a busy session was never legitimately parked
// (rateLimited ⇒ !busy), so there is no genuinely-held turn to preserve.
//
// Fully hermetic — a REAL PtyHost driven against a FAKE pty via the same SeamHost seam
// companion-live-upgrade.mjs / resume-after-rate-limit-stop-gate.mjs use (createPty() capture, kill()
// fires the real onExit synchronously) — no real claude, no daemon, no network.
//
// Proves:
//   1. BUSY guard: resumeAfterRateLimit firing while live.busy is true (an ordinary in-flight turn, never
//      parked) does NOT submit a second turn — `submitGeneration` (submit()'s own per-turn counter,
//      bumped exactly once per real submit() call) stays unchanged, and nothing is queued into `pending`
//      either (there's no genuinely-held turn to preserve).
//   2. The NORMAL (unblocked, idle) case is byte-identical to before: resumeAfterRateLimit still submits
//      immediately (submitGeneration bumps, busy becomes true) when the session isn't busy.
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-after-rate-limit-busy-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rate-limit-busy-guard-${Date.now()}-${process.pid}`);
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
      write() {}, // pty writes are no-ops here — nothing auto-completes a submitted turn
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

/** Spawns a fresh session, marks it ready, submits an ORDINARY turn (never parked) — leaving it alive,
 *  busy:true, rateLimited:false, lastPrompt:"ORDINARY_TURN". This is the "never-parked, busy session"
 *  shape the REST route's missing guard lets through. */
function makeBusySession(host, label) {
  const sessionId = `${label}-${randomUUID()}`;
  host.spawn({
    sessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
    resumeId: null, role: "worker", browserTesting: false, documentConversion: false,
    capabilities: [], restrictedTools: false, skills: null,
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const primer = host.enqueueStdin(sessionId, "ORDINARY_TURN", "system");
  if (!primer.delivered) throw new Error(`${label}: setup primer turn did not submit immediately`);
  return sessionId;
}

try {
  // ===================== (1) BUSY guard =====================
  {
    const host = new SeamHost(events);
    const sessionId = makeBusySession(host, "busy");
    check("setup: session is alive", host.isAlive(sessionId));
    check("setup: session is busy (ordinary in-flight turn)", host.isBusy(sessionId) === true);
    check("setup: session was never parked (rateLimited false)", host.live.get(sessionId).rateLimited === false);

    const genBefore = host.live.get(sessionId).submitGeneration;
    const pendingBefore = host.getPending(sessionId).length;

    // Simulates a direct `POST /api/sessions/:id/rate-limit/clear` against this busy, never-parked
    // session — the REST route has no busy/parked guard of its own, so this is exactly what it triggers.
    const resumed = host.resumeAfterRateLimit(sessionId);

    check("(1) resumeAfterRateLimit still reports success (session is alive)", resumed === true);
    check(
      "(1) BUSY: no second submit() fired — submitGeneration unchanged",
      host.live.get(sessionId).submitGeneration === genBefore,
    );
    check(
      "(1) BUSY: the ordinary turn is untouched — still busy (not clobbered/re-armed)",
      host.isBusy(sessionId) === true,
    );
    check(
      "(1) BUSY: nothing queued into pending either (no genuinely-held turn to preserve)",
      host.getPending(sessionId).length === pendingBefore,
    );
  }

  // ===================== (2) the NORMAL (idle, unblocked) case is unchanged =====================
  {
    const host = new SeamHost(events);
    const sessionId = `normal-${randomUUID()}`;
    host.spawn({
      sessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
      resumeId: null, role: "worker", browserTesting: false, documentConversion: false,
      capabilities: [], restrictedTools: false, skills: null,
    });
    host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
    const primer = host.enqueueStdin(sessionId, "PRIMER_TURN", "system");
    if (!primer.delivered) throw new Error("normal: setup primer turn did not submit immediately");
    host.deliverHook(sessionId, { hook_event_name: "StopFailure", error: "rate_limit" }); // parks it: busy:false, rateLimited:true
    check("setup: parked session is alive", host.isAlive(sessionId));
    check("setup: parked session is idle (busy false)", host.isBusy(sessionId) === false);

    const genBefore = host.live.get(sessionId).submitGeneration;
    const resumed = host.resumeAfterRateLimit(sessionId);

    check("(2) resumeAfterRateLimit reports success", resumed === true);
    check(
      "(2) NORMAL: with the session idle, the turn still submits immediately — submitGeneration bumps",
      host.live.get(sessionId).submitGeneration === genBefore + 1,
    );
    check(
      "(2) NORMAL: busy becomes true — unchanged behavior",
      host.isBusy(sessionId) === true,
    );
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resumeAfterRateLimit no longer re-submits lastPrompt as a second turn on top of a busy, never-parked session; the normal idle case is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
