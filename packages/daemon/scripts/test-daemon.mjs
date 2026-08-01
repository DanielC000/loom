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
// collects every `.mjs` file, then splits it two ways. A leading `_` on ANY path segment — the file's own
// name, or any containing directory (e.g. _guard.mjs, _tmp-fixture.mjs, or a whole _scratch/ directory) —
// marks an intentional helper and is silently excluded, same as before (card e7bcb0df: this used to check
// only the file's basename, which let a file inside an underscore-prefixed DIRECTORY through as a
// candidate — see GAP 2 in that card). Everything else MUST look like a real test — carry an assertion
// marker (`check(`/`assert`/`throw new Error`/`process.exit(1)`) — or discovery REFUSES LOUDLY, naming
// the file, instead of silently spawning it and recording a pass: a non-test `.mjs` that merely imports
// cleanly and exits 0 is indistinguishable from a real pass by exit code alone (measured on `node:test`
// too — a zero-test file reports `# tests 1, # pass 1`), so "unexpected but ran anyway" is not a safe
// default here. This is on top of, and does not replace, the small NOT_HERMETIC denylist below for
// genuine tests that need a human-started isolated daemon and/or a real `claude` login — run those
// manually per the header comment in each file. Adding a new ordinary hermetic test file still needs no
// edit here: the allowlist is a derivation rule, not a static list.
//
// Card e7bcb0df: the walk above cannot audit itself — `HERMETIC` and the executed-path-set assertion
// below both derive from the SAME walk, so a file the walk fails to discover is silently absent from
// both sides and never noticed. `auditDiscoveryAgainstGit` (below) cross-checks the walk's TRAVERSAL
// against git's own tracked-file list — a genuinely independent second opinion — and runs in the real
// gate path before any test spawns. See that function's own doc comment for the anchoring/validation/
// raw-layer constraints and its tracked-files-only blind spot.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "..", "test");

// Card 17069e7e (DoD-2): per-file test durations, on the normal gate path, no flag required. Written
// LOOM_HOME-relative — NOT into this worktree — because a worker's (or the merge gate's) worktree is
// force-removed (`git worktree remove --force`, git/worktrees.ts `removeWorktree`) on the ORDINARY
// successful-merge path (SessionService's `gcWorktreeDir`), so anything written inside it is destroyed the
// moment the task merges. `process.env.LOOM_HOME || path.join(os.homedir(), ".loom")` duplicates
// packages/daemon/src/paths.ts's own `LOOM_HOME` constant rather than importing it — this script is plain
// JS, run standalone before any build, and importing the TS source (or a maybe-stale dist/) here would be
// its own footgun. This resolves correctly for every zero-argv caller: run_gate/the merge gate (the gate
// child inherits the daemon's full `process.env` unconditionally — see gate-runner.ts's `runGateStep`, so
// the daemon's real LOOM_HOME is just there), a human's local `pnpm --filter @loom/daemon test:daemon` (their
// own real ~/.loom — the same daemon they're running), and CI (ci.yml/release.yml — lands in the runner's
// own ephemeral home; harmless, just not persisted, which is fine since CI isn't this artifact's consumer).
//
// Deliberately a DIFFERENT filename from the investigation's own committed snapshot
// (docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson) — that file is a
// point-in-time, git-tracked artifact; this one is live-accumulating gate telemetry, and the two must never
// be confused. Same per-row schema (kind:"file"/kind:"run-summary", same field names), so the two stay
// trivially concatenable for comparison — plus one ADDITIVE field (`runUid` on both row kinds; see the
// gate-timing emission block in the isMain run below for why `runIndex` alone isn't collision-safe here).
const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const GATE_TIMING_NDJSON = path.join(LOOM_HOME, "gate-timing", "daemon-per-file-timing.ndjson");

// Card 17069e7e (CR follow-up, DIRECTIVE #3): tally, don't print, on each individual write failure. A
// single gate run calls `appendGateTimingRow` up to ~631 times (1 run-summary + one per test file) — if
// `LOOM_HOME` were ever unwritable, warning ON EVERY CALL would print up to 631 near-identical lines to
// stderr. The merge gate surfaces only a bounded ~4KB stdout+stderr TAIL on rejection (see gate-runner.ts's
// OUTPUT_TAIL_BYTES); that many lines would push the actual failing test's assertion clean out of that
// tail — the failure mode of this OBSERVABILITY feature would destroy the diagnostic output of the very
// suite it observes. So: silently count here; the isMain block prints ONE summary warning (if any failures
// occurred at all), after every row for the run has been attempted. NEVER reintroduce a per-call
// console.warn in the catch below.
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

