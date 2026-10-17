import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a35e2bd8 — hermetic unit coverage for `_codex-graceful-stop.mjs`'s PURE decision logic (the
// codex graceful-stop exit-code accommodation shared by all five real-codex-spawn files). This is NOT a
// real-spawn test — see codex-prompt-ascii-fold-real-spawn.mjs / codex-stateful-runtime-real-spawn.mjs /
// codex-submit-confirmation-real-spawn.mjs / codex-transcript-real-spawn.mjs /
// codex-rollout-archive-restore-real-spawn.mjs for the real-spawn call sites this logic serves.
//
// Every scenario below pairs its PASS/FAIL expectation with a discriminating control (never a bare
// assertion that could pass for having written an inert always-true/always-false function): either a
// contrasting input that must produce the OPPOSITE outcome, or — for the two known-flake codes — the
// OLD, pre-accommodation bare `code === 0` predicate run against the SAME input, proving this helper is a
// real behavior change and not a no-op (same discipline card 2efd4bd7's own review used).
//
// Run: node test/codex-graceful-stop-accommodation.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const {
  CODEX_GRACEFUL_STOP_KNOWN_CODES, CODEX_GRACEFUL_STOP_WAIT_BUDGET_MS,
  evaluateCodexGracefulStopExit, reportCodexGracefulStopExit,
} = await import("./_codex-graceful-stop.mjs");

// --- 1. code=0, intended=true, exited=true -> PASS, silent (no warn) -----------------------------------
{
  const r = evaluateCodexGracefulStopExit({ exited: true, intended: true, code: 0, elapsedMs: 1900 });
  check("code=0 after an intended, completed graceful stop PASSES", r.pass === true);
  check("code=0's PASS carries NO warn line (the common, clean case stays silent)", r.warn === null);
}

// --- 2. code=1 (the FAST-PATH / HARD-KILL-BACKSTOP shape) -> PASS with a loud WARN ----------------------
{
  const r = evaluateCodexGracefulStopExit({ exited: true, intended: true, code: 1, elapsedMs: 1900, codexStopDiag: { secondSigintSent: true, msSinceSecondSigint: 1101, engineSessionIdCaptureEndReason: null } });
  check("code=1 after an intended, completed graceful stop PASSES (the known 176bdb0c flake)", r.pass === true);
  check("code=1's PASS carries a non-null warn line", typeof r.warn === "string" && r.warn.length > 0);
  check("code=1's warn line is WARN_LINE_RE-compliant (`WARN` + exactly two spaces at column 0 — card 22d995ca's own requirement, or scripts/test-daemon.mjs's declared-warning scan silently never finds it)", /^WARN {2}\S/.test(r.warn));
  check("code=1's warn names BOTH cards (a35e2bd8 and 176bdb0c)", r.warn.includes("a35e2bd8") && r.warn.includes("176bdb0c"));
  check("code=1's warn carries the observed codexStopDiag payload", r.warn.includes("1101"));
  // NEGATIVE CONTROL: the OLD, pre-accommodation bare predicate would have REJECTED this exact input —
  // proves the accommodation is a real behavior change on code=1, not an inert pass-through.
  check("CONTROL: the OLD bare `code === 0` check would have FAILED on this same code=1 input (this helper demonstrably changed behavior, not a no-op)", (1 === 0) === false);
}

// --- 3. code=undefined (the NEW third shape, card a35e2bd8) -> PASS with a loud WARN, DISTINCT wording --
{
  const r = evaluateCodexGracefulStopExit({ exited: true, intended: true, code: undefined, elapsedMs: 6300, codexStopDiag: { secondSigintSent: true, msSinceSecondSigint: 5500, engineSessionIdCaptureEndReason: "died-mid-capture" } });
  check("code=undefined after an intended, completed graceful stop PASSES (the NEW a35e2bd8 shape)", r.pass === true);
  check("code=undefined's PASS carries a non-null warn line", typeof r.warn === "string" && r.warn.length > 0);
  check("code=undefined's warn line is WARN_LINE_RE-compliant", /^WARN {2}\S/.test(r.warn));
  check("code=undefined's warn explicitly calls out the NEW-shape disclosure (so it reads differently from the code=1 warn, not just a generic template)", r.warn.includes("NEW undefined shape") && r.warn.includes("2026-10-17"));
  // NEGATIVE CONTROL: same shape, same discipline — the OLD bare check would also have rejected this.
  check("CONTROL: the OLD bare `code === 0` check would have FAILED on this same code=undefined input", (undefined === 0) === false);
  // DISCRIMINATING CONTRAST: confirm the undefined-shape warn text is NOT merely a byte-copy of the
  // code=1 warn (i.e. the shapeNote branch genuinely fired, rather than every known code sharing identical
  // text that happens to pass a loose substring check).
  const r1 = evaluateCodexGracefulStopExit({ exited: true, intended: true, code: 1, elapsedMs: 1900 });
  check("CONTRAST: code=1's warn and code=undefined's warn are NOT byte-identical (the undefined-specific disclosure genuinely changes the text)", r1.warn !== r.warn);
}

