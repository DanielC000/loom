// `pnpm --filter @loom/daemon test:daemon` — run the daemon's HERMETIC, claude-free test suite,
// isolated BY CONSTRUCTION: every test runs in its OWN fresh temp LOOM_HOME, on a non-4317 LOOM_PORT,
// with LOOM_TEST=1 set. So "run the daemon tests" can NEVER touch the prod db (~/.loom/loom.db) or the
// prod daemon on :4317 — the failure mode that wiped prod on 2026-06-04 (see test/_guard.mjs + the
// db.ts prod-guard). Each test ALSO arms its own guard (import "./_guard.mjs"), so this envelope is
// belt-and-suspenders, not the only line of defence.
//
// Run after a build (the tests import dist/):  pnpm --filter @loom/daemon build && pnpm --filter @loom/daemon test:daemon
//
// Tests are DISCOVERED by an explicit ALLOWLIST (card b122c7d4), not by "everything not positively
// excluded": a recursive walk of test/ (skipping the established non-test containers `fixtures/` and
// `census/` — child-process fixtures and the out-of-band census harness, neither ever hermetic tests)
// collects every `.mjs` file, then splits it two ways. A leading `_` (e.g. _guard.mjs, _tmp-fixture.mjs)
// marks an intentional helper and is silently excluded, same as before. Everything else MUST look like a
// real test — carry an assertion marker (`check(`/`assert`/`throw new Error`/`process.exit(1)`) — or
// discovery REFUSES LOUDLY, naming the file, instead of silently spawning it and recording a pass: a
// non-test `.mjs` that merely imports cleanly and exits 0 is indistinguishable from a real pass by exit
// code alone (measured on `node:test` too — a zero-test file reports `# tests 1, # pass 1`), so
// "unexpected but ran anyway" is not a safe default here. This is on top of, and does not replace, the
// small NOT_HERMETIC denylist below for genuine tests that need a human-started isolated daemon and/or a
// real `claude` login — run those manually per the header comment in each file. Adding a new ordinary
// hermetic test file still needs no edit here: the allowlist is a derivation rule, not a static list.
//
// Runs in a BOUNDED, port-safe worker pool (each test file is already hermetically isolated — own
// temp LOOM_HOME, own port — so this is embarrassingly-parallel). Pool size, in order:
// LOOM_TEST_CONCURRENCY env (explicit dial-up/down on a host you know can take it) ?? a bounded
// DEFAULT_CONCURRENCY (safe when unset — see its own doc below) — either way clamped to the
// MAX_CONCURRENCY ceiling (concurrent temp-SQLite DBs + in-process daemon boots thrash host
// resources past a point; incident: this exact command, run with no env override, starved a live
// self-hosting sibling service — card 301d8c01). Each of the fixed pool "lanes" owns one port for its
// whole run (4400+laneIndex), so concurrent workers never collide — unlike a file-index-derived port,
// which only avoided collisions when tests ran strictly one-at-a-time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "..", "test");

