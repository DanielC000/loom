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
process.env.LOOM_RESUME_MODE_POLL_MS = "40"; // fast footer polling for scenario 2's feedback cycle

const { PtyHost, isResumeSummaryGate } = await import("../dist/pty/host.js");

// --- resume-from-summary gate DETECTION (pure fn). collapseBoot is internal; replicate it
// (strip ANSI CSI + all whitespace) to feed realistic boot output. The exact gate text Loom hit:
const GATE = "This session is 1h 16m old and 435.1k tokens. Resuming the full session will consume a "
  + "substantial portion of your usage limits. We recommend resuming from a summary.\n"
  + "❯ 1. Resume from summary (recommended)\n  2. Resume full session as-is\n  3. Don't ask me again";
const collapse = (s) => s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+/g, "");
{
  let f = 0; const ck = (l, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) f++; };
  ck("gate: real summary/as-is gate text is DETECTED", isResumeSummaryGate(collapse(GATE)) === true);
  ck("gate: normal manager prose mentioning 'resume' is NOT a false positive",
    isResumeSummaryGate(collapse("Let me update my living resume doc and continue the loop.")) === false);
  ck("gate: 'resume from summary' alone (no as-is option) is NOT matched",
    isResumeSummaryGate(collapse("we recommend resuming from a summary")) === false);
  if (f) { console.log(`\n❌ ${f} gate-detection FAILURE(S).`); process.exit(1); }
}

const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = null;
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: (cb) => { dataCb = cb; return { dispose() {} }; }, // capture so a test can feed boot bytes
    onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes,
    feed: (s) => { if (dataCb) dataCb(s); }, // simulate engine output reaching host.onData
  };
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
  // Card b99d3d67: the mode-cycle is now FEEDBACK-driven (reads the footer), not blind timing — so this
  // scenario must feed a realistic footer progression for the cycle to actually converge. (No resumeId
  // here would also route through the same feedback cycler via startupModeCycles; resumeId is kept to
  // preserve this block's original "a resumed session" framing, but the routing is now identical either
  // way — see host.ts's SessionStart handler.)
  const B = "sess-resume-B";
  host.spawn({ sessionId: B, cwd: tmpHome, resumeId: "engine-B",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fb = fakes[fakes.length - 1];
  fb.feed("accept edits on (shift+tab to cycle)"); // boot footer already painted before SessionStart fires
  host.enqueueStdin(B, "NUDGE_B");
  host.deliverHook(B, { hook_event_name: "SessionStart" }); // starts the feedback cycle; ready only after it lands
  check("2: NOT ready immediately after SessionStart — cycle in flight, nudge still queued", countIn(fb, PASTE_START) === 0);
  await sleep(750); // > MODE_CYCLE_SETTLE_MS(700) — first footer read (acceptEdits) → press #1
  check("2: NOT ready mid-cycle either — still queued after the first (unconfirmed) press", countIn(fb, PASTE_START) === 0);
  fb.feed("plan mode on (shift+tab to cycle)"); // press #1 registered: footer repaints to plan
  await sleep(150); // > overridden poll (40ms) × a few ticks — the change is observed → press #2
  fb.feed("auto mode on (shift+tab to cycle)"); // press #2 registered: footer repaints to auto (the target)
  await sleep(150);
  check("2: both Shift+Tab mode-cycles were sent", countIn(fb, SHIFT_TAB) === 2);
  check("2: the nudge submitted exactly once after the cycle converged", countIn(fb, PASTE_START) === 1);
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

  // ============ 4) Gate dismissal WIRING: gate boot output → Down then Enter (select "as-is") ============
  const D = "sess-resume-gate";
  host.spawn({ sessionId: D, cwd: tmpHome, resumeId: "engine-D",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fd = fakes[fakes.length - 1];
  fd.feed(GATE);                 // engine prints the resume-from-summary gate (pre-SessionStart)
  await sleep(700);              // > 300ms settle + 150ms gap + slack
  const wd = fd.writes.join("");
  const di = wd.indexOf("\x1b[B"); const ei = wd.indexOf("\r");
  check("4: gate → Down arrow written (moves ❯ off the 'from summary' default)", di >= 0);
  check("4: gate → Enter written AFTER the Down (selects option 2 'as-is')", ei > di && di >= 0);
  check("4: ONLY Down+Enter written (no stray keys before the gate is dismissed)", wd === "\x1b[B\r");
  const wlen = fd.writes.length;
  fd.feed(GATE);                 // a repeat of the gate output must NOT re-fire (handled-once guard)
  await sleep(500);
  check("4: gate handled exactly once per session (no double-select)", fd.writes.length === wlen);
} finally {
  for (const s of ["sess-resume-A", "sess-resume-B", "sess-resume-C", "sess-resume-gate"]) { try { host.stop(s, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-readiness gate holds: injection queues until SessionStart, drains after the mode-cycles, and a missed SessionStart still drains via the fallback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
