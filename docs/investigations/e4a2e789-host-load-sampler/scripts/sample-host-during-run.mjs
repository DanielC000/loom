// Card e4a2e789 Stage 1 — an OS-level host-load sampler that samples DURING a run, not just
// before/after. Closes the blind spot named in the card's own retraction: `gate_queue` measures
// semaphore ADMISSION, own-fleet-busy-count sees only this project's workers, and the existing
// `hostSnapshot()` (packages/daemon/test/census/lib.mjs) is called only immediately before and after a
// batch — a spike mid-run is invisible to both endpoints. This script is a SEPARATE process, run
// concurrently with whatever is under study (a direct suite run, a real gate, or nothing at all), and
// writes condition-stamped NDJSON rows with real ISO timestamps — joinable against any other
// timestamped NDJSON (e.g. docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson,
// once that investigation lands) by finding rows whose `ts` falls inside a file's [startTsIso, endTsIso]
// window. This script does NOT itself run any test file, gate, or suite — it only observes.
//
// Per pinned memory `a-baseline-with-no-recorded-condition-is-not-a-baseline`: a reading with no recorded
// condition is folklore, not data. `--condition` is REQUIRED (not defaulted) so a caller cannot forget to
// stamp it. Use the card's own vocabulary: "SOLE GATE, NO DECLARED THIRD-PARTY LOAD" — never "quiet" or
// "idle" (per the same memory, a box running a gate is definitionally not quiet).
//
// Adds two measurements `hostSnapshot()` does not have, motivated by instance (5)'s
// `Error: AttachConsole failed` (conpty_console_list_agent.js:13) — a Windows console-handle failure:
//   - CPU% computed from os.cpus() tick deltas between consecutive samples (hostSnapshot has no CPU
//     reading at all; os.loadavg() is always [0,0,0] on Windows, so this is cross-sample tick deltas,
//     not loadavg).
//   - Windows OS-HANDLE counts (Get-Process HandleCount), broken out by process class: node-like
//     (node|esbuild|vite), conhost.exe (console-host processes; ConPTY sessions can spin these up — the
//     AttachConsole lead), claude-like, and system-wide total. A per-process handle table exhausting
//     would show as a rising ConhostHandleSum/TotalHandleSum well before it shows as CPU or memory
//     pressure — the failure mode CPU/memory sampling alone would miss.
//
// Usage (from repo root):
//   node docs/investigations/e4a2e789-host-load-sampler/scripts/sample-host-during-run.mjs \
//     --condition "SOLE GATE, NO DECLARED THIRD-PARTY LOAD" --interval-ms 2000 --duration-ms 60000 \
//     [--label "free text"] [--out <path>]
// Omit --duration-ms to sample until Ctrl-C (SIGINT) — a clean sampler-end row is still written.
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DAEMON_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "..", "packages", "daemon");
const { appendNdjson } = await import(pathToFileURL(path.join(DAEMON_DIR, "test", "census", "lib.mjs")).href);

const OUT_DEFAULT = path.join(import.meta.dirname, "..", "data", "host-samples.ndjson");

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? def : process.argv[i + 1];
}
const condition = argVal("--condition", null);
if (!condition) {
  console.error("Refusing to sample with no --condition. See pinned memory a-baseline-with-no-recorded-condition-is-not-a-baseline.");
  process.exit(1);
}
const intervalMs = Number(argVal("--interval-ms", 2000));
const durationMsArg = argVal("--duration-ms", null);
const durationMs = durationMsArg == null ? null : Number(durationMsArg);
const label = argVal("--label", null);
const out = argVal("--out", OUT_DEFAULT);

// Sum of all-core tick totals right now, for CPU% computed as a delta between two calls.
function cpuTicksNow() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    for (const t of Object.values(cpu.times)) total += t;
  }
  return { idle, total };
}

