// Shared helpers for the d39db2db suite-flake census + forced-pair probe harness.
// Reuses the REAL scripts/test-daemon.mjs discovery/exclusion logic (imports its NOT_HERMETIC export)
// so this harness's file set can never silently drift from the real gate's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged, unregister } from "../_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DAEMON_DIR = path.join(__dirname, "..", "..");
export const TEST_DIR = path.join(DAEMON_DIR, "test");

export async function discoverHermetic() {
  // Windows: dynamic import() needs a file:// URL, never a bare drive-letter path (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  const { NOT_HERMETIC } = await import(pathToFileURL(path.join(DAEMON_DIR, "scripts", "test-daemon.mjs")).href);
  const names = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => !f.startsWith("_"))
    .map((f) => f.slice(0, -4))
    .filter((name) => !NOT_HERMETIC.has(name))
    .sort();
  return { names, NOT_HERMETIC };
}

// Best-effort host snapshot: process count/working-set for node/esbuild/vite-shaped processes, plus
// generic OS stats. Never throws — a failed snapshot attempt just yields nulls for the PowerShell fields,
// so a probe/census run is never blocked on this being available.
export function hostSnapshot() {
  const base = {
    ts: new Date().toISOString(),
    cpuCount: os.cpus().length,
    freeMemMB: Math.round(os.freemem() / 1e6),
    totalMemMB: Math.round(os.totalmem() / 1e6),
  };
  try {
    const psCmd = "Get-Process | Where-Object { $_.ProcessName -match 'node|esbuild|vite' } | " +
      "Measure-Object -Property WorkingSet64 -Sum | Select-Object -Property Count,Sum | ConvertTo-Json -Compress";
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, { encoding: "utf8", timeout: 15000 });
    const parsed = JSON.parse(out);
    return { ...base, nodeLikeProcessCount: parsed.Count ?? 0, nodeLikeWorkingSetMB: Math.round((parsed.Sum ?? 0) / 1e6) };
  } catch (err) {
    return { ...base, nodeLikeProcessCount: null, nodeLikeWorkingSetMB: null, snapshotError: String(err?.message ?? err) };
  }
}

const TEST_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_OVERRIDES = {
  "merge-repo-mutex": 300_000,
  "merge-stranded-backstop": 300_000,
  "gate-timeout-circuit-breaker": 300_000,
  "merge-gate-reuse": 360_000,
  "merge-confirm-completion-nudge": 240_000,
};

// Resolves a test's spawn path — either the real TEST_DIR (hermetic suite files) or a synthetic/fixture
// dir passed in `sourceDirs` (keyed by name). Lets composition runs mix real + synthetic files without
// ever touching the real test/ directory.
function resolveFile(name, sourceDirs) {
  if (sourceDirs && sourceDirs[name]) return sourceDirs[name];
  return path.join(TEST_DIR, `${name}.mjs`);
}

const activeChildren = new Set(); // own-PID tracking only — never kill by name/port.

export function killAllTrackedChildren() {
  for (const child of activeChildren) {
    try { child.kill(); } catch { /* already dead */ }
  }
}

function runOneTimed(name, lane, { port, sourceDirs, tmpRoots, timeoutOverrides }) {
  return new Promise((resolve) => {
    const file = resolveFile(name, sourceDirs);
    if (!fs.existsSync(file)) { resolve({ name, ok: true, skipped: true }); return; }

    const home = mkdtempManaged(`loom-census-${name}-`);
    tmpRoots.push(home); // kept for diagnostics only — mkdtempManaged already owns guaranteed cleanup

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const startTs = Date.now();
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1" },
    });
    activeChildren.add(child);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timeoutMs = timeoutOverrides?.[name] ?? TEST_TIMEOUT_OVERRIDES[name] ?? TEST_TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* noop */ } }, timeoutMs);

    const finish = (status) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      const endTs = Date.now();
      const ok = !timedOut && status === 0;
      resolve({
        name, ok, lane, startTs, endTs, durationMs: endTs - startTs,
        status: timedOut ? "timeout" : status,
        // Full untruncated output kept ONLY for failures — card 522cf573: a bounded tail hides exactly
        // the evidence a census needs.
        stdout: ok ? undefined : stdout,
        stderr: ok ? undefined : stderr,
      });
    };
    child.on("error", (err) => { stderr += `\n${err.message}`; finish(null); });
    child.on("close", (status) => finish(status));
  });
}

function makeCursor(length) {
  let next = 0;
  return () => (next < length ? next++ : null);
}

