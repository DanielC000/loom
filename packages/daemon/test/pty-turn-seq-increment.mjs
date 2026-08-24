import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// HOST-LEVEL test for card 343441bd's turn-completion counter (staleDirective's clock) — the increment
// IS the feature's entire clock, so this drives a REAL PtyHost (no db, no claude, no network — the same
// SeamHost fake-pty seam resume-after-rate-limit-stop-gate.mjs / companion-live-upgrade.mjs use) through
// actual Stop/StopFailure hook delivery and counts calls to a stub `events.onTurnCompleted`.
//
// Code-review finding (this card, round 1): the increment originally fired at the Stop/StopFailure
// `setBusy(false, "stop-hook")` falling edge — BEFORE the two usage-cap PARK breaks (§19c rate-limit
// StopFailure, the weekly-cap text sentinel). A rate-limited worker replaying ONE directive turn via
// #19c-b resume would increment on each CAPPED attempt with no worker_report, false-firing
// staleDirective even though the worker never had a real opportunity to act — the same "no real
// opportunity" reasoning give-up-recovery's setBusy(false) sites are already excluded for. Fixed by
// moving the call to immediately before `drainPending`, after both park breaks.
//
// Proves:
//   (a) a CLEAN Stop advances the counter EXACTLY ONCE.
//   (b) a rate-limit StopFailure PARK does NOT advance the counter at all (the false-fire this card's
//       review caught).
//   (c) a clean Stop immediately AFTER a park (once unparked) still advances exactly once — the park
//       breaks don't leave the call site permanently short-circuited for the SAME session.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-turn-seq-increment.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-turn-seq-increment-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// Shared _seam-host-fixture.mjs base: captures every SpawnOpts; kill() fires the REAL onExit callback the
// base PtyHost.spawn() registers — alive/dead tracking is real. Distinct pids kept for parity via a spread.
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    return { ...super.createPty(opts), pid: 4242 + this.capture.length };
  }
}

const cwd = path.join(tmpHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });

function makeHost() {
  const turnCompletedCalls = [];
  const events = {
    onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
    onTurnCompleted(id) { turnCompletedCalls.push(id); },
  };
  return { host: new SeamHost(events), turnCompletedCalls };
}

/** Spawns a fresh session, marks it ready, and submits a primer turn (delivered immediately). */
function makeReadySession(host, label) {
  const sessionId = `${label}-${randomUUID()}`;
  host.spawn({
    sessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
    resumeId: null, role: "worker", browserTesting: false, documentConversion: false,
    capabilities: [], restrictedTools: false, skills: null,
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const primer = host.enqueueStdin(sessionId, "PRIMER_TURN", "system");
  if (!primer.delivered) throw new Error(`${label}: setup primer turn did not submit immediately`);
  return sessionId;
}

try {
  // ===================== (a) a CLEAN Stop advances the counter EXACTLY ONCE =====================
  {
    const { host, turnCompletedCalls } = makeHost();
    const sessionId = makeReadySession(host, "clean-stop");
    check("setup: session is busy after the primer submit", host.isBusy(sessionId) === true);

    host.deliverHook(sessionId, { hook_event_name: "Stop" });

    check("(a) a clean Stop advances turn_seq exactly once", turnCompletedCalls.length === 1);
    check("(a) the call names the right session", turnCompletedCalls[0] === sessionId);
    check("(a) busy falls back to false after the clean Stop", host.isBusy(sessionId) === false);
  }

  // ===================== (b) a rate-limit StopFailure PARK does NOT advance the counter =====================
  {
    const { host, turnCompletedCalls } = makeHost();
    const sessionId = makeReadySession(host, "rate-limit-park");

    host.deliverHook(sessionId, { hook_event_name: "StopFailure", error: "rate_limit" });

    check("(b) a rate-limit park does NOT advance turn_seq — the false-fire this review caught",
      turnCompletedCalls.length === 0);
    check("(b) the session is still alive (parked, not killed)", host.isAlive(sessionId));
    check("(b) busy is false (parked, not mid-turn)", host.isBusy(sessionId) === false);
  }

  // ===================== (c) a clean Stop right after a park still counts exactly once =====================
  // Proves the park breaks don't leave the SAME session's call site permanently short-circuited —
  // only the parked turn itself is excluded, not every future turn on that session.
  {
    const { host, turnCompletedCalls } = makeHost();
    const sessionId = makeReadySession(host, "park-then-clean");

    host.deliverHook(sessionId, { hook_event_name: "StopFailure", error: "rate_limit" });
    check("(c) setup: the park itself does not count", turnCompletedCalls.length === 0);

    const resumed = host.resumeAfterRateLimit(sessionId);
    check("(c) setup: resumeAfterRateLimit replays the held prompt", resumed === true && host.isBusy(sessionId) === true);

    host.deliverHook(sessionId, { hook_event_name: "Stop" });
    check("(c) the FOLLOWING clean Stop advances turn_seq exactly once (the park alone was excluded, not the session)",
      turnCompletedCalls.length === 1);
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — onTurnCompleted fires exactly once per GENUINE Stop/StopFailure completion, is correctly suppressed for a usage-cap park (the false-fire code review caught), and resumes counting normally on the very next clean Stop for the same session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