// One combined PowerShell call per sample (not one per process class) to keep sampler overhead bounded
// at high frequency. Never throws — a failed snapshot yields nulls for every PowerShell-derived field so
// a sampler run is never aborted by one bad sample (same discipline as census/lib.mjs hostSnapshot()).
function processAndHandleSnapshot() {
  const psCmd =
    "$p = Get-Process; " +
    "$nodeLike = $p | Where-Object { $_.ProcessName -match 'node|esbuild|vite' }; " +
    "$conhost = $p | Where-Object { $_.ProcessName -eq 'conhost' }; " +
    "$claude = $p | Where-Object { $_.ProcessName -match 'claude' }; " +
    "[PSCustomObject]@{ " +
    "NodeLikeCount=($nodeLike | Measure-Object).Count; " +
    "NodeLikeWorkingSetSum=($nodeLike | Measure-Object -Property WorkingSet64 -Sum).Sum; " +
    "NodeLikeHandleSum=($nodeLike | Measure-Object -Property HandleCount -Sum).Sum; " +
    "ConhostCount=($conhost | Measure-Object).Count; " +
    "ConhostHandleSum=($conhost | Measure-Object -Property HandleCount -Sum).Sum; " +
    "ClaudeCount=($claude | Measure-Object).Count; " +
    "ClaudeHandleSum=($claude | Measure-Object -Property HandleCount -Sum).Sum; " +
    "TotalProcessCount=($p | Measure-Object).Count; " +
    "TotalHandleSum=($p | Measure-Object -Property HandleCount -Sum).Sum " +
    "} | ConvertTo-Json -Compress";
  try {
    const outStr = execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, {
      encoding: "utf8",
      timeout: Math.min(Math.max(intervalMs - 200, 3000), 15000),
    });
    const parsed = JSON.parse(outStr);
    return {
      nodeLikeProcessCount: parsed.NodeLikeCount ?? null,
      nodeLikeWorkingSetMB: parsed.NodeLikeWorkingSetSum != null ? Math.round(parsed.NodeLikeWorkingSetSum / 1e6) : null,
      nodeLikeHandleSum: parsed.NodeLikeHandleSum ?? null,
      conhostProcessCount: parsed.ConhostCount ?? null,
      conhostHandleSum: parsed.ConhostHandleSum ?? null,
      claudeProcessCount: parsed.ClaudeCount ?? null,
      claudeHandleSum: parsed.ClaudeHandleSum ?? null,
      totalProcessCount: parsed.TotalProcessCount ?? null,
      totalHandleSum: parsed.TotalHandleSum ?? null,
      snapshotError: null,
    };
  } catch (err) {
    return {
      nodeLikeProcessCount: null, nodeLikeWorkingSetMB: null, nodeLikeHandleSum: null,
      conhostProcessCount: null, conhostHandleSum: null,
      claudeProcessCount: null, claudeHandleSum: null,
      totalProcessCount: null, totalHandleSum: null,
      snapshotError: String(err?.message ?? err),
    };
  }
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });

async function main() {
  const startTs = new Date().toISOString();
  const startedAtMs = Date.now();
  console.log(`[host-sampler] START ${startTs} condition="${condition}" intervalMs=${intervalMs} durationMs=${durationMs ?? "until SIGINT"}`);

  let prevTicks = cpuTicksNow();
  let sampleCount = 0;

  while (!stopping) {
    if (durationMs != null && Date.now() - startedAtMs >= durationMs) break;
    const iterStartMs = Date.now();

    const curTicks = cpuTicksNow();
    const idleDelta = curTicks.idle - prevTicks.idle;
    const totalDelta = curTicks.total - prevTicks.total;
    const cpuPct = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : null;
    prevTicks = curTicks;

    const procSnap = processAndHandleSnapshot();
    const freeMemMB = Math.round(os.freemem() / 1e6);
    const totalMemMB = Math.round(os.totalmem() / 1e6);

    appendNdjson(out, {
      kind: "host-sample-during",
      ts: new Date().toISOString(),
      tsEpoch: Date.now(),
      condition,
      label,
      intervalMsRequested: intervalMs,
      sampleIndex: sampleCount,
      cpuPct,
      cpuCount: os.cpus().length,
      freeMemMB,
      totalMemMB,
      usedMemPct: Math.round(((totalMemMB - freeMemMB) / totalMemMB) * 1000) / 10,
      ...procSnap,
    });
    sampleCount += 1;

    const elapsedThisTick = Date.now() - iterStartMs;
    await new Promise((r) => setTimeout(r, Math.max(0, intervalMs - elapsedThisTick)));
  }

  const endTs = new Date().toISOString();
  appendNdjson(out, {
    kind: "host-sample-run-end",
    ts: endTs,
    condition,
    label,
    startTs,
    endTs,
    sampleCount,
    stoppedBy: stopping ? "SIGINT" : "duration",
  });
  console.log(`[host-sampler] END ${endTs} sampleCount=${sampleCount} wrote ${out}`);
}

await main();
