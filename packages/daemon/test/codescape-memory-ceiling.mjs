import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ba22005b: the codescape supervisor samples the shared `codescape serve` child's own OS memory on
// its existing health cadence and recycles it once a human-configured ceiling is crossed — the Loom-side
// fix for a real incident where an unbounded leak in the (peer-owned) codescape serve process grew to
// ~110 GB and nearly OOM'd the self-hosting host. REAL-SPAWN, hermetic: the fixture `codescape` CLI
// (test/fixtures/fake-codescape-cli.mjs) stands in for the real binary; the MEMORY VALUE itself always
// comes from an INJECTED `memorySampler` seam (never a real OS memory read of the fixture, which would be
// flaky/slow to control deterministically) — this is what lets the fixture's own real, tiny pid stand in
// for "the real child", while the byte count is fully test-controlled. Claude-free, network-free beyond
// loopback. Never runs the real codescape binary, never a `*-real-spawn*` file.
//
// Proves the DoD:
//   (1) a sampled memory value that crosses the ceiling gets the child recycled through the EXISTING
//       child.kill() -> wireDeathHandling -> scheduleRestart path (a real new pid) EXACTLY ONCE — the
//       respawned child's own (lower) reading never re-triggers a second recycle — and the
//       `onMemoryCeilingRecycle` callback fires exactly once with the correct {pid, measuredBytes,
//       ceilingBytes, metric}, pid-scoped to the REAL sampled pid (proving "never by image name").
//   (2) NEGATIVE CONTROL: a sampler that always reports comfortably under the ceiling never recycles,
//       across the same number of ticks scenario (1) uses to prove its positive — the check can fail.
//   (3) a sampler FAILURE (unreadable/timed-out/gone pid) is fail-SAFE, never fail-KILL: it must never be
//       treated as "over ceiling", however many ticks it persists for.
//   (4) cost control: memory is sampled only every `memorySampleTickInterval`th health-probe tick, not
//       every tick — proven by comparing sampler-call count against completed-tick count.
//   (5) `getMemoryCeilingMb` is read LIVE on every sample tick, not frozen at construction — changing
//       what it returns between ticks changes whether the SAME byte count triggers a recycle.
//   (6) UNIT (CR follow-up, T2): the pure `/proc/<pid>/status` parser (with/without VmSwap, missing
//       VmRSS) and the pure win32 `PrivateMemorySize64` stdout parser (incl. the empty-output case —
//       finding 1's regression test), with no fs/subprocess involved.
//   (7) CR follow-up (product ruling): the ceiling is a BACKSTOP, not a thing that can itself take
//       `serve` down — 3 CONSECUTIVE unproductive respawns (each one's own first sample still over
//       ceiling) stop memory-based recycling for the rest of the supervisor lifetime, serve stays up
//       despite remaining over ceiling, a durable "suspended" callback fires exactly once, and a later
//       ceiling CHANGE re-arms it.
//
// Every POSITIVE wait below (T1, CR follow-up) is asserted via a NAMED, progress-keyed check on the wait
// itself succeeding — never just on the state it was waiting for — so a regression that makes the
// expected transition never happen (e.g. the kill silently disabled, or spawnCount never incrementing)
// fails LOUDLY with an attributable message instead of stalling into `waitForCompletedCondition`'s own
// generic stall-timeout or a confusing downstream assertion. Verified (not merely asserted) against two
// local mutations, each rebuilt and run before being reverted: (M1-shape) commenting out the
// `childAtSampleTime.kill()` call in checkMemoryCeiling, and (M6-shape) commenting out
// `this.spawnCount++` in spawnServeSelfReporting. Neither mutant produces a false PASS — in BOTH cases
// `healthProbeTickCount` (this file's own tickCounter) keeps advancing every tick regardless of the
// mutation, so `waitForCompletedCondition`'s own documented contract (card cc43c74d, copied above) means
// it never detects a stall either — the run hangs rather than timing out. M1 was confirmed this way
// (still running, unresolved, past 300s — stopped by hand). M6 was confirmed the same way under an
// external 15s `timeout` wrapper (exit 124): the run stops dead at "(1) wait for the over-ceiling
// recycle (2nd spawn) succeeded", which never prints — never a silent pass, never a misleadingly-worded
// failure elsewhere. A full, unmutated, green run of this file takes well under 60s.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-memory-ceiling.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  console.log(`FAIL  ${label}`);
  failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same progress-keyed discipline as codescape-health-probe.mjs's identical helper (card cc43c74d) —
