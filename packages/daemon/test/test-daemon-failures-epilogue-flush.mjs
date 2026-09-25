// Card 14e733fb: proves scripts/test-daemon.mjs's own `FAILURES:` epilogue (see `writeFullySync`'s doc
// there) actually flushes the WHOLE failing-file diagnostic before `process.exit(1)`, through the REAL
// entry point — `node scripts/test-daemon.mjs --only=epilogue-flush-fixture` — never by importing
// test-daemon.mjs's internals directly. epilogue-flush-fixture.mjs (this dir) is the deliberately-failing
// target; it only fails when LOOM_TEST_EPILOGUE_FLUSH_MARKER is set, so it's a no-op in every normal run
// and never pollutes a real gate run's own pass/fail.
//
// `LOOM_TEST_FORCE_WRITE_CHUNK_BYTES=N` forces `writeFullySync`'s own retry loop to make one `fs.writeSync`
// call per N bytes of the epilogue — the only way to exercise "loop until every byte is written"
// deterministically on THIS host: real POSIX async-pipe loss (the mechanism this fix targets) can't be
// reproduced hermetically here (this repo's own gate runs on Windows, where pipe writes are synchronous by
// construction — see card 14e733fb's own investigation report for why that host is structurally blind to
// it). A regression that replaced the loop with a single `fs.writeSync` call would, under this env var,
// write only the first forced-chunk-sized sliver of the epilogue and then move on to `process.exit(1)` —
// this test's [THE TEST] case below catches exactly that. Verified BREAK -> RED -> revert -> GREEN while
// authoring this fix (temporarily replacing the loop with one non-looping `fs.writeSync` call reproduced a
// truncated capture here; reverting restored the full capture) — not re-encoded as a shippable toggle.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(DAEMON_ROOT, "scripts", "test-daemon.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function runFixture({ marker, lineCount, forceChunkBytes }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [SCRIPT, "--only=epilogue-flush-fixture"], {
      cwd: DAEMON_ROOT,
      env: {
        ...process.env,
        LOOM_TEST_EPILOGUE_FLUSH_MARKER: marker,
        LOOM_TEST_EPILOGUE_FLUSH_LINE_COUNT: String(lineCount),
        ...(forceChunkBytes ? { LOOM_TEST_FORCE_WRITE_CHUNK_BYTES: String(forceChunkBytes) } : {}),
      },
    });
    child.stdout.on("data", (d) => { stdout += d; });
    // Card e61deaab: also captured (not just drained) so a passing block below can assert writeFullySync's
    // new deadline-truncation diagnostic (see scripts/test-daemon.mjs's describeWriteFullySyncTruncation)
    // does NOT spuriously fire on a run that completes normally — this file's own runs all complete well
    // under WRITE_FULLY_SYNC_DEADLINE_MS on this host, so a real "TRUNCATED" line here would itself be a bug.
    child.stderr.on("data", (d) => { stderr += d; });
    // "close" (not "exit"): waits for this test's OWN stdio pipe to actually finish delivering whatever
    // bytes the child sent — the same sound instrument card 776750ba's test-daemon-stderr-capture-race.mjs
    // already establishes (data/close listeners resolved on "close"), not a second thing under test here.
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function expectedLines(marker, lineCount) {
  return Array.from({ length: lineCount }, (_, i) => `${marker}-STDOUT-LINE-${i}`);
}

// [positive control] the fixture itself, un-forced (no LOOM_TEST_FORCE_WRITE_CHUNK_BYTES) — real writes on
// THIS host complete in one call regardless of the fix (win32 pipes are synchronous by construction), so
// this proves the harness/fixture wiring (spawn, --only= selection, marker plumbing) is sound before the
// forced-chunk case below is trusted either way.
{
  const marker = "CTRL";
  const lineCount = 50;
  const r = await runFixture({ marker, lineCount });
  const lines = expectedLines(marker, lineCount);
  check("[positive control] un-forced run: exits 1 (the fixture genuinely fails)", r.status === 1);
  check("[positive control] un-forced run: every stdout line present", lines.every((l) => r.stdout.includes(l)));
  check("[positive control] un-forced run: stderr tail line present", r.stdout.includes(`${marker}-STDERR-TAIL`));
}

