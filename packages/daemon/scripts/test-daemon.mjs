// `pnpm --filter @loom/daemon test:daemon` — run the daemon's HERMETIC, claude-free test suite,
// isolated BY CONSTRUCTION: every test runs in its OWN fresh temp LOOM_HOME, on a non-4317 LOOM_PORT,
// with LOOM_TEST=1 set. So "run the daemon tests" can NEVER touch the prod db (~/.loom/loom.db) or the
// prod daemon on :4317 — the failure mode that wiped prod on 2026-06-04 (see test/_guard.mjs + the
// db.ts prod-guard). Each test ALSO arms its own guard (import "./_guard.mjs"), so this envelope is
// belt-and-suspenders, not the only line of defence.
//
// Run after a build (the tests import dist/):  pnpm --filter @loom/daemon build && pnpm --filter @loom/daemon test:daemon
//
// Tests are DISCOVERED by an explicit ALLOWLIST, not by "everything not positively excluded": a
// recursive walk of test/ (skipping the established non-test containers `fixtures/` and `census/` —
// child-process fixtures and the out-of-band census harness, neither ever hermetic tests) collects every
// `.mjs` file, then splits it two ways. A leading `_` on ANY path segment — the file's own name, or any
// containing directory (e.g. _guard.mjs, _tmp-fixture.mjs, or a whole _scratch/ directory) — marks an
// intentional helper and is silently excluded. Everything else MUST look like a real test — carry an
// assertion marker (`check(`/`assert`/`throw new Error`/`process.exit(1)`) — or discovery REFUSES
// LOUDLY, naming the file, instead of silently spawning it and recording a pass. This is on top of, and
// does not replace, the small NOT_HERMETIC denylist below for genuine tests that need a human-started
// isolated daemon and/or a real `claude` login — run those manually per the header comment in each file.
// Adding a new ordinary hermetic test file still needs no edit here: the allowlist is a derivation rule,
// not a static list.
// @decision b122c7d4 — a non-test file that merely imports cleanly and exits 0 is graded a silent PASS
// by this harness's exit-code grading (and by `node:test`, measured); discovery must REFUSE such a file
// loudly, never run it silently, and membership must stay an explicit allowlist, never inverted.
//
// @decision e7bcb0df — the walk above cannot audit itself: `HERMETIC` and the executed-path-set
// assertion below both derive from the SAME walk, so a file it fails to discover is silently absent
// from both and never noticed. `auditDiscoveryAgainstGit` (below) is the independent cross-check.
//
// Runs in a BOUNDED, port-safe worker pool (each test file is already hermetically isolated — own
// temp LOOM_HOME, own port — so this is embarrassingly-parallel). Pool size, in order:
// LOOM_GATE_TEST_CONCURRENCY env (explicit dial-up/down on a host you know can take it) ?? a bounded
// DEFAULT_CONCURRENCY (safe when unset — see its own doc below) — either way clamped to the
// MAX_CONCURRENCY ceiling (concurrent temp-SQLite DBs + in-process daemon boots thrash host
// resources past a point; incident: this exact command, run with no env override, starved a live
// self-hosting sibling service — card 301d8c01). Each of the fixed pool "lanes" owns one port for its
// whole run (4400+laneIndex), so concurrent workers never collide — unlike a file-index-derived port,
// which only avoided collisions when tests ran strictly one-at-a-time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupPathSync } from "../test/_tmp-fixture.mjs";
import { reapStaleLoomTempDirs } from "./temp-reaper.mjs";
// Card f8b176f7 CR follow-up: deliberately NOT a top-level import. `git/worktrees.ts`'s
// `loadNotHermeticNames`/`loadExcludedTestDirNames` load THIS FILE as a real module (dynamic
// `import()`, not a parse) purely to read its NOT_HERMETIC/excluded-dir exports, from an
// arbitrary worktree — including test fixtures that mirror only this file's OWN direct siblings
// (see test/_emit-compare-fixtures.mjs's writeRealTestDaemonScript). A top-level import here would
// make loading this file for those two unrelated exports also require every transitive import to
// resolve, coupling this module's dependency graph to those loaders' fixture completeness for no
// reason — the exact defect a real gate run caught (op a450e3dd). Importing lazily, at the one call
// site that actually needs it, means loading this file for its exports alone never touches this
// module at all.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "..", "test");

// Gate-timing NDJSON schema history (row kinds: "file", "run-summary", "run-start", "host-sample").
// LOOM_HOME-relative, never the worktree (force-removed on merge); same schema as the committed
// investigation snapshot docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson
// so the two stay concatenable; every row carries `runUid` as its join key; an unknown row kind is
// silently ignored by any reader that filters by `kind`, so each addition below is additive-only.
//
// @decision 17069e7e — per-file emission must reuse this exact schema, run on the normal gate path
// with no flag, and never treat the discovered-file count as stable — it moves within hours.
//
// @decision 05056168 — every row kind here must flush INCREMENTALLY, at the moment each file
// completes, never batched into a post-run loop, with a write-ahead "run-start" row appended before
// the first spawn — a SIGKILLed run must still leave a nameable in-flight file, not nothing at all.
//
// @decision a496166a — host-sample rows sample load PERIODICALLY via a delta, never a cumulative-CPU
// ranking (a Get-Process-style ranking conflates "ran a long time" with "is busy now"); lane count
// stays capped on the gates x lanes PRODUCT after an unbounded fallback starved a live sibling service.
//
// @decision afd51f5d — `diskProbeMs` on the host-sample row is a bulk-sequential-write latency probe
// against a fixed, in-place-overwritten file, never grown; a flat reading does not prove disk isn't
// the bottleneck for metadata-heavy I/O (git worktree / npm install), a different I/O shape.
//
// @decision 237aa3a9 — a failing "file" row's `failureDetail` attaches on the SAME per-file flush as
// the row itself (card 05056168), never a close-time pass, additive-only: presence of the key IS the
// failure signal, never inferred from a key that merely exists with a false-y value.
//
// @decision ec2d154b — the "run-summary" row's `hostLoadAggregates` is computed from the SAME
// in-memory sample arrays the human-readable summary lines already accumulate, additive-only, with
// every field null (never a fabricated 0) when its source array is empty for this run.
const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const GATE_TIMING_NDJSON = path.join(LOOM_HOME, "gate-timing", "daemon-per-file-timing.ndjson");
// Card afd51f5d: a FIXED, dedicated probe file — separate from GATE_TIMING_NDJSON, overwritten in place
// every sample tick, NEVER appended to and NEVER grows. See `diskProbeWriteMs`'s own doc for why this file
// exists and what it measures.
const DISK_PROBE_FILE = path.join(LOOM_HOME, "gate-timing", ".disk-probe.bin");
const DISK_PROBE_BYTES = 64 * 1024;
const DISK_PROBE_BUF = Buffer.alloc(DISK_PROBE_BYTES, 7);

// Card 17069e7e (CR follow-up, DIRECTIVE #3): tally, don't print, on each individual write failure. A
// single gate run calls `appendGateTimingRow` up to ~633 times (1 run-start + 1 run-summary + one per test
// file — card 05056168 added the run-start row and moved the per-file calls to fire incrementally, but the
// total call count is unchanged) — if `LOOM_HOME` were ever unwritable, warning ON EVERY CALL would print
// up to 633 near-identical lines to stderr. The merge gate surfaces only a bounded ~4KB stdout+stderr TAIL
// on rejection (see gate-runner.ts's OUTPUT_TAIL_BYTES); that many lines would push the actual failing
// test's assertion clean out of that tail — the failure mode of this OBSERVABILITY feature would destroy
// the diagnostic output of the very suite it observes. So: silently count here; the isMain block prints ONE
// summary warning (if any failures occurred at all), after every row for the run has been attempted. NEVER
// reintroduce a per-call console.warn in the catch below.
let gateTimingWriteFailureCount = 0;
let gateTimingWriteFailureLastMessage = null;

/** Best-effort NDJSON append — mkdir -p then append one JSON line. NEVER throws: a write failure (an
 *  unwritable LOOM_HOME, a full disk, a permissions issue on some CI runner) must not affect this gate's own
 *  pass/fail or exit code — an observability feature that can fail a gate is strictly worse than no
 *  observability feature. `filePath` is a parameter (not read from the module-level constant) so a test can
 *  point this at a scratch file instead of the real LOOM_HOME. Mirrors test/census/lib.mjs's own
 *  `appendNdjson` (not imported — this script has no existing dependency on that harness and one helper
 *  doesn't warrant creating one). */
export function appendGateTimingRow(filePath, record) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
  } catch (err) {
    gateTimingWriteFailureCount++;
    gateTimingWriteFailureLastMessage = err.message;
  }
}

/** Read-only tally of every `appendGateTimingRow` failure so far this process — `{count, lastMessage}`.
 *  Exported so the isMain block can print ONE summary warning (see the doc above) and so a test can assert
 *  on the count directly instead of scraping console output. Monotonic within a process (this script exits
 *  after each real gate invocation, so there is no cross-run contamination in production) — a test that
 *  triggers a failure must read the count BEFORE and AFTER its own block and assert the DELTA, since
 *  earlier test blocks in the same file may have already incremented it. */
export function gateTimingWriteFailureSummary() {
  return { count: gateTimingWriteFailureCount, lastMessage: gateTimingWriteFailureLastMessage };
}

/** Cheap, synchronous, no-added-subprocess host snapshot — matches test/census/lib.mjs's `hostSnapshot`
 *  field NAMES (so a row here is shape-compatible with the existing NDJSON), but `nodeLikeProcessCount`/
 *  `nodeLikeWorkingSetMB` are always `null` here (honest-null, not a guess): that census helper gets those
 *  via a `powershell`/`Get-Process` subprocess, and this file already has a standing rule against adding a
 *  subprocess for observability (see `createRssTracker`'s own scope-caveat doc above). */
export function cheapHostSnapshot() {
  return {
    ts: new Date().toISOString(),
    cpuCount: os.cpus().length,
    freeMemMB: Math.round(os.freemem() / 1e6),
    totalMemMB: Math.round(os.totalmem() / 1e6),
    nodeLikeProcessCount: null,
    nodeLikeWorkingSetMB: null,
  };
}

/** Card a496166a DoD-0: the delta-based CPU busy % between two `os.cpus()`-shaped readings — TRUE current
 *  host load, never the CUMULATIVE lifetime total this card's kickoff RETRACTED (`Get-Process | Sort CPU
 *  -Desc` ranks by cumulative CPU-seconds, which conflates "has run a long time" with "is busy right now" —
 *  the retracted claim ranked Spotify #1 at 35,567 CPU-seconds while a sampled-delta read showed it absent
 *  from the live top 12 entirely). Host-wide % busy = 1 - (summed idle-time delta / summed total-time
 *  delta) across every core, between the two snapshots. Pure and injectable-input so a test can drive it
 *  with synthetic `times` objects instead of asserting against the real, non-deterministic host.
 *  Returns null (never NaN/Infinity) when there's nothing meaningful to divide by — a zero-or-negative
 *  elapsed delta (two reads in the same tick, or a clock oddity) or a shape mismatch (different core count
 *  between the two readings, e.g. a CPU hot-plug) — rather than reporting a fabricated number. */
export function cpuBusyPctDelta(prevCpus, currCpus) {
  if (!Array.isArray(prevCpus) || !Array.isArray(currCpus) || prevCpus.length === 0 || prevCpus.length !== currCpus.length) {
    return null;
  }
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < currCpus.length; i++) {
    const p = prevCpus[i].times;
    const c = currCpus[i].times;
    idleDelta += c.idle - p.idle;
    totalDelta += (c.user + c.nice + c.sys + c.idle + c.irq) - (p.user + p.nice + p.sys + p.idle + p.irq);
  }
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

/** Stateful wrapper around `cpuBusyPctDelta` + a real `os.cpus()` read, so the periodic sampler (the
 *  isMain run below) doesn't have to manage "what was the previous reading" itself. `readCpus` is
 *  injectable (defaults to the real `os.cpus`) so a test can drive deterministic synthetic readings
 *  instead of the real, non-deterministic host. The FIRST `sample()` call always returns `null` — there is
 *  no prior reading to delta against yet — never a fabricated 0% or 100%; every call after that returns
 *  the delta since the PREVIOUS `sample()` call, not since the sampler was created. */
export function createHostLoadSampler(readCpus = () => os.cpus()) {
  let prev = null;
  return {
    sample() {
      const curr = readCpus();
      const busyPct = prev ? cpuBusyPctDelta(prev, curr) : null;
      prev = curr;
      return busyPct;
    },
  };
}

/** Human-readable whole-run host-CPU-busy summary line (Card a496166a DoD-0) — same placement/posture as
 *  `formatRssFloorLine`/`formatMaxGapLine` below: printed unconditionally, pass or fail. The "SAMPLED
 *  DELTA, not cumulative" framing is baked INTO the line itself, not left to a caveat a reader can skip —
 *  this project was burned once already by a cumulative-CPU number read as load (see the card).
 *  `busyPctSamples` should already exclude the sampler's own null first reading (see createHostLoadSampler). */
export function formatHostLoadSummaryLine(busyPctSamples, intervalMs) {
  if (busyPctSamples.length === 0) {
    return `# host CPU busy — SAMPLED DELTA (not cumulative): 0 sample(s) with a valid delta @ ${intervalMs}ms (run too short for a second tick)`;
  }
  const min = Math.min(...busyPctSamples);
  const max = Math.max(...busyPctSamples);
  const mean = busyPctSamples.reduce((sum, v) => sum + v, 0) / busyPctSamples.length;
  return `# host CPU busy — SAMPLED DELTA (not cumulative), ${busyPctSamples.length} sample(s) @ ${intervalMs}ms: min ${min.toFixed(1)}% / mean ${mean.toFixed(1)}% / max ${max.toFixed(1)}%`;
}

// @decision afd51f5d — this disk probe is a bulk-sequential-write latency canary (fixed 64KB, one
// open+write+fsync+close per 5s tick against an in-place-overwritten file), chosen because both a
// subprocess-based OS counter and process-level I/O-operation counts were measured unusable here — a
// flat reading proves only that THIS write pattern wasn't queued, never that disk isn't the bottleneck
// for metadata-heavy I/O (git worktree add / npm install), a structurally different I/O shape.
export function diskProbeWriteMs(probeFilePath, buf, writeFn = defaultDiskProbeWrite) {
  const t0 = performance.now();
  try {
    writeFn(probeFilePath, buf);
  } catch {
    return null;
  }
  return performance.now() - t0;
}

function defaultDiskProbeWrite(probeFilePath, buf) {
  fs.mkdirSync(path.dirname(probeFilePath), { recursive: true });
  const fd = fs.openSync(probeFilePath, "w");
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Human-readable whole-run disk-probe-latency summary line — same placement/posture as
 *  `formatHostLoadSummaryLine` above: printed unconditionally, pass or fail. The "await-time PROXY, not a
 *  true queue-depth counter" framing is baked into the line itself for the same reason the CPU line bakes
 *  in "SAMPLED DELTA" — a reader must not mistake this for a real OS disk-queue metric.
 *  `probeMsSamples` should already exclude any null (failed-probe) samples. */
export function formatDiskProbeSummaryLine(probeMsSamples, intervalMs) {
  if (probeMsSamples.length === 0) {
    return `# disk probe write latency — AWAIT-TIME PROXY (not a true OS queue-depth counter): 0 sample(s) @ ${intervalMs}ms (run too short, or every probe failed)`;
  }
  const min = Math.min(...probeMsSamples);
  const max = Math.max(...probeMsSamples);
  const mean = probeMsSamples.reduce((sum, v) => sum + v, 0) / probeMsSamples.length;
  return `# disk probe write latency — AWAIT-TIME PROXY (not a true OS queue-depth counter), ${probeMsSamples.length} sample(s) @ ${intervalMs}ms: min ${min.toFixed(2)}ms / mean ${mean.toFixed(2)}ms / max ${max.toFixed(2)}ms`;
}

/** Nearest-rank p95 (never interpolated) over `samples`: sorts ascending and takes the value at
 *  `ceil(0.95 * n) - 1`, clamped into range. Returns `null` for an empty input rather than a fabricated
 *  number — same convention every other stat in this module already uses. Pure (no host reads), so a test
 *  can drive it with a fixed array instead of real, non-deterministic samples. */
function p95(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx];
}

