import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 55cba5c5: proves the SECONDARY fix — a failing test's identity survives truncation of the bounded
// OUTPUT_TAIL_BYTES (4096) tail. gate-runner.ts's `runGateStep` used to derive `failingTest` by scanning
// ONLY that bounded tail post-hoc (`extractFailingTest(outputTail)`), so a run whose failing-test marker
// printed EARLY, followed by enough trailing output to blow past the tail budget (a noisy epilogue — the
// COMMON failure mode per the card, not an edge case), silently lost the failing test's identity: the tail
// no longer contained it. The fix (`createFailingTestTracker`) scans the FULL stream live, as it arrives,
// independent of the tail's own eviction, and reports the failing-test line on `GateStepResult`/
// `GateSequentialResult.failingTest` regardless of how much trails it.
//
// REAL spawn (a real `node` child), no daemon/DB — drives orchestration/gate-runner.js directly.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-runner-failing-test-truncation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { runGateStep, runGateSequential, extractFailingTest, createFailingTestTracker } = await import("../dist/orchestration/gate-runner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gr-trunc-"));
try {
  // Prints the failing-test marker FIRST, then floods ~80KB of unrelated trailing output — well past the
  // 4096-byte tail cap — before exiting non-zero. Mirrors a real runner (e.g. test-daemon.mjs) whose own
  // PASS/FAIL-by-name summary prints BEFORE a noisy trailing pnpm/warning epilogue.
  const SCRIPT = [
    "console.error('FAIL widget.spec.js > renders correctly');",
    "console.error('AssertionError: expected 2 to equal 3');",
    "for (let i = 0; i < 2000; i++) console.log('epilogue noise line ' + i + ' padding padding padding');",
    "process.exit(1);",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "fail-then-flood.mjs"), SCRIPT);

  const res = await runGateStep("node fail-then-flood.mjs", dir, 15_000);
  check("(A) the step failed as expected (exit 1)", res.status === 1);
  check("(A) outputTail is bounded and the early failing line was genuinely evicted (proves the truncation is real, not assumed)",
    typeof res.outputTail === "string" && res.outputTail.length <= 4096 && !res.outputTail.includes("widget.spec.js"));
  check("(A) extractFailingTest against that SAME truncated tail finds NOTHING — proves the OLD post-hoc-only path was blind here",
    extractFailingTest(res.outputTail ?? "") === undefined);
  check("(A) failingTest STILL names the test — the live scan survived the truncation",
    res.failingTest === "FAIL widget.spec.js > renders correctly");

  const seq = await runGateSequential("node fail-then-flood.mjs", dir, 15_000);
  check("(B) runGateSequential forwards failingTest verbatim from the failing step", seq.failingTest === res.failingTest);
  check("(B) runGateSequential still reports the failed step + exit status", seq.passed === false && seq.failedStep === "node fail-then-flood.mjs" && seq.failedStatus === 1);

  // A run with NO recognizable failing-test marker at all (a genuinely unattributable failure) must
  // report `failingTest: undefined` — an honest miss, never a fabricated guess.
  fs.writeFileSync(path.join(dir, "fail-unrecognizable.mjs"), "console.error('kaboom, no idea why'); process.exit(1);");
  const unrecognizable = await runGateStep("node fail-unrecognizable.mjs", dir, 15_000);
  check("(C) a failure with no recognizable marker reports failingTest:undefined (never a guessed name)",
    unrecognizable.status === 1 && unrecognizable.failingTest === undefined);

  // A green step reports no failingTest at all.
  fs.writeFileSync(path.join(dir, "ok.mjs"), "process.exit(0);");
  const ok = await runGateStep("node ok.mjs", dir, 15_000);
  check("(D) a passing step reports failingTest:undefined", ok.status === 0 && ok.failingTest === undefined);

  // ── (E) Code Review follow-up (card 55cba5c5): `carry` — the not-yet-terminated remainder
  //        createFailingTestTracker holds between feed() calls — must be BOUNDED. A bare-`\r` progress/
  //        download-meter renderer (pnpm/npm/turbo all use one) writes with NO real `\n` at all, so the
  //        ORIGINAL split(/\r?\n/) never popped anything off `carry` for that shape — it would grow to
  //        hold the step's ENTIRE output in daemon memory, exactly the unbounded thing OUTPUT_TAIL_BYTES's
  //        own ring exists to avoid. Fixed two ways: (1) a bare `\r` is now a line boundary too, so a
  //        marker written via `\r` is found immediately regardless of how much progress-bar noise follows
  //        it; (2) `carry` is hard-capped as a backstop for the residual case NEITHER `\r` nor `\n` ever
  //        appears at all. Hermetic (drives createFailingTestTracker directly, no spawn) — mirrors this
  //        file's own "prove the failure state is actually reached" discipline. ─────────────────────────
  {
    // Mirrors gate-runner.ts's own (unexported) FAILING_TEST_CARRY_CAP_BYTES — kept in sync by hand since
    // the constant itself isn't exported; sized several times over so an off-by-one in either file can't
    // make this flaky.
    const CAP_BYTES = 8192;

    // (E1) a REALISTIC \r-progress-bar stream: thousands of bare-`\r`-terminated frames (no `\n`
    // anywhere) with a FAIL marker (also `\r`-terminated, never `\n`) buried in the middle — proves the
    // tracker "still resolves correctly if a marker appears" in exactly this shape, fed across many
    // small chunks (not one giant buffer) to exercise the real streaming path.
    {
      const tracker = createFailingTestTracker();
      const frame = (n) => `progress ${n}/50000 padding padding padding padding\r`;
      let blob = "";
      for (let i = 0; i < 25_000; i++) blob += frame(i);
      blob += "FAIL widget.spec.js > renders correctly\r";
      for (let i = 25_000; i < 50_000; i++) blob += frame(i);
      check("(E1) the synthetic \\r-progress blob genuinely has no real newline at all (proves this exercises the bare-\\r path, not the ordinary one)",
        !blob.includes("\n"));
      check("(E1) the blob is many times the carry cap (proves this isn't trivially small)", blob.length > CAP_BYTES * 50);

      const buf = Buffer.from(blob, "utf-8");
      const CHUNK = 4096;
      const started = Date.now();
      for (let off = 0; off < buf.length; off += CHUNK) tracker.feed(buf.subarray(off, off + CHUNK));
      const elapsedMs = Date.now() - started;
      check("(E1) a marker buried in a heavy bare-\\r stream (no real newline) is still found",
        tracker.result() === "FAIL widget.spec.js > renders correctly");
      check("(E1) feeding it stayed fast (no quadratic/unbounded blowup) — well under 2s for ~2MB of \\r-only input",
        elapsedMs < 2000);
    }

    // (E2) the residual PATHOLOGICAL case the \r-fix can't help: a single write with NEITHER `\r` NOR `\n`
    // ANYWHERE — an early marker at the very start, followed by enough delimiter-free padding to blow FAR
    // past the cap. Proves the hard cap is a REAL, active bound (the early marker is genuinely evicted),
    // not just documented intent.
    {
      const tracker = createFailingTestTracker();
      const marker = "FAIL early-marker.spec.js > this must be evicted";
      const padding = "x".repeat(CAP_BYTES * 50); // no \r, no \n anywhere in this string
      const blob = marker + padding;
      check("(E2) the padding-only tail genuinely has no delimiter either (proves this is the true no-\\r-no-\\n case)",
        !padding.includes("\r") && !padding.includes("\n"));

      tracker.feed(Buffer.from(blob, "utf-8"));
      check("(E2) an early marker buried under a delimiter-free blob far exceeding the cap is evicted — proves the cap is an ACTIVE bound, not just documented",
        tracker.result() === undefined);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a failing-test marker buried by trailing output beyond the tail budget still survives via the live per-step scan, independent of outputTail's own truncation; a genuinely unrecognizable failure reports an honest undefined, never a guess; a heavy bare-\\r progress stream still resolves a marker correctly and stays bounded; a delimiter-free blob far exceeding the carry cap correctly evicts an early marker."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