// never a fixed-duration budget; only gives up on a genuine STALL (no completed tick for stallTimeoutMs).
async function waitForCompletedCondition(cond, tickCounter, { pollMs = 10, stallTimeoutMs = 8000 } = {}) {
  let lastTicks = tickCounter();
  let lastProgressAt = Date.now();
  while (!cond()) {
    await sleep(pollMs);
    if (cond()) break;
    const ticks = tickCounter();
    if (ticks !== lastTicks) { lastTicks = ticks; lastProgressAt = Date.now(); }
    if (Date.now() - lastProgressAt > stallTimeoutMs) return false;
  }
  return true;
}

// T1 (CR follow-up): wraps waitForCompletedCondition with a NAMED check on the wait's own boolean result
// — a stalled positive wait now fails as ITS OWN attributable check, rather than silently returning
// (false-but-unobserved) and letting a later, differently-worded assertion take the blame.
async function checkWait(label, cond, tickCounter, opts) {
  const ok = await waitForCompletedCondition(cond, tickCounter, opts);
  check(label, ok);
  return ok;
}

// Mirrors codescape-health-probe.mjs's identical helper (card bab0e772) — settles a count to STABLE
// across `settleTicks` completed probe ticks before trusting it, rather than racing a would-be flood of
// more activity landing just after a bare threshold is first satisfied.
async function waitForStableCount(getCount, tickCounter, { settleTicks = 3, pollMs = 10, stallTimeoutMs = 8000 } = {}) {
  let lastCount = getCount();
  let lastTicks = tickCounter();
  let stableSinceTicks = lastTicks;
  let lastTickProgressAt = Date.now();
  while (true) {
    await sleep(pollMs);
    const count = getCount();
    const ticks = tickCounter();
    if (ticks !== lastTicks) { lastTicks = ticks; lastTickProgressAt = Date.now(); }
    if (count !== lastCount) {
      lastCount = count;
      stableSinceTicks = ticks;
    } else if (ticks - stableSinceTicks >= settleTicks) {
      return lastCount;
    }
    if (Date.now() - lastTickProgressAt > stallTimeoutMs) return lastCount;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");

// --- Hermetic LOOM_HOME, set BEFORE importing dist (CODESCAPE_HOME_DIR derives from it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-cs-memceil-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_CODESCAPE_ENABLED;
process.env.LOOM_CODESCAPE_BIN = fixtureCli;
process.env.LOOM_DEV = "1"; // gate: isLoomDev() + a resolvable codescape CLI (card 503a30a0)
// No `build` field on the health response at all — keeps checkBuildDrift's own (unrelated) subprocess
// spawn out of every tick this file exercises, so each tick's only subprocess work is the memory sample.
process.env.FAKE_CODESCAPE_HEALTH_BUILD = "__ABSENT__";

const { CodescapeSupervisor, parseProcStatusMemory, parsePrivateMemorySize64Output } =
  await import("../dist/codescape/supervisor.js");

const MB = 1024 * 1024;

// ===================== (1) a crossed ceiling recycles EXACTLY ONCE, event filed, pid-scoped =====================
{
  const homeDir = path.join(tmpHome, "over-ceiling-home");
  const sampledPids = [];
  const recycleCalls = [];
  let firstPid = null; // captured once the initial spawn is confirmed, below

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [40, 80, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 60,
    healthProbeTimeoutMs: 40,
    memorySampleTickInterval: 1, // sample every tick — this scenario is about the recycle, not the cadence
    getMemoryCeilingMb: () => 100, // 100MB ceiling
    memorySampler: async (pid) => {
      sampledPids.push(pid);
      // The FIRST child (the one this scenario means to catch) reports comfortably over the 100MB
      // ceiling; any LATER child (the respawned one) reports comfortably under it — modeling the real
      // shape: a leak on one generation, a fresh low-memory process on the next.
      return { ok: true, bytes: pid === firstPid ? 200 * MB : 10 * MB };
    },
    onMemoryCeilingRecycle: (detail) => { recycleCalls.push(detail); },
  });
  await sup.start(["/fake/repo/over-ceiling"]);
  await checkWait("(1) wait for the initial spawn succeeded", () => sup.getSpawnCount() >= 1, () => sup.getHealthProbeTickCount());
  firstPid = sup.getPid();
  check("(1) initial serve spawned with a real pid", sup.getSpawnCount() === 1 && typeof firstPid === "number");

  await checkWait("(1) wait for the over-ceiling recycle (2nd spawn) succeeded", () => sup.getSpawnCount() >= 2, () => sup.getHealthProbeTickCount());
  const pidAfterRecycle = sup.getPid();
  check("(1) over-ceiling memory triggered a recycle via the existing death path (a new serve spawn recorded)",
    sup.getSpawnCount() === 2);
  check("(1) the recycle produced a genuinely NEW pid", pidAfterRecycle !== firstPid && pidAfterRecycle !== null);

  // Let several more completed ticks pass against the now-low-memory respawned child — the respawn must
  // never trigger a SECOND recycle just because a leak-shaped ceiling is still configured.
  const settledSpawnCount = await waitForStableCount(() => sup.getSpawnCount(), () => sup.getHealthProbeTickCount());
  check("(1) exactly ONE recycle happened — spawn count settles at 2, never climbs further",
    settledSpawnCount === 2);
  check("(1) onMemoryCeilingRecycle fired exactly once", recycleCalls.length === 1);
  check("(1) the recycle detail names the FIRST child's real pid (pid-scoped, never a name/pattern match)",
    recycleCalls[0]?.pid === firstPid);
  check("(1) the recycle detail carries the measured + ceiling byte counts",
    recycleCalls[0]?.measuredBytes === 200 * MB && recycleCalls[0]?.ceilingBytes === 100 * MB);
  check("(1) the recycle detail names which OS metric was sampled",
    recycleCalls[0]?.metric === (process.platform === "win32" ? "PrivateMemorySize64" : "VmRSS+VmSwap"));
  check("(1) the sampler was only ever called with REAL child pids it was told about (never a fabricated one)",
    sampledPids.every((p) => p === firstPid || p === pidAfterRecycle));

  sup.stop();
}

// ===================== (2) NEGATIVE CONTROL: comfortably under ceiling never recycles =====================
{
  const homeDir = path.join(tmpHome, "under-ceiling-home");
  const recycleCalls = [];
  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [40, 80, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 60,
    healthProbeTimeoutMs: 40,
    memorySampleTickInterval: 1,
    getMemoryCeilingMb: () => 100,
    memorySampler: async () => ({ ok: true, bytes: 10 * MB }), // always well under the 100MB ceiling
    onMemoryCeilingRecycle: (detail) => { recycleCalls.push(detail); },
  });
  await sup.start(["/fake/repo/under-ceiling"]);
  await checkWait("(2) wait for the initial spawn succeeded", () => sup.getSpawnCount() >= 1, () => sup.getHealthProbeTickCount());
  const pidBefore = sup.getPid();
  // Wait out the SAME number of settled ticks scenario (1) used to prove its positive — if this check
  // were vacuous (e.g. the sampler were never actually invoked), scenario (1) would have caught that same
  // defect already, but asserting it here too is what makes this a genuine negative control rather than
  // an assumption borrowed from a different scenario.
  const settledSpawnCount = await waitForStableCount(() => sup.getSpawnCount(), () => sup.getHealthProbeTickCount());
  check("(2) NEGATIVE CONTROL: comfortably-under-ceiling memory never triggers a recycle",
    settledSpawnCount === 1 && sup.getPid() === pidBefore);
  check("(2) onMemoryCeilingRecycle never fires", recycleCalls.length === 0);

  sup.stop();
}