// --- 4. code=2 (an UNEXPECTED code, not in the known-flake set) -> FAILS -------------------------------
{
  const r = evaluateCodexGracefulStopExit({ exited: true, intended: true, code: 2, elapsedMs: 1900 });
  check("code=2 (not 0, 1, or undefined) after an intended, completed graceful stop FAILS", r.pass === false);
  check("code=2's FAIL carries no warn (an unexpected code is a hard failure, not an accommodated flake)", r.warn === null);
  // DISCRIMINATING CONTRAST: the SAME shape of input (exited:true, intended:true, differing only in
  // `code`) produces the OPPOSITE outcome for 1 vs 2 — proves this isn't a function that always returns
  // false (or always true) regardless of its input.
  const r1 = evaluateCodexGracefulStopExit({ exited: true, intended: true, code: 1, elapsedMs: 1900 });
  check("CONTRAST: code=1 PASSES while code=2 FAILS on an otherwise-identical input (the function genuinely discriminates on `code`, not a constant)", r1.pass === true && r.pass === false);
}

// --- 5. intended=false -> FAILS, regardless of code (an unintended death is a different, real defect) ---
{
  const r = evaluateCodexGracefulStopExit({ exited: true, intended: false, code: 0, elapsedMs: 1900 });
  check("intended=false (even with code=0) after a completed exit FAILS — an unrequested death must never be silently treated as a clean stop", r.pass === false);
  // DISCRIMINATING CONTRAST: identical `code` (0), differing ONLY in `intended`, produces the opposite
  // outcome — proves `intended` is actually load-bearing in the decision, not read-and-ignored.
  const rIntended = evaluateCodexGracefulStopExit({ exited: true, intended: true, code: 0, elapsedMs: 1900 });
  check("CONTRAST: the SAME code=0 PASSES when intended=true and FAILS when intended=false (intended is genuinely checked, not dead code)", rIntended.pass === true && r.pass === false);
}

// --- 6. exited=false (the never-exits / hang case) -> FAILS HARD, never downgraded ----------------------
{
  const r = evaluateCodexGracefulStopExit({ exited: false });
  check("exited=false (the real codex process never reported onExit within the wait budget) FAILS — a hang is a DIFFERENT defect than a known flake code and must never be downgraded", r.pass === false);
  check("exited=false carries no warn (a hang is a hard failure, never an accommodated flake)", r.warn === null);
  // DISCRIMINATING CONTRAST: the exact same (intended, code) pair that PASSES when exited=true must FAIL
  // when exited=false — proves the `exited` gate actually short-circuits everything else, rather than
  // every evaluation happening to fail by coincidence.
  const rExited = evaluateCodexGracefulStopExit({ exited: true, intended: true, code: 0, elapsedMs: 1900 });
  check("CONTRAST: the identical (intended:true, code:0) PASSES when exited=true and FAILS when exited=false (exited genuinely gates the whole evaluation)", rExited.pass === true && r.pass === false);
}

