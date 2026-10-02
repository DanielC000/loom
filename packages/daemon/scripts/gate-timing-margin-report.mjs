// ─────────────────────────────────────────────────────────────────────────────────────────────
// gate-timing-margin-report.mjs — card 2403d1bc's cheap follow-up: flags any hermetic test file
// whose recorded `kind:"file"` duration in the gate-timing NDJSON exceeds 0.75x its EFFECTIVE
// per-file timeout ceiling (TEST_TIMEOUT_OVERRIDES, or the 120s blanket default), so this card's
// own hand-sweep doesn't have to be repeated by hand again later.
//
// @decision 2403d1bc — do not add this to STATIC_GUARD_REPO_PATHS or
// CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS: the gate-timing NDJSON it reads is host-local data, so a
// gating verdict here would depend on which machine ran it, not on the diff under review.
//
// RUN:
//   node packages/daemon/scripts/gate-timing-margin-report.mjs [--threshold=0.75]
// Prints a JSON array of {name, n, maxDurationMs, ceilingMs, ratio} for every non-codex-family
// file at or above the threshold, sorted by ratio descending, plus a one-line summary. Exits 1 if
// any file is flagged (so a manual invocation can script on it), 0 if none are, and non-zero with
// a message on a genuine read failure (most commonly: no gate-timing data on this host/LOOM_HOME).
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import readline from "node:readline";
import { GATE_TIMING_NDJSON, resolveEffectiveTimeoutMs } from "./test-daemon.mjs";
import { CODEX_REAL_SPAWN_SET } from "../test/_codex-real-spawn-lock.mjs";

const DEFAULT_THRESHOLD = 0.75;

function parseThreshold(argv) {
  const flag = argv.find((a) => a.startsWith("--threshold="));
  if (!flag) return DEFAULT_THRESHOLD;
  const value = Number(flag.slice("--threshold=".length));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--threshold must be a positive number, got: ${flag}`);
  }
  return value;
}

/** Reads every `kind:"file"` row from `ndjsonPath`, grouped by name, max duration per name
 *  (across pass AND fail rows alike — a real completed failure is still a real recorded duration,
 *  and a SIGTERM kill's own duration is ~its ceiling, which only makes it MORE likely to flag, not
 *  less; skipped rows are excluded since they never ran). Exported for direct unit testing. */
export async function collectMaxDurationsByName(ndjsonPath) {
  const perFile = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // a torn trailing line from a write-in-progress run — ignore, not our row to diagnose
    }
    if (obj.kind !== "file" || obj.skipped) continue;
    const prevMax = perFile.get(obj.name);
    if (prevMax === undefined || obj.durationMs > prevMax.maxDurationMs) {
      perFile.set(obj.name, { maxDurationMs: obj.durationMs, n: (prevMax?.n ?? 0) + 1 });
    } else {
      perFile.set(obj.name, { maxDurationMs: prevMax.maxDurationMs, n: prevMax.n + 1 });
    }
  }
  return perFile;
}

/** Pure computation over an already-collected {name -> {maxDurationMs, n}} map: resolves each
 *  non-codex name's effective ceiling and returns every entry at or above `threshold`, sorted by
 *  ratio descending. `resolveCeiling` is injected so this is unit-testable without the real
 *  TEST_TIMEOUT_OVERRIDES map or the codex lock's lazy import. */
export async function computeFlagged(perFile, { threshold = DEFAULT_THRESHOLD, codexSet = CODEX_REAL_SPAWN_SET, resolveCeiling = resolveEffectiveTimeoutMs } = {}) {
  const flagged = [];
  for (const [name, { maxDurationMs, n }] of perFile.entries()) {
    if (codexSet.has(name)) continue;
    const ceilingMs = await resolveCeiling(name);
    const ratio = maxDurationMs / ceilingMs;
    if (ratio >= threshold) {
      flagged.push({ name, n, maxDurationMs, ceilingMs, ratio: Number(ratio.toFixed(3)) });
    }
  }
  flagged.sort((a, b) => b.ratio - a.ratio);
  return flagged;
}

async function main() {
  const threshold = parseThreshold(process.argv.slice(2));
  let perFile;
  try {
    perFile = await collectMaxDurationsByName(GATE_TIMING_NDJSON);
  } catch (err) {
    console.error(`[gate-timing-margin-report] could not read ${GATE_TIMING_NDJSON}: ${err.message}`);
    console.error(`[gate-timing-margin-report] no gate-timing history on this host/LOOM_HOME yet — nothing to report.`);
    process.exit(2);
  }
  const flagged = await computeFlagged(perFile, { threshold });
  console.log(JSON.stringify(flagged, null, 2));
  if (flagged.length > 0) {
    console.error(`[gate-timing-margin-report] ${flagged.length} file(s) at or above ${threshold}x their effective ceiling — see TEST_TIMEOUT_OVERRIDES in test-daemon.mjs.`);
    process.exit(1);
  }
  console.error(`[gate-timing-margin-report] 0 file(s) at or above ${threshold}x their effective ceiling.`);
}

// Same isMain discipline as test-daemon.mjs's own entry point: only run when invoked directly,
// never when another script imports this module's exports (e.g. a future test file).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  await main();
}