// ===================== (3) a sampler FAILURE is fail-SAFE, never fail-KILL =====================
{
  const homeDir = path.join(tmpHome, "sampler-failure-home");
  const recycleCalls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); originalWarn(...args); };

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [40, 80, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 60,
    healthProbeTimeoutMs: 40,
    memorySampleTickInterval: 1,
    getMemoryCeilingMb: () => 100,
    memorySampler: async () => ({ ok: false, bytes: null, reason: "simulated sampler failure (card ba22005b test)" }),
    onMemoryCeilingRecycle: (detail) => { recycleCalls.push(detail); },
  });
  await sup.start(["/fake/repo/sampler-failure"]);
  await checkWait("(3) wait for the initial spawn succeeded", () => sup.getSpawnCount() >= 1, () => sup.getHealthProbeTickCount());
  const pidBefore = sup.getPid();
  const settledSpawnCount = await waitForStableCount(() => sup.getSpawnCount(), () => sup.getHealthProbeTickCount());
  console.warn = originalWarn;

  check("(3) a sustained sampler FAILURE never kills — spawn count never climbs past the initial spawn",
    settledSpawnCount === 1 && sup.getPid() === pidBefore);
  check("(3) onMemoryCeilingRecycle never fires on an inconclusive read", recycleCalls.length === 0);
  const failureWarnings = warnings.filter((l) => l.includes("cannot sample serve memory"));
  check("(3) the sustained failure is reported LOUDLY but LATCHED — exactly once, not once per tick",
    failureWarnings.length === 1);

  sup.stop();
}

