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
import { spawn, spawnSync } from "node:child_process";
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

const { hermetic: HERMETIC, violations: DISCOVERY_VIOLATIONS, notHermeticNames: NOT_HERMETIC_NAMES } = discoverHermeticTests(TEST_DIR);

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
  // Card fa52f555 Part 1: a `--count`/`--list` invocation does discovery ONLY — no test spawns — so a
  // manager can read the authoritative number without paying for a full run. Read here, before any of the
  // loud discovery-integrity refusals below, so those refusals also cover this mode (a count computed over
  // a broken discovery state would itself be a lie).
  const countOnly = process.argv.includes("--count") || process.argv.includes("--list");

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