// [THE TEST] forced tiny write chunks — exercises writeFullySync's own multi-iteration retry loop directly.
{
  const marker = "CHUNK1";
  const lineCount = 300;
  const r = await runFixture({ marker, lineCount, forceChunkBytes: 1 });
  const lines = expectedLines(marker, lineCount);
  const missing = lines.filter((l) => !r.stdout.includes(l));
  check("[THE TEST] LOOM_TEST_FORCE_WRITE_CHUNK_BYTES=1: exits 1", r.status === 1);
  check(
    `[THE TEST] LOOM_TEST_FORCE_WRITE_CHUNK_BYTES=1: all ${lineCount} distinctive stdout lines survive a byte-at-a-time flush (writeFullySync's own retry loop) — ${missing.length} missing`,
    missing.length === 0,
  );
  check("[THE TEST] LOOM_TEST_FORCE_WRITE_CHUNK_BYTES=1: stderr tail line survives too", r.stdout.includes(`${marker}-STDERR-TAIL`));
  // [negative control] Card e61deaab: writeFullySync's new deadline-truncation diagnostic (fd 2) must not
  // fire on a run that completes normally — this run finishes well under WRITE_FULLY_SYNC_DEADLINE_MS, so
  // any "TRUNCATED" text here would itself be a new bug the diagnostic introduced.
  check("[negative control] LOOM_TEST_FORCE_WRITE_CHUNK_BYTES=1: no spurious writeFullySync TRUNCATED diagnostic", !r.stderr.includes("[writeFullySync] TRUNCATED"));
}

// A second, different forced chunk size — rules out an off-by-one that only happens to work at chunk size 1.
{
  const marker = "CHUNK7";
  const lineCount = 300;
  const r = await runFixture({ marker, lineCount, forceChunkBytes: 7 });
  const lines = expectedLines(marker, lineCount);
  const missing = lines.filter((l) => !r.stdout.includes(l));
  check(`[chunk-size robustness] LOOM_TEST_FORCE_WRITE_CHUNK_BYTES=7: all ${lineCount} lines survive, ${missing.length} missing`, missing.length === 0);
  // [negative control] same as above, for the chunk=7 configuration — this is the exact configuration that
  // reddened on Linux CI (card e61deaab) — NOT because writeFullySync lost lines (its TRUNCATED diagnostic
  // stayed silent there) but because the fixture's own console.log output was cut before the harness ever
  // captured it (card acf17673; see the [fixture direct] case below) — so the diagnostic must stay silent.
  check("[negative control] LOOM_TEST_FORCE_WRITE_CHUNK_BYTES=7: no spurious writeFullySync TRUNCATED diagnostic", !r.stderr.includes("[writeFullySync] TRUNCATED"));
}

// Card acf17673: the FIXTURE ITSELF must emit every line — the loss that reddened Linux CI here was in the
// fixture (console.log + process.exit(1) drops the tail of an async POSIX pipe write), upstream of both the
// harness capture and writeFullySync, which the cases above cannot see. Deterministic: no harness in the
// path, the reader is paused so the pipe (64KiB) fills, and 20000 lines (~500KB) cannot fit in it — a
// console.log fixture loses the tail on Linux every time, with no CPU load needed. (On win32 pipe writes are
// synchronous, so this case is only RED on POSIX; it is GREEN wherever the fixture writes synchronously.)
{
  const marker = "SLOWREADER";
  const lineCount = 20000;
  const r = await new Promise((resolve) => {
    let stdout = "";
    const child = spawn(process.execPath, [path.join(__dirname, "epilogue-flush-fixture.mjs")], {
      env: { ...process.env, LOOM_TEST_EPILOGUE_FLUSH_MARKER: marker, LOOM_TEST_EPILOGUE_FLUSH_LINE_COUNT: String(lineCount) },
    });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 500); // lets the child fill the pipe first; only affects whether RED bites, never GREEN
    child.on("close", (status) => resolve({ status, stdout }));
  });
  const have = new Set(r.stdout.match(new RegExp(marker + "-STDOUT-LINE-\\d+", "g")) ?? []).size;
  check("[fixture direct] exits 1", r.status === 1);
  check(`[fixture direct] slow reader: all ${lineCount} lines survive the fixture's own exit — ${lineCount - have} missing`, have === lineCount);
}

// [negative control] the marker-matching itself must be able to fail: a marker that was never sent must be
// reported absent, so a passing run above isn't hiding a broken `includes` check.
{
  const r = await runFixture({ marker: "REALMARKER", lineCount: 20, forceChunkBytes: 1 });
  check("[negative control] a marker that was never sent is correctly reported ABSENT", !r.stdout.includes("MARKER-NEVER-SENT-XYZ"));
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-failures-epilogue-flush: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
