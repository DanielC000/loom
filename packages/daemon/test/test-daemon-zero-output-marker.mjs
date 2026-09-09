// Card 5e3ebc80: scripts/test-daemon.mjs's `FAILURES:` epilogue used to append a failing file's captured
// stdout/stderr CONDITIONALLY — when both streams were empty/whitespace-only, neither block was emitted
// and the epilogue printed a bare, empty-tail bullet line. "The child genuinely produced no output" and
// "we failed to capture the output it produced" were therefore the SAME bytes on the page. This file
// proves the fix: `buildFailureEntryLines` (scripts/test-daemon.mjs) now emits an explicit, self-describing
// marker on that branch instead of silence.
//
// Same convention as test-daemon-gate-timing-failure-detail.mjs: a REAL `node` subprocess (never a
// synthetic string) driven through the exported `spawnWithTimeout` — the SAME function `runOne` calls —
// reshaped into a `runOne`-row via the SAME exported helpers (`computeFailureTail`, and `signal` sourced
// the same way `runOne` sources it: `r.exitSignal ?? null`) production actually uses, then fed straight
// into the exported, production `buildFailureEntryLines`. This is deliberately NOT routed through the full
// `node scripts/test-daemon.mjs --only=<fixture>` entry point (unlike test-daemon-failures-epilogue-flush.mjs) —
// that heavier path exists there to exercise `writeFullySync`'s own flush-under-forced-chunking behaviour,
// which is not what this card touches; this card is purely about what CONTENT the epilogue renders, so
// driving the exported content-building function directly (against a real spawn's real capture) is the
// narrower, faster, equally-real check for exactly this claim.
import fs from "node:fs";
import path from "node:path";
import { spawnWithTimeout, computeFailureTail, buildFailureEntryLines, describeExitShape } from "../scripts/test-daemon.mjs";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const scratchRoot = mkdtempManaged("loom-zero-output-marker-");

function writeFixture(name, source) {
  const file = path.join(scratchRoot, `${name}.mjs`);
  fs.writeFileSync(file, source);
  return file;
}

// Builds the SAME row shape runOne's non-errored return produces (scripts/test-daemon.mjs), from a REAL
// spawnWithTimeout result — reusing the exact same exported helpers production uses for `tail`/`signal`,
// so this test can never silently duplicate-and-drift that derivation.
function rowFromRealSpawn(name, r) {
  return {
    name,
    status: r.status,
    timeoutDetail: r.timeoutDetail,
    exitToCloseGapMs: r.exitToCloseGapMs,
    stdout: r.stdout,
    stderr: r.stderr,
    signal: r.exitSignal ?? null,
    tail: r.ok ? undefined : computeFailureTail(r.stdout, r.stderr),
  };
}

const MARKER_TEXT = "no output captured on either stream";

// ── [THE TEST] real positive control: a fixture that genuinely writes nothing to either stream ──────────
{
  const fixture = writeFixture("silent-fail", "process.exit(7);\n");
  const r = await spawnWithTimeout(process.execPath, [fixture], { timeoutMs: 15_000 });

  // Precondition: prove the fixture really is what this test claims it is — a genuine nonzero exit with
  // GENUINELY zero captured bytes on both streams, not merely whitespace this test forgot to check.
  check("[precondition] silent-fail fixture actually failed (nonzero exit, not a timeout)", r.ok === false && r.status === 7);
  check("[precondition] silent-fail fixture captured stdout is empty", r.stdout === "");
  check("[precondition] silent-fail fixture captured stderr is empty", r.stderr === "");

  const lines = buildFailureEntryLines(rowFromRealSpawn("silent-fail", r)).join("\n");
  check("[THE TEST] zero-output marker appears for a real zero-byte failure", lines.includes(MARKER_TEXT));
  check("[THE TEST] the marker names the real exit shape (numeric exit code 7)", lines.includes("exit code 7"));
}