/** Pure: the slowest `n` TIMED results (skipped/never-run entries have no `durationMs` and are excluded),
 *  descending. Exported so a test can drive it against synthetic result arrays directly. */
export function topSlowestFiles(results, n = 20) {
  return results
    .filter((r) => typeof r.durationMs === "number")
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, n);
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
//
// ⚠ Card fa52f555: hand-deriving the discovered test count from `git ls-tree`/`grep -c` (or any other
// tracked-file count) is UNSUPPORTED and WILL drift from the real number. Two exclusion layers already
// broke a hand-rolled count in production: (1) this very set — a naive count included every file under
// `fixtures/`/`census/`, which the walk never even descends into (668 vs. the real 646 at the time); (2)
// the underscore-prefix rule below (`isUnderscoreExcluded`) — a further ~18 files invisible to a count
// that only knows about (1) (646 vs. ~628, and even that corrected number wasn't certifiable, since it
// still didn't account for `looksLikeTest` violations). The ONLY authoritative number is `HERMETIC.length`
// (computed below) — read it from a real run's own "N/M hermetic daemon tests passed" line, or run this
// script with `--count` for the same number without running the suite.
const EXCLUDED_DIR_NAMES = new Set(["fixtures", "census"]);

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

// Card fa52f555 Part 2: a test-shaped file placed inside an EXCLUDED_DIR_NAMES subtree is, BY
// CONSTRUCTION, invisible to `walkMjsFiles`/`discoverHermeticTests`/the DISCOVERY_VIOLATIONS check above —
// it runs NEVER and SILENTLY, and nothing tells its author so (false coverage, worse than a miscount: card
// f106f28e is a real instance — test/census/lib-guards.test.mjs — that happens to be a legitimate,
// deliberately-manual test; nothing previously distinguished it from an accident).
//
// A bare "this is deliberate" marker is an unchecked claim — the same shape as a comment asserting safety
// with no argument attached. Every declaration must carry a non-empty REASON; a marker with an empty or
// missing reason is treated as ABSENT (still a violation), never silently accepted.
//
// Two markers, never conflated, because they mean different things to a reader of the `declared` echo
// (see the isMain block below):
//   `loom:gate-exempt: <reason>`  — a REAL test, deliberately run manually / out of band.
//   `loom:not-a-test: <reason>`   — NOT a test at all; it only trips the `looksLikeTest` heuristic (a
//     shared lib that throws for input validation, a CLI stub, a child-process fixture that calls
//     `process.exit(1)` to simulate an outcome). Folding this into `gate-exempt` would misrepresent it in
//     the echoed count as a manual test that exists, when no such test exists at all.
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

