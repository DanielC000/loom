import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1) — belt-and-suspenders, this test touches no db
// HERMETIC regression guard for the PURE cycle-decision logic behind the RESUME mode-convergence loop
// (host.ts nextCycleAction + modeAfterCyclesFromAcceptEdits; board card f05e4897). No real claude, no
// daemon, no pty — pure functions + a string→action simulator under test.
//
// What it locks:
//   1. modeAfterCyclesFromAcceptEdits — the empirical Shift+Tab cycle order from the acceptEdits boot
//      mode (acceptEdits →+1 plan →+2 auto →+3 default →+4 acceptEdits, period 4), incl. wrap + negatives.
//      This is how SessionService.resume derives a resume's TARGET mode from the SAME startupModeCycles a
//      fresh spawn uses, so resume lands where fresh lands (default 2 → auto).
//   2. nextCycleAction — the per-step decision: at the target → done; out of presses → giveup; else press.
//   3. A SEQUENCE simulator that mirrors the real loop (decide → press → observe the changed footer mode →
//      decide …): given the modes the footer reads after each press, it must issue the RIGHT number of
//      Shift+Tabs and stop at the target / at the cap. This is the table-driven proof the DoD asks for.
//
// RUN: pnpm build (repo root) then `node test/resume-mode-feedback.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = path.join(os.tmpdir(), `loom-rmf-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome; // host.ts reads paths at import time

const { nextCycleAction, modeAfterCyclesFromAcceptEdits } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ───────────────────────── 1. modeAfterCyclesFromAcceptEdits (the cycle map) ─────────────────────────
const MAP = [
  [0, "acceptEdits"], // boot mode (0 presses)
  [1, "plan"],
  [2, "auto"],        // ← the default config (startupModeCycles:2) target = the owner's required mode
  [3, "default"],
  [4, "acceptEdits"], // wraps (period 4)
  [5, "plan"],
  [6, "auto"],
  [-1, "default"],    // negative wraps too (−1 ≡ +3)
  [-2, "auto"],
];
for (const [cycles, expected] of MAP) {
  check(`modeAfterCyclesFromAcceptEdits(${cycles}) = ${expected}`, modeAfterCyclesFromAcceptEdits(cycles) === expected);
}
// non-integers are truncated (a config never sets one, but the map must not throw / NaN-index)
check("modeAfterCyclesFromAcceptEdits(2.9) truncates to 2 → auto", modeAfterCyclesFromAcceptEdits(2.9) === "auto");

// ───────────────────────── 2. nextCycleAction (per-step decision) ─────────────────────────
check("at the target → done", nextCycleAction({ current: "auto", target: "auto", presses: 0, maxPresses: 4 }) === "done");
check("at the target even with presses spent → done", nextCycleAction({ current: "auto", target: "auto", presses: 3, maxPresses: 4 }) === "done");
check("below the target, presses remain → press", nextCycleAction({ current: "acceptEdits", target: "auto", presses: 0, maxPresses: 4 }) === "press");
check("below the target, presses remain (mid-cycle) → press", nextCycleAction({ current: "plan", target: "auto", presses: 1, maxPresses: 4 }) === "press");
check("not at target AND at the press cap → giveup (leave as-is)", nextCycleAction({ current: "acceptEdits", target: "auto", presses: 4, maxPresses: 4 }) === "giveup");
check("not at target AND past the press cap → giveup", nextCycleAction({ current: "plan", target: "auto", presses: 5, maxPresses: 4 }) === "giveup");
// done WINS over the cap: if we've already reached the target on the cap-th read, it's done, not giveup.
check("reached the target on the cap-th read → done (not giveup)", nextCycleAction({ current: "auto", target: "auto", presses: 4, maxPresses: 4 }) === "done");

// ───────────────────────── 3. sequence simulator (the real loop's shape) ─────────────────────────
// Mirrors cycleResumeToMode: at decision i we observe modes[i] (the footer AFTER the i-th press, modes[0]
// = the boot mode). On "press" we press and advance to the next observed mode; on done/giveup we stop.
// (The real loop additionally WAITS for the footer to change before each re-decision — modelled here by
// each observed entry already being the settled post-press mode. That wait is what the real-claude probe
// validates; this proves the decision/press-count contract.)
function simulate(modes, target, maxPresses) {
  let presses = 0, i = 0;
  const trail = [];
  for (;;) {
    const current = modes[Math.min(i, modes.length - 1)];
    const action = nextCycleAction({ current, target, presses, maxPresses });
    trail.push(`${current}:${action}`);
    if (action !== "press") return { presses, action, final: current, trail };
    presses++; i++;
  }
}

// acceptEdits → auto is the load-bearing case: boot acceptEdits, press→plan, press→auto. Exactly 2 presses.
{
  const r = simulate(["acceptEdits", "plan", "auto"], "auto", 4);
  check("resume acceptEdits→auto issues exactly 2 Shift+Tabs and stops at auto",
    r.presses === 2 && r.action === "done" && r.final === "auto");
}
// already at the target (a future where resume restores auto directly): 0 presses.
{
  const r = simulate(["auto"], "auto", 4);
  check("already at auto → 0 presses, done", r.presses === 0 && r.action === "done");
}
// boot acceptEdits, target auto, but the footer NEVER advances (stuck) → press up to the cap then giveup.
{
  const r = simulate(["acceptEdits", "acceptEdits", "acceptEdits", "acceptEdits", "acceptEdits"], "auto", 4);
  check("footer stuck at acceptEdits → presses == cap (4) then giveup (graceful, never infinite)",
    r.presses === 4 && r.action === "giveup");
}
// a single press is enough (acceptEdits → plan target).
{
  const r = simulate(["acceptEdits", "plan"], "plan", 4);
  check("acceptEdits→plan issues exactly 1 Shift+Tab and stops at plan", r.presses === 1 && r.action === "done");
}
// full-period target (default = +3): acceptEdits→plan→auto→default, 3 presses, under the cap of 4.
{
  const r = simulate(["acceptEdits", "plan", "auto", "default"], "default", 4);
  check("acceptEdits→default issues exactly 3 Shift+Tabs and stops at default", r.presses === 3 && r.action === "done");
}
// the press count can NEVER exceed the cap, whatever the sequence.
{
  const r = simulate(["acceptEdits", "plan", "default", "acceptEdits", "plan", "default"], "auto", 4);
  check("press count is bounded by the cap on any non-converging sequence", r.presses <= 4 && r.action === "giveup");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the resume cycle map (acceptEdits-relative order) and the bounded press-until-target decision are correct: acceptEdits→auto takes 2 presses, a stuck footer gives up at the cap (never infinite-loops), and the press count is always bounded — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