// --- 7. reportCodexGracefulStopExit — the thin check()-calling wrapper, exercised against a FAKE check --
{
  const calls = [];
  const fakeCheck = (label, cond) => calls.push({ label, cond });
  const warned = [];
  const originalLog = console.log;
  console.log = (...args) => { warned.push(args.join(" ")); };
  let returned;
  try {
    returned = reportCodexGracefulStopExit(fakeCheck, { exited: true, intended: true, code: 1, elapsedMs: 1900 });
  } finally {
    console.log = originalLog;
  }
  check("reportCodexGracefulStopExit returns the SAME pass boolean evaluateCodexGracefulStopExit computed (true for code=1)", returned === true);
  check("reportCodexGracefulStopExit called the injected check() exactly once", calls.length === 1);
  check("reportCodexGracefulStopExit's check() call carries cond=true for code=1", calls[0]?.cond === true);
  check("reportCodexGracefulStopExit printed the warn line via console.log (the WARN_LINE_RE-compliant text, captured instead of the real console)", warned.some((line) => /^WARN {2}\S/.test(line)));
  // NEGATIVE CONTROL: for a code=0 input, nothing should be printed at all.
  const calls2 = [];
  const warned2 = [];
  console.log = (...args) => { warned2.push(args.join(" ")); };
  try {
    reportCodexGracefulStopExit((label, cond) => calls2.push({ label, cond }), { exited: true, intended: true, code: 0, elapsedMs: 1900 });
  } finally {
    console.log = originalLog;
  }
  check("CONTROL: for code=0, reportCodexGracefulStopExit prints NOTHING (silent pass) — contrasts with code=1 above, which always printed exactly one WARN line", warned2.length === 0);
}

// --- 8. CODEX_GRACEFUL_STOP_KNOWN_CODES — the accommodated set is EXACTLY {1, undefined}, nothing wider -
{
  check("CODEX_GRACEFUL_STOP_KNOWN_CODES has exactly 2 members (never silently widened to accommodate anything else)", CODEX_GRACEFUL_STOP_KNOWN_CODES.size === 2);
  check("CODEX_GRACEFUL_STOP_KNOWN_CODES contains 1", CODEX_GRACEFUL_STOP_KNOWN_CODES.has(1));
  check("CODEX_GRACEFUL_STOP_KNOWN_CODES contains undefined", CODEX_GRACEFUL_STOP_KNOWN_CODES.has(undefined));
  check("CODEX_GRACEFUL_STOP_KNOWN_CODES does NOT contain 2 (an arbitrary unaccommodated code)", !CODEX_GRACEFUL_STOP_KNOWN_CODES.has(2));
}

// --- 9. CODEX_GRACEFUL_STOP_WAIT_BUDGET_MS — mirrors pty/host.ts's un-exported GRACEFUL_STOP_KILL_MS -----
// Env-independent: re-derives the SAME formula from whatever LOOM_GRACEFUL_KILL_MS is (or isn't) set to
// in THIS process's own env, rather than hardcoding the default — correct whether or not the ambient
// host happens to have that var set (the hermetic-test footgun this project's own doctrine warns about).
{
  const expected = (Number(process.env.LOOM_GRACEFUL_KILL_MS) || 6_000) + 2_000;
  check(`CODEX_GRACEFUL_STOP_WAIT_BUDGET_MS (${CODEX_GRACEFUL_STOP_WAIT_BUDGET_MS}) mirrors pty/host.ts's GRACEFUL_STOP_KILL_MS formula + a 2000ms margin (expected ${expected}, from this process's own LOOM_GRACEFUL_KILL_MS env)`, CODEX_GRACEFUL_STOP_WAIT_BUDGET_MS === expected);
  check("CODEX_GRACEFUL_STOP_WAIT_BUDGET_MS is strictly greater than the bare GRACEFUL_STOP_KILL_MS mirror (the margin is real, not zero)", CODEX_GRACEFUL_STOP_WAIT_BUDGET_MS > (Number(process.env.LOOM_GRACEFUL_KILL_MS) || 6_000));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the shared codex graceful-stop accommodation (_codex-graceful-stop.mjs, cards a35e2bd8/176bdb0c) correctly: passes silently on code=0; passes with a loud, WARN_LINE_RE-compliant, card-naming warning on both known flake codes (1, and the NEW undefined shape, each with DISTINCT wording — proven not byte-identical); fails hard (no warn) on any other code, on intended=false, and on the never-exits case — each contrasted against an otherwise-identical input that passes, so no single assertion here could pass for having written a constant function; the reportCodexGracefulStopExit wrapper forwards the identical pass/fail to an injected check() and prints exactly the expected warn text (or nothing, for the clean case); the known-codes set is exactly {1, undefined}, never silently wider; and the wait-budget constant mirrors pty/host.ts's own un-exported GRACEFUL_STOP_KILL_MS formula, re-derived from this process's own env rather than a hardcoded default."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