// Card e7bcb0df — an INDEPENDENT cross-check of the discovery walk's TRAVERSAL against git's own
// tracked-file list. GAP 1: `HERMETIC` and the executed-path-set assertion further below both derive from
// the SAME `walkMjsFiles` call, so a file the walk never discovers is missing from both sides and compares
// equal — an under-discovering walk runs fewer tests and reports GREEN. `git ls-files` is a genuinely
// independent second opinion on which files exist under test/, so this is the only thing that can catch
// that class of bug.
//
// Three deliberate constraints, each closing a real hole found while designing this check:
// (i) ANCHORED, not cwd-dependent. `git rev-parse --show-toplevel` and `git ls-files` both run with an
//     EXPLICIT `cwd` (never relying on `process.cwd()`), so calling this from the wrong working directory
//     can never silently change the answer. (`git ls-files` itself IS cwd-dependent — from the wrong cwd
//     it can return nothing at all, and an empty reference set would otherwise pass VACUOUSLY: `∅ ⊆
//     executedNames` is trivially true, both sides "fail" together and the check reports success. See (ii).)
// (ii) VALIDATED reference. A zero-size reference set (git reported no tracked files at all under
//      testDir) is a HARD ERROR — thrown, never silently treated as "nothing to compare". This is a floor
//      on the instrument's INPUT (does the yardstick exist at all), not on the measurement itself.
// (iii) RAW-LAYER comparison. `walkAllMjsFiles` applies NO exclusions (not even EXCLUDED_DIR_NAMES), and
//       the git reference is filtered to `.mjs` files only — nothing about underscore-prefixing,
//       NOT_HERMETIC, or assertion markers. Filtering the git list by those same classification rules
//       would make the reference inherit the walk's own classification logic, and a classification bug
//       would then sit on both sides and compare equal — independence lost again, one layer down. Only
//       TRAVERSAL is cross-checked here: does the walk see the same FILES git sees, full stop.
//
// BLIND SPOT: `git ls-files` sees TRACKED files only. A brand-new, never-`git add`-ed test file is
// invisible to this check — it protects the MERGE criterion (nothing tracked is silently dropped by the
// walk), NOT a worker's own local run with a genuinely new, not-yet-staged file. Never read a clean
// result here as total coverage.
//
// Reports both directions, named: `inGitNotWalked` (git-tracked, walk never saw it — the real GAP-1 class
// of bug; the caller treats this as fatal) and `walkedNotInGit` (walk saw it, git doesn't track it — an
// untracked stray; the caller treats this as a warning, not a failure — an untracked file is a normal
// local-development state, not evidence of a broken walk).
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
export const KNOWN_CLI_FLAGS = new Set(["--count", "--list", "--help", "-h"]);

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
  if (unrecognized.length) return { mode: "error", unrecognized };

  const onlyRaw = parseValueFlag(argv, "--only=");
  const excludeRaw = parseValueFlag(argv, "--exclude=");
  const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const exclude = excludeRaw ? excludeRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  return {
    mode: (argv.includes("--count") || argv.includes("--list")) ? "count" : "run",
    only,
    exclude,
    concurrency,
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

// Card e6e55f7a: a sibling harness (Codescape) prints a whole-run peak-RSS + max-inter-event-gap summary
// on every gate run, pass or fail — a night was spent hand-reconstructing both numbers because this gate
// didn't. Observation only (DoD-5: zero change to selection/ordering/concurrency/exit codes) — cheap
// `process.memoryUsage`-class reads on a timer, no per-test synchronisation, no added subprocess (DoD-6).
//
// SCOPE CAVEAT (kickoff-mandated, not decoration): there is no cheap, reliable, cross-platform way to sum
// a spawned test child's RSS without an added subprocess (no `/proc` on win32; a `tasklist`/`ps` shell-out
// would itself be the added subprocess DoD-6 forbids). So this tracks the RUNNER process only — this
// coordinating script, not its spawned test children — and the printed line says so explicitly rather than
// claiming "process tree" for what is really one process.
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

// Max gap between successive entries of a timestamp series (ms, same unit as `performance.now()`) — the
// same liveness notion `GATE_EXTEND_IDLE_MS` reasons about (a gate that goes quiet past it is refused its
// extension). Fewer than 2 timestamps means there's no gap to measure yet — 0, not NaN or a thrown error.
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
  return `# max inter-event gap (stall watchdog input): ${gapMs}ms${partialNote}`;
}

