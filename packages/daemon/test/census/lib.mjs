// Shared helpers for the d39db2db suite-flake census + forced-pair probe harness.
// Reuses the REAL scripts/test-daemon.mjs discovery/exclusion logic (imports its NOT_HERMETIC export)
// so this harness's file set can never silently drift from the real gate's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

    const home = fs.mkdtempSync(path.join(os.tmpdir(), `loom-census-${name}-`));
    tmpRoots.push(home);

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
  for (const root of tmpRoots) {
    for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ } }
  }
  return { results, durationMs, poolSize };
}

export function appendNdjson(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
}
