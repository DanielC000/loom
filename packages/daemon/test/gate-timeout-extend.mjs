// Gate-timeout ONE-TIME AUTO-EXTEND (card 24642c3d — the false-fail-under-fleet-load fix): a busy 2-lane
// daemon gate (130+ hermetic test files) can genuinely still be healthy and PASSING at the moment
// `gateCommandTimeoutMs` fires — it's just slow under contention, not hung. Before this, ANY timeout was
// an immediate hard kill+reject, indistinguishable from a real hang. REAL spawn throughout: this is
// fundamentally about wall-clock/liveness behavior — a mocked exec would never exercise it.
//
// Proves runGateStep (gate-runner.ts), via GATE_EXTEND_IDLE_MS dialed low (300ms) so the test runs in
// real seconds, not real minutes:
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_GATE_EXTEND_IDLE_MS = "300"; // read at module-load time below — must be set BEFORE import
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

const TIMEOUT_MS = 700; // first deadline; second (extended) deadline lands at ~2x this

try {
  // ── (A) REALISTIC CASE: keeps streaming output past deadline 1, exits 0 before deadline 2 ──────────
  {
    const command = writeScript("streaming-then-pass.cjs", [
      "let n = 0;",
      "const t = setInterval(() => {",
      "  n++;",
      '  console.log("PASS  fake-test-" + n);',
      "  if (n >= 6) { clearInterval(t); process.exit(0); }", // ~900ms of ticks — after deadline 1 (700ms), before deadline 2 (1400ms)
      "}, 150);",
    ].join("\n"));
    const started = Date.now();
    const result = await withHardTimeout(runGateStep(command, scratchDir, TIMEOUT_MS), 5000, "(A)");
    const elapsed = Date.now() - started;
    // No fixed upper-bound assertion on `elapsed` here (CR follow-up): under the heavy-fleet/2-lane load
    // this card targets, node cold-start + timer drift on a REAL spawn can stretch past any fixed bound,
    // making it a contention-flake by construction. It's also redundant — `status === 0` already proves
    // the process reached its own natural exit rather than being killed, which is the only thing "finished
    // before the second deadline" actually needs to demonstrate.
    check("(A) a healthy-but-slow streaming step that finishes before the extended deadline resolves passed (status 0)", result.status === 0);
    check("(A) it is NOT reported as timedOut — the exact false-fail this card fixes", result.timedOut !== true);
    check("(A) it genuinely ran PAST the first deadline (proves the extension actually happened, not a fluke)", elapsed > TIMEOUT_MS);
  }

  // ── (B) IDLE from the start: no output at all → no extension → killed at the first deadline ────────
  {
    const command = writeScript("idle-forever.cjs", "setInterval(() => {}, 10000);");
    const started = Date.now();
    const result = await withHardTimeout(runGateStep(command, scratchDir, TIMEOUT_MS), 5000, "(B)");
    const elapsed = Date.now() - started;
    check("(B) a silent/idle step is still killed at the FIRST deadline — timedOut:true", result.timedOut === true);
    check("(B) no extension was granted (elapsed stays near the FIRST deadline, not the second)", elapsed < TIMEOUT_MS * 1.7);
  }

  // ── (C) ACTIVE forever (never exits): EXACTLY ONE extension, then killed at the second deadline ────
  {
    const command = writeScript("streaming-forever.cjs", 'setInterval(() => { console.log("PASS  fake-test"); }, 150);');
    const started = Date.now();
    const result = await withHardTimeout(runGateStep(command, scratchDir, TIMEOUT_MS), 6000, "(C)");
    const elapsed = Date.now() - started;
    check("(C) an actively-producing-but-never-finishing step is still eventually killed — timedOut:true", result.timedOut === true);
    check("(C) it ran past the first deadline (got the one extension)", elapsed > TIMEOUT_MS * 1.15);
    check("(C) it was killed at (not far past) the SECOND deadline — proves the cap: never extends a second time",
      elapsed < TIMEOUT_MS * 2.6);
  }

  // ── (D) allowExtend:false disables the extension even with live output — same as (B) ────────────────
  {
    const command = writeScript("streaming-forever-2.cjs", 'setInterval(() => { console.log("PASS  fake-test"); }, 150);');
    const started = Date.now();
    const result = await withHardTimeout(runGateStep(command, scratchDir, TIMEOUT_MS, undefined, false), 5000, "(D)");
    const elapsed = Date.now() - started;
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