// ===================== (4) cost control: sampled only every Nth tick, not every tick =====================
{
  const homeDir = path.join(tmpHome, "cadence-home");
  const sampleCalls = [];
  const TICK_INTERVAL = 4;
  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [40, 80, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 30,
    healthProbeTimeoutMs: 20,
    memorySampleTickInterval: TICK_INTERVAL,
    getMemoryCeilingMb: () => 100,
    memorySampler: async () => { sampleCalls.push(Date.now()); return { ok: true, bytes: 10 * MB }; },
  });
  await sup.start(["/fake/repo/cadence"]);
  // Wait for enough completed ticks that, at the configured interval, several samples should already
  // have happened — progress-keyed off the tick counter itself, never a guessed wall-clock duration.
  const minTicks = TICK_INTERVAL * 3;
  await checkWait(`(4) wait for >= ${minTicks} completed ticks succeeded`, () => sup.getHealthProbeTickCount() >= minTicks, () => sup.getHealthProbeTickCount());
  const ticks = sup.getHealthProbeTickCount();
  const expectedSamples = Math.floor(ticks / TICK_INTERVAL);
  check(`(4) memory is sampled roughly every ${TICK_INTERVAL}th tick, not every tick (${ticks} ticks -> ${sampleCalls.length} sample(s), expected ${expectedSamples})`,
    sampleCalls.length === expectedSamples);
  check("(4) the sampler is NOT called on every single completed tick",
    sampleCalls.length < ticks);

  sup.stop();
}

// ===================== (5) the ceiling is re-read LIVE, never frozen at construction =====================
{
  const homeDir = path.join(tmpHome, "live-ceiling-home");
  let ceilingMb = 500; // starts comfortably ABOVE the reported value — must not recycle yet
  let firstPid = null;
  const recycleCalls = [];
  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [40, 80, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 60,
    healthProbeTimeoutMs: 40,
    memorySampleTickInterval: 1,
    getMemoryCeilingMb: () => ceilingMb, // a LIVE closure, re-read on every sample tick
    // Only the FIRST child reports the leak-shaped 200MB; any respawn reports comfortably low — keeps
    // this scenario about live ceiling re-resolution alone, never accidentally tripping the separate
    // unproductive-recycle backstop scenario (7) below exists to test on its own terms.
    memorySampler: async (pid) => ({ ok: true, bytes: pid === firstPid ? 200 * MB : 10 * MB }),
    onMemoryCeilingRecycle: (detail) => { recycleCalls.push(detail); },
  });
  await sup.start(["/fake/repo/live-ceiling"]);
  await checkWait("(5) wait for the initial spawn succeeded", () => sup.getSpawnCount() >= 1, () => sup.getHealthProbeTickCount());
  firstPid = sup.getPid();
  const pidBefore = firstPid;
  await waitForStableCount(() => sup.getSpawnCount(), () => sup.getHealthProbeTickCount());
  check("(5) a 200MB reading under a 500MB ceiling does not recycle",
    sup.getSpawnCount() === 1 && sup.getPid() === pidBefore && recycleCalls.length === 0);

  // Lower the SAME live function's return value — no reconstruction, no restart — then prove the VERY
  // NEXT sample acts on the new value: the same reported 200MB now exceeds a 100MB ceiling.
  ceilingMb = 100;
  await checkWait("(5) wait for the live-ceiling-triggered recycle (2nd spawn) succeeded", () => sup.getSpawnCount() >= 2, () => sup.getHealthProbeTickCount());
  check("(5) lowering the live ceiling (no restart, same function) makes the SAME reading recycle on the next sample",
    sup.getSpawnCount() === 2 && recycleCalls.length === 1);

  // The respawned child reports LOW — settle to prove this single recycle never cascades into a second one.
  const settled = await waitForStableCount(() => sup.getSpawnCount(), () => sup.getHealthProbeTickCount());
  check("(5) exactly one recycle — no further kills after the low-memory respawn",
    settled === 2 && recycleCalls.length === 1);

  sup.stop();
}