/** @decision ec2d154b — sampleCount comes from `freeMemMBSamples.length` (the only never-null-filtered
 *  array) since it can exceed but never fall below the CPU/disk sample counts; every other field is
 *  `null`, never a fabricated 0, when its own source array is empty for this run. */
export function computeHostLoadAggregates(cpuBusyPctSamples, diskProbeMsSamples, freeMemMBSamples) {
  const mean = (arr) => (arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null);
  const max = (arr) => (arr.length ? Math.max(...arr) : null);
  const min = (arr) => (arr.length ? Math.min(...arr) : null);
  return {
    sampleCount: freeMemMBSamples.length,
    cpuBusyPctMean: mean(cpuBusyPctSamples),
    cpuBusyPctP95: p95(cpuBusyPctSamples),
    cpuBusyPctMax: max(cpuBusyPctSamples),
    diskProbeMsP95: p95(diskProbeMsSamples),
    diskProbeMsMax: max(diskProbeMsSamples),
    freeMemMBMin: min(freeMemMBSamples),
  };
}

/** Card 90678ee9 DoD-5: the one population field this NDJSON was missing. `testCount` only says HOW MANY
 *  files ran, so a reader can't tell "the suite grew" from "the same suite got slower" — a peer project
 *  hit exactly this gap (a flat file-count field while the real cost driver was corpus CONTENT). Sums the
 *  on-disk BYTE size of every selected file's own source — cheap (fs.statSync, no read) and a direct proxy
 *  for suite content size, independent of file count. A selected name with no file on disk (mirrors
 *  runOne's own fs.existsSync skip) contributes 0, never throws.
 *  What this does NOT distinguish: two files of equal byte size can do wildly different amounts of real
 *  work (e.g. a loop bound by fixture/DB row count, not by lines of test code), so a rise in
 *  testSourceBytes at a flat testCount says "the suite's own source grew", not "the suite got slower" —
 *  those stay two different claims a reader must not conflate. */
export function computeTestSourceBytes(testDir, selected) {
  let total = 0;
  for (const name of selected) {
    try {
      total += fs.statSync(path.join(testDir, `${name}.mjs`)).size;
    } catch {
      // missing file — same as runOne's own skip path; contributes 0, never throws.
    }
  }
  return total;
}

/** Card 720bb7ad DoD-3: the caller's `opId`, threaded in via the `LOOM_GATE_OP_ID` env var — the daemon
 *  sets it (see `gateOpIdEnvOverride` in sessions/service.ts) on the child running `pnpm --filter
 *  @loom/daemon test:daemon` for a merge/deploy/worker-self-check gate (including a RETRY, which gets the
 *  SAME opId as the attempt it's retrying), so this run's own `kind:"run-summary"` NDJSON row can be
 *  joined back to the exact `gate_status`-visible op that produced it — closing the gap where two runs
 *  admitted close together (routine at `maxConcurrentGates>=2`) were indistinguishable by timestamp
 *  alone. `undefined` (never a fabricated empty string) when absent — a human's own local `pnpm --filter
 *  @loom/daemon test:daemon`, CI, or any other caller that never set the env var. Exported as its own pure
 *  function so a test can assert the read directly without spawning a real gate. */
export function gateTimingOpId() {
  return process.env.LOOM_GATE_OP_ID || undefined;
}

/** Pure: the slowest `n` TIMED results (skipped/never-run entries have no `durationMs` and are excluded),
 *  descending. Exported so a test can drive it against synthetic result arrays directly. */
export function topSlowestFiles(results, n = 20) {
  return results
    .filter((r) => typeof r.durationMs === "number")
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, n);
}

/** Card 05056168: pure set-difference — given `selected` (a "kind":"run-start" row's file list) and
 *  `completedNames` (the names with a matching "kind":"file" row for the same runUid), returns the names
 *  that never got one, in `selected`'s original order. On a run that terminated normally this is always
 *  empty (every selected file has a completion row); on a run killed mid-flight, it names the file(s) that
 *  were in progress at the moment it died. Exported so a test — or a future reader of the raw NDJSON — can
 *  compute this directly instead of duplicating the set-difference. */
