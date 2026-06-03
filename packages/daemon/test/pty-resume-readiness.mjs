// Claude-free regression guard for the BOOT-READINESS gate (pty/host.ts) — the fix for the
// 2026-06-03 daemon-restart bug where a resumed session's injected nudge stranded un-submitted in the
// composer and the permission mode stuck mid-cycle on plan.
//
// Root cause: boot-recovery called enqueueStdin right after resume(); resume sets busy=false, and the
// OLD enqueueStdin submitted whenever !busy — but `busy` only means "turn in flight", not "engine
// booted". So the bracketed-paste + Enter went into a still-booting TUI: the Enter was swallowed (text
// stranded), and it interleaved with the SessionStart mode-cycle Shift+Tabs (mode stuck on plan).
//
// The fix adds a `ready` flag, flipped on the first SessionStart AFTER the mode-cycles land. Injection
// (enqueueStdin / drainPending) now requires `ready`, so a boot nudge QUEUES until the composer is live
// and the mode has settled, then submits cleanly — AND strictly after the Shift+Tabs.
//
// This exercises the real PtyHost state machine against a FAKE pty (the createPty seam). No real claude.
// RUN: pnpm build (from packages/daemon) then `node test/pty-resume-readiness.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn). Set the
// readiness fallback long enough that it can't fire before the cycles complete in the ordering test,
// but short enough that the fallback test below doesn't take 20s. BOTH must be set BEFORE importing
// host.js (constants are read at import time).
const tmpHome = path.join(os.tmpdir(), `loom-readytest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_READY_FALLBACK_MS = "2500";

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = { pid: 4242, write: (d) => writes.push(d), onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const busyLog = [];
const events = { onEngineSessionId() {}, onBusy(_i, b) { busyLog.push(b); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const PASTE_START = "\x1b[200~";
const SHIFT_TAB = "\x1b[Z";
const writtenOf = (fake) => fake.writes.join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;

try {
  // ============ 1) Ready-gate: enqueue before SessionStart QUEUES; SessionStart drains it ============
  // Resume spawn (resumeId set), no mode-cycles → SessionStart marks ready synchronously.
  const A = "sess-resume-A";
  host.spawn({ sessionId: A, cwd: tmpHome, resumeId: "engine-A",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fa = fakes[fakes.length - 1];
  const rBefore = host.enqueueStdin(A, "NUDGE_A");
  check("1: enqueue before SessionStart is QUEUED, not delivered", rBefore.delivered === false && rBefore.position === 1);
  check("1: nothing written to the booting TUI yet (no bracketed paste)", countIn(fa, PASTE_START) === 0);
  check("1: pending holds the nudge", JSON.stringify(host.getPending(A)) === JSON.stringify(["NUDGE_A"]));

  host.deliverHook(A, { hook_event_name: "SessionStart" });
  check("1: SessionStart marked ready and DRAINED the nudge (one bracketed paste)", countIn(fa, PASTE_START) === 1);
  check("1: the nudge text was written", writtenOf(fa).includes("NUDGE_A"));
  check("1: queue is now empty", host.getPending(A).length === 0);
  check("1: busy re-armed for the drained turn", busyLog[busyLog.length - 1] === true);

  // ============ 2) Ordering: on resume the mode-cycles land BEFORE the injection submits ============
  const B = "sess-resume-B";
  host.spawn({ sessionId: B, cwd: tmpHome, resumeId: "engine-B",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fb = fakes[fakes.length - 1];
  host.enqueueStdin(B, "NUDGE_B");
  host.deliverHook(B, { hook_event_name: "SessionStart" }); // starts the 2 mode-cycles; ready only after they land
  check("2: NOT ready immediately after SessionStart — cycles in flight, nudge still queued", countIn(fb, PASTE_START) === 0);
  await sleep(1400); // > MODE_CYCLE_SETTLE_MS(700) + 2*MODE_CYCLE_INTERVAL_MS(120) + slack
  check("2: both Shift+Tab mode-cycles were sent", countIn(fb, SHIFT_TAB) === 2);
  check("2: the nudge submitted exactly once after the cycles", countIn(fb, PASTE_START) === 1);
  check("2: ORDERING — the Shift+Tabs were written BEFORE the bracketed paste",
    writtenOf(fb).indexOf(SHIFT_TAB) >= 0 && writtenOf(fb).indexOf(SHIFT_TAB) < writtenOf(fb).indexOf(PASTE_START));

  // ============ 3) Fallback: a missed SessionStart still drains the nudge after the grace ============
  const C = "sess-resume-C";
  host.spawn({ sessionId: C, cwd: tmpHome, resumeId: "engine-C",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fc = fakes[fakes.length - 1];
  host.enqueueStdin(C, "NUDGE_C");
  check("3: queued, and held (no SessionStart delivered)", host.getPending(C).length === 1 && countIn(fc, PASTE_START) === 0);
  await sleep(2900); // > LOOM_READY_FALLBACK_MS(2500)
  check("3: readiness fallback drained the nudge despite no SessionStart", countIn(fc, PASTE_START) === 1 && writtenOf(fc).includes("NUDGE_C"));
} finally {
  for (const s of ["sess-resume-A", "sess-resume-B", "sess-resume-C"]) { try { host.stop(s, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-readiness gate holds: injection queues until SessionStart, drains after the mode-cycles, and a missed SessionStart still drains via the fallback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