// ===================== (6) UNIT (CR follow-up, T2): the pure OS-output parsers =====================
{
  // --- parseProcStatusMemory (POSIX /proc/<pid>/status content) ---
  const withSwap = parseProcStatusMemory("VmPeak:\t  123456 kB\nVmRSS:\t   51200 kB\nVmSwap:\t   2048 kB\n");
  check("(6) POSIX parser: VmRSS + VmSwap both present sums both",
    withSwap.ok === true && withSwap.bytes === (51200 + 2048) * 1024);

  const withoutSwap = parseProcStatusMemory("VmRSS:\t   51200 kB\n"); // no VmSwap line at all
  check("(6) POSIX parser: VmRSS present, NO VmSwap line -> swap treated as 0 (not a failure)",
    withoutSwap.ok === true && withoutSwap.bytes === 51200 * 1024);

  const noRss = parseProcStatusMemory("VmPeak:\t  123456 kB\nVmSwap:\t   2048 kB\n"); // no VmRSS at all
  check("(6) POSIX parser: NO VmRSS line -> ok:false (the one genuine parse failure)",
    noRss.ok === false && noRss.bytes === null);

  const empty = parseProcStatusMemory("");
  check("(6) POSIX parser: empty content -> ok:false", empty.ok === false);

  // --- parsePrivateMemorySize64Output (win32 Get-Process stdout content) ---
  const validOut = parsePrivateMemorySize64Output("1234567890\n");
  check("(6) win32 parser: a valid numeric line parses to that many bytes",
    validOut.ok === true && validOut.bytes === 1234567890);

  // Finding 1's own regression test: empty/whitespace stdout (what -ErrorAction SilentlyContinue
  // produces for a gone pid) must be an EXPLICIT failure, never silently read as "using 0 bytes"
  // (Number("") === 0 in JS, which is the exact defect this parser exists to avoid).
  const emptyOut = parsePrivateMemorySize64Output("");
  check("(6) win32 parser: EMPTY stdout -> ok:false (never bytes:0 — Number(\"\")===0 is the trap)",
    emptyOut.ok === false && emptyOut.bytes === null);

  const whitespaceOut = parsePrivateMemorySize64Output("\r\n  \r\n");
  check("(6) win32 parser: WHITESPACE-ONLY stdout -> ok:false",
    whitespaceOut.ok === false && whitespaceOut.bytes === null);

  const garbageOut = parsePrivateMemorySize64Output("not-a-number");
  check("(6) win32 parser: non-numeric stdout -> ok:false",
    garbageOut.ok === false && garbageOut.bytes === null);
}