export function neverCompletedFiles(selected, completedNames) {
  const completed = new Set(completedNames);
  return selected.filter((name) => !completed.has(name));
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Pure formatter for the human-readable gate-path summary (DoD-2): aggregate timed test time, wall-clock,
 *  and the slowest `topN` files. Returns an array of lines (never prints itself) so a test can assert the
 *  content directly. Printed UNCONDITIONALLY (pass or fail), same placement as the existing RSS-floor/
 *  max-gap lines — never behind a flag. */
export function formatGateTimingSummaryLines(results, wallClockMs, { topN = 20 } = {}) {
  const timed = results.filter((r) => typeof r.durationMs === "number");
  const aggregateMs = timed.reduce((sum, r) => sum + r.durationMs, 0);
  const lines = [
    `# per-file test timing — aggregate ${formatSeconds(aggregateMs)} across ${timed.length} file(s), wall-clock ${formatSeconds(wallClockMs)}`,
  ];
  const slowest = topSlowestFiles(results, topN);
  if (slowest.length) {
    lines.push(`# slowest ${slowest.length} file(s):`);
    slowest.forEach((r, i) => {
      lines.push(`   ${String(i + 1).padStart(2)}. ${formatSeconds(r.durationMs).padStart(6)}  ${r.name}`);
    });
  }
  return lines;
}

// Exported so an out-of-band census/probe harness (test/census/*) can import the REAL exclusion list
// instead of keeping its own copy — a duplicated copy is exactly the shared-unit-divergence anti-pattern
// this codebase keeps paying for (see card ec7983c6's 116-copy SeamHost fixture).
// mgmt-surface / platform-scope / scheduler REMOVED (card 76388dcb): all three were only excluded as
// collateral from the same loopback-guard breakage 4f1d4276 fixed on profiles-rest.mjs (card 4ff9a073,
// 2026-08-07 — a REAL spawned daemon 401s every unauthenticated non-GET /api/* write). None of the three
// need a real `claude` spawn or mutate shared state — read `gateway-loopback.key` after the daemon is up
// and send it as `Authorization: Bearer`, same fix, same pattern (see test/_loopback-auth.mjs). Verified
// green (exit 0) against a fresh isolated daemon before removal.
export const NOT_HERMETIC = new Set([
  "integration-e2e", "orchestration-e2e", "manager-live", "messaging", "orch-scope",
  "orch-spawn", "mcp-scope", "recycle", "scheduler-drain",
  "scheduler-disabled", "usage-limit-detect", "usage-limit-resume", "worker-report", "autonomy-rails",
  "busy-flag", "merge-gate", "board-consistency", "skills-e2e",
  "merge-confirm-slow-gate-pending", // ~20s wall-clock (a real 15s gate) + needs a manually-started daemon
  "web-build-no-orphans", // mutates the REAL packages/web/src/main.tsx + rebuilds the shared packages/web/dist
  // 2-3x (~5-20s each) to exercise turbo's actual cache — would race codescape-privacy-guard.mjs (which
  // reads that same dist) if run concurrently. Run manually per its own header comment.
]);

// Directories that are established non-test containers under test/ — never descended into by the
// allowlist walk, so a file inside either can never be discovered as a test candidate regardless of its
// own name or shape. `fixtures/` holds child-process fixture scripts spawned BY tests (some carry
// assertion-marker-shaped code — e.g. a fixture that calls `process.exit(1)` to simulate a failing
// child — which would otherwise false-positive as a "missing helper" violation below). `census/` is the
// out-of-band suite-flake census harness (its own `lib.mjs`, phase*.mjs probes, `fixtures/`, `raw/` logs)
// — a sibling investigation, not part of this gate.
//
// @decision d67725c1 — hand-deriving this discovered-test count (`git ls-tree`/`grep -c`, or any
// tracked-file count) is UNSUPPORTED and WILL drift; `HERMETIC.length` (or `--count`) is authoritative.
// @decision 815b4b30 — Exported so worktrees.ts's emit-compare classifier imports this Set directly,
// never a hand-copied second list.
export const EXCLUDED_DIR_NAMES = new Set(["fixtures", "census"]);

// A discovered file not underscore-prefixed must carry at least one of these to count as a real test.
// Card b122c7d4's census verified the marker set against test/'s top-level .mjs files at that commit:
// 629 top-level files MATCHED a marker. That is a DIFFERENT population from "hermetic" — 629 counts every
// top-level .mjs that matched, before NOT_HERMETIC exclusion; the actually-hermetic count at that same
// commit was 592 (card e7bcb0df: the original comment here conflated the two figures — don't reintroduce
// that when re-verifying this marker set later).
const ASSERTION_MARKERS = [/\bcheck\(/, /\bassert\b/, /throw new Error/, /process\.exit\(1\)/];

function looksLikeTest(source) {
  return ASSERTION_MARKERS.some((re) => re.test(source));
}

// True if ANY path segment — the file's own name, or any containing directory — starts with "_". Card
// e7bcb0df GAP 2: checking only the file's basename let a file inside an underscore-prefixed DIRECTORY
// (e.g. test/_fixtures/x.mjs — "_fixtures" != the exact-match EXCLUDED_DIR_NAMES entry "fixtures") through
// as a discovery candidate; a marker-less file there refused the whole gate. This makes the enforced rule
// match the convention as humans actually read it — underscore-prefix a whole helper directory, not just
// individual files.
function isUnderscoreExcluded(rel) {
  return rel.split("/").some((segment) => segment.startsWith("_"));
}

// Shared recursive `.mjs` collector. `skipDir(name)` is checked at every level of the recursion (so it
// applies at any depth, not just the top) and decides whether to descend into a given directory at all.
// Returns paths relative to `base`, POSIX-separated (stable/portable name shape regardless of nesting).
function walkMjsFilesImpl(dir, skipDir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDir(entry.name)) continue;
      out.push(...walkMjsFilesImpl(full, skipDir, base));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

// Recursively collect every `.mjs` file under `dir`, skipping EXCLUDED_DIR_NAMES subtrees entirely — the
// production discovery walk, unchanged from before card e7bcb0df.
function walkMjsFiles(dir, base = dir) {
  return walkMjsFilesImpl(dir, (name) => EXCLUDED_DIR_NAMES.has(name), base);
}

// A FULLY RAW walk — no directory exclusions at all, not even EXCLUDED_DIR_NAMES. Used ONLY by
// `auditDiscoveryAgainstGit` below (card e7bcb0df), which cross-checks the discovery walk's TRAVERSAL
// against git's own tracked-file list at a layer with NO classification logic on either side. Applying
// EXCLUDED_DIR_NAMES here would make the git reference inherit the production walk's own exclusion
// decision, and a traversal bug in `walkMjsFiles` (as opposed to a bug in what it deliberately excludes)
// would then no longer be catchable — the two sides would still compare equal.
function walkAllMjsFiles(dir, base = dir) {
  return walkMjsFilesImpl(dir, () => false, base);
}

// The allowlist derivation (card b122c7d4): walk `testDir`, split into silently-excluded helpers (a
// leading `_` on any path segment — card e7bcb0df) and candidates. Every candidate must `looksLikeTest`;
// one that doesn't is a VIOLATION — named and returned, never silently run and never silently dropped.
// `hermetic` is `candidates minus notHermetic`, using the SAME bare-name shape existing callers
// (NOT_HERMETIC, TEST_TIMEOUT_OVERRIDES) already key on — for every file that lives at test/ top level
// (all of them, today) the name is unchanged from before this card. Exported so a test can
// positive/negative-control this logic directly, against a synthetic directory, instead of a duplicated
// copy silently drifting from the real thing.
// Return shape is additive-only across changes (card fa52f555 added `notHermeticNames`) — existing
// callers destructure `{ hermetic, violations }` by name, so a new key never breaks them.
export function discoverHermeticTests(testDir, notHermetic = NOT_HERMETIC) {
  const violations = [];
  const hermetic = [];
  const notHermeticNames = [];
  for (const rel of walkMjsFiles(testDir).sort()) {
    if (isUnderscoreExcluded(rel)) continue;
    const name = rel.slice(0, -".mjs".length);
    if (notHermetic.has(name)) { notHermeticNames.push(name); continue; }
    const source = fs.readFileSync(path.join(testDir, rel), "utf8");
    if (!looksLikeTest(source)) { violations.push(rel); continue; }
    hermetic.push(name);
  }
  return { hermetic, violations, notHermeticNames };
}

// @decision d67725c1 — a test-shaped file inside an EXCLUDED_DIR_NAMES subtree runs NEVER and
// SILENTLY unless it declares `loom:gate-exempt:`/`loom:not-a-test:` with a non-empty reason.
const EXCLUDED_DIR_MARKER_RE = /loom:(gate-exempt|not-a-test):[ \t]*(.*)/;

function parseExcludedDirMarker(source) {
  const match = EXCLUDED_DIR_MARKER_RE.exec(source);
  if (!match) return null;
  const reason = match[2].trim();
  if (!reason) return null; // marker present but no reason — treated as undeclared, per the doc above.
  return { type: match[1], reason };
}

// Walks the FULL tree (`walkAllMjsFiles` — the same raw layer `auditDiscoveryAgainstGit` uses), keeps
// only paths inside an excluded-dir subtree, applies the SAME underscore-exclusion precedence as the main
// walk (an underscore-prefixed helper already declares itself — no marker needed), then classifies every
// remaining test-shaped file by its marker. Exported so the regression test can drive it against a
// synthetic directory, same pattern as `discoverHermeticTests`/`auditDiscoveryAgainstGit`.
export function findExcludedDirTestShapedFiles(testDir, excludedDirNames = EXCLUDED_DIR_NAMES) {
  const violations = [];
  const declared = { gateExempt: [], notATest: [] };
  for (const rel of walkAllMjsFiles(testDir).sort()) {
    const parentSegments = rel.split("/").slice(0, -1);
    if (!parentSegments.some((seg) => excludedDirNames.has(seg))) continue;
    if (isUnderscoreExcluded(rel)) continue;
    const source = fs.readFileSync(path.join(testDir, rel), "utf8");
    if (!looksLikeTest(source)) continue;
    const marker = parseExcludedDirMarker(source);
    if (marker?.type === "gate-exempt") { declared.gateExempt.push(rel); continue; }
    if (marker?.type === "not-a-test") { declared.notATest.push(rel); continue; }
    violations.push(rel);
  }
  return { violations, declared };
}

// Runs a read-only, local git command with an EXPLICIT cwd (never `process.cwd()`) and returns its
// stdout, or throws with a clear message. Used only by `auditDiscoveryAgainstGit` below; never mutates
// the repo. GIT_TERMINAL_PROMPT=0 + a short timeout are cheap insurance against ever hanging the gate on
// what should always be an instant local read.
function runGitReadOnly(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} (cwd ${cwd}) failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd ${cwd}) exited ${result.status}: ${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

// An INDEPENDENT cross-check of the discovery walk's TRAVERSAL against git's own tracked-file list —
// `git ls-files` is a genuinely independent second opinion on which files exist under test/, catching a
// class of under-discovery bug the post-run executed-path-set assertion cannot (see its own doc above).
// @decision e7bcb0df — anchor via `git rev-parse --show-toplevel` with an explicit `cwd` (an unanchored,
// unvalidated reference can pass VACUOUSLY from a wrong cwd); a zero-size reference is a hard error, not
// an empty comparison; compare at the RAW enumeration layer only — filtering by this walk's own
// classification rules re-shares its bug one layer down. Tracked-files-only: no cover for an untracked
// new test.
//
// Reports both directions, named: `inGitNotWalked` (git-tracked, walk never saw it — fatal) and
// `walkedNotInGit` (walk saw it, git doesn't track it — a normal untracked local-dev state, a warning).
export function auditDiscoveryAgainstGit(testDir) {
  const realTestDir = fs.realpathSync.native(testDir);
  const repoRootRaw = runGitReadOnly(["rev-parse", "--show-toplevel"], realTestDir).trim();
  if (!repoRootRaw) {
    throw new Error(`git rev-parse --show-toplevel returned nothing for ${realTestDir} — cannot anchor the discovery audit`);
  }
  const repoRoot = fs.realpathSync.native(repoRootRaw);
  const relTestDir = path.relative(repoRoot, realTestDir).split(path.sep).join("/");
  // `git ls-files -- ""` is a git error ("empty string is not a valid pathspec"), not an empty result —
  // the edge case where testDir IS the repo root itself (relTestDir === "") needs "." instead.
  const lsOutput = runGitReadOnly(["ls-files", "--", relTestDir === "" ? "." : relTestDir], repoRoot);
  const tracked = lsOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  if (tracked.length === 0) {
    throw new Error(`git ls-files reported ZERO tracked files under "${relTestDir || "."}" (repo root ${repoRoot}) — refusing to treat an empty reference set as a valid comparison`);
  }
  const prefix = relTestDir === "" ? "" : `${relTestDir}/`;
  const gitMjs = new Set(
    tracked.filter((rel) => rel.startsWith(prefix) && rel.endsWith(".mjs")).map((rel) => rel.slice(prefix.length)),
  );
  // The `tracked.length === 0` check above only guards that git tracks SOMETHING under testDir — it does
  // NOT guard that any of it is `.mjs`. `gitMjs` is the reference the comparison below actually consumes,
  // so THAT is the set that must not be silently empty: a directory git tracks non-.mjs files under (e.g.
  // a `src/` full of `.ts`) would otherwise pass `tracked.length === 0` and then compare two empty sets as
  // a clean pass — the same vacuous-pass shape this whole check exists to prevent, one level in. A
  // distinct message from the "zero tracked files at all" case above: that one means the pathspec/anchor
  // itself is broken; this one means the anchor is fine but nothing here is even candidate material.
  if (gitMjs.size === 0) {
    throw new Error(`git tracks ${tracked.length} file(s) under "${relTestDir || "."}" (repo root ${repoRoot}) but NONE are .mjs — refusing to treat an empty .mjs reference set as a valid comparison`);
  }
  const walked = new Set(walkAllMjsFiles(realTestDir));

  const inGitNotWalked = [...gitMjs].filter((rel) => !walked.has(rel)).sort();
  const walkedNotInGit = [...walked].filter((rel) => !gitMjs.has(rel)).sort();
  return { inGitNotWalked, walkedNotInGit };
}

// Card 05724a32: `--count`/`--list`/`--help` were the only recognized flags, but an unrecognized one
// (a typo, e.g. `--nope`) fell straight through to a full suite run — ~20min of CPU, silently, since the
// broken invocation and a bare `node scripts/test-daemon.mjs` produced identical observable behaviour.
// Pure classifier, exported so a test can exercise every outcome directly against the REAL flag set —
// never a hand-copied duplicate that could drift — without spawning this script as a subprocess (which
// for the "no flags" case would nest an entire hermetic-suite run inside a test).
// Card ce02e7e5: `--codex-real-spawn`/`--no-codex-real-spawn` are PRESETS over the codex real-spawn
// family (`CODEX_REAL_SPAWN_BASENAMES`, the single source of truth in `test/_codex-real-spawn-lock.mjs`)
// — shorthand for `--only=<that list>`/`--exclude=<that list>` that reads the array itself at run time
// (see `resolveSelectionForCliMode` below) rather than a second, hardcoded copy of the 7 (as of this
// writing) basenames that could silently drift from it the way a hand-authored `gateCommand` string
// already had (card 3791b14e's own history of this exact array growing unnoticed). Exact-match, so they
// belong in this Set, not KNOWN_CLI_VALUE_PREFIXES below.
export const KNOWN_CLI_FLAGS = new Set(["--count", "--list", "--help", "-h", "--codex-real-spawn", "--no-codex-real-spawn"]);

// Card 6185fbfc: a SEPARATE selection capability, decoupled from any change to the real gate command
// (this card's own resolution left the gate command unchanged — see its body). `--only=`/`--exclude=`
// name a comma-separated subset of the DISCOVERED hermetic set by bare name; `--concurrency=` overrides
// the pool size for just this invocation, without touching the env var. Several open measurement cards
// (f1043732, cfcc0946, 0bafbe35, c062a307) want exactly this: run a named subset at a chosen concurrency
// without a hand-rolled recipe. Value-bearing, so recognized by PREFIX (the value varies per
// invocation) rather than exact membership in KNOWN_CLI_FLAGS above — kept as a SEPARATE set so the
// existing exact-match flags and their own test assertions are untouched by this addition.
export const KNOWN_CLI_VALUE_PREFIXES = ["--only=", "--exclude=", "--concurrency="];

function parseValueFlag(argv, prefix) {
  const token = argv.find((a) => a.startsWith(prefix));
  return token === undefined ? undefined : token.slice(prefix.length);
}

// A positive integer only — "0", "-1", "abc", "1.5" are all invalid. `undefined` means "flag omitted"
// (the caller must not confuse that with an invalid value that was actually given).
function parseConcurrencyValue(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

export function classifyCliArgs(argv) {
  if (argv.some((a) => a === "--help" || a === "-h")) return { mode: "help" };
  const unrecognized = argv.filter(
    (a) => !KNOWN_CLI_FLAGS.has(a) && !KNOWN_CLI_VALUE_PREFIXES.some((p) => a.startsWith(p)),
  );
  const concurrencyRaw = parseValueFlag(argv, "--concurrency=");
  const concurrency = concurrencyRaw === undefined ? null : parseConcurrencyValue(concurrencyRaw);
  if (concurrencyRaw !== undefined && Number.isNaN(concurrency)) {
    // A recognized flag with an unusable value is exactly as dangerous as an unrecognized one (card
    // 05724a32's own point) — name the whole token so the reader sees exactly what was rejected.
    unrecognized.push(`--concurrency=${concurrencyRaw} (must be a positive integer)`);
  }

  const onlyRaw = parseValueFlag(argv, "--only=");
  const excludeRaw = parseValueFlag(argv, "--exclude=");
  const wantsCodexOnly = argv.includes("--codex-real-spawn");
  const wantsCodexExclude = argv.includes("--no-codex-real-spawn");
  // Card ce02e7e5: fail loudly on an ambiguous combination rather than silently picking a winner — same
  // "a recognized token can still be rejected" posture as the --concurrency= value check above.
  if (wantsCodexOnly && wantsCodexExclude) {
    unrecognized.push("--codex-real-spawn and --no-codex-real-spawn (mutually exclusive)");
  } else if ((wantsCodexOnly || wantsCodexExclude) && (onlyRaw !== undefined || excludeRaw !== undefined)) {
    unrecognized.push("--codex-real-spawn/--no-codex-real-spawn cannot be combined with --only=/--exclude=");
  }
  if (unrecognized.length) return { mode: "error", unrecognized };

  const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const exclude = excludeRaw ? excludeRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  return {
    mode: (argv.includes("--count") || argv.includes("--list")) ? "count" : "run",
    only,
    exclude,
    concurrency,
    // Card ce02e7e5: "only" | "exclude" | null — resolved against the REAL CODEX_REAL_SPAWN_BASENAMES
    // array by `resolveSelectionForCliMode` below, never hardcoded here (this classifier stays pure/sync
    // and has no access to that array — see that function's own doc for why).
    codexRealSpawnPreset: wantsCodexOnly ? "only" : wantsCodexExclude ? "exclude" : null,
  };
}

// Card 6185fbfc: resolve the actual RUN SET from the discovered `hermetic` list plus an optional
// --only=/--exclude= selection. Pure + exported so a test can exercise every combination directly,
// never by spawning this whole script (which for "no selection" would nest a full suite run inside a
// test — the same reasoning `classifyCliArgs`/`discoverHermeticTests` already established). Returns
// `{ selected, error }` — `error` is a human-readable refusal reason (an --only/--exclude name that
// isn't in `hermetic`, or a selection that empties the run set to zero) with `selected: null` in that
// case; this function never calls `process.exit` itself, so a test can assert the refusal reason
// without spawning a subprocess. When neither `only` nor `exclude` is given, `selected` is the SAME
// array reference as `hermetic` (not a copy) — the caller uses that reference equality to decide
// whether to print a "selection active" line, so the default (no-argv) path never gains one.
export function resolveSelection(hermetic, { only, exclude } = {}) {
  const hermeticSet = new Set(hermetic);
  let selected = hermetic;
  if (only) {
    const unknown = only.filter((name) => !hermeticSet.has(name));
    if (unknown.length) {
      return { selected: null, error: `--only names ${unknown.length} file(s) not in the discovered hermetic set: ${unknown.join(", ")}` };
    }
    selected = only;
  }
  if (exclude) {
    const unknown = exclude.filter((name) => !hermeticSet.has(name));
    if (unknown.length) {
      // A typo'd --exclude name would otherwise silently fail to exclude anything — exactly the class
      // of silent-coverage bug this gate exists to prevent elsewhere (DISCOVERY_VIOLATIONS etc.).
      return { selected: null, error: `--exclude names ${unknown.length} file(s) not in the discovered hermetic set: ${unknown.join(", ")}` };
    }
    const excludeSet = new Set(exclude);
    selected = selected.filter((name) => !excludeSet.has(name));
  }
  if (selected.length === 0) {
    return { selected: null, error: "--only/--exclude selected ZERO tests — refusing to report a green run that ran nothing" };
  }
  return { selected, error: null };
}

// Card ce02e7e5: resolves `cliMode` (from `classifyCliArgs` above) into the actual `resolveSelection`
// call, applying the `--codex-real-spawn`/`--no-codex-real-spawn` presets when set. `codexRealSpawnBasenames`
// is an explicit PARAMETER — never closed over a module-level constant — which is what makes a preset
// PROVABLY read the array rather than a re-hardcoded copy: a test can pass a synthetic array (with a
// planted fake member) and observe the resulting selection change accordingly, without spawning this
// script or touching the real `test/_codex-real-spawn-lock.mjs`. The real caller (isMain, below) passes
// the REAL, dynamically-imported `CODEX_REAL_SPAWN_BASENAMES`.
// `--codex-real-spawn` is exactly `--only=<codexRealSpawnBasenames>`; `--no-codex-real-spawn` is exactly
// `--exclude=<codexRealSpawnBasenames>` — so `resolveSelection`'s own unknown-name/empty-selection
// refusals (card 6185fbfc) apply unchanged: a `codexRealSpawnBasenames` entry that isn't in `hermetic`
// (e.g. a lock-file basename with no matching test/ file) is refused loudly, exactly like a typo'd --only=.
export function resolveSelectionForCliMode(hermetic, cliMode, codexRealSpawnBasenames) {
  if (cliMode.codexRealSpawnPreset === "only") {
    return resolveSelection(hermetic, { only: codexRealSpawnBasenames });
  }
  if (cliMode.codexRealSpawnPreset === "exclude") {
    return resolveSelection(hermetic, { exclude: codexRealSpawnBasenames });
  }
  return resolveSelection(hermetic, { only: cliMode.only, exclude: cliMode.exclude });
}

// @decision e6e55f7a — this samples/prints whole-run peak-RSS + max inter-event gap (own process
// tree, own labeled scope) so it's never hand-reconstructed again; observation-only, zero behavior change.
// @decision f1043732 — RUNNER-ONLY RSS scope is permanent: whole-tree via IPC was implemented then
// REVERTED (crashes via node-pty#952's ConPTY kill race) — do not re-attempt by excluding files by name.
//
// `readRssBytes` is injectable so a hermetic test can drive this with synthetic readings instead of
// asserting real, non-deterministic process memory.
export function createRssTracker(readRssBytes = () => process.memoryUsage().rss) {
  let sampleCount = 0;
  let floorBytes = 0;
  return {
    sample() {
      sampleCount++;
      const rss = readRssBytes();
      if (rss > floorBytes) floorBytes = rss;
      return rss;
    },
    sampleCount: () => sampleCount,
    floorBytes: () => floorBytes,
  };
}

// Max gap between successive entries of a timestamp series (ms, same unit as `performance.now()`) —
// DESCRIPTIVE ONLY (card b6ab2521, retiring `f1043732`'s original stall-detector framing): a genuinely
// HUNG long-running unit and a HEALTHY long-running unit produce the IDENTICAL reading, because this
// measures gaps between COMPLETION events and a hang-in-progress emits none — so this number can never
// discriminate the failure case from the healthy one, and no threshold derived from it is a stall verdict
// or a safety margin, however superficially it resembles the liveness notion `GATE_EXTEND_IDLE_MS`
// reasons about. See `formatMaxGapLine` for the caveat as it must appear IN the output itself, not just
// here. Fewer than 2 timestamps means there's no gap to measure yet — 0, not NaN or a thrown error.
export function maxGapMs(timestamps) {
  if (timestamps.length < 2) return 0;
  let max = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > max) max = gap;
  }
  return Math.round(max);
}

// Both formatters are exported so a test can assert the qualifier wording survives verbatim — a sampled
// max that reads like a measured peak is exactly the kind of number this project has been burned by
// (see the card): "highest OBSERVED, not a proven peak", the sample count + interval, and the scope
// (runner process only, not the full tree) all belong IN the line, not in a caveat someone can truncate
// away. `partial` (manager follow-up to the card) marks a number captured on the CRASH path — the harness
// itself died before the run completed normally, so sampling stopped early and the true floor/gap may be
// higher than what was actually observed. A crash-path number must never read identically to a clean-path
// one — a lower-confidence max deserves its own, visibly different label, not the same line reused.
// `formatMaxGapLine` additionally (card b6ab2521) bakes an UNDETERMINED verdict into the line itself — a
// reader who only sees this one line, with no access to this comment or any doc, must still be told the
// number cannot support a stall verdict or a margin. "Prefer UNDETERMINED to a wrong reason," implemented
// in the instrument, not left to a caveat elsewhere that a reader can skip.
export function formatRssFloorLine(sampleCount, intervalMs, floorBytes, { partial = false } = {}) {
  const mb = floorBytes / (1024 * 1024);
  const partialNote = partial
    ? " — PARTIAL: sampling stopped before the run completed normally (the harness exited early); the true floor may be higher than this observed value"
    : "";
  return `# RSS FLOOR — highest OBSERVED, not a proven peak (runner process only, not the full test-child ` +
    `tree — no cheap, reliable cross-platform way to sum spawned test-child RSS without an added ` +
    `subprocess; ${sampleCount} sample(s) @ ${intervalMs}ms): ${mb.toFixed(2)} MB${partialNote}`;
}

export function formatMaxGapLine(gapMs, { partial = false } = {}) {
  const partialNote = partial
    ? " — PARTIAL: the run did not complete normally; a larger gap may have occurred after sampling stopped"
    : "";
  return `# max inter-event gap — UNDETERMINED, NOT a stall verdict or margin (${gapMs}ms observed between ` +
    `completions): a HUNG long-running unit and a HEALTHY long-running unit produce this IDENTICAL reading, ` +
    `so no threshold on this number can tell them apart; descriptive run-shape diagnostic only${partialNote}`;
}

// @decision e6e55f7a — a harness crash mid-run is the most opaque rejection mode this instrument
// exists to illuminate; on failure this prints BOTH lines (labelled `partial: true`) then RETHROWS
// THE SAME ERROR UNCHANGED — never swallowed, never a different exit code.
// `runFn` does the actual test-running work; `log` is injectable so a hermetic test can capture output
// instead of asserting against real console.log side effects.
// @decision a496166a — `onSample` is an OPTIONAL, ADDITIVE hook on the SAME RSS-sample timer tick;
// defaults to a no-op so every existing call site stays byte-identical.
export async function runInstrumentedSuite(runFn, { sampleIntervalMs = 5000, log = console.log, onSample = () => {} } = {}) {
  const rssTracker = createRssTracker();
  const completionTimestamps = [performance.now()];
  rssTracker.sample();
  onSample();
  const timer = setInterval(() => { rssTracker.sample(); onSample(); }, sampleIntervalMs);
  timer.unref?.();
  try {
    await runFn(completionTimestamps);
  } catch (err) {
    clearInterval(timer);
    log(formatRssFloorLine(rssTracker.sampleCount(), sampleIntervalMs, rssTracker.floorBytes(), { partial: true }));
    log(formatMaxGapLine(maxGapMs(completionTimestamps), { partial: true }));
    throw err;
  }
  clearInterval(timer);
  return { rssTracker, completionTimestamps };
}

const { hermetic: HERMETIC, violations: DISCOVERY_VIOLATIONS, notHermeticNames: NOT_HERMETIC_NAMES } = discoverHermeticTests(TEST_DIR);

// Ceiling — unchanged. `LOOM_GATE_TEST_CONCURRENCY` may still dial UP to this on a host known to take it.
const MAX_CONCURRENCY = 8;
// @decision 301d8c01 — never fall back to `os.availableParallelism()` on an unset env; that spiked
// this to MAX_CONCURRENCY unbounded and starved the self-hosting Codescape service once already.
// @decision ba3c9580 — reads `LOOM_GATE_TEST_CONCURRENCY`, a Loom-project-qualified name, never the
// old generic `LOOM_TEST_CONCURRENCY` (injected into every project's gate child regardless of project).
// @decision 2ff32b5c — DO NOT raise past 3 without re-deciding: 4 lanes puts the worst-case product
// (maxConcurrentGates x lanes) at 8 processes, exactly the level that starved Codescape on 2026-07-15.
const DEFAULT_CONCURRENCY = 3;
const POOL_SIZE = Math.max(
  1,
  Math.min(
    Number(process.env.LOOM_GATE_TEST_CONCURRENCY) || DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  ),
);

const TEST_TIMEOUT_MS = 120_000;
// @decision cc595ca7 — do not raise the blanket TEST_TIMEOUT_MS for the handful of git-heavy
// merge/lock tests; use a small per-test override map instead (dulls fast-fail for ~296 unrelated
// hermetic tests otherwise) — a real hang is still killed+reported regardless of ceiling value.
// @decision 6436bd5a — gate-timeout-circuit-breaker's cost is real confirmWorkerMerge/
// createWorktree/commits across its 8 blocks, not a hang; measured ~50-52s standalone, 3/3 runs.
// @decision 2bb7a114 — merge-gate-reuse is the HEAVIEST of this family by git-work volume and the
// one that actually rejected a real production merge gate with `exit timeout`; measured up to 130s
// standalone (7 runs), already past the blanket ceiling alone, before any gate contention.
// @decision 63bdd2cc — merge-confirm-completion-nudge no longer needs an override: its sync-wait
// budget is now injectable (0faaaa55's DI seam) so real gate waits only need to outlive a shrunk
// budget; measured 3/3 standalone: 33.5-33.8s, ~3.5x under the 120s blanket ceiling.
const TEST_TIMEOUT_OVERRIDES = {
  "merge-repo-mutex": 300_000, // 15 trials x 2 concurrent real merges + a full content-integrity sweep
  "merge-stranded-backstop": 300_000, // 2x createWorktree + reviewWorkerMerge/confirmWorkerMerge, all real git
  "gate-timeout-circuit-breaker": 300_000, // measured ~50-52s standalone (3 runs); ~6x headroom for 8 blocks x real union-merges/createWorktree/commits under concurrent gate contention
  "merge-gate-reuse": 360_000, // measured 52-58s x6 + one 130s outlier (7 standalone runs, quiet host); heaviest of these by git+merge-call volume and the one that actually timed out in production (card 2bb7a114) — ~6.7x the steady median / ~2.8x the observed outlier
  "merge-canonical-dirty-overlap-backstop": 300_000, // card 4b7ff996, Code Review follow-up: 1x Db/SessionService boot, 4x createWorktree + 2 real submodule clones across 6 scenarios (A/E/S/U/D/G); measured 16.8s standalone (quiet host) — well under the blanket ceiling on its own. Carries this override for consistency with merge-stranded-backstop's DEMONSTRATED near-cap risk (comparable real-git-subprocess volume — both are in the ISOLATED_REAL_SPAWN_BASENAMES classification below), not a risk measured for this file itself: a proactive buffer, not a mechanism. That classification is ONLY consumed by the sequential isolation phase (ISOLATED_REAL_SPAWN_PHASE_ENABLED below), which is opt-in and default OFF, so membership in it confers no runtime scheduling protection today — this override applies unconditionally either way.
  "merge-canonical-untracked-overlap-backstop": 300_000, // card 98d6264d, sibling of merge-canonical-dirty-overlap-backstop above: 1x Db/SessionService boot, 4x createWorktree across 5 scenarios (A/B/U/I/C); measured 12.6s standalone (quiet host) — well under the blanket ceiling on its own. Carries this override for the same reason as its sibling above: consistency with the real-git-subprocess-heavy classification (ISOLATED_REAL_SPAWN_BASENAMES below), not a risk measured for this file itself — and that classification triggers no runtime scheduling on its own, since the sequential isolation phase it feeds (ISOLATED_REAL_SPAWN_PHASE_ENABLED below) is opt-in and default OFF; this override applies unconditionally regardless of that flag.
  "merge-gate-inert-diff": 300_000, // cards e5a75b65/55ea3b32: already in ISOLATED_REAL_SPAWN_BASENAMES below ("11x Db/SessionService boot, 15x real createWorktree") but was the ONLY member of that class with no override, running on the blanket 120s ceiling. Per-file history (~/.loom/gate-timing/daemon-per-file-timing.ndjson), n=15: 14 passes at 71,229-85,432ms (median 75,189ms, max 85,432ms) and 1 fail SIGTERM-killed AT the 120,000ms ceiling (censored — true cost unknown, bounded only from below, not a duration). Margin at the observed max pass vs the 120s ceiling: 1.40x. A same-window sibling gate ran this file concurrently and PASSED at 82,476ms, refuting concurrent load as the discriminating cause (present in both the failing and a passing run) — the honest attribution is a thin margin plus ordinary variance, not a race. 300k gives 3.51x margin at the observed max, matching the proactive-buffer posture already granted to merge-canonical-dirty-overlap-backstop/merge-canonical-untracked-overlap-backstop above (measured 16.8s/12.6s standalone).
  // @decision 3791b14e — this override must stay numerically ABOVE codex-doctrine-real-spawn.mjs's
  // own largest internal waitUntil timeout (currently 150_000ms, widened from 90s per card
  // 887e10b8) — an outer ceiling below an inner wait can never let that wait mature.
  "codex-doctrine-real-spawn": 300_000,
};

// @decision 0f0816e2 — this JUDGMENT-CURATED set of real-spawn/daemon-boot-heavy basenames runs FIRST and
// SEQUENTIALLY (pool size 1) before the remainder runs in the existing concurrent pool, unchanged; it does
// not itself prove or fix the intermittent full-suite hang it targets — full reasoning in the record.
//
// Membership is curated by reading each file, never derived by a `*real*`/`*gate*` name-pattern grep —
// same discipline as STATIC_GUARD_REPO_PATHS (git/worktrees.ts), for the same reason. See the record for
// the full per-basename grep-count accounting (every measured number kept there) and the
// test-daemon-gate-timing-sigkill.mjs export-driven incident this list caused when merge-repo-mutex moved
// into it. merge-canonical-dirty-overlap-backstop/merge-canonical-untracked-overlap-backstop (cards
// 4b7ff996/98d6264d) are members here for the same real-git-subprocess-volume reasoning; the production
// preflight mechanisms each exercises are those cards' own decisions against git/worktrees.ts, not this one.
//
// Exported (not module-local): test-daemon-gate-timing-sigkill.mjs asserts its own FAST/SLOW basenames
// land in the SAME phase against this exact set at import time — do not stop exporting it, or drop this
// list's discipline for a name-pattern shortcut; see the record for the incident that made this necessary.
export const ISOLATED_REAL_SPAWN_BASENAMES = [
  "kickoff-real-spawn",
  "merge-gate-inert-diff",
  "emit-compare-gate",
  "gate-status",
  "merge-confirm-completion-nudge",
  "merge-spawn-tracked",
  "gate-timeout-circuit-breaker",
  "merge-repo-mutex",
  "merge-stranded-backstop",
  "merge-gate-reuse",
  "merge-canonical-dirty-overlap-backstop",
  "merge-canonical-untracked-overlap-backstop",
];
export const ISOLATED_REAL_SPAWN_SET = new Set(ISOLATED_REAL_SPAWN_BASENAMES);
// Fixed at 1, deliberately NOT an env-tunable dial — out of scope per the card: this changes scheduling
// SHAPE, not the concurrency BUDGET (LOOM_GATE_TEST_CONCURRENCY/DEFAULT_CONCURRENCY/MAX_CONCURRENCY, all
// unchanged by this card).
const ISOLATED_PHASE_POOL_SIZE = 1;

// @decision 0f0816e2 — this CR follow-up (Loom lead direction, 2026-08-28) is OPT-IN, default OFF: a
// measured wall-clock tax (+229.4s/+117% on a 10-file subset; est. +230-285s embedded in the real gate) for
// a benefit this card's own DoD-4 forbids claiming, so it must never default on or be flipped via config.
//
// See the record for the full measurement (before/after, aggregate vs. wall-clock) and the staleness note:
// this estimate was taken against a 10-file list and the membership list is 12 today, so enabling now
// costs MORE than quoted. LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE=1 opts in deliberately (e.g. a DoD-5
// timeout-rate observation) — never via the gate command or a daemon config pin (same posture as
// `gate-cap-is-2-by-owner-decision-never-change-silently`). Flag off ⇒ isolatedPhaseFileCount/
// isolatedPhasePoolSize on the NDJSON rows both read 0 — a flat run's honest signal, not a fabricated "1".
const ISOLATED_REAL_SPAWN_PHASE_ENABLED = process.env.LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE === "1";

// Card 3791b14e: the real-codex-spawn family (CODEX_REAL_SPAWN_BASENAMES, imported above from
// `_codex-real-spawn-lock.mjs` — the single source of truth for membership) is scheduled sequentially,
// ALWAYS-ON, pool size 1 — deliberately SEPARATE from ISOLATED_REAL_SPAWN_PHASE_ENABLED just above: it is
// never gated by that flag, never reads it, and runs this way regardless of its value. That flag is a
// different, larger, owner-approved opt-in cost tradeoff for a different file set (see its own doc above
// for the measured +24-30% per-gate cost); this grouping is unconditional because the alternative —
// sizing `_codex-real-spawn-lock.mjs`'s own wait budget to cover N-1 concurrently-running real `codex`
// processes — is what went stale the moment a 3rd/4th contender was added (that card's own root cause).
// Making the scheduler itself serialize this family turns that lock into a pure backstop instead of the
// primary means of exclusion. Fixed at 1 for the same reason ISOLATED_PHASE_POOL_SIZE is fixed above:
// this changes scheduling SHAPE for a specific, named, small file set, not the general concurrency budget.
const CODEX_REAL_SPAWN_PHASE_POOL_SIZE = 1;

const tmpRoots = [];

// Card e26f3199: on a timeout the harness used to report `status: "timeout"` and DISCARD the child's
// real exit status — so "the child completed successfully and 'close' merely arrived late" (mechanism A:
// a grandchild that inherited the stdio pipe kept it open after the child itself was long gone — Node
// fires 'exit' the moment the process terminates, but 'close' only once every stdio stream referencing
// that pipe is closed) was indistinguishable from "genuinely wedged, killed, and never exited" (mechanism
// B). `exitAt`/`timeoutFiredAt` are the discriminator, MEASURED rather than argued: if the child's own
// 'exit' fired before the timer ever called `child.kill()`, nothing here was actually killed — something
// downstream just kept the pipe open.
//
// Pure classifier so a test can drive every combination directly. Never guesses: `exitAt: null` (the
// child's own 'exit' was never observed at all, e.g. it's still genuinely running when 'close' somehow
// fires, or the process truly never exited) is reported as "killed, never exited", not a fabricated exit.
export function describeTimeoutDetail({ exitAt, exitStatus, exitSignal, timeoutFiredAt }) {
  if (exitAt !== null && timeoutFiredAt !== null && exitAt <= timeoutFiredAt) {
    return exitSignal ? `child had already exited via signal ${exitSignal}` : `child had already exited ${exitStatus}`;
  }
  if (exitAt !== null) {
    return exitSignal ? `killed (exited via signal ${exitSignal} after kill)` : `killed (exited ${exitStatus} after kill)`;
  }
  return "killed, never exited";
}

// Card e26f3199: the actual spawn/timeout/exit/close wiring, factored out of `runOne` so a test can drive
// it directly against a purpose-built fixture without duplicating this logic or spawning the whole gate.
// Never rejects — a spawn error is captured as a failure, same posture as before this card. `env`
// defaults to node's own `spawn` default (`process.env`) when omitted, same as passing nothing at all.
export function spawnWithTimeout(execPath, argv, { timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutFiredAt = null;
    let exitStatus = null;
    let exitSignal = null;
    let exitAt = null;

    const child = spawn(execPath, argv, { env });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => { timedOut = true; timeoutFiredAt = Date.now(); child.kill(); }, timeoutMs);

    // Node fires 'exit' the instant the process itself terminates — always before 'close' — so this is
    // the child's REAL exit, captured regardless of whether a timeout ever happens.
    child.on("exit", (status, signal) => {
      exitStatus = status;
      exitSignal = signal;
      exitAt = Date.now();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false, status: null, stdout, stderr: `${stderr}\n${err.message}`,
        timedOut, exitAt, exitStatus, exitSignal, timeoutFiredAt, closeAt: null,
        exitToCloseGapMs: null, timeoutDetail: null, errored: true,
      });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      const closeAt = Date.now();
      resolve({
        ok: !timedOut && status === 0,
        status: timedOut ? "timeout" : status,
        stdout, stderr,
        timedOut, exitAt, exitStatus, exitSignal, timeoutFiredAt, closeAt,
        exitToCloseGapMs: exitAt !== null ? closeAt - exitAt : null,
        timeoutDetail: timedOut ? describeTimeoutDetail({ exitAt, exitStatus, exitSignal, timeoutFiredAt }) : null,
        errored: false,
      });
    });
  });
}

