// Card bf30e8b6 DoD-2: card `bf30e8b6` names a THIRD, untested mechanism nobody had chased for the
// specimen where `merge-composer-integrity-warning` exited 1 with no assertion/error text captured — "a
// stack trace or error written to the child's stderr, lost because the child's `close` event fires before
// all stderr data has drained." This drives scripts/test-daemon.mjs's own exported `spawnWithTimeout` —
// the EXACT capture path `runOne` uses (spawn().stderr.on("data") accumulated into a string, resolved on
// the child's "close" event) — against a purpose-built fixture (test/fixtures/_stderr-sentinel-exit.mjs)
// that writes a known, uniquely-greppable sentinel to stderr and exits 1, varying BOTH the payload SIZE
// and the exit TIMING (immediate sync exit / wait-for-write-callback / no explicit exit at all).
//
// This is deliberately hermetic and reproduces NOTHING about the original gate failure itself — it tests
// only the CAPTURE INSTRUMENT's own soundness, per the card's own framing ("a question about the
// INSTRUMENT, not the test"). No gate run, no full suite, no daemon.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithTimeout } from "../scripts/test-daemon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "_stderr-sentinel-exit.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function run(size, mode, marker) {
  return spawnWithTimeout(process.execPath, [FIXTURE, String(size), mode, marker], { timeoutMs: 15_000 });
}

function markersPresent(stderr, marker) {
  return { startOk: stderr.includes(`${marker}-START`), endOk: stderr.includes(`${marker}-END`) };
}

// --- [positive control] a real uncaught exception, small payload -> the sentinel MUST survive. If this
// fails, the whole instrument (this test, or spawnWithTimeout itself) is broken and every later negative
// reading below is meaningless.
{
  const marker = "CTRL-THROW";
  const r = await run(80, "throw", marker);
  const { startOk, endOk } = markersPresent(r.stderr, marker);
  check("[positive control] small throw payload: START marker present", startOk);
  check("[positive control] small throw payload: END marker present", endOk);
  check("[positive control] child exited nonzero as expected", r.status === 1);
}

// --- [positive control] small payload, immediate sync exit -> a tiny write comfortably fits inside a
// single synchronous pipe write on every observed platform; if THIS is lost, size isn't the discriminator
// and something else entirely is broken.
{
  const marker = "CTRL-SMALL";
  const r = await run(80, "write-then-exit-sync", marker);
  const { startOk, endOk } = markersPresent(r.stderr, marker);
  check("[positive control] small write-then-exit-sync payload: START marker present", startOk);
  check("[positive control] small write-then-exit-sync payload: END marker present", endOk);
}

// --- THE RACE ITSELF: large payload(s) + process.exit(1) called IMMEDIATELY after the write (no wait for
// the write's own flush callback), repeated several times per size — a race is probabilistic, not
// deterministic, so one clean trial proves nothing either way. Sweeps size too, since a race (if real) is
// far more likely to show up once a write can't complete in a single synchronous pipe write.
const RACE_SIZES = [2_000, 50_000, 500_000];
const RACE_TRIALS = 5;
const raceLostDetail = [];
for (const size of RACE_SIZES) {
  for (let trial = 0; trial < RACE_TRIALS; trial++) {
    const marker = `RACE-${size}-${trial}`;
    const r = await run(size, "write-then-exit-sync", marker);
    const { startOk, endOk } = markersPresent(r.stderr, marker);
    if (!startOk || !endOk) {
      raceLostDetail.push({ size, trial, startOk, endOk, capturedLen: r.stderr.length });
    }
  }
}
check(
  `[THE TEST] write-then-exit-sync across ${RACE_SIZES.length} size(s) x ${RACE_TRIALS} trial(s): sentinel survived every trial (capture-layer race NOT observed)`,
  raceLostDetail.length === 0,
);
if (raceLostDetail.length) {
  console.log(`  race detail (size/trial/startOk/endOk/capturedLen): ${JSON.stringify(raceLostDetail)}`);
}

// --- Exit-TIMING contrast, same sizes: wait for the write's own callback before exiting (the
// documented-safe explicit pattern) — isolates whether it's specifically the SYNCHRONOUS-exit timing that
// matters, independent of payload size.
for (const size of RACE_SIZES) {
  const marker = `CB-${size}`;
  const r = await run(size, "write-then-exit-callback", marker);
  const { startOk, endOk } = markersPresent(r.stderr, marker);
  check(`[exit-timing contrast] write-then-exit-callback at ${size} bytes: sentinel survived`, startOk && endOk);
}

// --- Exit-TIMING contrast, same sizes: no explicit process.exit() call at all (natural event-loop drain).
for (const size of RACE_SIZES) {
  const marker = `NAT-${size}`;
  const r = await run(size, "write-then-natural", marker);
  const { startOk, endOk } = markersPresent(r.stderr, marker);
  check(`[exit-timing contrast] write-then-natural at ${size} bytes: sentinel survived`, startOk && endOk);
}

// --- [negative control] the check ITSELF must be able to return false: confirm a marker that was NEVER
// sent is correctly reported absent, so a passing run above isn't hiding a broken `includes` check.
{
  const r = await run(80, "throw", "REAL-MARKER-NOT-USED-BELOW");
  check("[negative control] a marker that was never sent is correctly reported ABSENT", !r.stderr.includes("NEVER-SENT-MARKER"));
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-stderr-capture-race: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