// ===================== (7) CR follow-up (product ruling): the ceiling is a BACKSTOP — 3 consecutive =====================
// unproductive respawns stop recycling (serve stays up), and a ceiling CHANGE re-arms it.
{
  const homeDir = path.join(tmpHome, "backstop-home");
  let ceilingMb = 100;
  const recycleCalls = [];
  const suspendCalls = [];
  const seenPids = [];
  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [40, 80, 150, 150, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 60,
    healthProbeTimeoutMs: 40,
    // This scenario's own subject is the MEMORY backstop, not health-probe wedge detection — it drives
    // 5 real respawns in a row (more spawn churn than any other scenario in this file), and a tight
    // health-probe timeout racing that many real cold-starts under host load is an unrelated hazard this
    // scenario doesn't need. Decision bab0e772's own sanctioned pattern: disarm ONLY the wedge-kill
    // branch (checkMemoryCeiling, and the tick itself, still run every bit as normal).
    healthProbeWedgeKillEnabled: false,
    memorySampleTickInterval: 1,
    getMemoryCeilingMb: () => ceilingMb,
    // Generations 1-4 ALL report the SAME 300MB (no pid-keyed "fresh child reports low" shape here — the
    // whole point of this scenario is that the respawn does NOT help, modeling a ceiling that's simply
    // below serve's real baseline). Generation 5+ (the RE-ARMED respawn) reports low, so the re-arm test
    // below settles deterministically instead of racing a further cascade of kills.
    memorySampler: async (pid) => {
      if (!seenPids.includes(pid)) seenPids.push(pid);
      const generation = seenPids.indexOf(pid) + 1;
      return { ok: true, bytes: generation <= 4 ? 300 * MB : 10 * MB };
    },
    onMemoryCeilingRecycle: (detail) => { recycleCalls.push(detail); },
    onMemoryRecycleSuspended: (detail) => { suspendCalls.push(detail); },
  });
  await sup.start(["/fake/repo/backstop"]);
  await checkWait("(7) wait for the initial spawn succeeded", () => sup.getSpawnCount() >= 1, () => sup.getHealthProbeTickCount());

  // Default threshold is 3 (the product ruling's own number — not shrunk via the test seam here): the
  // initial over-ceiling detection (no prior respawn to compare against) kills unconditionally;
  // respawns #2 and #3 are each STILL over ceiling and get killed too (benefit of the doubt); respawn
  // #4's own first sample is the THIRD consecutive one still over ceiling, which is where the backstop
  // trips — 4 total spawns, 3 total recycles, and the 4th child is left running despite being over ceiling.
  await checkWait("(7) wait for 4 total spawns (initial + 3 unproductive respawns) succeeded", () => sup.getSpawnCount() >= 4, () => sup.getHealthProbeTickCount());
  check("(7) exactly 3 recycles fired before the backstop tripped", recycleCalls.length === 3);
  check("(7) the backstop tripped exactly once", suspendCalls.length === 1);
  check("(7) the suspend detail carries the consecutive count + the same measured/ceiling shape as a recycle detail",
    suspendCalls[0]?.consecutiveUnproductiveRecycles === 3 && suspendCalls[0]?.measuredBytes === 300 * MB && suspendCalls[0]?.ceilingBytes === 100 * MB);
  check("(7) getMemoryRecycleSuspended() reports true", sup.getMemoryRecycleSuspended() === true);
  check("(7) getConsecutiveUnproductiveRecycles() reports 3", sup.getConsecutiveUnproductiveRecycles() === 3);

  // Named, progress-keyed (T1): prove serve genuinely STAYS UP despite remaining over ceiling — several
  // more completed ticks must NOT produce a 5th spawn.
  const settledAt4 = await waitForStableCount(() => sup.getSpawnCount(), () => sup.getHealthProbeTickCount());
  check("(7) serve stays up — spawn count settles at 4 and never climbs further despite staying over ceiling",
    settledAt4 === 4);

  // A ceiling CHANGE re-arms it — still below the reported 300MB, but a DIFFERENT value than the one the
  // backstop tripped at, proving re-arm is keyed on the ceiling actually CHANGING, not merely re-read.
  ceilingMb = 200;
  await checkWait("(7) wait for the re-armed kill (5th spawn) succeeded", () => sup.getSpawnCount() >= 5, () => sup.getHealthProbeTickCount());
  check("(7) a ceiling change re-arms memory-based recycling — a 5th spawn happened", sup.getSpawnCount() === 5);
  check("(7) getMemoryRecycleSuspended() reports false again after re-arming", sup.getMemoryRecycleSuspended() === false);

  // The re-armed respawn (generation 5) reports LOW — settle to prove re-arming didn't itself cascade
  // into an unbounded restart loop.
  const settledAt5 = await waitForStableCount(() => sup.getSpawnCount(), () => sup.getHealthProbeTickCount());
  check("(7) after re-arming, the healthy respawn settles at 5 — no further kills",
    settledAt5 === 5);

  sup.stop();
}

// ===================== cleanup =====================
delete process.env.LOOM_CODESCAPE_BIN;
delete process.env.LOOM_CODESCAPE_ENABLED;
delete process.env.LOOM_DEV;
delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — codescape memory-ceiling recycle (7 scenarios): over-ceiling recycle-exactly-once + event shape + pid-scoping, negative control, sampler-failure fail-safe, sample-cadence cost control, live (non-frozen) ceiling resolution, pure OS-output parser units (incl. the empty-stdout regression), and the 3-strikes unproductive-recycle backstop (stays up, re-arms on a ceiling change). See this file's own scenario-header comments for the full per-scenario DoD."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