// Exported so an out-of-band census/probe harness (test/census/*) can import the REAL exclusion list
// instead of keeping its own copy — a duplicated copy is exactly the shared-unit-divergence anti-pattern
// this codebase keeps paying for (see card ec7983c6's 116-copy SeamHost fixture).
export const NOT_HERMETIC = new Set([
  "integration-e2e", "orchestration-e2e", "manager-live", "messaging", "mgmt-surface", "orch-scope",
  "orch-spawn", "mcp-scope", "platform-scope", "recycle", "scheduler", "scheduler-drain",
  "scheduler-disabled", "usage-limit-detect", "usage-limit-resume", "worker-report", "autonomy-rails",
  "busy-flag", "merge-gate", "board-consistency", "skills-e2e", "profiles-rest",
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
const EXCLUDED_DIR_NAMES = new Set(["fixtures", "census"]);

// A discovered file not underscore-prefixed must carry at least one of these to count as a real test —
// the exact marker set the b122c7d4 census verified holds for every one of the 629 currently-hermetic
// top-level files (the other 4 non-matches were all underscore-prefixed helpers).
const ASSERTION_MARKERS = [/\bcheck\(/, /\bassert\b/, /throw new Error/, /process\.exit\(1\)/];

function looksLikeTest(source) {
  return ASSERTION_MARKERS.some((re) => re.test(source));
}

// Recursively collect every `.mjs` file under `dir`, skipping EXCLUDED_DIR_NAMES subtrees entirely.
// Returns paths relative to `dir`, POSIX-separated (stable/portable name shape regardless of nesting).
function walkMjsFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      out.push(...walkMjsFiles(full, base));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

// The allowlist derivation (card b122c7d4): walk `testDir`, split into silently-excluded helpers (a
// leading `_`) and candidates. Every candidate must `looksLikeTest`; one that doesn't is a VIOLATION —
// named and returned, never silently run and never silently dropped. `hermetic` is `candidates minus
// notHermetic`, using the SAME bare-name shape existing callers (NOT_HERMETIC, TEST_TIMEOUT_OVERRIDES)
// already key on — for every file that lives at test/ top level (all of them, today) the name is
// unchanged from before this card. Exported so a test can positive/negative-control this logic directly,
// against a synthetic directory, instead of a duplicated copy silently drifting from the real thing.
export function discoverHermeticTests(testDir, notHermetic = NOT_HERMETIC) {
  const violations = [];
  const hermetic = [];
  for (const rel of walkMjsFiles(testDir).sort()) {
    if (path.basename(rel).startsWith("_")) continue;
    const name = rel.slice(0, -".mjs".length);
    if (notHermetic.has(name)) continue;
    const source = fs.readFileSync(path.join(testDir, rel), "utf8");
    if (!looksLikeTest(source)) { violations.push(rel); continue; }
    hermetic.push(name);
  }
  return { hermetic, violations };
}

const { hermetic: HERMETIC, violations: DISCOVERY_VIOLATIONS } = discoverHermeticTests(TEST_DIR);

// Ceiling — unchanged. `LOOM_TEST_CONCURRENCY` may still dial UP to this on a host known to take it.
const MAX_CONCURRENCY = 8;
// Safe DEFAULT when LOOM_TEST_CONCURRENCY is unset (card 301d8c01 — a bare `pnpm --filter @loom/daemon
// test:daemon`, no env override, is exactly the command a worker or the daemon-run merge gate runs
// unattended). Previously this fell back to `os.availableParallelism()`, which on a many-core
// self-hosting box let this command spike to `MAX_CONCURRENCY` lanes of concurrent temp-SQLite/
// in-process-daemon boots with nothing bounding it — that's what starved the live Codescape service.
// 2 is a conservative default; a beefier/known-safe host can still override upward via the env.
const DEFAULT_CONCURRENCY = 2;
const POOL_SIZE = Math.max(
  1,
  Math.min(
    Number(process.env.LOOM_TEST_CONCURRENCY) || DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  ),
);

const TEST_TIMEOUT_MS = 120_000;
// Card cc595ca7: a HANDFUL of git-locking/merge tests do heavy REAL git subprocess work (dozens to
// hundreds of real `git` spawns — worktree creation, concurrent merges, content-integrity sweeps) with
// no internal timing assertion of their own; under the full suite's ~540-concurrent-git contention, that
// real work alone can blow past the blanket TEST_TIMEOUT_MS even though nothing is actually wedged
// (confirmed: merge-repo-mutex.mjs timed out on an unrelated card's gate, all-green standalone;
// merge-stranded-backstop.mjs flaked the same way at cap=2/concurrent=2; gate-timeout-circuit-breaker.mjs
// — card 6436bd5a — timed out under concurrent gate load but measured ~50-52s standalone on a quiet host,
// 3/3 runs, with every stubbed gate call resolving instantly: its cost is entirely the real
// `confirmWorkerMerge` union-merges + createWorktree + commits across its 8 blocks, not a hang;
// merge-gate-reuse.mjs — card 2bb7a114 — rejected an innocent card's merge gate with `exit timeout`
// despite being the HEAVIEST of these by real git-work volume (50 git invocations · 52
// createWorktree/confirmWorkerMerge calls); measured 7/7 standalone runs on a quiet host: 6 clustered
// 52-58s, but one (immediately after a fresh build) spiked to 130s — already past the blanket ceiling
// even standalone, before any concurrent-gate contention is added on top; merge-confirm-completion-nudge.mjs
// — same sweep — measured a rock-steady 83-84s across 3 standalone runs, by design: 6 scenarios each
// deliberately wait out a real `confirmWorkerMergeTracked` gate rather than stub it, so ~78s of its ~84s
// is genuine wall-clock wait, not host contention — already 70% of the blanket budget on an idle host).
// Raising TEST_TIMEOUT_MS itself would dull fast-fail for the ~296 OTHER hermetic tests that have nothing
// to do with git contention, so instead this is a small, explicit per-test override — same documented-list
// shape as NOT_HERMETIC above — giving just these git-heavy tests real headroom. A genuine infinite hang
// in any of them still gets killed and reported (verified: the same kill-and-report path fires and
// reports `status:"timeout"` regardless of the ceiling value), just at a ceiling actually sized for their
// real workload instead of one with zero margin.
const TEST_TIMEOUT_OVERRIDES = {
  "merge-repo-mutex": 300_000, // 15 trials x 2 concurrent real merges + a full content-integrity sweep
  "merge-stranded-backstop": 300_000, // 2x createWorktree + reviewWorkerMerge/confirmWorkerMerge, all real git
  "gate-timeout-circuit-breaker": 300_000, // measured ~50-52s standalone (3 runs); ~6x headroom for 8 blocks x real union-merges/createWorktree/commits under concurrent gate contention
  "merge-gate-reuse": 360_000, // measured 52-58s x6 + one 130s outlier (7 standalone runs, quiet host); heaviest of these by git+merge-call volume and the one that actually timed out in production (card 2bb7a114) — ~6.7x the steady median / ~2.8x the observed outlier
  "merge-confirm-completion-nudge": 240_000, // measured 83-84s x3 (quiet host, low variance — dominated by 6 deliberate real-gate waits, not contention); ~2.9x headroom over its steady measured cost
};
const tmpRoots = [];

// Runs one test file on a fixed pool "lane" (its port for the whole run, so concurrent lanes never
// collide). Resolves to a result record; never rejects — a spawn error is captured as a failure.
function runOne(name, lane) {
  return new Promise((resolve) => {
    const file = path.join(TEST_DIR, `${name}.mjs`);
    if (!fs.existsSync(file)) { resolve({ name, ok: true, skipped: true }); return; }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), `loom-td-${name}-`));
    tmpRoots.push(home);
    // Card fa52f555: this is safe WITHIN one invocation of this script (POOL_SIZE lanes, POOL_SIZE
    // distinct ports) but NOT across two CONCURRENT invocations — e.g. two merge gates admitted at once
    // under `maxConcurrentGates` >= 2 — since each independently computes the same `4400 + lane` values.
    // Checked (census card d39db2db): not currently reachable, because no hermetic test binds a real
    // listener on this assigned port (all either use in-memory `.inject()` or an unrelated ephemeral
    // `:0` bind) — but that is a property of today's test files, not a guarantee this scheme provides.
    const port = 4400 + lane;

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1" },
    });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timeoutMs = TEST_TIMEOUT_OVERRIDES[name] ?? TEST_TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ name, ok: false, status: null, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      const ok = !timedOut && status === 0;
      resolve({
        name,
        ok,
        status: timedOut ? "timeout" : status,
        stdout, stderr,
        tail: ok ? undefined : (stdout.split("\n").filter(Boolean).slice(-1)[0] || stderr.split("\n").filter(Boolean).slice(-1)[0]),
      });
    });
  });
}

