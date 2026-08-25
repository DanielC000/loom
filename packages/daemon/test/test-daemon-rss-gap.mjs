// Card e6e55f7a acceptance evidence: scripts/test-daemon.mjs's whole-run RSS-floor + max-inter-event-gap
// summary lines. Exercises the exported `createRssTracker`/`maxGapMs`/`formatRssFloorLine`/
// `formatMaxGapLine` directly against synthetic inputs — never a real spawn of the script itself (that
// would either run the full hermetic suite or need a `--count`-shaped early exit, neither of which
// exercises this logic in isolation) and never real `process.memoryUsage()` readings (real RSS is
// non-deterministic — the whole point of `createRssTracker`'s injectable `readRssBytes` is to make this
// testable without depending on it).
import { pathToFileURL } from "node:url";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { createRssTracker, maxGapMs, formatRssFloorLine, formatMaxGapLine, runInstrumentedSuite } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "test-daemon.mjs")).href
);

// ── createRssTracker ────────────────────────────────────────────────────────────────────────────────
{
  // A rising-then-falling synthetic reading sequence: the tracker must report the MAX seen, not the last
  // reading — proves it's a floor/high-water-mark, not a running average or a last-value cache.
  const readings = [10, 50, 30, 80, 20];
  let i = 0;
  const tracker = createRssTracker(() => readings[i++]);
  for (const _ of readings) tracker.sample();
  check("[positive control] floorBytes tracks the MAX reading seen, not the last one (last=20, max=80)",
    tracker.floorBytes() === 80);
  check("sampleCount matches the number of sample() calls", tracker.sampleCount() === readings.length);

  // [negative control] a single, small reading reports exactly that reading — proves the tracker isn't
  // silently pre-seeded with some nonzero floor.
  const single = createRssTracker(() => 42);
  single.sample();
  check("[negative control] one sample reports exactly that reading as the floor", single.floorBytes() === 42);
  check("[negative control] one sample reports sampleCount 1", single.sampleCount() === 1);

  // Zero samples: an untouched tracker reports a zero floor and zero count — never undefined/NaN.
  const untouched = createRssTracker(() => 999);
  check("an untouched tracker reports floorBytes 0", untouched.floorBytes() === 0);
  check("an untouched tracker reports sampleCount 0", untouched.sampleCount() === 0);
}

// ── maxGapMs ─────────────────────────────────────────────────────────────────────────────────────────
{
  // [positive control] the largest of several gaps must win, regardless of position in the series.
  check("[positive control] the largest gap in the series is reported (1000, 5, 3995 -> 3995)",
    maxGapMs([0, 1000, 1005, 5000]) === 3995);

  // [negative control] a perfectly even series reports that even gap, not something larger/smaller.
  check("[negative control] a uniform series reports the uniform gap", maxGapMs([0, 100, 200, 300]) === 100);

  // Fewer than 2 timestamps: no gap to measure — 0, never NaN or a thrown error.
  check("zero timestamps reports 0 (nothing to measure)", maxGapMs([]) === 0);
  check("a single timestamp reports 0 (nothing to measure)", maxGapMs([123]) === 0);

  // Fractional inputs (performance.now() is sub-millisecond) must round, not truncate/floor silently to a
  // different bucket boundary.
  check("a fractional gap rounds to the nearest ms", maxGapMs([0, 10.6]) === 11);
}