// Card e6e55f7a (manager follow-up, not the card's literal DoD but its PURPOSE): the harness itself
// dying mid-run — an uncaught exception, a hang killed externally, anything that aborts before the
// normal summary prints — is the single most opaque rejection mode this instrument exists to illuminate.
// GATE_EXTEND_IDLE_MS-style stall detection is exactly the case where the max-gap number matters most, and
// a DoD that covered every case except that one would be a technicality. So: wrap the actual run body.
// On success, resolve normally — the CALLER prints the two clean-path lines itself (unlabelled,
// full-confidence), unchanged from before. On failure, print BOTH lines HERE — labelled `partial: true` —
// then RETHROW THE SAME ERROR UNCHANGED. Never swallowed (this file IS the merge gate for every project on
// this daemon; a swallowed exception here would silently green a dead harness) and never a different exit
// code (the caller/Node's own default uncaught-exception handling is what decides that, exactly as it did
// before this wrapper existed — this function only ever observes and rethrows, never catches-and-exits).
// `runFn` does the actual test-running work; `log` is injectable so a hermetic test can capture output
// instead of asserting against real console.log side effects.
export async function runInstrumentedSuite(runFn, { sampleIntervalMs = 5000, log = console.log } = {}) {
  const rssTracker = createRssTracker();
  const completionTimestamps = [performance.now()];
  rssTracker.sample();
  const timer = setInterval(() => rssTracker.sample(), sampleIntervalMs);
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
// Safe DEFAULT when LOOM_GATE_TEST_CONCURRENCY is unset (card 301d8c01 — a bare `pnpm --filter @loom/daemon
// test:daemon`, no env override, is exactly the command a worker or the daemon-run merge gate runs
// unattended). Previously this fell back to `os.availableParallelism()`, which on a many-core
// self-hosting box let this command spike to `MAX_CONCURRENCY` lanes of concurrent temp-SQLite/
// in-process-daemon boots with nothing bounding it — that's what starved the live Codescape service.
// 2 is a conservative default; a beefier/known-safe host can still override upward via the env.
// Card ba3c9580: renamed from the generic `LOOM_TEST_CONCURRENCY`, which every project's gate child
// received regardless of whether its own harness happened to read that same generic name.
const DEFAULT_CONCURRENCY = 2;
const POOL_SIZE = Math.max(
  1,
  Math.min(
    Number(process.env.LOOM_GATE_TEST_CONCURRENCY) || DEFAULT_CONCURRENCY,
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
// even standalone, before any concurrent-gate contention is added on top).
// Raising TEST_TIMEOUT_MS itself would dull fast-fail for the ~296 OTHER hermetic tests that have nothing
// to do with git contention, so instead this is a small, explicit per-test override — same documented-list
// shape as NOT_HERMETIC above — giving just these git-heavy tests real headroom. A genuine infinite hang
// in any of them still gets killed and reported (verified: the same kill-and-report path fires and
// reports `status:"timeout"` regardless of the ceiling value), just at a ceiling actually sized for their
// real workload instead of one with zero margin.
// merge-confirm-completion-nudge.mjs used to carry an entry here too (measured 83-84s standalone,
// dominated by 6 deliberately real, un-injectable ~13s gate waits) — card 63bdd2cc made its sync-wait
// budget injectable (SessionService's `syncAttachBudgetMs` opt, card 0faaaa55's DI seam) so each real
// gate only needs to outlive a shrunk budget instead of the full 12s production one; measured 3/3
// standalone runs (single lane, post-e082bf4d-rebase build, commit 88915101): 33.5-33.8s — no measurable
// cost at the resolution that matters, ~3.5x under the 120s blanket TEST_TIMEOUT_MS with no override.
const TEST_TIMEOUT_OVERRIDES = {
  "merge-repo-mutex": 300_000, // 15 trials x 2 concurrent real merges + a full content-integrity sweep
  "merge-stranded-backstop": 300_000, // 2x createWorktree + reviewWorkerMerge/confirmWorkerMerge, all real git
  "gate-timeout-circuit-breaker": 300_000, // measured ~50-52s standalone (3 runs); ~6x headroom for 8 blocks x real union-merges/createWorktree/commits under concurrent gate contention
  "merge-gate-reuse": 360_000, // measured 52-58s x6 + one 130s outlier (7 standalone runs, quiet host); heaviest of these by git+merge-call volume and the one that actually timed out in production (card 2bb7a114) — ~6.7x the steady median / ~2.8x the observed outlier
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
    // Card 17069e7e: Date.now() (not performance.now()) to match the existing NDJSON schema's
    // startTs/endTs, which the standalone investigation script (test/census/lib.mjs's `runOneTimed`)
    // already stamps this same way.
    const startTs = Date.now();
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1" },
    });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timeoutMs = TEST_TIMEOUT_OVERRIDES[name] ?? TEST_TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      const endTs = Date.now();
      resolve({ name, ok: false, status: null, stdout, stderr: `${stderr}\n${err.message}`, lane, startTs, endTs, durationMs: endTs - startTs });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      const endTs = Date.now();
      const ok = !timedOut && status === 0;
      resolve({
        name,
        ok,
        status: timedOut ? "timeout" : status,
        stdout, stderr,
        tail: ok ? undefined : (stdout.split("\n").filter(Boolean).slice(-1)[0] || stderr.split("\n").filter(Boolean).slice(-1)[0]),
        lane, startTs, endTs, durationMs: endTs - startTs,
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

async function runLane(lane, names, nextIndex, results, completionTimestamps) {
  for (let idx = nextIndex(); idx !== null; idx = nextIndex()) {
    const name = names[idx];
    const result = await runOne(name, lane);
    results[idx] = result;
    // Card e6e55f7a: this PASS/FAIL line is the observable liveness signal a stall watchdog reads — the
    // same completion event `maxGapMs` measures gaps between. Recorded regardless of pass/fail.
    completionTimestamps.push(performance.now());
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
  // Card 05724a32: validate argv FIRST, before any discovery work, and FAIL CLOSED — an unrecognized flag
  // is a hard error, never a warn-then-proceed, because a warning that scrolls past on a run which then
  // takes ~20 minutes is the bug with extra text, not a fix.
  const cliMode = classifyCliArgs(process.argv.slice(2));

  if (cliMode.mode === "help") {
    console.log([
      "Usage: node scripts/test-daemon.mjs [--count | --list | --help]",
      "                                    [--only=name,name] [--exclude=name,name] [--concurrency=N]",
      "",
      "  (no flags)       run the full hermetic daemon suite — this is what the merge gate,",
      "                   package.json's test:daemon, and CI/release all invoke; unaffected by",
      "                   any flag below unless you actually pass one",
      "  --count          print discovery counts only (no tests run)",
      "  --list           alias for --count",
      "  --only=a,b       run ONLY these discovered hermetic test(s), by bare name",
      "  --exclude=a,b    run every discovered hermetic test EXCEPT these, by bare name",
      "  --concurrency=N  override the pool size for just this invocation (still clamped to",
      "                   the MAX_CONCURRENCY ceiling); LOOM_GATE_TEST_CONCURRENCY still applies",
      "                   when this is omitted",
      "  --help, -h       print this usage and exit",
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
    console.error("❌ test-daemon.mjs: discovered ZERO hermetic tests — refusing to report a green suite that ran nothing.");
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
    console.log(`  → hermetic tests this gate will run: ${HERMETIC.length}`);
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

  // Card 6185fbfc: resolve --only=/--exclude= against the discovered set, fail loudly on an unknown name
  // or an empty resulting selection (never silently run nothing). `SELECTED` is the SAME array reference
  // as `HERMETIC` when neither flag is given, so the zero-argv default path — package.json's test:daemon,
  // ci.yml, release.yml, the merge gate itself — prints no extra line and behaves byte-identically to
  // before this card.
  const selectionResult = resolveSelection(HERMETIC, { only: cliMode.only, exclude: cliMode.exclude });
  if (selectionResult.error) {
    console.error(`❌ test-daemon.mjs: ${selectionResult.error}`);
    process.exit(1);
  }
  const SELECTED = selectionResult.selected;
  if (SELECTED !== HERMETIC) {
    console.log(`ℹ selection active: running ${SELECTED.length}/${HERMETIC.length} discovered hermetic tests (--only/--exclude applied)`);
  }
  // Card 6185fbfc: --concurrency=N overrides the pool size for just this invocation (still clamped to
  // MAX_CONCURRENCY), leaving LOOM_GATE_TEST_CONCURRENCY-derived POOL_SIZE untouched when omitted — so
  // the zero-argv default path's concurrency is exactly what it was before this card.
  const EFFECTIVE_POOL_SIZE = cliMode.concurrency != null
    ? Math.max(1, Math.min(cliMode.concurrency, MAX_CONCURRENCY))
    : POOL_SIZE;

  // Card e6e55f7a: sample only around the actual test run, never during --count/--help/error paths above.
  // `runInstrumentedSuite` seeds the gap series with the run's own start (so a long stall BEFORE the
  // first completion is captured too, not just gaps between completions) and, on a genuine harness crash,
  // prints the two lines itself (labelled partial) before rethrowing — see that function's own comment.
  const RSS_SAMPLE_INTERVAL_MS = 5000;
  const results = new Array(SELECTED.length);
  // Card 17069e7e: wall-clock bounds for the gate-timing run-summary row + human summary below — captured
  // around the WHOLE instrumented run (lane execution + tmp cleanup + the executed-set assertion), not just
  // the lane dispatch, so it reads as "how long this gate run's test phase actually took" end to end.
  const gateTimingRunStartTs = new Date().toISOString();
  const gateTimingRunStartEpoch = Date.now();
  const gateTimingHostBefore = cheapHostSnapshot();
  const { rssTracker, completionTimestamps } = await runInstrumentedSuite(async (completionTimestamps) => {
    const nextIndex = makeCursor(SELECTED.length);
    await Promise.all(
      Array.from({ length: Math.min(EFFECTIVE_POOL_SIZE, SELECTED.length) }, (_, lane) => runLane(lane, SELECTED, nextIndex, results, completionTimestamps)),
    );

    // Best-effort cleanup of the per-test temp homes (WAL handles may briefly hold a few on Windows).
    for (const root of tmpRoots) {
      for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ } }
    }

    // Card b122c7d4 DoD #1: assert the executed PATH SET against the discovered allowlist, by path, never
    // by count — a count (e.g. `results.length === SELECTED.length`) can't distinguish "ran the right
    // files" from "ran the wrong files, same tally" (`runOne`'s own `fs.existsSync` skip path resolves
    // `ok:true` without ever spawning anything). Named, not just counted, so a future divergence is
    // diagnosable from this output alone.
    const executedNames = new Set(results.filter((r) => !r.skipped).map((r) => r.name));
    const notExecuted = SELECTED.filter((name) => !executedNames.has(name));
    if (notExecuted.length) {
      console.error(`❌ test-daemon.mjs: ${notExecuted.length} discovered hermetic test(s) were NOT actually executed — naming them: ${notExecuted.join(", ")}`);
      process.exit(1);
    }
  }, { sampleIntervalMs: RSS_SAMPLE_INTERVAL_MS });
  const gateTimingRunEndTs = new Date().toISOString();
  const gateTimingWallClockMs = Date.now() - gateTimingRunStartEpoch;

  const pass = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log(`\n${pass}/${SELECTED.length} hermetic daemon tests passed. (pool size ${EFFECTIVE_POOL_SIZE})`);
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

  // Card 17069e7e (DoD-2): per-file timing — human summary (unconditional, pass or fail, same placement as
  // the RSS/gap lines above) + a best-effort NDJSON artifact. Wrapped whole: this is observation only, and
  // must never affect this gate's own exit code — see appendGateTimingRow's own doc for why each write is
  // already individually guarded; this outer try/catch also guards the (pure, should-never-throw) summary
  // computation itself, belt-and-suspenders.
  try {
    // Card 6185fbfc reviewer note carried forward here too: a bare Date.now() run key collides across two
    // gates admitted in the same millisecond (maxConcurrentGates >= 2) — the exact defect card f5421d27
    // found in test/deploy-staleness.mjs's fixture names. `runIndex` stays numeric (Date.now()) for schema
    // compatibility with the existing investigation NDJSON; `runUid` adds process.pid so two concurrent gate
    // runs on this host can never share a join key, even if they start in the same ms.
    const gateTimingRunIndex = gateTimingRunStartEpoch;
    const gateTimingRunUid = `${gateTimingRunStartEpoch}-${process.pid}`;
    // gateTimingHostBefore was captured BEFORE runInstrumentedSuite ran (see above) — only the "after" side
    // is taken here, so the two snapshots actually bracket the run instead of both landing post-run.
    const gateTimingHostAfter = cheapHostSnapshot();
    appendGateTimingRow(GATE_TIMING_NDJSON, {
      kind: "run-summary",
      runIndex: gateTimingRunIndex,
      runUid: gateTimingRunUid,
      runStartTs: gateTimingRunStartTs,
      runEndTs: gateTimingRunEndTs,
      durationMs: gateTimingWallClockMs,
      poolSize: EFFECTIVE_POOL_SIZE,
      testCount: SELECTED.length,
      executedCount: results.filter((r) => !r.skipped).length,
      failedCount: failed.length,
      failedNames: failed.map((f) => f.name),
      hostBefore: gateTimingHostBefore,
      hostAfter: gateTimingHostAfter,
    });
    for (const r of results) {
      appendGateTimingRow(GATE_TIMING_NDJSON, {
        kind: "file",
        runIndex: gateTimingRunIndex,
        runUid: gateTimingRunUid,
        name: r.name,
        startTs: r.startTs ?? null,
        startTsIso: r.startTs != null ? new Date(r.startTs).toISOString() : null,
        endTs: r.endTs ?? null,
        endTsIso: r.endTs != null ? new Date(r.endTs).toISOString() : null,
        durationMs: r.durationMs ?? null,
        ok: r.ok,
        status: r.status ?? null,
        skipped: !!r.skipped,
        lane: r.lane ?? null,
      });
    }
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