// A fixed number of lanes each pull the next unclaimed test off a shared cursor — bounded concurrency,
// stable per-lane port, and every file still runs to completion regardless of earlier failures.
function makeCursor(length) {
  let next = 0;
  return () => (next < length ? next++ : null);
}

async function runLane(lane, names, nextIndex, results) {
  for (let idx = nextIndex(); idx !== null; idx = nextIndex()) {
    const name = names[idx];
    const result = await runOne(name, lane);
    results[idx] = result;
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `  (exit ${result.status})`}`);
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
// pass. Neither a correct guard nor a totally broken one can be told apart by the gate itself (both look
// like a green gate) — verified instead by directly running the real invocation and watching test output
// appear (see card d39db2db's report). Two defences against a future regression:
//   1. Compare RESOLVED REAL paths (`fs.realpathSync.native`), not raw URL strings — normalises drive-
//      letter case, 8.3 short-name components, and symlinks/junctions in one step (all three are
//      concrete, non-exotic ways a raw string compare can silently diverge on Windows).
//   2. If argv[1] LOOKS like a direct invocation of this exact file (same basename) but the resolved
//      paths still differ, that is precisely the dangerous mismatch — fail loudly and non-zero instead
//      of silently falling through. A genuinely different importer (a different basename entirely, e.g.
//      the census harness importing NOT_HERMETIC) stays silent — that path is intentional, not a guard
//      failure, and must not be treated as one.
//   3. Card b122c7d4: a THROWN resolution is its own loud state, not folded into "not main". Before this,
//      if `realpathSync.native` threw on either side, both `selfPath`/`argvPath` could end up null,
//      `isMain` was false, and the mismatch branch (which needs both non-null) could never fire either —
//      a silent skip with no output at all. Track whether each side THREW, separately from whether it
//      resolved to null for an ordinary reason (e.g. no argv[1]), and fail loudly on a real throw.
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
    console.error("❌ test-daemon.mjs: discovered ZERO hermetic tests — refusing to report a green suite that ran nothing.");
    process.exit(1);
  }
  const results = new Array(HERMETIC.length);
  const nextIndex = makeCursor(HERMETIC.length);
  await Promise.all(
    Array.from({ length: Math.min(POOL_SIZE, HERMETIC.length) }, (_, lane) => runLane(lane, HERMETIC, nextIndex, results)),
  );

  // Best-effort cleanup of the per-test temp homes (WAL handles may briefly hold a few on Windows).
  for (const root of tmpRoots) {
    for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ } }
  }

  // Card b122c7d4 DoD #1: assert the executed PATH SET against the discovered allowlist, by path, never
  // by count — a count (e.g. `results.length === HERMETIC.length`) can't distinguish "ran the right
  // files" from "ran the wrong files, same tally" (`runOne`'s own `fs.existsSync` skip path resolves
  // `ok:true` without ever spawning anything). Named, not just counted, so a future divergence is
  // diagnosable from this output alone.
  const executedNames = new Set(results.filter((r) => !r.skipped).map((r) => r.name));
  const notExecuted = HERMETIC.filter((name) => !executedNames.has(name));
  if (notExecuted.length) {
    console.error(`❌ test-daemon.mjs: ${notExecuted.length} discovered hermetic test(s) were NOT actually executed — naming them: ${notExecuted.join(", ")}`);
    process.exit(1);
  }

  const pass = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log(`\n${pass}/${HERMETIC.length} hermetic daemon tests passed. (pool size ${POOL_SIZE})`);
  // Card 12bdea9e: a test excluded here has no owner and no alarm — it decays silently and its decay
  // is invisible until someone happens to run it by hand. Naming the excluded set on EVERY gate run
  // (pass or fail) means the exclusion itself can never again go unnoticed, without paying the cost of
  // actually booting a live daemon here. Run one manually: `node dist/index.js` (some need extra env —
  // see the file's own header), then `node test/<name>.mjs` from packages/daemon.
  console.log(`ℹ NOT_HERMETIC (excluded from this gate — needs a live daemon and/or real claude; run manually, see each file's header): ${[...NOT_HERMETIC].sort().join(", ")}`);
  if (failed.length) {
    console.log("FAILURES:");
    // Echo each failed test's FULL captured stdout/stderr (not just the last line) — the individual
    // check() failures inside a test file were otherwise invisible in the CI log, which is exactly why a
    // Linux-only failure (card 45a23c27) shipped undiagnosable from CI output alone.
    for (const f of failed) {
      console.log(`  - ${f.name} (exit ${f.status}): ${f.tail ?? ""}`);
      if (f.stdout?.trim()) console.log(f.stdout.trimEnd().split("\n").map((l) => `      ${l}`).join("\n"));
      if (f.stderr?.trim()) console.log(f.stderr.trimEnd().split("\n").map((l) => `      ${l}`).join("\n"));
    }
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
