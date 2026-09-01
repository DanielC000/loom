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
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const { runGateStep, runGateSequential, extractFailingTest, createFailingTestTracker, createFailureBlockTracker, identifyRetriableTestFile } = await import("../dist/orchestration/gate-runner.js");

let failures = 0;
// `diagnostic` is an OPTIONAL third arg: a () => string called ONLY on failure, printed alongside the
// FAIL line. Card cf88f03b: the three (A2) content assertions used to report a bare boolean — two full
// CI runs on Linux told us only "the content isn't there", never WHAT was there instead. Making a failure
// self-diagnosing from the CI log alone is the fix that keeps paying after this card closes.
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

const dir = mkdtempManaged("loom-gr-trunc-");
{
  // Prints the failing-test marker FIRST, then floods ~80KB of unrelated trailing output — well past the
  // 4096-byte tail cap — before exiting non-zero. Mirrors a real runner (e.g. test-daemon.mjs) whose own
  // PASS/FAIL-by-name summary prints BEFORE a noisy trailing pnpm/warning epilogue.
  const SCRIPT = [
    "console.error('FAIL widget.spec.js > renders correctly');",
    "console.error('AssertionError: expected 2 to equal 3');",
    "for (let i = 0; i < 2000; i++) console.log('epilogue noise line ' + i + ' padding padding padding');",
    // Card cf88f03b: same reasoning as the (A2) specimen below — this fixture's printed content is what
    // (A)/(B)'s assertions check, so a POSIX async-stdout-drop on process.exit() could in principle lose
    // it too; a clean run history under sampled load isn't evidence against a load-sensitive race. No
    // pending async work above, so a natural exit can't hang.
    "process.exitCode = 1;",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "fail-then-flood.mjs"), SCRIPT);

  const res = await runGateStep("node fail-then-flood.mjs", dir, 15_000);
  check("(A) the step failed as expected (exit 1)", res.status === 1);
  check("(A) failingTest STILL names the test — the live scan survived the truncation",
    res.failingTest === "FAIL widget.spec.js > renders correctly");
  // Card 6ffee3e2: outputTail itself is now CONTENT-SELECTED on a failing step, not the positional
  // trailing ring — no `FAILURES:` marker was ever printed here, so it falls back to the same
  // content-selected line `failingTest` already names (see createFailingTestTracker's own doc; this
  // fallback tier is exactly what DoD-1 calls "select by content, not position" for a gate command that
  // isn't test-daemon.mjs). Before this card, outputTail was the naive last-OUTPUT_TAIL_BYTES ring, which
  // this exact specimen (an early failing line + ~80KB of unrelated trailing flood) genuinely evicted —
  // the old assertion here proved that eviction; this one proves it no longer determines what's reported.
  check("(A) outputTail is content-selected, not positional — it recovers the early failing line the OLD trailing-4KB ring would have evicted",
    res.outputTail === res.failingTest);
  check("(A) extractFailingTest against the NEW (content-selected) outputTail now finds it directly — proves outputTail itself carries the diagnosis, not just the separate failingTest field",
    extractFailingTest(res.outputTail ?? "") === "FAIL widget.spec.js > renders correctly");

  const seq = await runGateSequential("node fail-then-flood.mjs", dir, 15_000);
  check("(B) runGateSequential forwards failingTest verbatim from the failing step", seq.failingTest === res.failingTest);
  check("(B) runGateSequential still reports the failed step + exit status", seq.passed === false && seq.failedStep === "node fail-then-flood.mjs" && seq.failedStatus === 1);
  check("(B) runGateSequential forwards the SAME content-selected outputTail from the failing step", seq.outputTail === res.outputTail);

  // A run with NO recognizable failing-test marker at all (a genuinely unattributable failure) must
  // report `failingTest: undefined` — an honest miss, never a fabricated guess.
  // Card cf88f03b: `process.exitCode = 1` + natural exit — (C) below asserts this fixture's own printed
  // content (`outputTail === "kaboom, no idea why"`), the same theoretical exposure as (A2)'s specimen.
  fs.writeFileSync(path.join(dir, "fail-unrecognizable.mjs"), "console.error('kaboom, no idea why'); process.exitCode = 1;");
  const unrecognizable = await runGateStep("node fail-unrecognizable.mjs", dir, 15_000);
  check("(C) a failure with no recognizable marker reports failingTest:undefined (never a guessed name)",
    unrecognizable.status === 1 && unrecognizable.failingTest === undefined);
  // Card 6ffee3e2, CORRECTED (Code Review, merge-gate-retry.mjs case (E)): this specimen's total output
  // is tiny — well under OUTPUT_TAIL_BYTES — so NOTHING was ever evicted from the ring. Content-selection
  // is a replacement for a LOSSY tail, not a blanket ban on the raw one; when the raw tail already IS the
  // complete output, showing it is honest (not "an arbitrary tail that looks like an answer" — it's not
  // arbitrary, it's everything). DoD-3's "no failure line matched" honest-miss is exercised properly by
  // (C2) below, where the output genuinely exceeds the cap.
  check("(C) outputTail is the untruncated raw tail — nothing was evicted, so there is nothing to hide behind an honest-miss string",
    unrecognizable.outputTail === "kaboom, no idea why");

  // ── (C2) Card 6ffee3e2 DoD-3, THE REAL TEST: an unattributable failure whose output GENUINELY exceeds
  //        the tail budget — here content-selection actually applies, finds nothing in the flood, and the
  //        explicit honest-miss string is what must come back, never a lossy/evicted positional fragment. ──
  fs.writeFileSync(path.join(dir, "fail-unrecognizable-flood.mjs"), [
    "for (let i = 0; i < 2000; i++) console.log('unrelated noise line ' + i + ' padding padding padding');",
    "process.exit(1);",
  ].join("\n"));
  const unrecognizableFlood = await runGateStep("node fail-unrecognizable-flood.mjs", dir, 15_000);
  check("(C2) the flood genuinely exceeds the 4096-byte budget (proves this exercises the lossy-tail branch, not (C)'s untouched-raw-tail one)",
    unrecognizableFlood.status === 1);
  check("(C2) DoD-3: nothing recognizable matched anywhere in a genuinely-truncated run — outputTail says so EXPLICITLY, never an arbitrary evicted fragment",
    unrecognizableFlood.outputTail === "no failure line matched");

  // A green step reports no failingTest at all.
  fs.writeFileSync(path.join(dir, "ok.mjs"), "process.exit(0);");
  const ok = await runGateStep("node ok.mjs", dir, 15_000);
  check("(D) a passing step reports failingTest:undefined", ok.status === 0 && ok.failingTest === undefined);
  check("(D) card 4c5bf820's green-path outputTail is UNTOUCHED by this card — still the plain (here: empty) positional tail, never content-selected or the honest-miss string",
    ok.outputTail === "");

  // ── (A2) Card 6ffee3e2 DoD-4, THE REQUIRED POSITIVE CONTROL: reconstruct the exact op `a2679c1f`
  //        specimen HERMETICALLY — hundreds of PASS lines (positional budget consumers) ahead of ONE
  //        failing file whose real assertion body is printed via test-daemon.mjs's own `FAILURES:` echo
  //        shape, followed by pnpm's own recursive-run epilogue (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` +
  //        "Exit status 1") — the exact trailing noise the card's specimen showed swallowing the body. If
  //        the fix recovers this assertion, it works (the card's own acceptance bar). ──────────────────
  {
    // Deliberately contains single quotes (a REAL assertion message shape) — embedded via JSON.stringify
    // below (a valid, properly-escaped JS string literal), never hand-wrapped in single quotes, so this
    // fixture can't silently generate a syntactically-broken specimen script (caught in review: an
    // earlier hand-quoted version DID break the specimen's own JS syntax, and the resulting SyntaxError
    // text — echoed to stderr, which this tracker also scans — happened to CONTAIN this same substring,
    // making the acceptance-bar check below pass VACUOUSLY for the wrong reason; JSON.stringify closes
    // that hole structurally instead of relying on hand-escaping never regressing).
    const REAL_ASSERTION = "AssertionError: expected vault push status 'clean' but got 'dirty' (uncommitted: .loom/session.lock)";
    const PASS_LINES = Array.from({ length: 690 }, (_, i) => `console.log('PASS  fixture-test-${i}');`).join("\n");
    const SPECIMEN_SCRIPT = [
      PASS_LINES,
      "console.log('691/691 hermetic daemon tests passed. (pool size 3)');", // never actually reached — this run fails; mirrors the real summary line's position ahead of FAILURES:
      "console.log('FAILURES:');",
      "console.log('  - vault-push-status (exit 1): C:\\\\Users\\\\danie\\\\.loom-worktrees\\\\fixture\\\\packages\\\\daemon:');",
      `console.log(${JSON.stringify(`      ${REAL_ASSERTION}`)});`,
      "console.log('      at Object.<anonymous> (vault-push-status.mjs:42:9)');",
      // pnpm's own recursive-run wrapper epilogue — printed by the OUTER pnpm process, after the inner
      // node script (test-daemon.mjs) has already exited — exactly what pushed the real specimen's body
      // out of a naive trailing-4KB ring.
      "console.log(' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @loom/daemon@0.0.0 test:daemon: `node scripts/test-daemon.mjs`');",
      "console.log('Exit status 1');",
      // Card cf88f03b: `process.exitCode = 1` + a natural exit, NOT `process.exit(1)`. On POSIX, a pipe-
      // backed process.stdout write is ASYNCHRONOUS, and process.exit() does not wait for pending writes to
      // drain — the specimen's own tail (this script's entire reason for existing) can be discarded before
      // it ever reaches the parent's pipe. Setting exitCode and falling off the end of the script lets node
      // drain its stdio queue before the process actually exits. Safe here: nothing above is async (no
      // timers/handles/pending I/O), so there is no risk of hanging instead of exiting.
      "process.exitCode = 1;",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "specimen-a2679c1f.mjs"), SPECIMEN_SCRIPT);

    // The ACTUAL printed output (not the source script's own text) is what the positional ring measures —
    // compute it the same way the script itself will print it, so this check reflects real runtime bytes.
    const specimenPassOutputBytes = Buffer.byteLength(
      Array.from({ length: 690 }, (_, i) => `PASS  fixture-test-${i}`).join("\n"), "utf-8",
    );
    const specimen = await runGateStep("node specimen-a2679c1f.mjs", dir, 15_000);
    // Card cf88f03b diagnostic: bounded (~500 chars) dump of the ACTUAL outputTail, printed only when one
    // of the three content checks below fails — a bare "isn't there" boolean told us nothing about WHAT
    // arrived instead (empty ⇒ flush loss; "no failure line matched" ⇒ the stream arrived but the marker
    // didn't match; a partial block ⇒ a cap/carry bug). Kept as a shared closure so all three failures
    // report the SAME snapshot rather than re-deriving it.
    const outputTailDiagnostic = () => {
      const t = specimen.outputTail;
      if (typeof t !== "string") return `outputTail is ${JSON.stringify(t)} (not a string)`;
      return `outputTail length=${t.length}, first 500 chars: ${JSON.stringify(t.slice(0, 500))}`;
    };
    check("(A2) the specimen's PASS-line flood alone genuinely exceeds the 4096-byte positional tail budget (proves this isn't a short-suite no-op)",
      specimenPassOutputBytes > 4096 && specimen.status === 1);
    check("(A2) the recovered outputTail contains the FAILURES: header",
      typeof specimen.outputTail === "string" && specimen.outputTail.includes("FAILURES:"), outputTailDiagnostic);
    check("(A2) the recovered outputTail contains the failing file's name + exit code",
      typeof specimen.outputTail === "string" && specimen.outputTail.includes("vault-push-status (exit 1)"), outputTailDiagnostic);
    check("(A2) THE ACCEPTANCE BAR: the recovered outputTail contains the ACTUAL assertion body — the exact content a positional trailing ring pushed out in the real op a2679c1f",
      typeof specimen.outputTail === "string" && specimen.outputTail.includes(REAL_ASSERTION), outputTailDiagnostic);
    // Card cf88f03b: paired with a non-vacuity precondition (non-empty AND contains the marker) — the
    // original negation-only form (`!outputTail.includes("fixture-test-")`) ALSO passes on an empty or
    // marker-free capture, so it could not discriminate "correctly front-anchored" from "captured nothing"
    // (it passed vacuously in both red CI runs while its three siblings caught the failure loudly).
    check("(A2) the recovered outputTail is genuinely front-anchored FROM the marker (non-vacuous: outputTail is non-empty AND contains FAILURES:) — none of the 690 preceding PASS lines leaked into it",
      typeof specimen.outputTail === "string" && specimen.outputTail.length > 0 && specimen.outputTail.includes("FAILURES:") && !specimen.outputTail.includes("fixture-test-"),
      outputTailDiagnostic);
    check("(A2) HARD SCOPE FENCE: this card never touches verdict — the step still genuinely fails (status 1), unchanged from before this fix",
      specimen.status === 1);
  }

  // ── (A3) createFailureBlockTracker, driven directly (hermetic, no spawn) — mirrors this file's own
  //        createFailingTestTracker unit-test convention below. ────────────────────────────────────────
  {
    const noMarker = createFailureBlockTracker();
    noMarker.feed(Buffer.from("PASS one\nPASS two\nAssertionError: unrelated to a FAILURES echo\n", "utf-8"));
    check("(A3) negative control: no FAILURES: marker anywhere reports undefined (never a guess)",
      noMarker.result() === undefined);

    const withMarker = createFailureBlockTracker();
    withMarker.feed(Buffer.from("PASS one\nPASS two\n", "utf-8"));
    withMarker.feed(Buffer.from("FAILURES:\n  - some-test (exit 1): body line one\n", "utf-8"));
    withMarker.feed(Buffer.from("      body line two\n", "utf-8"));
    const found = withMarker.result();
    check("(A3) once the marker is seen, everything from it forward is captured, across multiple feed() calls",
      found !== undefined && found.includes("FAILURES:") && found.includes("body line one") && found.includes("body line two"));

    const capped = createFailureBlockTracker();
    capped.feed(Buffer.from("FAILURES:\n", "utf-8"));
    capped.feed(Buffer.from("x".repeat(30_000) + "\n", "utf-8"));
    capped.feed(Buffer.from("this arrives after the cap and must be dropped\n", "utf-8"));
    const cappedResult = capped.result();
    check("(A3) the front-anchored capture is bounded (never grows to hold the whole stream) — proves the cap is an ACTIVE bound, not just documented",
      cappedResult !== undefined && cappedResult.length <= 16_384);
    check("(A3) content AFTER the cap was reached is genuinely dropped, not silently included",
      !cappedResult.includes("arrives after the cap"));
  }

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
      // Card c976f009 (Part 2, resolved (a)): a synchronous, no-I/O, no-timer CPU loop over ~2MB — an
      // O(n) `feed` should take low-single-digit ms, so the 2s ceiling is a ~100-1000x margin meant to
      // catch a quadratic/unbounded regression, not to prove a real-time bound. Extreme host contention
      // (this whole process starved of CPU by other load) could in principle still push it over, but that
      // margin makes it low-risk; nothing here races a clock adjustment the way a LOWER-bound check would
      // (see codescape-supervisor.mjs's MONOTONIC notes for that different, genuinely-fixed risk), so
      // Date.now() is fine as-is.
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

  // ── (F)-(H) Card 0e5b2045: THE UNCAUGHT IDIOM — 9 of this daemon's own test files report a genuine
  //     (non-AssertionError) thrown failure via `console.error("... UNCAUGHT ...")`, and matched NONE of the
  //     original 3 tiers. The real incident (worker 7e4020e7's investigation of 04ef579e): a 907s/686-file
  //     run's ONLY tier hit was `test-daemon.mjs`'s own content-free per-file summary line —
  //     `FAIL  kickoff-real-spawn  (exit 1)` — while the actual stack, printed later in the same stream via
  //     that same script's end-of-run `FAILURES:` echo (`      💥 UNCAUGHT — Error: ...`, 6-space-indented,
  //     the exact real `test-daemon.mjs` shape), was discarded. THIS IS DoD-2's REQUIRED POSITIVE CONTROL:
  //     the specimen is the exact idiom (a plain Error, not AssertionError, rendered through
  //     `💥 UNCAUGHT — ${err.stack}`), and the assertion is that the tracker returns THAT line, not the bare
  //     FAIL summary — proving the fix, not merely that the new pattern matches something in isolation. ────
  {
    const FAIL_LINE = "FAIL  kickoff-real-spawn  (exit 1)";
    // The real kickoff-real-spawn.mjs idiom (`console.error(\`\n💥 UNCAUGHT — ${err?.stack || err}\`)`), as it
    // would actually reach the live scan via test-daemon.mjs's own FAILURES: echo (6-space-indented, one
    // line per stdout/stderr line of the failing child) — not a hand-simplified stand-in. `result()` trims
    // each stored line (`scanLine`'s own `line.trim()`, same as every other marker in this file), so the
    // TRIMMED form is what a caller actually observes — asserted against RAW below, not by accident.
    const UNCAUGHT_LINE_RAW = "      💥 UNCAUGHT — Error: waitUntil timed out after 8000ms";
    const UNCAUGHT_LINE = UNCAUGHT_LINE_RAW.trim();
    const STACK_FRAME = "          at waitUntil (file:///dist/test/kickoff-real-spawn.mjs:120:9)";

    // (F1) NEGATIVE CONTROL FIRST — prove the new pattern is not a vacuous always-match: a line that
    // discusses "uncaught" concepts in lowercase prose (not the idiom's actual all-caps marker) must NOT
    // match, and a tracker fed ONLY ordinary passing-shaped output finds nothing.
    {
      const tracker = createFailingTestTracker();
      tracker.feed(Buffer.from("the handler gracefully handles uncaught exceptions in children\n", "utf-8"));
      tracker.feed(Buffer.from("PASS  some-other-test\n", "utf-8"));
      check("(F1) negative control: lowercase 'uncaught' prose + a PASS line match no tier",
        tracker.result() === undefined);
    }

    // (F2) THE SPECIMEN, FAIL-LINE-FIRST (matches the real run's actual chronology: the per-lane completion
    // line prints mid-run, the FAILURES: echo prints only once ALL lanes finish). Pre-fix, tier 0 (FAIL)
    // was the only hit and won; post-fix, UNCAUGHT must win.
    {
      const tracker = createFailingTestTracker();
      tracker.feed(Buffer.from(`${FAIL_LINE}\n`, "utf-8"));
      tracker.feed(Buffer.from(`${UNCAUGHT_LINE_RAW}\n${STACK_FRAME}\n`, "utf-8"));
      check("(F2) DoD-2 POSITIVE CONTROL: with a real FAIL <name> line seen BEFORE the UNCAUGHT line, result() returns the UNCAUGHT line, not the bare FAIL summary",
        tracker.result() === UNCAUGHT_LINE);
      check("(F2) the bare FAIL summary is genuinely NOT what's returned (proves this isn't a coincidental string overlap)",
        tracker.result() !== FAIL_LINE);
    }

    // (G) DoD-3, BOTH DIRECTIONS: the priority decision (UNCAUGHT ranks ABOVE FAIL/not-ok) must hold
    // regardless of which line the stream happens to print first — proving this is a tier-priority choice,
    // not an accidental "whichever line arrived last" artifact (result() already prefers the LAST match
    // *within* a tier, so order-independence across tiers is exactly what needs proving here).
    {
      const orderA = createFailingTestTracker();
      orderA.feed(Buffer.from(`${FAIL_LINE}\n${UNCAUGHT_LINE_RAW}\n`, "utf-8"));
      const orderB = createFailingTestTracker();
      orderB.feed(Buffer.from(`${UNCAUGHT_LINE_RAW}\n${FAIL_LINE}\n`, "utf-8"));
      check("(G) FAIL-then-UNCAUGHT resolves to UNCAUGHT", orderA.result() === UNCAUGHT_LINE);
      check("(G) UNCAUGHT-then-FAIL ALSO resolves to UNCAUGHT (order-independent — a genuine tier decision)", orderB.result() === UNCAUGHT_LINE);
    }

    // (H) DoD-4: matchCount() must not double-count ONE logical failure just because it prints two
    // recognizable lines (one FAIL wrapper line + one UNCAUGHT idiom line) across two DIFFERENT tiers —
    // matchCount() reports the WINNING tier's own count only, so a single failing file's own single
    // UNCAUGHT line must report exactly 1, never 2.
    {
      const oneFailure = createFailingTestTracker();
      oneFailure.feed(Buffer.from(`${FAIL_LINE}\n${UNCAUGHT_LINE_RAW}\n`, "utf-8"));
      check("(H1) one logical failure (1 FAIL line + 1 UNCAUGHT line) reports matchCount()===1, not 2",
        oneFailure.matchCount() === 1);

      // Two GENUINELY DISTINCT failing files, each printing its own UNCAUGHT line, must still report 2 —
      // proves (H1)'s ===1 isn't from an under-counting bug that would ALSO hide real multi-file ambiguity.
      const twoFailures = createFailingTestTracker();
      twoFailures.feed(Buffer.from("      💥 UNCAUGHT — Error: file A timed out\n", "utf-8"));
      twoFailures.feed(Buffer.from("      💥 UNCAUGHT — Error: file B timed out\n", "utf-8"));
      check("(H2) two distinct UNCAUGHT-tier lines report matchCount()===2 (ambiguity is still visible, not collapsed)",
        twoFailures.matchCount() === 2);
    }

    // (I) THE DECOUPLING, ASSERTED EXPLICITLY (manager review, card 0e5b2045): `identifyRetriableTestFile`
    // reads `failTierResult()`/`failTierMatchCount()`, NOT `result()`/`matchCount()` — a run with BOTH a
    // real FAIL <name> line and an UNCAUGHT line must (a) still return the UNCAUGHT line from result() for
    // diagnostics, AND (b) still produce a WORKING retry target via the tier-isolated accessors. Losing (b)
    // as a side effect of fixing (a) would have silently turned kickoff-real-spawn's own self-healing
    // retries into hard merge rejections (~15 extra minutes each, at its measured ~1-in-11 weaker-pass
    // rate) — a policy change to fleet-wide retry behavior this card never asked for. Plants the real
    // fixture files identifyRetriableTestFile's own `fs.existsSync` checks require, mirroring
    // merge-gate-single-file-retry.mjs's fixture-planting convention.
    {
      const scriptsDir = path.join(dir, "packages", "daemon", "scripts");
      const testDirFixture = path.join(dir, "packages", "daemon", "test");
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.mkdirSync(testDirFixture, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, "test-daemon.mjs"), "// fixture\n");
      fs.writeFileSync(path.join(testDirFixture, "kickoff-real-spawn.mjs"), "// fixture\n");

      const tracker = createFailingTestTracker();
      tracker.feed(Buffer.from(`${FAIL_LINE}\n${UNCAUGHT_LINE_RAW}\n`, "utf-8"));

      check("(I-a) result() still returns the UNCAUGHT line for diagnostics, with the retry-target decoupling in place",
        tracker.result() === UNCAUGHT_LINE);

      const candidate = identifyRetriableTestFile(tracker.failTierResult(), dir, tracker.failTierMatchCount());
      check("(I-b) failTierResult()/failTierMatchCount() still identify kickoff-real-spawn as a WORKING retry target — the single-file merge retry does NOT silently stop firing for UNCAUGHT-idiom files",
        candidate !== undefined && candidate.name === "kickoff-real-spawn");
      check("(I-b) the retry command is the real --only= single-file re-invocation",
        candidate?.command === "node packages/daemon/scripts/test-daemon.mjs --only=kickoff-real-spawn");

      // NEGATIVE CONTROL: feeding result()/matchCount() (the diagnostic-winning fields, NOT the tier-
      // isolated ones) into identifyRetriableTestFile must decline — proves (I-b)'s pass isn't vacuous
      // (i.e. isn't passing because identifyRetriableTestFile accepts anything it's handed).
      const wrongFieldCandidate = identifyRetriableTestFile(tracker.result(), dir, tracker.matchCount());
      check("(I) negative control: passing result()/matchCount() (the UNCAUGHT-winning diagnostic fields) instead of the failTier* accessors correctly declines — the two accessor pairs are not interchangeable",
        wrongFieldCandidate === undefined);
    }

    // ── (K) Card 6c84b87b — THE ACTUAL DEFECT, PROVEN END-TO-END THROUGH THE REAL TRACKER (not an
    //     injected count). DoD-2's own named missing assertion: "a single file failing one check()
    //     assertion, rendered through test-daemon.mjs's own FAILURES: echo, still yields
    //     failTierMatchCount() === 1." Before this card, (I-b) above was the ONLY place the real tracker
    //     fed the real predicate end-to-end, and its only fixture was the UNCAUGHT idiom — the one shape
    //     that happened to yield 1 even under the old bug (nothing for the epilogue to echo, since an
    //     UNCAUGHT crash has zero failed check()s). This reconstructs the OTHER, dominant shape (815-of-848
    //     of this daemon's own test files): a normal check() assertion failure, rendered through the REAL
    //     runLane wrapper line PLUS the REAL FAILURES: epilogue's 6-space-indented echo of that SAME file's
    //     own FAIL <label> line — both console.log shapes reproduced verbatim from scripts/test-daemon.mjs,
    //     not hand-simplified. ──────────────────────────────────────────────────────────────────────────
    {
      const testDirFixture = path.join(dir, "packages", "daemon", "test");

      // The runLane wrapper line — printed ONCE, unindented, the moment this file's child process settles.
      const WRAPPER_LINE = "FAIL  widget-assertion-fail  (exit 1)";
      // This file's OWN check() print, as ITS OWN stdout carries it: unindented (e.g.
      // packages/daemon/test/gate-history.mjs:60's `const check = (label, cond) => console.log(...)`).
      const CHILD_OWN_FAIL_LINE = "FAIL  the widget renders with the right label";

      // (K1) THE BUG, PRE-FIX / PROVEN FIXED POST-FIX: feed the REAL stream shape, in the REAL order — the
      // wrapper line during the run, then (once the whole suite finishes) the FAILURES: epilogue's own
      // per-file header + the full stdout echo containing that SAME file's own FAIL line, now re-indented.
      {
        fs.writeFileSync(path.join(testDirFixture, "widget-assertion-fail.mjs"), "// fixture\n");
        const tracker = createFailingTestTracker();
        tracker.feed(Buffer.from(`${WRAPPER_LINE}\n`, "utf-8"));
        tracker.feed(Buffer.from([
          "FAILURES:",
          `  - widget-assertion-fail (exit 1): ${CHILD_OWN_FAIL_LINE}`,
          `      ${CHILD_OWN_FAIL_LINE}`,
        ].join("\n") + "\n", "utf-8"));

        check("(K1) DoD-2 NAMED ASSERTION: a single file failing ONE check() assertion, rendered through test-daemon.mjs's own FAILURES: echo, yields failTierMatchCount() === 1 (pre-fix this read 2 — the wrapper line PLUS its own echoed FAIL line double-counted as two DIFFERENT failing files)",
          tracker.failTierMatchCount() === 1);
        check("(K1) failTierResult() names the real wrapper line itself, never the echoed indented copy",
          tracker.failTierResult() === WRAPPER_LINE);

        const candidate = identifyRetriableTestFile(tracker.failTierResult(), dir, tracker.failTierMatchCount());
        check("(K1) THE ACTUAL FIX: identifyRetriableTestFile now identifies widget-assertion-fail as a working retry target for a plain ASSERTION failure — not just the UNCAUGHT idiom (I-b) already covered (pre-fix: the retry NEVER fired for an assertion failure at all — this is the ~96%-of-the-population case the card names)",
          candidate !== undefined && candidate.name === "widget-assertion-fail");
      }

      // (K2) NEGATIVE CONTROL — genuine multi-file ambiguity must still refuse. Two REAL, distinct files
      // each printing their own real wrapper line must still report failTierMatchCount() === 2 and decline
      // the retry — proves (K1)'s anchoring didn't accidentally collapse real ambiguity down to 1 along
      // with fixing the false positive (the unsafe direction this card's own DoD explicitly warns against).
      {
        fs.writeFileSync(path.join(testDirFixture, "widget-assertion-fail-2.mjs"), "// fixture\n");
        const tracker = createFailingTestTracker();
        tracker.feed(Buffer.from("FAIL  widget-assertion-fail  (exit 1)\nFAIL  widget-assertion-fail-2  (exit 1)\n", "utf-8"));
        check("(K2) two GENUINELY distinct failing files' own wrapper lines still report failTierMatchCount() === 2 — real ambiguity is not swallowed by the anchoring fix",
          tracker.failTierMatchCount() === 2);
        const candidate = identifyRetriableTestFile(tracker.failTierResult(), dir, tracker.failTierMatchCount());
        check("(K2) and the retry correctly declines on that real ambiguity",
          candidate === undefined);
      }

      // (K3) card 2a79a74c finding #4, VERIFIED HERE (not just cited): a REDUCED-PATH static guard runs
      // BARE (`node <guard>.mjs` — git/worktrees.ts's buildReducedGateCommand), so its own failed check()
      // prints an unindented FAIL <label> line with NO runLane wrapper and NO "(exit " suffix at all —
      // mirrors the reviewer's own real specimen (a guard check() label starting with the token
      // "gate-history", which names a real test file). Pre-fix this satisfied the old unanchored FAIL/
      // not-ok tier at count 1 and produced a candidate that would have retried an UNRELATED file, masking
      // the guard's own failure. Post-fix it must produce NOTHING — the "(exit " suffix this pattern
      // requires is something only runLane's own per-FILE wrapper ever prints, so a guard's bare assertion
      // failure can never satisfy it.
      {
        fs.writeFileSync(path.join(testDirFixture, "gate-history.mjs"), "// fixture\n");
        const tracker = createFailingTestTracker();
        tracker.feed(Buffer.from("FAIL  gate-history is still witnessed by the fixed-wait guard\n", "utf-8"));
        check("(K3) card 2a79a74c #4: a bare reduced-path guard's own FAIL <label> line (no runLane wrapper, no exit suffix) is NOT counted by failTierMatchCount()",
          tracker.failTierMatchCount() === 0);
        check("(K3) and failTierResult() is undefined — nothing for identifyRetriableTestFile to even parse",
          tracker.failTierResult() === undefined);
        const candidate = identifyRetriableTestFile(tracker.failTierResult(), dir, tracker.failTierMatchCount());
        check("(K3) so identifyRetriableTestFile never produces a candidate at all — a guard failure can no longer masquerade as a retry into an unrelated file",
          candidate === undefined);
      }

      // (K4) card 2a79a74c finding #5: `test-daemon.mjs`'s own structural `notExecuted` invariant trips
      // BEFORE its `FAILURES:` echo — but `runLane`'s per-file wrapper line for a co-occurring GENUINE
      // failure is unaffected (it's printed live, the moment that one file's own child settles, well
      // before the later notExecuted bookkeeping check even runs). So failTierMatchCount() alone cannot
      // tell "one real failure, otherwise a clean run" apart from "one real failure PLUS some other
      // selected file(s) silently never ran at all" — this is exactly the masking risk the card names.
      {
        const NOT_EXECUTED_LINE = "❌ test-daemon.mjs: 2 discovered hermetic test file(s) were NOT actually executed — naming them: ghost-one, ghost-two";
        fs.writeFileSync(path.join(testDirFixture, "real-failure.mjs"), "// fixture\n");

        // (K4a) MUTATION PROOF, ARM 1 (pre-fix shape / RED without the new refusal): the wrapper line for
        // a genuinely failing file, PLUS the notExecuted marker, in the SAME stream — mirrors a real run
        // that both failed one test AND lost track of whether every selected file even ran.
        {
          const tracker = createFailingTestTracker();
          tracker.feed(Buffer.from(`FAIL  real-failure  (exit 1)\n${NOT_EXECUTED_LINE}\n`, "utf-8"));
          check("(K4a) failTierMatchCount() is UNCHANGED at 1 — the co-occurring genuine failure's own wrapper line is not suppressed by the notExecuted line existing elsewhere in the stream",
            tracker.failTierMatchCount() === 1);
          check("(K4a) failTierResult() still names the real failing file — the retry's OLD input alone would have identified it",
            tracker.failTierResult() === "FAIL  real-failure  (exit 1)");
          check("(K4a) THE NEW SIGNAL: harnessNotExecutedDetected() is true",
            tracker.harnessNotExecutedDetected() === true);

          // PROVES THE CHECK CAN FAIL (mutation): calling identifyRetriableTestFile the OLD way (3 args,
          // matching every pre-#5 call site in this repo) still produces a candidate — the bug this card
          // fixes, reproduced live, not asserted from memory.
          const oldShapeCandidate = identifyRetriableTestFile(tracker.failTierResult(), dir, tracker.failTierMatchCount());
          check("(K4a) OLD 3-ARG CALL SHAPE (pre-#5 fix): still identifies a retry candidate — this is the exact masking risk card 2a79a74c #5 describes, reproduced here as the RED case the fix must close",
            oldShapeCandidate !== undefined && oldShapeCandidate.name === "real-failure");

          // THE FIX ITSELF: passing harnessNotExecutedDetected() (true) refuses the retry outright, despite
          // failTierMatchCount() === 1 and a real, existing candidate file.
          const fixedCandidate = identifyRetriableTestFile(tracker.failTierResult(), dir, tracker.failTierMatchCount(), tracker.harnessNotExecutedDetected());
          check("(K4a) THE FIX: passing harnessNotExecutedDetected() through refuses the retry — no candidate, despite a real, otherwise-retriable single failure",
            fixedCandidate === undefined);
        }

        // (K4b) NEGATIVE CONTROL — the SAME single genuine failure, with NO notExecuted line anywhere in
        // the stream, must still retry normally: this card's fix must not become a blanket refusal.
        {
          const tracker = createFailingTestTracker();
          tracker.feed(Buffer.from("FAIL  real-failure  (exit 1)\n", "utf-8"));
          check("(K4b) harnessNotExecutedDetected() is false on an ordinary run with no structural invariant tripped",
            tracker.harnessNotExecutedDetected() === false);
          const candidate = identifyRetriableTestFile(tracker.failTierResult(), dir, tracker.failTierMatchCount(), tracker.harnessNotExecutedDetected());
          check("(K4b) an ordinary single-file genuine failure still identifies a working retry target — the #5 fix does not suppress the normal case",
            candidate !== undefined && candidate.name === "real-failure");
        }

        // (K4c) the notExecuted line ALONE (no genuine test failure at all — e.g. a pure harness/pool bug
        // with every selected file that DID run passing) must still refuse: failTierResult() is undefined
        // in that case (nothing for identifyRetriableTestFile to even parse), so this is really a
        // tracker-level check that the marker is detected independent of whether any FAIL-tier line exists.
        {
          const tracker = createFailingTestTracker();
          tracker.feed(Buffer.from(`${NOT_EXECUTED_LINE}\n`, "utf-8"));
          check("(K4c) notExecuted alone (no genuine failure in the stream): harnessNotExecutedDetected() is true",
            tracker.harnessNotExecutedDetected() === true);
          check("(K4c) failTierMatchCount() stays 0 — the notExecuted line itself is never mistaken for a FAIL-tier wrapper line",
            tracker.failTierMatchCount() === 0);
          const candidate = identifyRetriableTestFile(tracker.failTierResult(), dir, tracker.failTierMatchCount(), tracker.harnessNotExecutedDetected());
          check("(K4c) no candidate either way — failTierResult() is undefined, so identifyRetriableTestFile's own first check already refuses",
            candidate === undefined);
        }
      }
    }
  }

  // ── (J) Card 2f0b2e57 — THE REAL INCIDENT: op `5b2075db` reported gateDetail.failingTest as a PASSING
  //     assertion. `merge-gate-single-file-retry.mjs`'s own retry-decoupling check is LABELLED with prose
  //     that describes the UNCAUGHT idiom — "the retry call names flaky-j (from failTierTest), never
  //     anything derived from the UNCAUGHT diagnostic string" — and that label, once printed as
  //     `PASS  <label>` by this daemon's own check() convention, matched tier 0's UNANCHORED `UNCAUGHT`
  //     pattern and WON, because it contains the bare word "UNCAUGHT". This is the VERBATIM real line
  //     (op 5b2075db's own gateDetail.failingTest, reproduced from the card), not a paraphrase. ──────────
  {
    // Verbatim, as printed by check(): `${cond ? "PASS" : "FAIL"}  ${label}` with the real op's own label.
    const REAL_PASS_LINE = "PASS  (J) the retry call names flaky-j (from failTierTest), never anything derived from the UNCAUGHT diagnostic string";
    const REAL_FAIL_LINE = "FAIL  (G) worker2's own re-union at admission absorbed worker1's landed squash";
    const REAL_UNCAUGHT_LINE = "      💥 UNCAUGHT — Error: waitUntil timed out after 8000ms";

    // (J1) THE BUG, REPRODUCED PRE-FIX / PROVEN FIXED POST-FIX: the specimen PASS line ALONE — nothing
    // else in the stream recognizable as a failure — must report undefined. Pre-fix, tier 0's unanchored
    // \bUNCAUGHT\b matched this exact line and `result()` returned it as "the failing test" despite it
    // being a passing assertion; this is the negative control proving the fix, not just a shape check.
    {
      const tracker = createFailingTestTracker();
      tracker.feed(Buffer.from(`${REAL_PASS_LINE}\n`, "utf-8"));
      check("(J1) THE BUG SPECIMEN: the real op 5b2075db PASS line, fed alone, is NEVER reported as failingTest (pre-fix this exact line was wrongly returned)",
        tracker.result() === undefined);
      check("(J1) matchCount() agrees: zero matches, not a phantom hit on a tier that then got suppressed for display only",
        tracker.matchCount() === 0);
    }

    // (J2) DoD-3 POSITIVE CONTROL, ARM (a): the specimen PASS line (contains "UNCAUGHT") coexists with a
    // REAL FAIL line ⇒ the FAIL line is reported, never the PASS line — proves the guard doesn't just
    // suppress the PASS line into a false "nothing recognizable", it correctly falls through to a real
    // failure elsewhere in the same stream.
    {
      const tracker = createFailingTestTracker();
      tracker.feed(Buffer.from(`${REAL_PASS_LINE}\n${REAL_FAIL_LINE}\n`, "utf-8"));
      check("(J2) DoD-3(a): PASS-line-containing-UNCAUGHT + a real FAIL line ⇒ result() reports the FAIL line",
        tracker.result() === REAL_FAIL_LINE);
      check("(J2) DoD-3(a): the PASS line is genuinely not what's returned (not a coincidental substring match)",
        tracker.result() !== REAL_PASS_LINE);
    }

    // (J3) DoD-3 POSITIVE CONTROL, ARM (b): a genuine UNCAUGHT crash, no FAIL line, but the SAME
    // PASS-line-containing-UNCAUGHT specimen also present in the stream ⇒ the UNCAUGHT crash line still
    // wins — proves the PASS guard does NOT regress card 0e5b2045's actual purpose (UNCAUGHT outranking a
    // bare FAIL summary when a genuine crash is present).
    {
      const tracker = createFailingTestTracker();
      tracker.feed(Buffer.from(`${REAL_PASS_LINE}\n${REAL_UNCAUGHT_LINE}\n`, "utf-8"));
      check("(J3) DoD-3(b): a genuine UNCAUGHT crash line is still reported even with a PASS-line-containing-UNCAUGHT also present",
        tracker.result() === REAL_UNCAUGHT_LINE.trim());
    }

    // (J4) extractFailingTest (the post-hoc fallback for a raw string) must honor the SAME invariant —
    // the fix applies to both entry points, not just the live tracker.
    {
      check("(J4) extractFailingTest: the specimen PASS line alone reports undefined",
        extractFailingTest(REAL_PASS_LINE) === undefined);
      check("(J4) extractFailingTest: the specimen PASS line + a real FAIL line reports the FAIL line, not the PASS line",
        extractFailingTest(`${REAL_PASS_LINE}\n${REAL_FAIL_LINE}`) === REAL_FAIL_LINE);
    }
  }
}
// dir's own manual finally-block rmSync removed here: mkdtempManaged already registered it for
// guaranteed cleanup at process exit (card 995be21f).

console.log(failures === 0
  ? "\n✅ ALL PASS — a failing-test marker buried by trailing output beyond the tail budget still survives via the live per-step scan, independent of outputTail's own truncation; a genuinely unrecognizable failure reports an honest undefined, never a guess; a heavy bare-\\r progress stream still resolves a marker correctly and stays bounded; a delimiter-free blob far exceeding the carry cap correctly evicts an early marker; an UNCAUGHT-idiom line outranks a content-free FAIL <name> summary for diagnostics (order-independent), matchCount() doesn't double-count one logical failure across the two tiers, and the retry target is DECOUPLED from that diagnostic priority — failTierResult()/failTierMatchCount() still identify a working single-file retry even when result() reports the UNCAUGHT line instead."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