async function runLane(lane, names, nextIndex, results, ctx) {
  for (let idx = nextIndex(); idx !== null; idx = nextIndex()) {
    const name = names[idx];
    const result = await runOneTimed(name, lane, ctx);
    results[idx] = result;
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `  (exit ${result.status})`}`);
  }
}

// Runs `names` (a list of hermetic test-basenames, optionally including synthetic ones resolved via
// `sourceDirs`) at the given pool size, on fixed per-lane ports (basePort+lane, mirroring the real
// harness's per-lane-port-for-the-whole-run scheme). Returns { results, durationMs, poolSize }.
export async function runCensusBatch({ names, poolSize, sourceDirs, basePort = 4500, timeoutOverrides }) {
  const tmpRoots = [];
  const results = new Array(names.length);
  const nextIndex = makeCursor(names.length);
  const start = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(poolSize, names.length) }, (_, lane) =>
      runLane(lane, names, nextIndex, results, { port: basePort + lane, sourceDirs, tmpRoots, timeoutOverrides })),
  );
  const durationMs = Date.now() - start;
  // Early release, not the sole guarantee: a long multi-batch census run wants dirs freed per-batch, not
  // deferred to final process exit (unlike a single daemon test file, this lib can be called many times in
  // one process). mkdtempManaged already registered every root; only unregister on PROVEN removal so a
  // FAILED attempt here still leaves the exit-hook backstop to retry it later (card 995be21f §THE
  // COMPOSITION BUG — never deregister on an unverified removal).
  for (const root of tmpRoots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (err) { console.error(`[tmp] retained for backstop: ${root} — ${err}`); }
    if (!fs.existsSync(root)) unregister(root);
  }
  return { results, durationMs, poolSize };
}

export function appendNdjson(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
}

// Reads an NDJSON file into an array of parsed row objects. A missing file reads as `[]` (a fresh
// census file legitimately doesn't exist yet), not an error.
export function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Card f106f28e: refuses LOUDLY (throws, naming the colliding index) if `runIndex` already appears among
// `existingRows` for `phase`. This is the read-back that was previously entirely absent —
// phase2-baseline.mjs used to derive `runIndex` from `--start`/`--count` argv alone, so a replacement
// invocation racing an original that was still running (a `worker_redirect` that interrupted the worker's
// turn but not its detached background task) silently appended a second row at the same index
// (raw/baseline.ndjson rows 4 & 5, both runIndex:4). Per `ambiguity-fail-toward-duplicate-never-loss`:
// refusing the write is the safe direction — the run itself is reproducible, a silently-duplicated
// dataset is not.
export function assertRunIndexAvailable(existingRows, runIndex, phase) {
  const collision = existingRows.find((r) => r.phase === phase && r.runIndex === runIndex);
  if (collision) {
    throw new Error(
      `runIndex ${runIndex} already exists for phase "${phase}" (recorded at ${collision.ts}) — refusing to append a duplicate row. Pass a different --start, or omit --start to derive the next free index from the file.`,
    );
  }
}

// The next free `runIndex` for `phase`, derived from the file itself (max existing + 1, or 1 if none) —
// so two concurrent invocations that both omit `--start` don't independently mint the same label.
// `--start` still lets a deliberate re-run override this default; `assertRunIndexAvailable` above gates
// the result either way, so an explicit override that collides is still refused, never silently accepted.
export function nextRunIndex(existingRows, phase) {
  const indices = existingRows.filter((r) => r.phase === phase).map((r) => r.runIndex);
  return indices.length ? Math.max(...indices) + 1 : 1;
}

// A row's wall-clock window. Prefers hostBefore.ts/hostAfter.ts — sampled right around the actual test
// run — over the row's own top-level `ts`, which is sampled at record-construction time, after the run
// has already finished (so it approximates the window's END, not a useful START).
function rowWindow(row) {
  return { start: row.hostBefore?.ts ?? row.ts, end: row.hostAfter?.ts ?? row.ts };
}

// Card f106f28e DoD #4/#5: which of `existingRows`' wall-clock windows overlap `newRow`'s, for `phase` —
// COMPUTED from hostBefore/hostAfter timestamps only, never self-reported (the prior `knownConcurrentActivity`
// free-text annotation was FALSE for row 1 — it missed an entire merge gate overlap — which is exactly why
// classification must key on a measured covariate, not an annotation). Returns the colliding runIndex
// values, sorted ascending. Does not refuse anything — an overlapping run is still real data (e.g. the
// accidental load-stress arm behind card 28279371), just flagged so a reader doesn't have to re-derive
// the overlap by hand the way the f106f28e audit did.
export function computeOverlappingRunIndices(existingRows, newRow, phase) {
  const { start: newStart, end: newEnd } = rowWindow(newRow);
  const overlapping = [];
  for (const row of existingRows) {
    if (row.phase !== phase) continue;
    const { start, end } = rowWindow(row);
    if (newStart < end && start < newEnd) overlapping.push(row.runIndex);
  }
  return overlapping.sort((a, b) => a - b);
}

// Card f106f28e DoD #3: summarizes which of a `runCensusBatch()` `results` array actually EXECUTED (a
// result is `skipped:true` only when `runOneTimed` couldn't resolve the test's file — see its own
// `fs.existsSync` check). Without this, a persisted row's `testCount` is a PRE-COMPUTED CONSTANT set
// before any test runs, and `failed` is a pure blacklist of non-ok results — so `failedCount: 0` cannot
// distinguish "ran and passed" from "silently never ran". Bounded: one name per test (~585), never full
// output.
export function summarizeExecuted(results) {
  const executed = results.filter((r) => !r.skipped);
  return { executedCount: executed.length, executedNames: executed.map((r) => r.name).sort() };
}