// ── formatRssFloorLine / formatMaxGapLine — the qualifier wording itself is load-bearing ──────────────
{
  const line = formatRssFloorLine(92, 5000, 5.28 * 1024 * 1024);
  check("[positive control] the RSS line states \"highest OBSERVED, not a proven peak\" verbatim",
    line.includes("highest OBSERVED, not a proven peak"));
  check("the RSS line states the sample count inline", line.includes("92 sample(s)"));
  check("the RSS line states the interval inline", line.includes("@ 5000ms"));
  check("the RSS line states the scope as runner-only, not the full tree",
    line.includes("runner process only") && line.includes("not the full test-child"));
  check("the RSS line reports the value in MB, to 2 decimals", line.includes("5.28 MB"));

  // [negative control] a qualifier-stripped line (what a careless future edit might produce) must NOT be
  // mistaken for the real thing by this same substring check — proves the check discriminates rather than
  // trivially passing on any string.
  const strippedLine = "# RSS FLOOR: 5.28 MB";
  check("[negative control] a qualifier-stripped line correctly fails the same assertion",
    !strippedLine.includes("highest OBSERVED, not a proven peak"));

  const gapLine = formatMaxGapLine(42434);
  check("[positive control] the gap line states UNDETERMINED and disclaims stall-verdict/margin readings",
    gapLine.includes("UNDETERMINED") && gapLine.includes("NOT a stall verdict or margin"));
  check("the gap line states the hung-vs-healthy indistinguishability reason",
    gapLine.includes("IDENTICAL reading"));
  check("the gap line states the value", gapLine.includes("42434ms"));

  check("the retired stall-watchdog framing is gone from the line",
    !gapLine.includes("stall watchdog input"));

  // The `partial` flag (manager follow-up — the crash path) must produce a VISIBLY DIFFERENT line, never
  // the clean-path line reused verbatim: a lower-confidence, sampling-stopped-early max deserves its own
  // label, not a number a reader could mistake for a completed run's.
  const partialRssLine = formatRssFloorLine(3, 5000, 1 * 1024 * 1024, { partial: true });
  check("[positive control] partial:true visibly marks the RSS line as PARTIAL", partialRssLine.includes("PARTIAL"));
  check("the clean-path RSS line (partial omitted) does NOT say PARTIAL — the two must read differently",
    !line.includes("PARTIAL"));
  const partialGapLine = formatMaxGapLine(999, { partial: true });
  check("[positive control] partial:true visibly marks the gap line as PARTIAL", partialGapLine.includes("PARTIAL"));
  check("the clean-path gap line (partial omitted) does NOT say PARTIAL", !gapLine.includes("PARTIAL"));
}

// ── runInstrumentedSuite — the crash path (manager follow-up to the card) ──────────────────────────────
// RED-FIRST: this block was run against the pre-fix code (no try/catch around the run body) and both
// checks below failed — nothing was logged, and the thrown error surfaced as an ordinary unhandled
// rejection with no summary lines at all. Restoring the try/catch/rethrow in `runInstrumentedSuite` turns
// both green, which is what's asserted here now.
{
  const logged = [];
  const boom = new Error("simulated harness crash mid-run");
  let caught = null;
  try {
    await runInstrumentedSuite(async (completionTimestamps) => {
      completionTimestamps.push(performance.now());
      throw boom;
    }, { sampleIntervalMs: 5000, log: (line) => logged.push(line) });
  } catch (err) {
    caught = err;
  }
  check("[positive control] a runFn that throws still gets its RSS-floor line printed before propagating",
    logged.some((l) => l.startsWith("# RSS FLOOR")));
  check("[positive control] a runFn that throws still gets its max-gap line printed before propagating",
    logged.some((l) => l.startsWith("# max inter-event gap")));
  check("the crash-path RSS line is labelled PARTIAL — not identical to a clean-path line",
    logged.some((l) => l.startsWith("# RSS FLOOR") && l.includes("PARTIAL")));
  check("the crash-path gap line is labelled PARTIAL — not identical to a clean-path line",
    logged.some((l) => l.startsWith("# max inter-event gap") && l.includes("PARTIAL")));
  check("the ORIGINAL error propagates UNCHANGED — never swallowed (this file IS the merge gate)",
    caught === boom);
}

// [negative control] a runFn that resolves normally must log NOTHING through this wrapper — the real
// isMain block prints the clean-path lines itself, unlabelled, using the returned tracker/timestamps.
// Proves the crash-path logging above is conditional on the throw, not unconditional.
{
  const logged = [];
  const returned = await runInstrumentedSuite(async () => { /* success, no throw */ }, {
    sampleIntervalMs: 5000,
    log: (line) => logged.push(line),
  });
  check("[negative control] a runFn that resolves normally logs nothing via this wrapper", logged.length === 0);
  check("a successful run still returns a usable rssTracker for the caller to print from",
    typeof returned.rssTracker.floorBytes === "function" && typeof returned.rssTracker.sampleCount === "function");
  check("a successful run still returns the completionTimestamps series for the caller to print from",
    Array.isArray(returned.completionTimestamps) && returned.completionTimestamps.length >= 1);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-rss-gap: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
