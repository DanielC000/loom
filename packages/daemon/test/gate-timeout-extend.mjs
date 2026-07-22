// Gate-timeout ONE-TIME AUTO-EXTEND (card 24642c3d — the false-fail-under-fleet-load fix): a busy 2-lane
// daemon gate (130+ hermetic test files) can genuinely still be healthy and PASSING at the moment
// `gateCommandTimeoutMs` fires — it's just slow under contention, not hung. Before this, ANY timeout was
// an immediate hard kill+reject, indistinguishable from a real hang. REAL spawn throughout: this is
// fundamentally about wall-clock/liveness behavior — a mocked exec would never exercise it.
//
// Proves runGateStep (gate-runner.ts), via GATE_EXTEND_IDLE_MS dialed down (see the constants below) so
// the test runs in real seconds, not real minutes:
//   (A) REALISTIC CASE — a step that keeps emitting output past the first deadline (modeling a slow-but-
//       healthy streaming test suite) and exits 0 before the second deadline resolves passed:true, NOT
//       timedOut — this is the exact false-fail this card fixes.
//   (B) a step that is IDLE (zero output) from the start gets NO extension — killed at the first
//       deadline, same as pre-24642c3d behavior. Proves the extend is liveness-gated, not unconditional.
//   (C) a step that stays ACTIVE (steady output) but never exits gets EXACTLY ONE extension, then is
//       killed at the second deadline — proves the cap (never extends twice, so a truly wedged-but-
//       spinning process is still bounded).
//   (D) allowExtend:false (the flag the merge gate's own retry-after-timeout call passes, so the two
//       "one more chance" mechanisms don't compound) disables the extension even with live output —
//       killed at the first deadline, identical to (B).
// Run: 1) build daemon (pnpm build), 2) node test/gate-timeout-extend.mjs
//
// Card 9f3164b8 (2026-07-22): under heavy host CPU oversubscription this file produced FAILs unrelated to
// any real logic bug. Instrumented repro (22 CPU-bound processes on 16 cores) named THREE distinct
// real-clock mechanisms — never a race in the extend/no-extend DECISION itself, which was correct in every
// traced run:
//  1. Fixture (A) left only ~500ms of slack between its nominal work and the one-time-extend cap; under
//     contention a freshly-spawned child's OWN event-loop scheduling (not just this file's timers) runs
//     measurably slower, and MORE scheduled events (interval ticks) means more chances to accumulate that
//     slowdown — see the arithmetic comment at fixture (A) below for the re-parameterization + margin.
//  2. (B)/(C)/(D) measured `elapsed` up to promise-resolution, which includes `killGateProcessTree`'s own
//     real OS-process teardown cost (a Windows `taskkill` subprocess) — observed 324-1037ms under load vs
//     ~150-400ms quiet, dwarfing the fixed multiplier tolerance. `GateStepResult.decidedAt` (added for this
//     card) is a `performance.now()` stamp of the instant the outcome was DECIDED, before that teardown —
//     asserting against it removes teardown cost from the measured window instead of tolerating it.
//  3. THE ONE THAT MATTERED MOST: validating (1) and (2) in ISOLATION (one fixture at a time) passed
//     reliably, but the REAL (A)-(B)-(C)-(D) back-to-back sequence — as this file actually runs it, and as
//     a 130+-file suite actually runs under a merge gate — still failed. Direct `idleMs` instrumentation at
//     the onTimeout decision instant showed why: under the combined load of the full sequence, a freshly-
//     spawned child sometimes got ZERO CPU time — zero scheduled callbacks, zero captured output — for up
//     to ~1.6 SECONDS. The original constants (700ms first deadline, 300ms idle threshold) are test-only
//     dial-downs from production's real defaults (`gateCommandTimeoutMs` 120-1800s, `GATE_EXTEND_IDLE_MS`
//     60s) — chosen only so this file runs in seconds, not minutes — and they had drifted below the host's
//     actual process-scheduling noise floor under genuine contention. No fixture shape can fix that: a
//     deadline can fire before the child executes a single instruction, regardless of what it's programmed
//     to do. See the constants block below for the widened values and the property-preservation argument
//     for both directions. Lesson for any future timing test: dialed-down constants must stay above the
//     PLATFORM's scheduling jitter under real contention, not merely above the logic's own nominal timings
//     — isolated-fixture validation hid this because it never reproduced that jitter.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// GATE_EXTEND_IDLE_MS test override (card 9f3164b8, widened from 300ms — see the file-header mechanism-3
// note). Both this and TIMEOUT_MS below are test-only dial-downs from production's real defaults
// (gateCommandTimeoutMs 120-1800s; GATE_EXTEND_IDLE_MS 60s) — 300ms/700ms were chosen only for test speed,
// and instrumentation showed they'd drifted below the host's real scheduling noise floor under
// contention (a fresh child can wait ~1.6s for its first CPU slice under a heavy combined load). 2000ms
// budgets ~25% above that observed 1.6s worst case while staying two orders of magnitude below the 60s
// production value — still "real seconds, not real minutes" for this file's own runtime.
process.env.LOOM_GATE_EXTEND_IDLE_MS = "2000"; // read at module-load time below — must be set BEFORE import
const { runGateStep } = await import("../dist/orchestration/gate-runner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (p) => `"${p}"`; // quote a path for both cmd.exe and posix sh
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const scratchDir = path.join(os.tmpdir(), `loom-gte-scratch-${sfx}`);
fs.mkdirSync(scratchDir, { recursive: true });

// A hard external safety net — independent of the correctness of the code under test — so a genuinely
// broken "extends forever" implementation fails this test loudly instead of hanging the whole suite.
async function withHardTimeout(promise, ms, label) {
  let timer;
  const bomb = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: hard safety timeout after ${ms}ms — extension likely unbounded`)), ms); });
  try {
    return await Promise.race([promise, bomb]);
  } finally {
    clearTimeout(timer);
  }
}

function writeScript(name, body) {
  const file = path.join(scratchDir, name);
  fs.writeFileSync(file, body);
  return `${q(process.execPath)} ${q(file)}`;
}

// TIMEOUT_MS (card 9f3164b8, widened from 700ms — see the GATE_EXTEND_IDLE_MS comment above for the
// shared "test-only dial-down, previously below the noise floor" reasoning; 3000ms budgets ~1.85x above
// the same observed ~1.6s worst-case scheduling delay). First deadline; second (extended) deadline lands
// at ~2x this (6000ms).
//
// Property-preservation check for the WIDENED idle threshold (2000ms), both directions — widening a
// liveness window is only safe if it still tells the two cases apart:
//   - extension IS granted for a genuinely live child: fixture (A)/(C)/(D)'s ticks land every 150-300ms
//     apart even under load (per this card's own instrumentation, steady-state per-tick delay stayed in
//     the tens-to-low-hundreds-of-ms range once a child was scheduled at all) — idleMs at the deadline is
//     ≈150-300ms, far below the 2000ms threshold ⇒ correctly judged live.
//   - extension is NOT granted for a genuinely wedged child: fixture (B) never emits a single byte, so at
//     the 3000ms deadline idleMs ≈ 3000ms (the full elapsed time since start) — comfortably ABOVE the
//     2000ms threshold ⇒ still correctly denied and killed, same as before the widening.
// The threshold has to sit between "a live tick's idle gap" (≤~300ms) and "a wedged step's idle gap"
// (3000ms) — 2000ms sits in that range with ~1700ms of margin above the live case and ~1000ms of margin
// below the wedged case.
const TIMEOUT_MS = 3000;

try {
  // ── (A) REALISTIC CASE: keeps streaming output past deadline 1, exits 0 before deadline 2 ──────────
  {
    // Margin arithmetic (card 9f3164b8) — deadline1=3000ms, cap=6000ms (2x deadline1, fixed by the
    // production one-time-extend). Fixture: 3 ticks @ 1200ms = 3600ms nominal work (interval*count).
    //   - nominal(3600) > deadline1(3000): margin 600ms — still genuinely running when deadline1 fires, so
    //     the extend path is actually exercised (not skipped because the child already finished).
    //   - jitter budget: instrumented repro under 22-CPU-bound-process/16-core oversubscription, validated
    //     against the FULL (A)-(B)-(C)-(D) sequence (not an isolated fixture — see the file-header
    //     mechanism-3 note on why that distinction matters), measured per-tick delay inflation up to ~40%
    //     once a child was scheduled at all, on top of the up-to-~1.6s one-time scheduling delay the
    //     widened TIMEOUT_MS/idle-threshold above already budget for. Fewer, wider-spaced ticks (3 vs the
    //     original 6) reduce the number of scheduling events that can each accumulate delay, same principle
    //     as the original fixture fix. Budgeting a 55% jitter factor (above the ~40% observed steady-state
    //     worst case) on the 3600ms nominal gives 5580ms — for calibration only; see the DoD re-validation
    //     run count for the actual empirical result against the 6000ms cap.
    const command = writeScript("streaming-then-pass.cjs", [
      "let n = 0;",
      "const t = setInterval(() => {",
      "  n++;",
      '  console.log("PASS  fake-test-" + n);',
      "  if (n >= 3) { clearInterval(t); process.exit(0); }",
      "}, 1200);",
    ].join("\n"));
    const testStart = performance.now();
    const result = await withHardTimeout(runGateStep(command, scratchDir, TIMEOUT_MS), 12000, "(A)");
    const elapsed = result.decidedAt - testStart;
    // No fixed upper-bound assertion on `elapsed` here (CR follow-up, still valid post-9f3164b8): even
    // with the re-parameterized fixture's margin, an arbitrarily-loaded host could in principle push a
    // healthy process past any fixed bound. `status === 0` already proves the process reached its own
    // natural exit rather than being killed, which is the only thing "finished before the second deadline"
    // actually needs to demonstrate.
    check("(A) a healthy-but-slow streaming step that finishes before the extended deadline resolves passed (status 0)", result.status === 0);
    check("(A) it is NOT reported as timedOut — the exact false-fail this card fixes", result.timedOut !== true);
    check("(A) it genuinely ran PAST the first deadline (proves the extension actually happened, not a fluke)", elapsed > TIMEOUT_MS);
  }

  // ── (B) IDLE from the start: no output at all → no extension → killed at the first deadline ────────
  {
    const command = writeScript("idle-forever.cjs", "setInterval(() => {}, 10000);");
    const testStart = performance.now();
    const result = await withHardTimeout(runGateStep(command, scratchDir, TIMEOUT_MS), 8000, "(B)");
    // `decidedAt` (card 9f3164b8) marks the instant the kill decision was made, BEFORE the async
    // `killGateProcessTree` teardown (a real OS-process wait — observed 324-1037ms under the same
    // oversubscription this file targets, vs ~150-400ms quiet — that has nothing to do with whether the
    // TIMING DECISION itself was correct). Asserting on it instead of promise-resolution time keeps this
    // bound about the decision, not about `taskkill`'s variable duration.
    const elapsed = result.decidedAt - testStart;
    check("(B) a silent/idle step is still killed at the FIRST deadline — timedOut:true", result.timedOut === true);
    check("(B) no extension was granted (elapsed stays near the FIRST deadline, not the second)", elapsed < TIMEOUT_MS * 1.7);
  }

  // ── (C) ACTIVE forever (never exits): EXACTLY ONE extension, then killed at the second deadline ────
  {
    const command = writeScript("streaming-forever.cjs", 'setInterval(() => { console.log("PASS  fake-test"); }, 150);');
    const testStart = performance.now();
    const result = await withHardTimeout(runGateStep(command, scratchDir, TIMEOUT_MS), 12000, "(C)");
    const elapsed = result.decidedAt - testStart; // decision instant, not promise-resolution — see (B)'s comment
    check("(C) an actively-producing-but-never-finishing step is still eventually killed — timedOut:true", result.timedOut === true);
    check("(C) it ran past the first deadline (got the one extension)", elapsed > TIMEOUT_MS * 1.15);
    check("(C) it was killed at (not far past) the SECOND deadline — proves the cap: never extends a second time",
      elapsed < TIMEOUT_MS * 2.6);
  }

  // ── (D) allowExtend:false disables the extension even with live output — same as (B) ────────────────
  {
    const command = writeScript("streaming-forever-2.cjs", 'setInterval(() => { console.log("PASS  fake-test"); }, 150);');
    const testStart = performance.now();
    const result = await withHardTimeout(runGateStep(command, scratchDir, TIMEOUT_MS, undefined, false), 8000, "(D)");
    const elapsed = result.decidedAt - testStart; // decision instant, not promise-resolution — see (B)'s comment
    check("(D) allowExtend:false kills at the FIRST deadline despite live output — timedOut:true", result.timedOut === true);
    check("(D) no extension was granted (elapsed stays near the FIRST deadline)", elapsed < TIMEOUT_MS * 1.7);
  }
} finally {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a healthy-but-slow gate step (still producing output, zero failures) survives past its timeout via ONE bounded auto-extend and resolves to its own true exit code instead of a false timeout-fail; a genuinely idle/wedged step, or an extension-disabled call, is still killed exactly as before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
