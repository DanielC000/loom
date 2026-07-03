// Claude-free regression guard for card b99d3d67 — the FRESH-spawn permission-mode cycle is now
// FEEDBACK-driven (cycleToMode, generalized off the resume-only cycleResumeToMode), not the old blind
// relative sendModeCycles. Blind cycling never verified a press registered, so a dropped/mistimed
// Shift+Tab could half-land a fresh worker on `plan` and STRAND it there (a worker has no ExitPlanMode
// tool to self-exit — `/worker` doctrine forbids addressing the human, and the tool is structurally
// disallowed at spawn). This exercises the REAL PtyHost state machine (spawn/deliverHook/markReady/
// logLandedMode) against a FAKE pty that we feed realistic footer text into, at the createPty() seam
// (mirrors pty-resume-readiness.mjs). No real claude, no daemon, no network.
//
// What it locks:
//   1. A fresh spawn (no resumeId, config startupModeCycles:2) converges to `auto` by READING the footer
//      and pressing Shift+Tab until it lands there — exactly 2 presses, same contract as resume's
//      cycleResumeToMode/cycleToMode (resume-mode-feedback.mjs's "acceptEdits→auto issues exactly 2" case).
//   2. When a press doesn't register (the footer never advances past `plan`), the cycle gives up WITHOUT
//      overshooting — but (per resume-mode-feedback.mjs's new "stuck at plan" case) that raw give-up CAN
//      leave the session resting in `plan`, not `acceptEdits`. The role-gated auto-heal in logLandedMode
//      then catches it for a Loom-driven role with ExitPlanMode disallowed (worker): it now drives the
//      correction through the SAME feedback-verified cycleToMode primitive (card 1658fc22) rather than a
//      single blind press, fired at most once per session (see pty-mode-heal-retry.mjs for the case where
//      the heal's own corrective press doesn't register on the first read).
//   3. The auto-heal is role-scoped: a manager (ExitPlanMode NOT disallowed) resting in `plan` after the
//      same stuck sequence is left alone — the backstop never fights a legitimate human-approved plan.
//
// RUN: pnpm build (repo root) then `node test/pty-mode-convergence.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn). Speed up the
// feedback-cycle polling (defaults: 200ms/15 polls ≈ 3s change-wait) so the "stuck" scenarios below don't
// take multiple seconds each; MODE_CYCLE_SETTLE_MS (700ms, the post-SessionStart settle) and
// MODE_LOG_POLL_MS (500ms, logLandedMode's first read delay) are NOT env-overridable — the sleeps below
// account for both as fixed costs. All must be set BEFORE importing host.js (constants read at import time).
const tmpHome = path.join(os.tmpdir(), `loom-pmc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_RESUME_MODE_POLL_MS = "40";   // fast footer polling
process.env.LOOM_RESUME_MODE_MAX_POLLS = "3";  // change-wait cap ≈ 120ms (a "stuck" give-up resolves fast)
process.env.LOOM_READY_FALLBACK_MS = "9000";   // comfortably longer than any scenario below

const { PtyHost, disallowedToolsForRole } = await import("../dist/pty/host.js");

check("(setup) worker has ExitPlanMode disallowed (the role the auto-heal protects)",
  disallowedToolsForRole("worker").includes("ExitPlanMode"));
check("(setup) manager does NOT have ExitPlanMode disallowed (the auto-heal must never touch it)",
  !disallowedToolsForRole("manager").includes("ExitPlanMode"));

const SHIFT_TAB = "\x1b[Z";
const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
const PLAN_FOOTER = "plan mode on (shift+tab to cycle)";
const AUTO_FOOTER = "auto mode on (shift+tab to cycle)";

const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = null;
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: (cb) => { dataCb = cb; return { dispose() {} }; }, // capture so a test can feed footer bytes
    onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes,
    feed: (s) => { if (dataCb) dataCb(s); }, // simulate engine output reaching host.onData (repaints the ring)
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;
const spawnFresh = (id, role) => {
  host.spawn({
    sessionId: id, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
  });
  return fakes[fakes.length - 1];
};

try {
  // ============ 1) Fresh spawn converges to auto by FEEDBACK — exactly 2 presses, no blind timing ============
  const A = "sess-fresh-A";
  const fa = spawnFresh(A, "worker");
  fa.feed(ACCEPT_EDITS_FOOTER); // boot footer already painted before SessionStart fires (realistic ordering)
  host.deliverHook(A, { hook_event_name: "SessionStart", session_id: "eng-A" });
  await sleep(750); // > MODE_CYCLE_SETTLE_MS(700) — first read (acceptEdits) → decide → press #1
  check("1: fresh spawn issued its FIRST Shift+Tab only after reading a real footer (feedback, not blind)",
    countShiftTabs(fa) === 1);
  fa.feed(PLAN_FOOTER); // the 1st press registered: footer repaints to plan
  await sleep(150); // > overridden poll (40ms) × a few ticks
  check("1: the confirmed plan reading issued the SECOND Shift+Tab", countShiftTabs(fa) === 2);
  fa.feed(AUTO_FOOTER); // the 2nd press registered: footer repaints to auto (the target) — cycle stops
  await sleep(150);
  check("1: fresh spawn converged to auto in EXACTLY 2 presses (matches resume's acceptEdits→auto contract)",
    countShiftTabs(fa) === 2);
  await sleep(600); // let logLandedMode's read (500ms after markReady) settle — auto is not plan, no heal
  check("1: NO auto-heal press fires when the session actually reached auto (not stuck in plan)",
    countShiftTabs(fa) === 2);

  // ============ 2) Stuck mid-cycle: the 2nd press never registers → raw give-up lands on `plan` ============
  // ============    → the role-gated auto-heal (worker) corrects it with ONE more Shift+Tab ============
  const B = "sess-fresh-worker-stuck";
  const fb = spawnFresh(B, "worker");
  fb.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(B, { hook_event_name: "SessionStart", session_id: "eng-B" });
  await sleep(750);
  check("2: 1st press issued (acceptEdits → plan attempt)", countShiftTabs(fb) === 1);
  fb.feed(PLAN_FOOTER); // 1st press registers
  await sleep(150);
  check("2: 2nd press issued (plan → auto attempt)", countShiftTabs(fb) === 2);
  // Do NOT feed anything further — the 2nd press is dropped/never observed, simulating the exact failure
  // this task fixes. The change-wait cap (overridden ≈120ms) expires and the cycle gives up AT plan.
  await sleep(400); // > change-wait cap; the raw cycler has now finished (give-up), landed mode = plan
  check("2: the RAW cycler gave up WITHOUT a 3rd blind press (bounded, never infinite/overshooting)",
    countShiftTabs(fb) === 2);
  // The heal now routes through cycleToMode (card 1658fc22), which adds its OWN MODE_CYCLE_SETTLE_MS
  // (700ms, fixed) settle delay before its first read — on top of logLandedMode's MODE_LOG_POLL_MS(500)
  // read delay — before the corrective press is issued.
  await sleep(1500); // MODE_LOG_POLL_MS(500) + MODE_CYCLE_SETTLE_MS(700) + slack for both reads + the write
  check("2: AUTO-HEAL fired a 3rd Shift+Tab — a worker is NEVER left stranded in plan",
    countShiftTabs(fb) === 3);
  const healCountAtFirstRead = countShiftTabs(fb);
  await sleep(700);
  check("2: the auto-heal fires AT MOST ONCE per session (modeLogged guard — no repeat correction)",
    countShiftTabs(fb) === healCountAtFirstRead);

  // ============ 3) Same stuck-at-plan sequence for a MANAGER — the auto-heal must NOT fire ============
  // (a manager is deliberately excluded from disallowedToolsForRole's ExitPlanMode-disallowed set — it can
  // legitimately be in plan mode surfacing a decision to the human, so the backstop must never touch it.)
  const C = "sess-fresh-manager-stuck";
  const fc = spawnFresh(C, "manager");
  fc.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(C, { hook_event_name: "SessionStart", session_id: "eng-C" });
  await sleep(750);
  fc.feed(PLAN_FOOTER);
  await sleep(150);
  check("3: manager also confirms 2 cycle presses (identical convergence attempt to a worker)",
    countShiftTabs(fc) === 2);
  await sleep(1300); // change-wait cap + MODE_LOG_POLL_MS + slack — enough for a heal to have fired if it would
  check("3: NO auto-heal press for a manager stranded in plan (role-gated — never fights a legitimate plan)",
    countShiftTabs(fc) === 2);
} finally {
  for (const s of ["sess-fresh-A", "sess-fresh-worker-stuck", "sess-fresh-manager-stuck"]) {
    try { host.stop(s, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fresh spawn converges to its target mode by reading the footer (not blind timing), "
    + "a dropped press's worst case is caught by the role-gated plan auto-heal (fires once, worker-only, "
    + "never touches a manager) — a Loom-driven worker can never be silently stranded in plan mode."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
