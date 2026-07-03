// Claude-free regression guard for card 1658fc22 — the plan auto-heal in logLandedMode (pty/host.ts) is
// now FEEDBACK-VERIFIED (routed through the same cycleToMode primitive the main convergence path uses),
// not a single fire-and-forget Shift+Tab. Before this fix, the heal wrote ONE Shift+Tab and never checked
// whether it registered — if that single corrective press also dropped under load, a Loom-driven worker
// (no ExitPlanMode to self-exit) stayed stranded in `plan` PERMANENTLY (the modeLogged guard means the
// heal never gets a second chance). pty-mode-convergence.mjs covers the heal FIRING; it does NOT cover
// the case where the heal's own corrective press doesn't register on the first read(s) — the exact gap
// this test closes. This exercises the REAL PtyHost state machine (spawn/deliverHook/markReady/
// logLandedMode/cycleToMode) against a FAKE pty fed realistic footer text, at the createPty() seam
// (mirrors pty-mode-convergence.mjs). No real claude, no daemon, no network.
//
// What it locks:
//   1. A worker's main mode-cycle gets stuck at `plan` (its 2nd press is never observed), landing the
//      role-gated auto-heal — same setup as pty-mode-convergence.mjs's scenario 2.
//   2. The heal's OWN corrective press (issued via cycleToMode, not a blind write) is fed a footer that
//      STAYS at `plan` for a few reads (simulating a laggy/dropped-looking repaint under load) before
//      finally clearing to `auto` — i.e. the press's effect doesn't register on the FIRST read(s).
//   3. The heal RECOVERS: it keeps polling (bounded, per cycleToMode's change-wait loop) rather than
//      giving up after a single unconfirmed read, observes the eventual change, and converges to `auto` —
//      asserted both by the Shift+Tab count (exactly one corrective press — no overshoot) and by the
//      cycleToMode completion log line explicitly recording `reached ... (mode=auto)` for the heal's cycle
//      (distinguishing genuine convergence from a second give-up).
//
// Uses condition-polling (waitUntil) rather than fixed sleeps to size each wait, since the exact instant a
// timer-chained read/press lands is not worth hand-computing precisely and a fixed sleep either races the
// event (flaky) or over-waits (slow) — only the FEED of the clearing footer partway through the heal's
// change-wait window needs a deliberately-bounded delay, which is called out explicitly below.
//
// RUN: pnpm build (repo root) then `node test/pty-mode-heal-retry.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, timeoutMs, intervalMs = 20) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(intervalMs);
  }
  return true;
};

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn). Widen the
// feedback-cycle CHANGE-WAIT window (defaults: 200ms/15 polls ≈ 3s) to a deterministic, generous ~600ms
// (40ms × 15 polls) so the test has clear room to feed the clearing footer partway through it. MODE_CYCLE_
// SETTLE_MS (700ms, cycleToMode's own pre-first-read settle) and MODE_LOG_POLL_MS (500ms, logLandedMode's
// first read delay) are NOT env-overridable. All must be set BEFORE importing host.js (constants read at
// import time).
const tmpHome = path.join(os.tmpdir(), `loom-pmhr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_RESUME_MODE_POLL_MS = "40";
process.env.LOOM_RESUME_MODE_MAX_POLLS = "15"; // change-wait window ≈ 600ms
process.env.LOOM_READY_FALLBACK_MS = "9000";

const { PtyHost, disallowedToolsForRole } = await import("../dist/pty/host.js");

check("(setup) worker has ExitPlanMode disallowed (the role the auto-heal protects)",
  disallowedToolsForRole("worker").includes("ExitPlanMode"));

const SHIFT_TAB = "\x1b[Z";
const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
const PLAN_FOOTER = "plan mode on (shift+tab to cycle)";
const AUTO_FOOTER = "auto mode on (shift+tab to cycle)";

// Capture the cycleToMode completion log lines ("[resume-mode] <id> cycle→<target>: <reason> after N
// press(es) (mode=<mode>)") so we can assert the HEAL's cycle specifically reached its target, not merely
// stopped pressing (which "footer-unchanged"/"press-cap" would ALSO leave the Shift+Tab count unchanged).
const cycleLogLines = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  if (line.includes("cycle→")) cycleLogLines.push(line);
  realLog(...args);
};

const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = null;
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: (cb) => { dataCb = cb; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes,
    feed: (s) => { if (dataCb) dataCb(s); },
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;
const cycleAutoLines = () => cycleLogLines.filter((l) => l.includes("cycle→auto:"));
const SID = "sess-heal-retry-worker";

try {
  host.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker",
  });
  const f = fakes[fakes.length - 1];

  // ---- Stall the MAIN convergence at `plan` (same setup as pty-mode-convergence.mjs's scenario 2) ----
  f.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: "eng-heal-retry" });
  check("main cycle issued its 1st Shift+Tab (acceptEdits→plan attempt)",
    await waitUntil(() => countShiftTabs(f) === 1, 2000));
  f.feed(PLAN_FOOTER); // 1st press registers
  check("main cycle issued its 2nd Shift+Tab (plan→auto attempt)",
    await waitUntil(() => countShiftTabs(f) === 2, 1000));
  // Do NOT feed anything further for this 2nd press — it's dropped, so the main cycle's change-wait
  // window (≈600ms) expires and it gives up landing AT plan (mirrors pty-mode-convergence.mjs scenario 2).
  check("main cycle gave up WITHOUT a 3rd blind press (bounded, landed at plan)",
    await waitUntil(() => cycleAutoLines().some((l) => l.includes("footer-unchanged") && l.includes("after 2 press")), 1500));
  check("count stayed at 2 through the main cycle's give-up (no overshoot)", countShiftTabs(f) === 2);

  // ---- The auto-heal fires (role-gated, worker) via cycleToMode — its FIRST read + press ----
  // logLandedMode's tryRead fires MODE_LOG_POLL_MS(500ms) after markReady; cycleToMode then adds its OWN
  // MODE_CYCLE_SETTLE_MS(700ms) settle before its first read/press. Give it generous headroom.
  check("auto-heal issued its corrective Shift+Tab (3rd overall) via cycleToMode, not a blind write",
    await waitUntil(() => countShiftTabs(f) === 3, 2500));
  // At this point the heal's cycleToMode is inside its awaitChange poll loop, waiting to observe the
  // footer actually move off `plan`. We have NOT fed anything since PLAN_FOOTER above, so a read right now
  // still sees `plan` — the corrective press's effect has NOT registered yet on these early reads.

  // ---- The corrective press's effect only becomes observable after a few reads (simulated repaint lag
  // ---- under load) — feed the clearing footer partway through the ≈600ms change-wait window. ----
  await sleep(150); // a handful of 40ms polls have elapsed reading `plan` — well short of the ≈600ms cap
  check("still only 3 Shift+Tabs while the corrective press's effect isn't yet observable", countShiftTabs(f) === 3);
  check("the heal's cycle has NOT given up yet — still polling, not a second finish", cycleAutoLines().length === 1);
  f.feed(AUTO_FOOTER); // the press's effect finally shows up in the footer

  check("the heal's cycleToMode logged a genuine 'reached' completion (mode=auto) — not a second give-up",
    await waitUntil(() => cycleAutoLines().length === 2, 1000));
  const healLine = cycleAutoLines()[1];
  check("the reached line is for the heal's single press, converged to auto",
    /reached after 1 press\(s\) \(mode=auto\)/.test(healLine) || (healLine.includes("reached") && /\(mode=auto\)/.test(healLine)));
  check("auto-heal RECOVERED with exactly ONE corrective press (no overshoot)", countShiftTabs(f) === 3);

  // ---- Guard: no further pressing after convergence (modeLogged fires the heal at most once). ----
  await sleep(400);
  check("no further Shift+Tab after the heal converged (modeLogged guard — no repeat correction)",
    countShiftTabs(f) === 3);
} finally {
  console.log = realLog;
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the plan auto-heal recovers even when its own corrective press doesn't register on "
    + "the first read(s): it keeps polling (bounded, feedback-verified via cycleToMode) instead of giving "
    + "up after a single unconfirmed blind write, so a dropped-looking heal press can no longer permanently "
    + "strand a Loom-driven worker in plan mode."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