// ── [THE TEST — the control that actually matters] a fixture that DOES write output must NOT get the
//    marker. Without this, a runner that emits the marker UNCONDITIONALLY would also pass the block above. ─
{
  const fixture = writeFixture("loud-stdout-fail", 'console.log("REAL-OUTPUT-STDOUT-LINE");\nprocess.exit(3);\n');
  const r = await spawnWithTimeout(process.execPath, [fixture], { timeoutMs: 15_000 });

  check("[precondition] loud-stdout-fail fixture actually failed", r.ok === false && r.status === 3);
  check("[precondition] loud-stdout-fail fixture captured real stdout", r.stdout.includes("REAL-OUTPUT-STDOUT-LINE"));

  const lines = buildFailureEntryLines(rowFromRealSpawn("loud-stdout-fail", r)).join("\n");
  check("[THE TEST] zero-output marker is ABSENT when stdout was actually captured", !lines.includes(MARKER_TEXT));
  check("[sanity] the real captured stdout line still renders (existing behaviour, byte-identical)", lines.includes("REAL-OUTPUT-STDOUT-LINE"));
}

// Same shape, stderr-only (no stdout) — the marker's condition is "both streams empty", so a failure with
// ONLY stderr content must also decline the marker.
{
  const fixture = writeFixture("loud-stderr-fail", 'console.error("REAL-OUTPUT-STDERR-LINE");\nprocess.exit(5);\n');
  const r = await spawnWithTimeout(process.execPath, [fixture], { timeoutMs: 15_000 });

  check("[precondition] loud-stderr-fail fixture actually failed", r.ok === false && r.status === 5);
  check("[precondition] loud-stderr-fail fixture captured real stderr", r.stderr.includes("REAL-OUTPUT-STDERR-LINE"));

  const lines = buildFailureEntryLines(rowFromRealSpawn("loud-stderr-fail", r)).join("\n");
  check("[THE TEST] zero-output marker is ABSENT when only stderr was captured", !lines.includes(MARKER_TEXT));
  check("[sanity] the real captured stderr line still renders (existing behaviour, byte-identical)", lines.includes("REAL-OUTPUT-STDERR-LINE"));
}

// [negative control] the marker-matching itself must be able to fail: a string that was never emitted must
// be reported absent, so the ABSENT checks above aren't hiding a broken `includes` check.
{
  const fixture = writeFixture("loud-stdout-fail-2", 'console.log("REAL-OUTPUT-STDOUT-LINE");\nprocess.exit(3);\n');
  const r = await spawnWithTimeout(process.execPath, [fixture], { timeoutMs: 15_000 });
  const lines = buildFailureEntryLines(rowFromRealSpawn("loud-stdout-fail-2", r)).join("\n");
  check("[negative control] a string that was never emitted is correctly reported ABSENT", !lines.includes("STRING-NEVER-EMITTED-XYZ"));
}

// ── synthetic unit coverage for describeExitShape's OTHER branches (timeout / signal-kill / neither ever
//    observed) — a real signal-kill isn't exercised above (both real fixtures above exit via a numeric
//    code), so these are explicitly SYNTHETIC, not a second real control; same split this file's sibling
//    test-daemon-gate-timing-failure-detail.mjs already documents for classifyFailureDetail's own buckets. ─
{
  check("[synthetic] describeExitShape: timeout", describeExitShape({ status: "timeout" }) === "timeout");
  check("[synthetic] describeExitShape: numeric exit code", describeExitShape({ status: 1 }) === "exit code 1");
  check("[synthetic] describeExitShape: signal kill (no numeric code)", describeExitShape({ status: null, signal: "SIGSEGV" }) === "signal SIGSEGV");
  check("[synthetic] describeExitShape: neither a code nor a signal ever observed", describeExitShape({ status: null, signal: null }) === "exit code null (no signal captured either)");

  // And that the synthetic signal case actually reaches the epilogue's marker the same way the real
  // zero-byte fixture above did — proves buildFailureEntryLines's zero-output branch isn't hardcoded to
  // the numeric-code shape.
  const lines = buildFailureEntryLines({ name: "synthetic-signal-fail", status: null, signal: "SIGSEGV", stdout: "", stderr: "", tail: undefined }).join("\n");
  check("[synthetic] zero-output marker names a signal kill when that's the real exit shape", lines.includes(MARKER_TEXT) && lines.includes("signal SIGSEGV"));
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-zero-output-marker: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
