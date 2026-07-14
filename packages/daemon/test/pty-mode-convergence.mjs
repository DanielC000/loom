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
//   4. WIDENED (card 9c03f5a6): the heal's trigger is no longer plan-only — a worker whose VERY FIRST
//      press never registers gives up resting at `acceptEdits` (short of the `auto` target), the OTHER
//      stall the owner named ("a worker in acceptEdits hitting a non-allowlisted command prompt"). The
//      heal now fires for ANY landed mode that isn't the session's own computed target, not just `plan`.
//   5. FIXED (card 67593ddd): the heal's destination is the session's ACTUAL configured target (the SAME
//      `resumeModeTarget ?? modeAfterCyclesFromAcceptEdits(startupModeCycles)` expression the main
//      convergence path computes), not a hardcoded `auto` — so a worker that cleanly reaches its OWN
//      non-auto target (e.g. `startupModeCycles:3` → `default`) is left there (scenario 5 below).
//   6. FIXED (card 67593ddd), the RESUME side of the same asymmetry: SessionService.resume ALWAYS pins
//      `startupModeCycles:0` AND ALWAYS passes an explicit `resumeModeTarget` (never null — for a
//      `startupModeCycles:0` config that's `modeAfterCyclesFromAcceptEdits(0)` = `acceptEdits`), so the OLD
//      `noCyclingConfigured` guard (`startupModeCycles===0 && resumeModeTarget==null`) was structurally
//      never-true on resume and the heal force-cycled such a session to hardcoded `auto` — contradicting a
//      config that deliberately wants NO cycling, and contradicting a FRESH spawn of the identical config
//      (which correctly stayed at `acceptEdits`). A resumed `startupModeCycles:0` session now stays at
//      `acceptEdits` too (scenario 7), while a resumed shipping-default (`startupModeCycles:2`) session that
//      gets stuck mid-cycle is still healed to `auto` exactly as before (scenario 8 — no regression).
//
// RUN: pnpm build (repo root) then `node test/pty-mode-convergence.mjs` from packages/daemon.
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
const DEFAULT_FOOTER = "(shift+tab to cycle)"; // no mode label — the unlabeled "default" state
// detectPermissionMode reads only the trailing 8192 bytes of the ring and picks the LAST labeled token —
// transitioning TO the unlabeled "default" state emits no label of its own, so a stale earlier label still
// sitting in that trailing window would otherwise win. Pad the ring past that window first so the read
// sees ONLY the fresh (unlabeled) content — a test-harness accommodation, not a production behavior change
// (mirrors pty-mode-race.mjs's identical accommodation).
const RING_WINDOW_PAD = "x".repeat(8300);

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
const spawnFresh = (id, role, startupModeCycles = 2) => {
  host.spawn({
    sessionId: id, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
  });
  return fakes[fakes.length - 1];
};
// Mirrors SessionService.resume's actual contract (service.ts): startupModeCycles is ALWAYS pinned to 0 on
// the resume spawn, and resumeModeTarget is ALWAYS passed explicitly, derived from the PROJECT'S configured
// cycles via the SAME modeAfterCyclesFromAcceptEdits map a fresh spawn uses — so `resumeTarget` here is what
// a real caller would compute for a given `configuredCycles`, not an independent free choice.
const spawnResume = (id, role, resumeTarget) => {
  host.spawn({
    sessionId: id, cwd: tmpHome, resumeId: `eng-${id}`,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    resumeModeTarget: resumeTarget,
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

  // ============ 4) Stuck at the START: the 1st press never registers → raw give-up lands on `acceptEdits` ============
  // ============    → the WIDENED auto-heal (card 9c03f5a6) still corrects it — not just a plan landing ============
  // Before the widening, logLandedMode only healed `mode==="plan"` — a worker resting at `acceptEdits`
  // (short of its `auto` target) had NO backstop, and could hit exactly the OTHER trap the owner named: a
  // non-allowlisted command prompts for approval nobody can answer.
  const D = "sess-fresh-worker-stuck-start";
  const fd = spawnFresh(D, "worker");
  fd.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(D, { hook_event_name: "SessionStart", session_id: "eng-D" });
  await sleep(750);
  check("4: 1st press issued (acceptEdits → plan attempt)", countShiftTabs(fd) === 1);
  // Do NOT feed anything — the 1st press itself never registers, simulating a dropped/mistimed VERY FIRST
  // keystroke. The change-wait cap (overridden ≈120ms) expires and the raw cycler gives up AT acceptEdits
  // (the pre-press mode — `finish` reports whatever `cur` was, and no change was ever confirmed).
  await sleep(400);
  check("4: the RAW cycler gave up WITHOUT a 2nd blind press, resting at the boot default (acceptEdits)",
    countShiftTabs(fd) === 1);
  // The widened heal fires (mode=acceptEdits !== target=auto, ExitPlanMode disallowed for worker) and
  // drives its OWN cycleToMode(target:"auto") — needing 2 presses from acceptEdits (acceptEdits→plan→auto).
  // Unlike scenario 2's single-press heal, THIS heal needs a 2nd corrective press too, so its own
  // change-wait window (overridden ≈120ms) must be fed WITHIN that window — poll for each press instead
  // of a long fixed sleep, or the heal's own cycle would give up mid-correction exactly like scenario 2's
  // ORIGINAL failure (a test-timing pitfall, not a production one).
  check("4: WIDENED auto-heal fired a 2nd Shift+Tab (acceptEdits → plan attempt) — not just for a plan landing",
    await waitUntil(() => countShiftTabs(fd) === 2, 2500));
  fd.feed(PLAN_FOOTER); // the heal's 1st corrective press registers — feed it promptly, inside the ≈120ms window
  check("4: heal's 2nd corrective press issued (plan → auto attempt)",
    await waitUntil(() => countShiftTabs(fd) === 3, 1000));
  fd.feed(AUTO_FOOTER); // the heal's 2nd corrective press registers — reaches the target
  await sleep(150);
  check("4: heal converged the worker to auto (2 corrective presses) — never left stranded at acceptEdits",
    countShiftTabs(fd) === 3);
  const healCountScenario4 = countShiftTabs(fd);
  await sleep(700);
  check("4: the widened heal also fires AT MOST ONCE per session (modeLogged guard)",
    countShiftTabs(fd) === healCountScenario4);

  // ============ 5) A role reaches `default` cleanly (its OWN configured target, startupModeCycles:3) ============
  // ============    — the heal (card 67593ddd) now targets the session's ACTUAL configured target, not a ============
  // ============    hardcoded `auto`, so it fires (HEALABLE_MODES still includes `default`, unconditionally, ============
  // ============    not only on a give-up/failure landing) but its OWN cycleToMode sees current===target ============
  // ============    immediately and presses NOTHING further — the old hardcoded-auto special case (which ============
  // ============    would have chased this worker 3 more presses past its own correctly-reached target) is gone. ============
  const E = "sess-fresh-worker-default-target";
  const fe = spawnFresh(E, "worker", 3); // startupModeCycles:3 → the session's OWN target is "default"
  fe.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(E, { hook_event_name: "SessionStart", session_id: "eng-E" });
  await sleep(750);
  check("5: 1st press issued (acceptEdits → plan attempt)", countShiftTabs(fe) === 1);
  fe.feed(PLAN_FOOTER);
  await sleep(150);
  check("5: 2nd press issued (plan → auto attempt)", countShiftTabs(fe) === 2);
  fe.feed(AUTO_FOOTER);
  await sleep(150);
  check("5: 3rd press issued (auto → default attempt)", countShiftTabs(fe) === 3);
  fe.feed(RING_WINDOW_PAD + DEFAULT_FOOTER);
  await sleep(150);
  check("5: the RAW cycler cleanly reached ITS OWN target `default` in exactly 3 presses (no give-up)",
    countShiftTabs(fe) === 3);
  await sleep(1500); // MODE_LOG_POLL_MS(500) + MODE_CYCLE_SETTLE_MS(700) + slack — enough for a heal press to have fired if it would
  check("5: NO further heal press — the heal's target IS `default` (this session's own config), " +
    "not the hardcoded `auto` the pre-fix heal would have chased it toward",
    countShiftTabs(fe) === 3);

  // ============ 6) A footer that NEVER becomes readable ("unknown") triggers NO auto-heal ============
  // ============    — the load-bearing invariant "no correction without a definite read" survives the widening ============
  const F = "sess-fresh-worker-unknown";
  const ff2 = spawnFresh(F, "worker");
  // Deliberately feed NOTHING — the footer is never painted, so every read (the main cycle's AND
  // logLandedMode's) is "unknown" through both polling windows.
  host.deliverHook(F, { hook_event_name: "SessionStart", session_id: "eng-F" });
  await sleep(6000); // > MODE_CYCLE_SETTLE_MS + the raw cycle's own give-up window + logLandedMode's full poll cap
  check("6: the raw main cycle issued ZERO presses (never had a definite footer to decide from)",
    countShiftTabs(ff2) === 0);
  check("6: NO auto-heal press fires for an unreadable footer — HEALABLE_MODES excludes 'unknown' by construction",
    countShiftTabs(ff2) === 0);

  // ============ 7) RESUME asymmetry FIX (card 67593ddd): a `startupModeCycles:0` config stays at ============
  // ============    `acceptEdits` on RESUME too — no force-cycle to the old hardcoded `auto` ============
  // configuredCycles:0 → resumeModeTarget = modeAfterCyclesFromAcceptEdits(0) = "acceptEdits" (never null),
  // exactly as SessionService.resume computes it. Pre-fix this session would land here (noCyclingConfigured
  // was structurally false on resume) and get force-cycled to "auto" despite the config wanting NO cycling.
  const G = "sess-resume-worker-cycles0";
  const fg = spawnResume(G, "worker", "acceptEdits");
  fg.feed(ACCEPT_EDITS_FOOTER); // boot footer already painted before SessionStart fires
  host.deliverHook(G, { hook_event_name: "SessionStart", session_id: "eng-G" });
  await sleep(750); // > MODE_CYCLE_SETTLE_MS — main convergence reads acceptEdits === its own target, 0 presses
  check("7: main convergence issued ZERO presses (resume already at its own configured target, acceptEdits)",
    countShiftTabs(fg) === 0);
  await sleep(1500); // MODE_LOG_POLL_MS + MODE_CYCLE_SETTLE_MS + slack — long enough for the OLD hardcoded-auto heal to have fired
  check("7: FIXED — no auto-heal press on resume for a startupModeCycles:0 config (stays at acceptEdits, " +
    "matching a FRESH spawn of the identical config — the asymmetry this task closes)",
    countShiftTabs(fg) === 0);

  // ============ 8) REGRESSION GUARD: a resumed shipping-default (startupModeCycles:2) session that gets ============
  // ============    stuck mid-cycle is STILL healed to `auto` — the fix must not weaken the common case ============
  const H = "sess-resume-worker-cycles2-stuck";
  const fh = spawnResume(H, "worker", "auto"); // configuredCycles:2 → resumeModeTarget = "auto"
  fh.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(H, { hook_event_name: "SessionStart", session_id: "eng-H" });
  await sleep(750);
  check("8: main convergence issued its 1st Shift+Tab (acceptEdits → plan attempt)", countShiftTabs(fh) === 1);
  fh.feed(PLAN_FOOTER); // 1st press registers
  await sleep(150);
  check("8: main convergence issued its 2nd Shift+Tab (plan → auto attempt)", countShiftTabs(fh) === 2);
  // Do NOT feed anything further — the 2nd press drops, main cycle gives up at plan (mirrors scenario 2).
  await sleep(400);
  check("8: main cycle gave up WITHOUT a 3rd blind press, landed at plan", countShiftTabs(fh) === 2);
  check("8: the role-gated heal STILL fires and corrects a stuck RESUME to its configured target `auto`",
    await waitUntil(() => countShiftTabs(fh) === 3, 2500));
  fh.feed(AUTO_FOOTER);
  await sleep(150);
  check("8: resume converged to auto via the heal (1 corrective press) — the common case is not regressed",
    countShiftTabs(fh) === 3);
} finally {
  for (const s of [
    "sess-fresh-A", "sess-fresh-worker-stuck", "sess-fresh-manager-stuck", "sess-fresh-worker-stuck-start",
    "sess-fresh-worker-default-target", "sess-fresh-worker-unknown",
    "sess-resume-worker-cycles0", "sess-resume-worker-cycles2-stuck",
  ]) {
    try { host.stop(s, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fresh spawn converges to its target mode by reading the footer (not blind timing), "
    + "a dropped press's worst case is caught by the role-gated auto-heal (fires once, worker-only, never "
    + "touches a manager) — WIDENED to correct ANY landed mode short of the session's target, not just a "
    + "plan landing — so a Loom-driven worker can never be silently stranded in plan OR left short at "
    + "acceptEdits (the other unattended-prompt trap). The heal's destination is now the session's OWN "
    + "configured target, not a hardcoded auto, closing the fresh/resume asymmetry where a startupModeCycles:0 "
    + "config was honoured fresh but force-cycled to auto on resume."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