// Card 237aa3a9: per-row bounds for `failureDetail.messages` — a STORAGE bound (this file is appended to
// on every file of every gate run, ~777 rows/run today), not a threshold statistic, so unlike a fixed-ms
// timeout constant it does not rot against the suite's own growth (per the peer's design-input (a): only
// take that shape when a value is compared against a fixed threshold to make a judgement — a storage cap
// makes no judgement, it just bounds bytes). Two independent caps — message COUNT (so many small failures
// don't crowd out the earliest ones) and total CHARS (so one very long message can't blow the budget alone)
// — either tripping sets `truncated: true`, explicit and never silent (DoD-3's own requirement: a silent
// truncation would re-create the exact defect this card fixes).
const FAILURE_DETAIL_MAX_MESSAGES = 20;
const FAILURE_DETAIL_MAX_CHARS = 4000;
// CR follow-up (manager review of cad5d5d6, mixed-case question): a much smaller secondary bound for the
// `stderrExcerpt` a mixed assertionFailed+testThrew failure carries alongside its FAIL messages (see
// `classifyFailureDetail` below) — a supplementary excerpt, not the primary diagnostic, so it does not
// need anywhere near the same budget as `messages` itself.
const FAILURE_DETAIL_STDERR_EXCERPT_MAX_MESSAGES = 5;
const FAILURE_DETAIL_STDERR_EXCERPT_MAX_CHARS = 800;

