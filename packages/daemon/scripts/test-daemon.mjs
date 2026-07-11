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
// temp LOOM_HOME, own port — so this is embarrassingly-parallel). Pool size defaults to
// os.availableParallelism() capped at MAX_CONCURRENCY (concurrent temp-SQLite DBs thrash IO past a
// point); override with LOOM_TEST_CONCURRENCY=<n> for tuning/debugging (e.g. =1 to force serial).
// Each of the fixed pool "lanes" owns one port for its whole run (4400+laneIndex), so concurrent
// workers never collide — unlike a file-index-derived port, which only avoided collisions when tests
// ran strictly one-at-a-time.
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
]);

const HERMETIC = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => !f.startsWith("_"))
  .map((f) => f.slice(0, -4))
  .filter((name) => !NOT_HERMETIC.has(name))
  .sort();

const MAX_CONCURRENCY = 8;
const POOL_SIZE = Math.max(
  1,
  Math.min(
    Number(process.env.LOOM_TEST_CONCURRENCY) || os.availableParallelism(),
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
if (failed.length) {
  console.log("FAILURES:");
  for (const f of failed) console.log(`  - ${f.name} (exit ${f.status}): ${f.tail ?? ""}`);
  process.exit(1);
}
console.log("✅ hermetic daemon suite green — never touched prod.");
