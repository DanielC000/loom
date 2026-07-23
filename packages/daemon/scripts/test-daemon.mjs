// `pnpm --filter @loom/daemon test:daemon` — run the daemon's HERMETIC, claude-free test suite,
// isolated BY CONSTRUCTION: every test runs in its OWN fresh temp LOOM_HOME, on a non-4317 LOOM_PORT,
// with LOOM_TEST=1 set. So "run the daemon tests" can NEVER touch the prod db (~/.loom/loom.db) or the
// prod daemon on :4317 — the failure mode that wiped prod on 2026-06-04 (see test/_guard.mjs + the
// db.ts prod-guard). Each test ALSO arms its own guard (import "./_guard.mjs"), so this envelope is
// belt-and-suspenders, not the only line of defence.
//
// Run after a build (the tests import dist/):  pnpm --filter @loom/daemon build && pnpm --filter @loom/daemon test:daemon
//
// Tests are DISCOVERED by glob (mirrors the web suite's test/*.mjs pattern) — adding a new hermetic
// test file needs no edit here. Two kinds of file are excluded: helpers (a leading `_`, e.g.
// _guard.mjs, _trust-writer.mjs — not standalone tests) and the small NOT_HERMETIC denylist below,
// for tests that need a human-started isolated daemon and/or a real `claude` login. Run those
// manually per the header comment in each file.
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

const NOT_HERMETIC = new Set([
  "integration-e2e", "orchestration-e2e", "manager-live", "messaging", "mgmt-surface", "orch-scope",
  "orch-spawn", "mcp-scope", "platform-scope", "recycle", "scheduler", "scheduler-drain",
  "scheduler-disabled", "usage-limit-detect", "usage-limit-resume", "worker-report", "autonomy-rails",
  "busy-flag", "merge-gate", "board-consistency", "skills-e2e", "profiles-rest",
  "merge-confirm-slow-gate-pending", // ~20s wall-clock (a real 15s gate) + needs a manually-started daemon
  "web-build-no-orphans", // mutates the REAL packages/web/src/main.tsx + rebuilds the shared packages/web/dist
  // 2-3x (~5-20s each) to exercise turbo's actual cache — would race codescape-privacy-guard.mjs (which
  // reads that same dist) if run concurrently. Run manually per its own header comment.
]);

const HERMETIC = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => !f.startsWith("_"))
  .map((f) => f.slice(0, -4))
  .filter((name) => !NOT_HERMETIC.has(name))
  .sort();

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
const tmpRoots = [];

// Runs one test file on a fixed pool "lane" (its port for the whole run, so concurrent lanes never
// collide). Resolves to a result record; never rejects — a spawn error is captured as a failure.
function runOne(name, lane) {
  return new Promise((resolve) => {
    const file = path.join(TEST_DIR, `${name}.mjs`);
    if (!fs.existsSync(file)) { resolve({ name, ok: true, skipped: true }); return; }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), `loom-td-${name}-`));
    tmpRoots.push(home);
    const port = 4400 + lane; // fixed per-lane port — safe under concurrency (POOL_SIZE lanes, POOL_SIZE ports)

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1" },
    });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => { timedOut = true; child.kill(); }, TEST_TIMEOUT_MS);

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

const results = new Array(HERMETIC.length);
const nextIndex = makeCursor(HERMETIC.length);
await Promise.all(
  Array.from({ length: Math.min(POOL_SIZE, HERMETIC.length) }, (_, lane) => runLane(lane, HERMETIC, nextIndex, results)),
);

// Best-effort cleanup of the per-test temp homes (WAL handles may briefly hold a few on Windows).
for (const root of tmpRoots) {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ } }
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
