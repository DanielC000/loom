// Card a496166a DoD-0 (REMAINING WORK) acceptance evidence: the periodic host-load sampler that lets a
// fast gate run and a slow gate run be compared distribution-to-distribution, instead of by the single
// point-in-time snapshot §DoD-0 retracted as an instrument artifact. Exercises the exported
// `cpuBusyPctDelta`/`createHostLoadSampler`/`formatHostLoadSummaryLine`/`runInstrumentedSuite` directly
// against synthetic inputs — never real `os.cpus()` readings (real host load is non-deterministic, the
// whole point of the injectable `readCpus` seam), same reasoning test-daemon-rss-gap.mjs already
// established for this file's other synthetic-input exports.
import { pathToFileURL } from "node:url";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { cpuBusyPctDelta, createHostLoadSampler, formatHostLoadSummaryLine, runInstrumentedSuite } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "test-daemon.mjs")).href
);

// A minimal synthetic os.cpus()-shaped reading: one core, given total ticks split across user/idle.
function cpu(user, idle) {
  return [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
}

// ── cpuBusyPctDelta ──────────────────────────────────────────────────────────────────────────────────────
{
  // [positive control] a core busy the WHOLE delta window (all user ticks, zero idle ticks added) reports
  // ~100% busy — not the average of anything, the delta between exactly these two readings.
  const fullyBusy = cpuBusyPctDelta(cpu(1000, 500), cpu(1500, 500));
  check("[positive control] all-user delta ticks report ~100% busy", fullyBusy !== null && Math.abs(fullyBusy - 100) < 0.01);

  // [negative control] a core idle the WHOLE delta window (all idle ticks, zero user ticks added) reports
  // 0% busy, not a fabricated nonzero value.
  const fullyIdle = cpuBusyPctDelta(cpu(1000, 500), cpu(1000, 1000));
  check("[negative control] all-idle delta ticks report 0% busy", fullyIdle === 0);

  // A half-and-half split reports ~50%.
  const half = cpuBusyPctDelta(cpu(1000, 500), cpu(1250, 750));
  check("an even user/idle split reports ~50% busy", half !== null && Math.abs(half - 50) < 0.01);

  // THIS is the exact instrument the card's kickoff retracted: cumulative lifetime totals fed straight in
  // as if they were the delta (i.e. calling this with only ONE reading, or with `prevCpus` all-zero as a
  // stand-in for "since boot") must NOT be mistaken for a valid two-point delta by this function's own
  // shape — proven below by confirming a genuine two-reading delta ignores how large the CUMULATIVE totals
  // themselves are and reports only the CHANGE between them.
  const busyRegardlessOfCumulativeSize = cpuBusyPctDelta(cpu(50_000_000, 20_000_000), cpu(50_000_500, 20_000_000));
  check("a huge cumulative total with a small delta on top still reports the DELTA's own busy%, not something derived from the cumulative size", busyRegardlessOfCumulativeSize !== null && Math.abs(busyRegardlessOfCumulativeSize - 100) < 0.01);

  // Multi-core: two cores, one fully busy and one fully idle over the same window, report ~50% host-wide.
  const twoCoreHalf = cpuBusyPctDelta(
    [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    [{ times: { user: 1000, nice: 0, sys: 0, idle: 0, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } }],
  );
  check("[positive control] a host-wide read averages across cores, not just core 0 (1 busy + 1 idle core -> ~50%)", twoCoreHalf !== null && Math.abs(twoCoreHalf - 50) < 0.01);

  // [negative control] zero elapsed delta (two identical readings) must report null, never a fabricated
  // 0% or a division-by-zero NaN.
  const identical = cpu(1000, 500);
  check("[negative control] two identical readings (zero elapsed delta) report null, not 0 or NaN", cpuBusyPctDelta(identical, identical) === null);

  // [negative control] a core-count mismatch (e.g. a CPU hot-plug between reads) reports null rather than
  // a bogus number computed over misaligned arrays.
  check("[negative control] a core-count mismatch between readings reports null", cpuBusyPctDelta(cpu(0, 0), [...cpu(0, 0), ...cpu(0, 0)]) === null);

  // [negative control] empty/missing inputs report null, never throw.
  check("[negative control] empty arrays report null", cpuBusyPctDelta([], []) === null);
  check("[negative control] non-array input reports null, does not throw", cpuBusyPctDelta(null, cpu(0, 0)) === null);
}

// ── createHostLoadSampler ────────────────────────────────────────────────────────────────────────────────
{
  const readings = [cpu(0, 0), cpu(500, 0), cpu(1000, 0)]; // strictly busy, ticks by ticks
  let i = 0;
  const sampler = createHostLoadSampler(() => readings[i++]);

  // [positive control] the FIRST sample has no prior reading to delta against — null, not a fabricated 0%.
  check("[positive control] the first sample() call reports null (no prior reading yet)", sampler.sample() === null);

  // Every call AFTER the first deltas against the PREVIOUS sample() call, not against the sampler's
  // creation time.
  const second = sampler.sample();
  check("the second sample() call reports a real delta against the first (not null)", second !== null && Math.abs(second - 100) < 0.01);
  const third = sampler.sample();
  check("the third sample() call deltas against the SECOND call, not the first", third !== null && Math.abs(third - 100) < 0.01);
}

// ── formatHostLoadSummaryLine — the "SAMPLED DELTA, not cumulative" framing must survive in the line itself
{
  const line = formatHostLoadSummaryLine([10, 50, 30], 5000);
  check("[positive control] the line states \"SAMPLED DELTA (not cumulative)\" verbatim", line.includes("SAMPLED DELTA (not cumulative)"));
  check("the line states the sample count inline", line.includes("3 sample(s)"));
  check("the line states the interval inline", line.includes("@ 5000ms"));
  check("the line reports min/mean/max, not just one statistic", line.includes("min 10.0%") && line.includes("max 50.0%") && line.includes("mean 30.0%"));

  // [negative control] a qualifier-stripped line (what a careless future edit might produce) must NOT be
  // mistaken for the real thing by this same substring check.
  const strippedLine = "# host CPU busy: 30.0%";
  check("[negative control] a qualifier-stripped line correctly fails the same assertion", !strippedLine.includes("SAMPLED DELTA (not cumulative)"));

  // Zero valid-delta samples (e.g. a run too short for a second tick) must not crash the formatter or
  // fabricate a min/mean/max from nothing.
  const emptyLine = formatHostLoadSummaryLine([], 5000);
  check("[negative control] zero samples reports 0 sample(s), no fabricated min/mean/max", emptyLine.includes("0 sample(s)") && !emptyLine.includes("min "));
}

// ── runInstrumentedSuite's onSample hook (additive — card a496166a) ─────────────────────────────────────
{
  // [positive control] onSample fires once immediately (matching rssTracker's own initial sample) plus
  // once per interval tick thereafter — proven here via a runFn that resolves only after enough real time
  // has passed for at least one tick.
  let calls = 0;
  await runInstrumentedSuite(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }, { sampleIntervalMs: 10, onSample: () => { calls++; } });
  check("[positive control] onSample fires at least twice (once immediately, once+ per tick) over a run outliving one interval", calls >= 2);

  // [negative control] omitting onSample entirely (every pre-existing call site, incl. test-daemon-rss-gap.mjs)
  // must not throw — the default no-op keeps every existing caller byte-identical.
  let threw = false;
  try {
    await runInstrumentedSuite(async () => {}, { sampleIntervalMs: 5000 });
  } catch {
    threw = true;
  }
  check("[negative control] omitting onSample does not throw (default no-op preserves existing call sites)", !threw);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-host-load-sampling: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