// Applies the two bounds above to an ordered list of candidate message lines, reporting whether either
// bound actually cut anything. Pure so DoD-3's truncation behavior is directly testable against synthetic
// input, independent of any real subprocess.
//
// CR follow-up (manager review of cad5d5d6): a FIRST line alone longer than FAILURE_DETAIL_MAX_CHARS used
// to trip the char bound on iteration one and return `messages: []` — `truncated: true` satisfied DoD-3's
// LETTER (the bound really was marked) but broke the card's own stated property ("a reader can name the
// failing assertion(s) from one read") — a reader got a bucket and nothing else, on exactly the failure
// mode (one huge stack trace) where the message matters most. Now: when the FIRST message alone would
// overflow the remaining budget, push a budget-sized PREFIX of it rather than leaving `messages` empty —
// a clipped stack head beats nothing. This only applies while `messages` is still empty; a line that
// overflows the budget after at least one full message has already been captured still just stops there
// (that first message is real, useful content — no reason to also clip a second, partial one onto it).
function boundMessageList(lines, maxMessages, maxChars) {
  let truncated = lines.length > maxMessages;
  const capped = lines.slice(0, maxMessages);
  const messages = [];
  let chars = 0;
  for (const line of capped) {
    const remaining = maxChars - chars;
    if (remaining <= 0) { truncated = true; break; }
    if (line.length > remaining) {
      truncated = true;
      if (messages.length === 0) messages.push(line.slice(0, remaining));
      break;
    }
    messages.push(line);
    chars += line.length;
  }
  return { messages, truncated };
}

function boundFailureMessages(failureType, lines) {
  const { messages, truncated } = boundMessageList(lines, FAILURE_DETAIL_MAX_MESSAGES, FAILURE_DETAIL_MAX_CHARS);
  return { failureType, messages, truncated };
}

// @decision 14e733fb — this epilogue's writeFullySync loop MUST keep writing until every byte is
// confirmed out (never assume one fs.writeSync call drains the buffer): a POSIX process.exit() can tear
// the process down mid-async-pipe-write and silently drop this file's own multi-line FAILURES: diagnostic.
const TEST_FORCE_WRITE_CHUNK_BYTES = process.env.LOOM_TEST_FORCE_WRITE_CHUNK_BYTES
  ? Math.max(1, Number(process.env.LOOM_TEST_FORCE_WRITE_CHUNK_BYTES))
  : undefined;
// @decision 14e733fb — bound the EAGAIN/zero-byte retry by ELAPSED TIME, never iteration count: an
// unbounded spin against a non-blocking fd whose reader never drains would hang the gate's own FAILURE
// path forever in a shared lane (commit 53175055's own prior "rare but unbounded wait" hazard here).
const WRITE_FULLY_SYNC_DEADLINE_MS = 5_000;
function writeFullySync(fd, text) {
  const buf = Buffer.from(text, "utf-8");
  const deadline = Date.now() + WRITE_FULLY_SYNC_DEADLINE_MS;
  let offset = 0;
  while (offset < buf.length) {
    // Give up and keep whatever's already written — partial output is the PRE-EXISTING failure mode this
    // function replaces (a lost tail), strictly better than a hang; a throw here would lose the WHOLE
    // block instead of just the unwritten remainder.
    if (Date.now() >= deadline) break;
    const remaining = buf.length - offset;
    const len = TEST_FORCE_WRITE_CHUNK_BYTES ? Math.min(remaining, TEST_FORCE_WRITE_CHUNK_BYTES) : remaining;
    try {
      const written = fs.writeSync(fd, buf, offset, len);
      if (written === 0) continue; // degenerate zero-byte write — retry, bounded by the SAME deadline above
      offset += written;
    } catch (err) {
      if (err.code === "EAGAIN") continue; // fd not ready yet — retry, bounded by the SAME deadline above
      throw err;
    }
  }
}

// @decision sha:cad5d5d6 — four honest buckets, never a fifth: "assertionFailed" stays the PRIMARY signal
// even when a file ALSO throws uncaught after a failed check() — attach a bounded `stderrExcerpt`
// alongside it instead (present only when both FAIL lines and stderr exist), never reclassify or drop it.
//   "timeout"        — already fully named by `timeoutDetail` elsewhere on the row; this just labels it.
//   "assertionFailed" — this project's own `check(label, cond)` helper prints "FAIL  <label>" to stdout for
//                       every false assertion; pulling every such line names EVERY distinct failing
//                       assertion in one read of this row.
//   "testThrew"       — no FAIL line at all, but the process still exited nonzero and produced stderr: the
//                       file's own code threw/rejected (an uncaught exception, a rejected promise, a syntax
//                       error) rather than a false assertion. Node prints the thrown error's message + top
//                       stack frames to stderr, which is what actually named the peer's root cause.
//   "unclassified"    — nonzero exit, no FAIL line, no stderr at all: genuinely nothing to classify from.
export function classifyFailureDetail({ status, stdout, stderr }) {
  if (status === "timeout") return { failureType: "timeout", messages: [], truncated: false };

  const failLines = (stdout ?? "").split("\n")
    .filter((l) => /^FAIL\s\s/.test(l))
    .map((l) => l.replace(/^FAIL\s\s/, "").trim());
  const stderrLines = (stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  if (failLines.length) {
    const result = boundFailureMessages("assertionFailed", failLines);
    if (stderrLines.length) {
      const excerpt = boundMessageList(stderrLines, FAILURE_DETAIL_STDERR_EXCERPT_MAX_MESSAGES, FAILURE_DETAIL_STDERR_EXCERPT_MAX_CHARS);
      result.stderrExcerpt = excerpt.messages;
      if (excerpt.truncated) result.truncated = true;
    }
    return result;
  }

  if (stderrLines.length) return boundFailureMessages("testThrew", stderrLines);

  return { failureType: "unclassified", messages: [], truncated: false };
}

// The single line of a failing run's OWN stdout/stderr worth surfacing inline on its `FAILURES:` bullet
// line. Extracted to its own pure function (card 5e3ebc80) so a test can drive it — and the epilogue
// renderer below that consumes its output — directly against a REAL `spawnWithTimeout` result, without
// re-deriving this formula a second time and risking the two copies drifting apart.
export function computeFailureTail(stdout, stderr) {
  return stdout.split("\n").filter(Boolean).slice(-1)[0] || stderr.split("\n").filter(Boolean).slice(-1)[0];
}

// Card 5e3ebc80: names WHAT KIND of nonzero termination a failing run had — a numeric exit code, an
// OS signal, or (rare) neither ever observed — so a reader of the `FAILURES:` epilogue doesn't have to
// re-derive it from `f.status`/`f.signal` by hand. Only actually printed on the zero-output branch below
// (see `buildFailureEntryLines`): the bullet line above it already shows a numeric exit code, so this
// would be pure noise there; it earns its place only where there's no captured output to show instead.
export function describeExitShape(f) {
  if (f.status === "timeout") return "timeout";
  if (typeof f.status === "number") return `exit code ${f.status}`;
  if (f.signal) return `signal ${f.signal}`;
  return "exit code null (no signal captured either)";
}

// Card 5e3ebc80: builds the `FAILURES:` epilogue lines for ONE failing run. Pure + exported so a test can
// drive it directly (including with a REAL spawnWithTimeout result reshaped into this row) without running
// the whole hermetic suite. Every non-empty-output branch is byte-identical to the code this replaced —
// the ONLY new behaviour is the explicit marker on the branch where both streams are empty/whitespace-only:
// before this card that branch emitted NOTHING, so "the child genuinely produced no output" and "we failed
// to capture the output it produced" were the same bytes on the page (see this card for the full incident).
export function buildFailureEntryLines(f) {
  const statusLabel = f.status === "timeout" && f.timeoutDetail ? `timeout (${f.timeoutDetail})` : f.status;
  const lines = [`  - ${f.name} (exit ${statusLabel}): ${f.tail ?? ""}`];
  if (f.status === "timeout") {
    lines.push(`      exit->close gap: ${f.exitToCloseGapMs != null ? `${f.exitToCloseGapMs}ms` : "n/a (child's own exit was never observed)"}`);
  }
  const hasStdout = !!f.stdout?.trim();
  const hasStderr = !!f.stderr?.trim();
  if (hasStdout) lines.push(f.stdout.trimEnd().split("\n").map((l) => `      ${l}`).join("\n"));
  if (hasStderr) lines.push(f.stderr.trimEnd().split("\n").map((l) => `      ${l}`).join("\n"));
  if (!hasStdout && !hasStderr) {
    lines.push(`      (no output captured on either stream — ${describeExitShape(f)})`);
  }
  return lines;
}

// Runs one test file on a fixed pool "lane" (its port for the whole run, so concurrent lanes never
// collide). Resolves to a result record; never rejects — a spawn error is captured as a failure.
async function runOne(name, lane) {
  const file = path.join(TEST_DIR, `${name}.mjs`);
  if (!fs.existsSync(file)) return { name, ok: true, skipped: true };

  const home = fs.mkdtempSync(path.join(os.tmpdir(), `loom-td-${name}-`));
  tmpRoots.push(home);
  // Card fa52f555: this is safe WITHIN one invocation of this script (POOL_SIZE lanes, POOL_SIZE
  // distinct ports) but NOT across two CONCURRENT invocations — e.g. two merge gates admitted at once
  // under `maxConcurrentGates` >= 2 — since each independently computes the same `4400 + lane` values.
  // Checked (census card d39db2db): not currently reachable, because no hermetic test binds a real
  // listener on this assigned port (all either use in-memory `.inject()` or an unrelated ephemeral
  // `:0` bind) — but that is a property of today's test files, not a guarantee this scheme provides.
  const port = 4400 + lane;

  // Card 17069e7e: Date.now() (not performance.now()) to match the existing NDJSON schema's
  // startTs/endTs, which the standalone investigation script (test/census/lib.mjs's `runOneTimed`)
  // already stamps this same way.
  const startTs = Date.now();
  const timeoutMs = TEST_TIMEOUT_OVERRIDES[name] ?? TEST_TIMEOUT_MS;
  const r = await spawnWithTimeout(process.execPath, [file], {
    timeoutMs,
    // Card d1e10795: LOOM_REAL_HOME carries the harness's own (real) LOOM_HOME through to the spawned
    // child ADDITIVELY — LOOM_HOME itself stays overridden to `home` (the per-test throwaway temp dir,
    // load-bearing hermetic isolation, unchanged). A test file that writes its OWN diagnostic telemetry
    // (mirroring this script's own appendGateTimingRow/GATE_TIMING_NDJSON pattern) needs the REAL home,
    // not the isolated one, to produce anything durable — see memory
    // `instrument-inside-test-reads-isolated-loom-home` for the bug this closes.
    env: { ...process.env, LOOM_HOME: home, LOOM_REAL_HOME: LOOM_HOME, LOOM_PORT: String(port), LOOM_TEST: "1" },
  });
  const endTs = Date.now();

  if (r.errored) {
    // Byte-identical shape to before this card: a spawn error never carried a `tail` or the
    // exit/close instrumentation fields (they're meaningless when the child never even started).
    // Card 237aa3a9: `failureDetail` IS added here, unlike those — the spawn-error message (captured onto
    // `r.stderr` by `spawnWithTimeout`'s own error handler) is the single most useful diagnostic available
    // for exactly this case, not a meaningless one.
    // Card 5e3ebc80: `signal` IS also added here (unlike the fields the first sentence above names) —
    // shape-consistency with the non-errored return below, even though it's always null in this branch
    // (the child never started, so the 'exit' event that would populate it never fired either).
    return {
      name, ok: false, status: r.status, stdout: r.stdout, stderr: r.stderr, signal: r.exitSignal ?? null,
      lane, startTs, endTs, durationMs: endTs - startTs,
      failureDetail: classifyFailureDetail({ status: r.status, stdout: r.stdout, stderr: r.stderr }),
    };
  }
  return {
    name,
    ok: r.ok,
    status: r.status,
    stdout: r.stdout, stderr: r.stderr,
    // Card 5e3ebc80: carried through so the FAILURES: epilogue's zero-output marker can name a signal kill
    // (vs. a numeric exit code) — see `describeExitShape`. `r.exitSignal` is captured off the child's own
    // 'exit' event (spawnWithTimeout), which fires even when a signal, not a numeric code, is why it died.
    signal: r.exitSignal ?? null,
    tail: r.ok ? undefined : computeFailureTail(r.stdout, r.stderr),
    // Card 237aa3a9: `undefined` (never computed) on a pass — JSON.stringify drops the key entirely, so a
    // passing row carries no `failureDetail` key at all (see the module-header doc above for why that
    // matters — key PRESENCE, not a valued-but-false field, is the failure signal).
    failureDetail: r.ok ? undefined : classifyFailureDetail({ status: r.status, stdout: r.stdout, stderr: r.stderr }),
    lane, startTs, endTs, durationMs: endTs - startTs,
    // Card e26f3199 DoD-2: exitAt/closeAt/exitToCloseGapMs are recorded for EVERY completed (non-errored)
    // run — real numbers on a normal pass too, not just a timeout. That's deliberate, not incidental: a
    // pass's own exit->close gap is a free population baseline for how often a grandchild holds the pipe
    // open AT ALL, across the whole suite, on every gate run — data neither the card nor a one-off
    // investigation could otherwise get. `timeoutDetail` alone is genuinely timeout-only (null otherwise —
    // see the FAILURES: printer below, which only reads it when status is "timeout").
    exitAt: r.exitAt, closeAt: r.closeAt, exitToCloseGapMs: r.exitToCloseGapMs, timeoutDetail: r.timeoutDetail,
  };
}

// A fixed number of lanes each pull the next unclaimed test off a shared cursor — bounded concurrency,
// stable per-lane port, and every file still runs to completion regardless of earlier failures.
function makeCursor(length) {
  let next = 0;
  return () => (next < length ? next++ : null);
}

// `gateTimingCtx` ({runIndex, runUid}) is the SAME join key the write-ahead "run-start" row and the
// eventual "run-summary" row share (see the isMain block below) — passed in rather than read from a
// module-level var so a future test can drive this function with a synthetic ctx.
async function runLane(lane, names, nextIndex, results, completionTimestamps, gateTimingCtx) {
  for (let idx = nextIndex(); idx !== null; idx = nextIndex()) {
    const name = names[idx];
    const result = await runOne(name, lane);
    results[idx] = result;
    // Card e6e55f7a: this PASS/FAIL line marks a completion event; `completionTimestamps` records it so
    // the descriptive max-gap line (UNDETERMINED as a stall verdict — see card b6ab2521 and
    // `formatMaxGapLine`) has data to describe. Recorded regardless of pass/fail.
    completionTimestamps.push(performance.now());
    // Card e26f3199: the same "exit timeout (<detail>)" wording the FAILURES: block below uses, so a
    // timeout's real exit status is visible in the live streaming output too, not only the end-of-run
    // summary.
    const statusLabel = result.status === "timeout" && result.timeoutDetail ? `timeout (${result.timeoutDetail})` : result.status;
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `  (exit ${statusLabel})`}`);
    // Card 05056168: flush THIS file's row the moment it completes, rather than batching every row into a
    // loop that only ran after the whole suite finished (the original defect — a SIGKILLed run never
    // reached that loop, so nothing was written even for files that had already completed). Same row shape
    // as before this card. `appendGateTimingRow` itself never throws (see its own doc) — relied on here
    // exactly as the old post-run loop relied on it, with no per-call wrapping.
    appendGateTimingRow(GATE_TIMING_NDJSON, {
      kind: "file",
      runIndex: gateTimingCtx.runIndex,
      runUid: gateTimingCtx.runUid,
      name: result.name,
      startTs: result.startTs ?? null,
      startTsIso: result.startTs != null ? new Date(result.startTs).toISOString() : null,
      endTs: result.endTs ?? null,
      endTsIso: result.endTs != null ? new Date(result.endTs).toISOString() : null,
      durationMs: result.durationMs ?? null,
      ok: result.ok,
      status: result.status ?? null,
      skipped: !!result.skipped,
      lane: result.lane ?? null,
      // Card e26f3199 DoD-1/2: exitAt/closeAt/exitToCloseGapMs are recorded for EVERY completed run — real
      // numbers on a normal PASS too, not just a timeout (that's deliberate: it's a free population
      // baseline for how often a grandchild holds the pipe open at all, across the whole suite, every gate
      // run — data this card couldn't otherwise get). `null` (JSON-present, never omitted) only on the
      // errored path, where the child never even started and there's nothing to measure. `timeoutDetail`
      // alone is genuinely timeout-only (null otherwise), and it's what keeps the discriminator readable
      // even past the merge gate's own bounded ~4KB output tail.
      exitAt: result.exitAt ?? null,
      closeAt: result.closeAt ?? null,
      exitToCloseGapMs: result.exitToCloseGapMs ?? null,
      timeoutDetail: result.timeoutDetail ?? null,
      // Card 237aa3a9: `result.failureDetail` is `undefined` on every passing/skipped row (both `runOne`
      // return paths only compute it when `!ok`) — passed straight through, NEVER defaulted to `null`,
      // so `JSON.stringify` drops the key entirely on a pass and it is only ever PRESENT on a failing row.
      // See the module-header doc above for why that key-presence contract matters.
      failureDetail: result.failureDetail,
    });
  }
}

// Guard the actual run behind a main-module check: an out-of-band harness (test/census/*) needs to
// import this file's NOT_HERMETIC export without ALSO triggering a full 585-test run as a side effect
// of that import — importing a bare top-level script otherwise runs unconditionally. `node
// scripts/test-daemon.mjs` (the real gate entry point) is unaffected by this — argv[1] resolves to this
// same file there, so the guard is true and behavior is unchanged.
//
// This guard is the single highest-blast-radius line in the repo: if it is EVER false on the real gate
// invocation, the merge gate runs ZERO tests and exits 0 — a silent green indistinguishable from a real
// pass, verified only by directly running the real invocation and watching test output appear (neither a
// correct guard nor a totally broken one is otherwise distinguishable — both look like a green gate).
// Two defences: (1) compare RESOLVED REAL paths (`fs.realpathSync.native`), never raw URL strings —
// normalises drive-letter case/8.3 short-name components/symlinks-and-junctions, all concrete ways a
// raw string compare can silently diverge on Windows; (2) a same-basename-but-different-resolved-path
// mismatch fails loudly and
// non-zero, never silently falls through (a genuinely different importer, e.g. the census harness, stays
// silent on purpose).
// @decision b122c7d4 — a THROWN `realpathSync.native` resolution on either side is its own loud failure
// state, never folded into "not main": letting both sides go null would also suppress defence (2)'s
// mismatch branch, a silent skip with no output at all.
function resolveReal(p) {
  try { return { path: fs.realpathSync.native(p), threw: false }; } catch { return { path: null, threw: true }; }
}
const selfResolved = resolveReal(fileURLToPath(import.meta.url));
const argvResolved = process.argv[1] ? resolveReal(process.argv[1]) : { path: null, threw: false };
const selfPath = selfResolved.path;
const argvPath = argvResolved.path;
const isMain = selfPath !== null && argvPath !== null && selfPath === argvPath;
const resolutionThrew = selfResolved.threw || argvResolved.threw;

if (isMain) {
  // Card 05724a32: validate argv FIRST, before any discovery work, and FAIL CLOSED — an unrecognized flag
  // is a hard error, never a warn-then-proceed, because a warning that scrolls past on a run which then
  // takes ~20 minutes is the bug with extra text, not a fix.
  const cliMode = classifyCliArgs(process.argv.slice(2));

  if (cliMode.mode === "help") {
    console.log([
      "Usage: node scripts/test-daemon.mjs [--count | --list | --help]",
      "                                    [--only=name,name] [--exclude=name,name] [--concurrency=N]",
      "                                    [--codex-real-spawn | --no-codex-real-spawn]",
      "",
      "  (no flags)             run the full hermetic daemon suite — this is what the merge gate,",
      "                         package.json's test:daemon, and CI/release all invoke; unaffected by",
      "                         any flag below unless you actually pass one",
      "  --count                print discovery counts only (no tests run)",
      "  --list                 alias for --count",
      "  --only=a,b             run ONLY these discovered hermetic test(s), by bare name",
      "  --exclude=a,b          run every discovered hermetic test EXCEPT these, by bare name",
      "  --concurrency=N        override the pool size for just this invocation (still clamped to",
      "                         the MAX_CONCURRENCY ceiling); LOOM_GATE_TEST_CONCURRENCY still applies",
      "                         when this is omitted",
      "  --codex-real-spawn     run ONLY the codex real-spawn family (CODEX_REAL_SPAWN_BASENAMES —",
      "                         see test/_codex-real-spawn-lock.mjs, the single source of truth for",
      "                         its membership); equivalent to --only=<that list>, but always derived",
      "                         from the array itself, never a hardcoded copy",
      "  --no-codex-real-spawn  run every discovered hermetic test EXCEPT the codex real-spawn family;",
      "                         equivalent to --exclude=<that list>, same array-derived guarantee",
      "                         (mutually exclusive with each other and with --only=/--exclude=)",
      "  --help, -h             print this usage and exit",
    ].join("\n"));
    process.exit(0);
  }
  if (cliMode.mode === "error") {
    console.error(`❌ test-daemon.mjs: unrecognized argument(s): ${cliMode.unrecognized.join(", ")}`);
    console.error(`   Supported flags: ${[...KNOWN_CLI_FLAGS].sort().join(", ")}`);
    console.error("   Refusing to fall through to a full suite run on an unrecognized argument — run with --help for usage.");
    process.exit(1);
  }

  // Card fa52f555 Part 1: a `--count`/`--list` invocation does discovery ONLY — no test spawns — so a
  // manager can read the authoritative number without paying for a full run. Read here, before any of the
  // loud discovery-integrity refusals below, so those refusals also cover this mode (a count computed over
  // a broken discovery state would itself be a lie).
  const countOnly = cliMode.mode === "count";

  if (DISCOVERY_VIOLATIONS.length) {
    // Card b122c7d4's positive-control scenario: a file under test/ that is neither underscore-prefixed
    // nor test-shaped. Refuse loudly and name it, rather than silently spawning it (a false pass) or
    // silently dropping it (a false negative) — either would be indistinguishable from a clean run.
    console.error(`❌ test-daemon.mjs: ${DISCOVERY_VIOLATIONS.length} file(s) under test/ are neither underscore-prefixed helpers nor test-shaped (no check(/assert/throw new Error/process.exit(1) marker) — refusing to silently run or silently drop them:`);
    for (const v of DISCOVERY_VIOLATIONS) console.error(`   - ${v}`);
    console.error("   Rename it with a leading underscore if it's a helper, or give it a real assertion if it's a test.");
    process.exit(1);
  }
  if (HERMETIC.length === 0) {
    // A second, independent silent-green trap: even with isMain correctly true, an empty discovered set
    // (a TEST_DIR/glob bug) would otherwise fall through to "0/0 passed" — indistinguishable from a real
    // green. "Ran nothing" and "everything passed" must never share an exit code.
    console.error("❌ test-daemon.mjs: discovered ZERO hermetic test files — refusing to report a green suite that ran nothing.");
    process.exit(1);
  }

  // Card fa52f555 Part 2: a test-shaped file inside fixtures/ or census/ is structurally invisible to the
  // checks above (they both derive from `walkMjsFiles`, which never descends into an EXCLUDED_DIR_NAMES
  // subtree) — so it runs never and silently. Refuse loudly, naming every undeclared one, before a single
  // test spawns; a legitimately manual/out-of-band file must carry a reasoned marker (see
  // `findExcludedDirTestShapedFiles`'s own doc comment) to be exempted.
  const excludedDirCheck = findExcludedDirTestShapedFiles(TEST_DIR);
  if (excludedDirCheck.violations.length) {
    console.error(`❌ test-daemon.mjs: ${excludedDirCheck.violations.length} test-shaped file(s) under an EXCLUDED_DIR_NAMES subtree (fixtures/, census/) would NEVER run — the discovery walk never descends there, so these are silently dead, not covered by this gate:`);
    for (const v of excludedDirCheck.violations) console.error(`   - ${v}`);
    console.error("   Rename it with a leading underscore if it's a helper, add `// loom:not-a-test: <reason>` if it only trips the heuristic (a lib/stub/fixture, not a real test), or `// loom:gate-exempt: <reason>` if it's a real test deliberately run manually / out of band. A marker with no reason does not count.");
    process.exit(1);
  }
  // Card 12bdea9e's reasoning applied one layer in: an exemption with no standing echo decays silently.
  // Print the declared set on EVERY run (pass or fail, `--count` or not) so it stays auditable rather than
  // implicitly trusted forever.
  if (excludedDirCheck.declared.gateExempt.length || excludedDirCheck.declared.notATest.length) {
    console.log(`ℹ excluded-dir test-shaped files, declared (gate-exempt: ${excludedDirCheck.declared.gateExempt.length}, not-a-test: ${excludedDirCheck.declared.notATest.length}):`);
    for (const rel of excludedDirCheck.declared.gateExempt) console.log(`   - [gate-exempt] ${rel}`);
    for (const rel of excludedDirCheck.declared.notATest) console.log(`   - [not-a-test] ${rel}`);
  }

  if (countOnly) {
    const rawAll = walkAllMjsFiles(TEST_DIR).length;
    const walked = walkMjsFiles(TEST_DIR);
    const excludedDirFilesCount = rawAll - walked.length;
    const underscoreExcludedCount = walked.filter(isUnderscoreExcluded).length;
    console.log(`\nDiscovery breakdown for ${TEST_DIR}:`);
    console.log(`  all .mjs under test/ (raw walk, no exclusions): ${rawAll}`);
    console.log(`  excluded — under fixtures/ or census/ (never walked): ${excludedDirFilesCount}`);
    console.log(`  excluded — underscore-prefixed path segment: ${underscoreExcludedCount}`);
    console.log(`  excluded — NOT_HERMETIC (needs a live daemon/claude, run manually): ${NOT_HERMETIC_NAMES.length}`);
    console.log(`  discovery violations (neither helper nor test-shaped): ${DISCOVERY_VIOLATIONS.length}`);
    console.log(`  → hermetic test files this gate will run: ${HERMETIC.length}`);
    // Card fa52f555: `--count` exists to REPLACE a hand-rolled tracked-file count, so it must not print a
    // confident number while a known git-vs-walk drift condition sits undetected — but this mode is for a
    // fast read, so a drift here is a WARNING, not the fatal refusal the real run enforces below.
    try {
      const gitAudit = auditDiscoveryAgainstGit(TEST_DIR);
      if (gitAudit.inGitNotWalked.length || gitAudit.walkedNotInGit.length) {
        console.warn(`⚠ git-vs-walk drift detected — this count may not reflect what the real gate run would see: ${gitAudit.inGitNotWalked.length} git-tracked file(s) unseen by the walk, ${gitAudit.walkedNotInGit.length} walked file(s) untracked by git.`);
      }
    } catch (err) {
      console.warn(`⚠ could not run the git-vs-walk audit (non-fatal in --count mode): ${err.message}`);
    }
    process.exit(0);
  }

  // Card e7bcb0df DoD 6: the cross-check must actually run in the real gate path, not just exist as an
  // importable function — so it runs here, unconditionally, before a single test spawns.
  let gitAudit;
  try {
    gitAudit = auditDiscoveryAgainstGit(TEST_DIR);
  } catch (err) {
    console.error(`❌ test-daemon.mjs: could not verify the discovery walk against git — refusing to trust an unverified allowlist: ${err.message}`);
    process.exit(1);
  }
  if (gitAudit.inGitNotWalked.length) {
    console.error(`❌ test-daemon.mjs: ${gitAudit.inGitNotWalked.length} git-tracked .mjs file(s) under test/ were never seen by the discovery walk — naming them:`);
    for (const rel of gitAudit.inGitNotWalked) console.error(`   - ${rel}`);
    console.error("   The walk under-discovers relative to git — refusing to report a green gate that may have silently skipped real tests.");
    process.exit(1);
  }
  if (gitAudit.walkedNotInGit.length) {
    console.warn(`⚠ test-daemon.mjs: ${gitAudit.walkedNotInGit.length} .mjs file(s) seen by the discovery walk are untracked by git (fine for a local run; invisible to the merge gate's own tracked-files-only check): ${gitAudit.walkedNotInGit.join(", ")}`);
  }

  // @decision 3791b14e — this import must stay a LAZY, call-site `await import()` inside `isMain`, never
  // module-top: a top-level static import broke git/worktrees.ts's two dynamic-import-based loaders
  // (gate `39331d61`) by throwing before a fixture repo lacking this file could even be caught.
  const { CODEX_REAL_SPAWN_BASENAMES, CODEX_REAL_SPAWN_SET } = await import("../test/_codex-real-spawn-lock.mjs");

  // Card 6185fbfc: resolve --only=/--exclude= against the discovered set, fail loudly on an unknown name
  // or an empty resulting selection (never silently run nothing). `SELECTED` is the SAME array reference
  // as `HERMETIC` when neither flag is given, so the zero-argv default path — package.json's test:daemon,
  // ci.yml, release.yml, the merge gate itself — prints no extra line and behaves byte-identically to
  // before this card. Card ce02e7e5: `resolveSelectionForCliMode` ALSO resolves the
  // `--codex-real-spawn`/`--no-codex-real-spawn` presets here, from `CODEX_REAL_SPAWN_BASENAMES` above —
  // every other cliMode shape (plain --only=/--exclude=, or neither) is byte-identical to the old direct
  // `resolveSelection` call it replaces.
  const selectionResult = resolveSelectionForCliMode(HERMETIC, cliMode, CODEX_REAL_SPAWN_BASENAMES);
  if (selectionResult.error) {
    console.error(`❌ test-daemon.mjs: ${selectionResult.error}`);
    process.exit(1);
  }
  const SELECTED = selectionResult.selected;
  if (SELECTED !== HERMETIC) {
    console.log(`ℹ selection active: running ${SELECTED.length}/${HERMETIC.length} discovered hermetic test files (--only/--exclude${cliMode.codexRealSpawnPreset ? "/--codex-real-spawn preset" : ""} applied)`);
  }
  // Card 3791b14e: split off the real-codex-spawn family FIRST, unconditionally — before the
  // ISOLATED_REAL_SPAWN_PHASE_ENABLED-gated split below even sees the selection. `nonCodexSelected`
  // (not `SELECTED`) feeds that split so a codex real-spawn file can never ALSO land in `concurrentNames`
  // and run a second time. Preserves relative order (`.filter`), same discipline as the split below.
  const codexRealSpawnNames = SELECTED.filter((name) => CODEX_REAL_SPAWN_SET.has(name));
  const nonCodexSelected = SELECTED.filter((name) => !CODEX_REAL_SPAWN_SET.has(name));
  if (codexRealSpawnNames.length) {
    console.log(`ℹ codex real-spawn phase: running ${codexRealSpawnNames.length} real-codex-spawn file(s) first and sequentially (pool size ${CODEX_REAL_SPAWN_PHASE_POOL_SIZE}, always-on, independent of ISOLATED_REAL_SPAWN_PHASE_ENABLED below): ${codexRealSpawnNames.join(", ")}`);
  }
  // Card 0f0816e2: split the REMAINDER (nonCodexSelected), preserving each subset's own relative order,
  // into the isolated sequential phase (ISOLATED_REAL_SPAWN_SET) and everything else (the ordinary
  // concurrent pool below, unchanged). A `--only=` selection that excludes every isolated basename
  // legitimately yields an empty `isolatedNames` — phase 1 below is skipped entirely in that case, not an
  // error. Gated on ISOLATED_REAL_SPAWN_PHASE_ENABLED (default OFF — see that constant's own doc for the
  // measured cost): disabled, `isolatedNames` is always empty and `concurrentNames === nonCodexSelected`,
  // so dispatch below is byte-identical to the original flat-pool-only behavior MINUS whatever the codex
  // real-spawn split above already carved out.
  const isolatedNames = ISOLATED_REAL_SPAWN_PHASE_ENABLED ? nonCodexSelected.filter((name) => ISOLATED_REAL_SPAWN_SET.has(name)) : [];
  const concurrentNames = ISOLATED_REAL_SPAWN_PHASE_ENABLED ? nonCodexSelected.filter((name) => !ISOLATED_REAL_SPAWN_SET.has(name)) : nonCodexSelected;
  if (isolatedNames.length) {
    console.log(`ℹ isolated phase: running ${isolatedNames.length} real-spawn/daemon-boot-heavy file(s) first and sequentially (pool size ${ISOLATED_PHASE_POOL_SIZE}): ${isolatedNames.join(", ")}`);
  }
  // Card 6185fbfc: --concurrency=N overrides the pool size for just this invocation (still clamped to
  // MAX_CONCURRENCY), leaving LOOM_GATE_TEST_CONCURRENCY-derived POOL_SIZE untouched when omitted — so
  // the zero-argv default path's concurrency is exactly what it was before this card.
  const EFFECTIVE_POOL_SIZE = cliMode.concurrency != null
    ? Math.max(1, Math.min(cliMode.concurrency, MAX_CONCURRENCY))
    : POOL_SIZE;

  // Card f273ebb9: reap orphaned `loom-*` temp dirs left behind by a PRIOR run's force-killed process tree
  // (see gate-runner.ts's killGateProcessTree — a taskkill /T /F on timeout or cancel bypasses this
  // runner's own tmpRoots cleanup below, and every mid-flight test file's cleanup too, regardless of how
  // well that file's own cleanup is written). Runs automatically here, once, before any test spawns — so
  // nobody is ever asked to run this by hand (a human was asked to approve this pattern twice already, on
  // 2026-08-06 and 2026-08-24). Age-gated + `loom-*`-scoped + bounded — see temp-reaper.mjs's own header
  // for why each of those is load-bearing. Best-effort: a reaper problem must never fail the suite it runs
  // ahead of, so only log the summary, never throw.
  try {
    const reapSummary = reapStaleLoomTempDirs(os.tmpdir());
    if (reapSummary.reaped > 0 || reapSummary.errors.length > 0) {
      console.log(`ℹ temp-reaper: reaped ${reapSummary.reaped}/${reapSummary.candidates} stale loom-* temp dir(s) (skipped ${reapSummary.skippedTooYoung} too-young, ${reapSummary.skippedOverCap} over this run's cap)${reapSummary.errors.length ? `; ${reapSummary.errors.length} error(s): ${reapSummary.errors.join("; ")}` : ""}`);
    }
  } catch (err) {
    console.warn(`⚠ temp-reaper failed (non-fatal): ${err.message}`);
  }

  // Card e6e55f7a: sample only around the actual test run, never during --count/--help/error paths above.
  // `runInstrumentedSuite` seeds the gap series with the run's own start (so a long stall BEFORE the
  // first completion is captured too, not just gaps between completions) and, on a genuine harness crash,
  // prints the two lines itself (labelled partial) before rethrowing — see that function's own comment.
  const RSS_SAMPLE_INTERVAL_MS = 5000;
  // Card 0f0816e2 (extended by 3791b14e): one local array per phase — `results` (below) is assigned once
  // ALL THREE phases have completed, by concatenating these in codex-then-isolated-then-concurrent order.
  // Downstream code only ever filters/counts `results` or checks name membership via a Set, so this
  // concatenation order has no effect on any existing assertion.
  const codexRealSpawnResults = new Array(codexRealSpawnNames.length);
  const isolatedResults = new Array(isolatedNames.length);
  const concurrentResults = new Array(concurrentNames.length);
  let results = [];
  // Card 17069e7e: wall-clock bounds for the gate-timing run-summary row + human summary below — captured
  // around the WHOLE instrumented run (lane execution + tmp cleanup + the executed-set assertion), not just
  // the lane dispatch, so it reads as "how long this gate run's test phase actually took" end to end.
  const gateTimingRunStartTs = new Date().toISOString();
  const gateTimingRunStartEpoch = Date.now();
  const gateTimingHostBefore = cheapHostSnapshot();
  // Card 90678ee9 DoD-5: computed once (SELECTED is fixed for the whole run) and stamped on both the
  // write-ahead row and the run-summary row, same pattern as testCount below.
  const gateTimingTestSourceBytes = computeTestSourceBytes(TEST_DIR, SELECTED);
  // Card 6185fbfc reviewer note: a bare Date.now() run key collides across two gates admitted in the same
  // millisecond (maxConcurrentGates >= 2) — the exact defect card f5421d27 found in
  // test/deploy-staleness.mjs's fixture names. `runIndex` stays numeric (Date.now()) for schema
  // compatibility with the existing investigation NDJSON; `runUid` adds process.pid so two concurrent gate
  // runs on this host can never share a join key, even if they start in the same ms. Card 05056168 moved
  // this computation HERE, before any test spawns, so the write-ahead row below and every incremental
  // per-file row (see runLane) share the same join key the eventual run-summary row will also carry.
  const gateTimingRunIndex = gateTimingRunStartEpoch;
  const gateTimingRunUid = `${gateTimingRunStartEpoch}-${process.pid}`;
  // Card 05056168: the WRITE-AHEAD record — appended BEFORE the first test spawn, so it is the one row a
  // SIGKILL of this whole process cannot defeat. `selected` is the full run set; a reader pairs this row
  // with the run-summary row sharing `runUid` (its absence means the run never terminated normally) and can
  // name the file(s) in flight at kill time via `neverCompletedFiles(selected, <names with a "file" row>)`.
  try {
    appendGateTimingRow(GATE_TIMING_NDJSON, {
      kind: "run-start",
      runIndex: gateTimingRunIndex,
      runUid: gateTimingRunUid,
      // Card 937bdb18: same source + same omit-when-unset discipline as the run-summary row's own opId
      // (see gateTimingOpId's own doc) — this is the row a SIGKILL/timeout cannot defeat, so it's the one
      // that must carry the id for a killed run to stay attributable at all; run-summary never gets
      // written for that run.
      opId: gateTimingOpId(),
      runStartTs: gateTimingRunStartTs,
      poolSize: EFFECTIVE_POOL_SIZE,
      testCount: SELECTED.length,
      // Card 0f0816e2 DoD-3: additive fields — an OLDER reader simply lacks these keys (same additivity
      // convention as every other field on this row). Per the convention `1ec2e353` established for this
      // row family (see gate-timing-band.ts's own `testCount` doc), an on-disk key already present here is
      // NEVER renamed to disclose a new unit/semantic — `poolSize` above keeps its on-disk name and keeps
      // meaning "the pool size for whatever ran in the ordinary concurrent pool", now phase 2 rather than
      // the whole run; that narrowing is disclosed in this comment, not in the key name. These two keys are
      // new, so they're named plainly from the start: how many files ran in the isolated sequential phase,
      // and at what pool size — together with `poolSize`/`testCount` above, a later reader can tell an
      // isolated-phase run (isolatedPhaseFileCount > 0) from a flat pre-card run (key absent).
      isolatedPhaseFileCount: isolatedNames.length,
      isolatedPhasePoolSize: ISOLATED_REAL_SPAWN_PHASE_ENABLED ? ISOLATED_PHASE_POOL_SIZE : 0,
      // Card 3791b14e: same additive-field convention as the isolatedPhase* pair above, for the SEPARATE,
      // always-on codex real-spawn phase — UNCONDITIONAL (no flag), so codexRealSpawnPhasePoolSize is
      // CODEX_REAL_SPAWN_PHASE_POOL_SIZE whenever any such file was selected, never gated to 0 the way
      // isolatedPhasePoolSize is when its own flag is off.
      codexRealSpawnPhaseFileCount: codexRealSpawnNames.length,
      codexRealSpawnPhasePoolSize: codexRealSpawnNames.length ? CODEX_REAL_SPAWN_PHASE_POOL_SIZE : 0,
      testSourceBytes: gateTimingTestSourceBytes,
      selected: SELECTED.slice(),
      hostBefore: gateTimingHostBefore,
    });
  } catch (err) {
    // Belt-and-suspenders only — appendGateTimingRow itself never throws (see its own doc); this guards the
    // (trivial, should-never-throw) row construction, same posture as the post-run block below.
    console.warn(`⚠ gate-timing write-ahead record failed (non-fatal): ${err.message}`);
  }
  // Card a496166a DoD-0 (REMAINING WORK): periodic host-load sampling for the WHOLE duration of a gate
  // run, not just a before/after bracket — the piece §DoD-0b names as missing: a single point-in-time
  // sample can't tell a fast run and a slow run apart. Rides the SAME timer `runInstrumentedSuite` already
  // runs for RSS sampling below (no second interval, no new harness) via its `onSample` hook. Each tick
  // writes an ADDITIVE "host-sample" NDJSON row (own `kind`, joined by the SAME `runUid` every other row
  // in this run already carries) — existing consumers filter by `kind` and silently ignore one they don't
  // recognize (see the header comment above GATE_TIMING_NDJSON), so this cannot break
  // compute-sum-wall-slack.mjs or any other reader of this file.
  const gateTimingHostSampler = createHostLoadSampler();
  const gateTimingHostBusySamples = [];
  // Card afd51f5d: parallel array to gateTimingHostBusySamples, same null-exclusion convention — see
  // diskProbeWriteMs's own doc for what this measures and why.
  const gateTimingDiskProbeSamples = [];
  // Card ec2d154b: parallel array to the two above, but NEVER null-filtered — every tick records a real
  // freeMemMB reading (unlike cpuBusyPct's first-tick null or an occasional failed disk probe), so this
  // array's own length is what computeHostLoadAggregates uses as sampleCount. Feeds ONLY that aggregate;
  // the per-tick "host-sample" row already carries its own freeMemMB field independently, unchanged.
  const gateTimingFreeMemMBSamples = [];
  let gateTimingHostSampleIndex = 0;
  const onHostSample = () => {
    try {
      const busyPct = gateTimingHostSampler.sample();
      if (busyPct !== null) gateTimingHostBusySamples.push(busyPct);
      const diskProbeMs = diskProbeWriteMs(DISK_PROBE_FILE, DISK_PROBE_BUF);
      if (diskProbeMs !== null) gateTimingDiskProbeSamples.push(diskProbeMs);
      const freeMemMB = Math.round(os.freemem() / 1e6);
      gateTimingFreeMemMBSamples.push(freeMemMB);
      appendGateTimingRow(GATE_TIMING_NDJSON, {
        kind: "host-sample",
        runIndex: gateTimingRunIndex,
        runUid: gateTimingRunUid,
        sampleIndex: gateTimingHostSampleIndex++,
        ts: new Date().toISOString(),
        // Date.now()-derived, not performance.now() — matches this NDJSON schema's existing startTs/endTs
        // convention (see the runOne comment above): these rows are joined and read as wall-clock epoch
        // timestamps against the run-start/run-summary rows, never used for an in-process pass/fail
        // assertion a monotonic clock would matter for.
        elapsedMs: Date.now() - gateTimingRunStartEpoch,
        // SAMPLED DELTA, never cumulative — see cpuBusyPctDelta's own doc for why that distinction is
        // load-bearing here. null on the sampler's first tick (no prior reading to delta against yet).
        cpuBusyPct: busyPct,
        freeMemMB,
        totalMemMB: Math.round(os.totalmem() / 1e6),
        // Card afd51f5d DoD-1/2/3: disk-I/O signal, additive on this existing row kind — an OLDER row (or
        // any reader that predates this field) simply lacks the key; every reader here already destructures
        // by name rather than assuming a fixed field set (DoD-6). null on a failed probe, never fabricated.
        diskProbeMs,
      });
    } catch {
      // Best-effort, same posture as appendGateTimingRow itself (which never throws on its own) — this
      // guards the (should-never-throw) os.cpus()/os.freemem()/diskProbeWriteMs reads feeding it. A
      // sampling failure must never affect this gate's own pass/fail or exit code.
    }
  };
  const { rssTracker, completionTimestamps } = await runInstrumentedSuite(async (completionTimestamps) => {
    const gateTimingCtx = { runIndex: gateTimingRunIndex, runUid: gateTimingRunUid };

    // Card 3791b14e: PHASE 0 — the real-codex-spawn family (CODEX_REAL_SPAWN_SET) runs FIRST and fully to
    // completion, at CODEX_REAL_SPAWN_PHASE_POOL_SIZE (1), UNCONDITIONALLY (no flag gates this, unlike
    // Phase 1 below) — so no two of these files ever compete with each other, or with anything else, for
    // the box. Reuses the SAME runLane/runOne machinery as every other phase; only the pool size and the
    // input set differ. Skipped entirely (no lanes started) when a `--only=` selection excludes every
    // codex real-spawn basename.
    if (codexRealSpawnNames.length) {
      const codexRealSpawnCursor = makeCursor(codexRealSpawnNames.length);
      await Promise.all(
        Array.from({ length: Math.min(CODEX_REAL_SPAWN_PHASE_POOL_SIZE, codexRealSpawnNames.length) }, (_, lane) => runLane(lane, codexRealSpawnNames, codexRealSpawnCursor, codexRealSpawnResults, completionTimestamps, gateTimingCtx)),
      );
    }

    // Card 0f0816e2 DoD-1: PHASE 1 — the isolated real-spawn/daemon-boot-heavy set (ISOLATED_REAL_SPAWN_SET
    // above) runs next and fully to completion, at ISOLATED_PHASE_POOL_SIZE (1) — so none of these files
    // ever compete with a concurrent sibling for the box. Reuses the SAME runLane/runOne machinery as the
    // ordinary pool below; only the pool size and the input set differ. Skipped entirely (no lanes started)
    // when a `--only=` selection excludes every isolated basename.
    if (isolatedNames.length) {
      const isolatedCursor = makeCursor(isolatedNames.length);
      await Promise.all(
        Array.from({ length: Math.min(ISOLATED_PHASE_POOL_SIZE, isolatedNames.length) }, (_, lane) => runLane(lane, isolatedNames, isolatedCursor, isolatedResults, completionTimestamps, gateTimingCtx)),
      );
    }

    // PHASE 2 — everything else, in the existing pool, exactly as before this card (same EFFECTIVE_POOL_SIZE
    // computation, just bounded by the remaining file count instead of SELECTED.length).
    const concurrentCursor = makeCursor(concurrentNames.length);
    await Promise.all(
      Array.from({ length: Math.min(EFFECTIVE_POOL_SIZE, concurrentNames.length) }, (_, lane) => runLane(lane, concurrentNames, concurrentCursor, concurrentResults, completionTimestamps, gateTimingCtx)),
    );
    results = codexRealSpawnResults.concat(isolatedResults).concat(concurrentResults);

    // Best-effort cleanup of the per-test temp homes (WAL handles may briefly hold a few on Windows).
    // Reuses _tmp-fixture.mjs's proven-correct bounded retry WITH A REAL DELAY between attempts — the
    // ad hoc version this replaced retried 5x with ZERO delay, which cannot outlast a transient
    // EBUSY/EPERM handle (5 synchronous attempts complete in microseconds; see _tmp-fixture.mjs's own
    // CORRECTION 1) and was the single largest contributor to the %TEMP% fixture-dir leak (card a1f72ab8;
    // ~1,067 loom-td-* dirs/14d, the largest of any family — one per test file per full-suite run, since
    // this loop's own retry could never actually succeed against a transient lock).
    for (const root of tmpRoots) cleanupPathSync(root);

    // Card b122c7d4 DoD #1: assert the executed PATH SET against the discovered allowlist, by path, never
    // by count — a count (e.g. `results.length === SELECTED.length`) can't distinguish "ran the right
    // files" from "ran the wrong files, same tally" (`runOne`'s own `fs.existsSync` skip path resolves
    // `ok:true` without ever spawning anything). Named, not just counted, so a future divergence is
    // diagnosable from this output alone.
    const executedNames = new Set(results.filter((r) => !r.skipped).map((r) => r.name));
    const notExecuted = SELECTED.filter((name) => !executedNames.has(name));
    if (notExecuted.length) {
      console.error(`❌ test-daemon.mjs: ${notExecuted.length} discovered hermetic test file(s) were NOT actually executed — naming them: ${notExecuted.join(", ")}`);
      process.exit(1);
    }
  }, { sampleIntervalMs: RSS_SAMPLE_INTERVAL_MS, onSample: onHostSample });
  const gateTimingRunEndTs = new Date().toISOString();
  const gateTimingWallClockMs = Date.now() - gateTimingRunStartEpoch;

  const pass = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  // Card 9a6b1f2b: already computed for the gate-timing run-summary row below (and, by construction, always
  // equal to SELECTED.length here — the notExecuted guard above exits the process before this line runs on
  // any divergence).
  const executedCount = results.filter((r) => !r.skipped).length;

  // Card 22d995ca: a DECLARED WARNING is a test's own `console.log("WARN  <message>")` line — the SAME
  // two-space convention `check()` already uses for `PASS  `/`FAIL  ` (see codex-transcript-real-spawn.mjs's
  // `reportGracefulStopExitCode`, the motivating case: a KNOWN, non-blocking accommodation that must stay
  // visible even when the file it lives in exits 0). Scanned across EVERY result's full captured `stdout`,
  // pass or fail alike — unlike `failed` above, a PASSING file's own stdout is otherwise discarded entirely
  // once this run finishes (see the `FAILURES:` epilogue below, which only ever reads `failed`), which was
  // the actual defect: a non-blocking warning survived nowhere once the file it lived in started passing.
  const WARN_LINE_RE = /^WARN {2}(.+)$/;
  const declaredWarnings = results
    .map((r) => ({ name: r.name, lines: (r.stdout ?? "").split("\n").filter((l) => WARN_LINE_RE.test(l)) }))
    .filter((w) => w.lines.length > 0);

  console.log(`\n${pass}/${SELECTED.length} hermetic daemon test files passed — all selected files executed (a skip would have exited above). (pool size ${EFFECTIVE_POOL_SIZE})`);
  // Card 12bdea9e: a test excluded here has no owner and no alarm — it decays silently and its decay
  // is invisible until someone happens to run it by hand. Naming the excluded set on EVERY gate run
  // (pass or fail) means the exclusion itself can never again go unnoticed, without paying the cost of
  // actually booting a live daemon here. Run one manually: `node dist/index.js` (some need extra env —
  // see the file's own header), then `node test/<name>.mjs` from packages/daemon.
  console.log(`ℹ NOT_HERMETIC (excluded from this gate — needs a live daemon and/or real claude; run manually, see each file's header): ${[...NOT_HERMETIC].sort().join(", ")}`);
  // Card e6e55f7a: printed on pass AND fail alike — a rejected run's numbers are as valuable as a passed
  // run's, arguably more, since rejections are disproportionately the interesting ones.
  console.log(formatRssFloorLine(rssTracker.sampleCount(), RSS_SAMPLE_INTERVAL_MS, rssTracker.floorBytes()));
  console.log(formatMaxGapLine(maxGapMs(completionTimestamps)));
  console.log(formatHostLoadSummaryLine(gateTimingHostBusySamples, RSS_SAMPLE_INTERVAL_MS));
  console.log(formatDiskProbeSummaryLine(gateTimingDiskProbeSamples, RSS_SAMPLE_INTERVAL_MS));

  // Card 17069e7e (DoD-2): per-file timing — human summary (unconditional, pass or fail, same placement as
  // the RSS/gap lines above) + a best-effort NDJSON artifact. Wrapped whole: this is observation only, and
  // must never affect this gate's own exit code — see appendGateTimingRow's own doc for why each write is
  // already individually guarded; this outer try/catch also guards the (pure, should-never-throw) summary
  // computation itself, belt-and-suspenders.
  try {
    // gateTimingHostBefore was captured BEFORE runInstrumentedSuite ran (see above) — only the "after" side
    // is taken here, so the two snapshots actually bracket the run instead of both landing post-run.
    const gateTimingHostAfter = cheapHostSnapshot();
    // Card 05056168: this "run-summary" row is what CLOSES the write-ahead "run-start" row written before
    // the first spawn (same runUid, computed once above) — its presence is the "the run terminated
    // normally" signal a reader keys on. Every per-file "file" row was already flushed incrementally in
    // runLane as each file completed, so there is no longer a post-run loop over `results` here — the
    // original defect this card fixes was exactly that loop never running when the process was SIGKILLed.
    //
    // Card ec2d154b (CR follow-up): computeHostLoadAggregates is called in its OWN try/catch, separate from
    // the row it feeds — a throw here must cost only the aggregate, never the whole run-summary row (the
    // "the run terminated normally" signal gate-timing-band.ts and the deferred-trigger nudge composition
    // both key on). Falls back to `null`, same "absent detail, not a fabricated value" posture the function
    // itself already uses for an empty sample array.
    let gateTimingHostLoadAggregates = null;
    try {
      gateTimingHostLoadAggregates = computeHostLoadAggregates(gateTimingHostBusySamples, gateTimingDiskProbeSamples, gateTimingFreeMemMBSamples);
    } catch (err) {
      console.warn(`⚠ gate-timing: hostLoadAggregates computation failed (non-fatal, row still written): ${err.message}`);
    }
    appendGateTimingRow(GATE_TIMING_NDJSON, {
      kind: "run-summary",
      runIndex: gateTimingRunIndex,
      runUid: gateTimingRunUid,
      // Card 720bb7ad DoD-3: see gateTimingOpId's own doc — omitted (not a fabricated empty string) for
      // any caller that never set LOOM_GATE_OP_ID.
      opId: gateTimingOpId(),
      runStartTs: gateTimingRunStartTs,
      runEndTs: gateTimingRunEndTs,
      durationMs: gateTimingWallClockMs,
      poolSize: EFFECTIVE_POOL_SIZE,
      testCount: SELECTED.length,
      // Card 0f0816e2 DoD-3: same additive fields as the write-ahead row above — see that row's own comment
      // for the on-disk-key-never-renamed convention this follows.
      isolatedPhaseFileCount: isolatedNames.length,
      isolatedPhasePoolSize: ISOLATED_REAL_SPAWN_PHASE_ENABLED ? ISOLATED_PHASE_POOL_SIZE : 0,
      // Card 3791b14e: same additive fields as the write-ahead row's own pair above — see that row's own
      // comment for why this one is never gated to 0 by a flag.
      codexRealSpawnPhaseFileCount: codexRealSpawnNames.length,
      codexRealSpawnPhasePoolSize: codexRealSpawnNames.length ? CODEX_REAL_SPAWN_PHASE_POOL_SIZE : 0,
      testSourceBytes: gateTimingTestSourceBytes,
      executedCount,
      failedCount: failed.length,
      failedNames: failed.map((f) => f.name),
      hostBefore: gateTimingHostBefore,
      hostAfter: gateTimingHostAfter,
      // Card ec2d154b: per-run CPU/disk/mem aggregates over this run's OWN "host-sample" ticks — see this
      // file's header comment (search `hostLoadAggregates`) and computeHostLoadAggregates's own doc. These
      // survive gate-timing-retention.mjs's compaction (which drops the per-tick "host-sample" rows for
      // every run older than keepFullRuns) because they live on THIS row, not on the rows being dropped.
      // Computed above in its own try/catch — `null` here means the computation itself threw, not "no
      // samples" (which the function reports as a real object with null fields, not a null object).
      hostLoadAggregates: gateTimingHostLoadAggregates,
    });
    for (const line of formatGateTimingSummaryLines(results, gateTimingWallClockMs)) console.log(line);
    // Card 17069e7e (CR follow-up): ONE summary line for every write failure this run, never one per row —
    // see gateTimingWriteFailureSummary's own doc for why per-row warnings would blind a rejected gate's
    // bounded output tail.
    const gateTimingFailures = gateTimingWriteFailureSummary();
    if (gateTimingFailures.count > 0) {
      console.warn(`⚠ gate-timing: ${gateTimingFailures.count} row write(s) to ${GATE_TIMING_NDJSON} failed this run (non-fatal, not repeated per row): ${gateTimingFailures.lastMessage}`);
    }
  } catch (err) {
    console.warn(`⚠ gate-timing observability block failed (non-fatal): ${err.message}`);
  }

  // Card f8b176f7: best-effort compaction of the gate-timing NDJSON — see gate-timing-retention.mjs's own
  // doc for the full policy and why it's shaped the way it is. Runs AFTER the run-summary write above (so
  // this run's own rows are eligible to be treated as "the most recent run" immediately) and is wrapped
  // exactly like every other observability step in this block: compactGateTimingLogIfNeeded itself never
  // throws (see its own doc), this outer try/catch is belt-and-suspenders only, and a compaction miss must
  // never affect this gate's own pass/fail or exit code.
  try {
    // Lazy import (see the header comment above this file's other imports for why) — loaded here, at the
    // one real call site, rather than at module top-level.
    const { compactGateTimingLogIfNeeded } = await import("./lib/gate-timing-retention.mjs");
    const compactionResult = compactGateTimingLogIfNeeded(GATE_TIMING_NDJSON);
    if (compactionResult.compacted) {
      console.log(`ℹ gate-timing: compacted ${GATE_TIMING_NDJSON} (${compactionResult.beforeBytes} bytes, ${compactionResult.beforeRows} rows → ${compactionResult.afterRows} rows${compactionResult.droppedOldSummaries ? `, dropped ${compactionResult.droppedOldSummaries} old run-summary row(s) past the retention ceiling` : ""})`);
    } else if (compactionResult.reason === "error" || compactionResult.reason === "write-failed") {
      console.warn(`⚠ gate-timing: compaction attempt failed (non-fatal): ${compactionResult.error}`);
    }
  } catch (err) {
    console.warn(`⚠ gate-timing compaction block failed (non-fatal): ${err.message}`);
  }

  // Card 22d995ca: printed UNCONDITIONALLY — pass OR fail — and positioned here deliberately, as the LAST
  // thing this file prints before either terminal branch below (the FAILURES: epilogue + process.exit(1),
  // or the single "✅ ..." line on a clean pass). The gate step that runs this file (`gate-runner.ts`)
  // retains a bounded TRAILING ring of a step's own stdout+stderr even on a genuine PASS (`tail()`,
  // OUTPUT_TAIL_BYTES) — the queryable channel `gate_status(opId)` and the persisted full-output spill both
  // read from; placing this block as close as possible to this file's own end-of-output maximizes the
  // chance it survives whatever (if anything) the outer gate command still prints afterward. Same
  // one-string + writeFullySync discipline as the FAILURES: epilogue immediately below (card 14e733fb) —
  // a `console.log` loop's writes are exactly the ones a POSIX host could lose to a later process.exit()
  // tearing the process down before they reach the pipe.
  if (declaredWarnings.length) {
    const warningLines = ["WARNINGS:"];
    for (const w of declaredWarnings) {
      warningLines.push(`  - ${w.name}:`);
      for (const line of w.lines) warningLines.push(`      ${line}`);
    }
    writeFullySync(1, warningLines.join("\n") + "\n");
  }

  if (failed.length) {
    // Echo each failed test's FULL captured stdout/stderr (not just the last line) — the individual
    // check() failures inside a test file were otherwise invisible in the CI log, which is exactly why a
    // Linux-only failure (card 45a23c27) shipped undiagnosable from CI output alone.
    // Card 63664129: THIS echo — front-anchored by orchestration/gate-runner.ts's `outputTail` capture,
    // not this file's own bytes — is the ONLY surface that survives for a test whose decisive failure
    // detail is multi-line (a stack, a timeline, a stdout/stderr dump): `failingTest` keeps just one line
    // per tier, or `undefined` entirely for a thrown message matching no recognized marker. See
    // GateStepResult.failingTest's own doc (gate-runner.ts) for the full constraint and its known gaps —
    // don't restate it here, it drifts.
    //
    // Card 14e733fb: built into ONE string and flushed via writeFullySync (see its own doc above) instead
    // of a `console.log` loop — the loop's writes are exactly the ones a POSIX gate host could lose to
    // process.exit() below tearing the process down before they reach the pipe. `epilogueLines.join("\n")
    // + "\n"` reproduces the SAME bytes the old per-call console.log sequence produced (each call wrote its
    // argument plus one trailing "\n"; join("\n") + a final "\n" is byte-identical to that).
    // Card e26f3199: on a timeout, name WHICH of the two failure modes this was — before this card, the
    // child's real exit status was discarded, so "completed successfully, 'close' was just late" printed
    // identically to "genuinely wedged, killed, never exited". They must not print the same. Card 5e3ebc80:
    // per-entry line-building moved to `buildFailureEntryLines` (above `runOne`) — same lines, same order,
    // for every non-empty-output case; see that function's own doc for what's new (the zero-output marker).
    const epilogueLines = ["FAILURES:"];
    for (const f of failed) epilogueLines.push(...buildFailureEntryLines(f));
    writeFullySync(1, epilogueLines.join("\n") + "\n");
    process.exit(1);
  }
  console.log("✅ hermetic daemon suite green — never touched prod.");
} else if (resolutionThrew) {
  // Card b122c7d4, defence 3 above: a real resolution failure is its own loud state — never fold it into
  // the silent "genuinely imported as a module" fallthrough below, which is for a DIFFERENT (successful,
  // just non-matching) resolution.
  console.error("❌ test-daemon.mjs: main-module guard could not resolve a real path on one or both sides (realpathSync.native threw) — refusing to silently skip the run.");
  console.error(`   import.meta.url resolved: ${!selfResolved.threw}`);
  console.error(`   process.argv[1] resolved: ${!argvResolved.threw}`);
  process.exit(1);
} else if (argvPath && selfPath && path.basename(argvPath).toLowerCase() === path.basename(selfPath).toLowerCase()) {
  // argv[1] has the SAME FILENAME as this script but resolved to a different real path — this is not a
  // legitimate import-for-export (that would have a different basename entirely), it is the guard
  // mismatch itself: a direct invocation whose path didn't compare equal. Fail loudly and non-zero
  // instead of silently exiting 0 with no test output — see the guard's own comment above.
  console.error("❌ test-daemon.mjs: main-module guard MISMATCH — this looks like a direct invocation, but the resolved real paths differ:");
  console.error(`   import.meta.url resolved to: ${selfPath}`);
  console.error(`   process.argv[1] resolved to: ${argvPath}`);
  console.error("   Refusing to silently report a green gate having run zero tests.");
  process.exit(1);
}
// else: genuinely imported as a module by a different script (e.g. the census harness importing
// NOT_HERMETIC) — silent and expected, no run, no exit.
