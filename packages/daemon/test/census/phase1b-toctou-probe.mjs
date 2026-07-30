// Phase 1b — retargeted per manager directive #4: a static grep for the peer's sharpened pattern
// (allocate a port → RELEASE it → a LATER, separate process re-acquires it) found a real candidate in
// PRODUCTION code: src/codescape/supervisor.ts's pickLoopbackPort() binds ephemeral (:0), reads the
// port, then CLOSES the socket before spawnServe() launches a separate child process that rebinds that
// same port number. "Go straight to forcing it" — only codescape-health-probe.mjs (14 real sup.start()
// calls) and codescape-supervisor.mjs (4 real sup.start() calls) actually exercise this path repeatedly;
// the other codescape-* test files only reference the class in imports/types, never call .start().
import path from "node:path";
import { runCensusBatch, appendNdjson } from "./lib.mjs";

const OUT = path.join(import.meta.dirname, "raw", "phase1b.ndjson");
function record(obj) { appendNdjson(OUT, { ts: new Date().toISOString(), ...obj }); }

async function runN(label, names, poolSize, reps) {
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const { results, durationMs } = await runCensusBatch({ names, poolSize, basePort: 4700 });
    const failed = results.filter((r) => !r.ok).map((r) => ({ name: r.name, status: r.status }));
    runs.push({ rep: i, durationMs, failed });
    console.log(`  [${label}] rep ${i + 1}/${reps}: ${failed.length ? "FAIL " + JSON.stringify(failed) : "clean"} (${durationMs}ms)`);
  }
  record({ step: "run", label, names, poolSize, reps, runs });
  return runs;
}

const NAMES = ["codescape-health-probe", "codescape-supervisor"];
console.log("=== Phase 1b: force codescape-health-probe + codescape-supervisor (both exercise real pickLoopbackPort()) ===");
const forced = await runN("toctou:forced-concurrent-2", NAMES, 2, 10);
const soloHealth = await runN("toctou:solo-health-probe", ["codescape-health-probe"], 1, 3);
const soloSup = await runN("toctou:solo-supervisor", ["codescape-supervisor"], 1, 3);

const forcedFails = forced.flatMap((r) => r.failed);
const soloFails = [...soloHealth, ...soloSup].flatMap((r) => r.failed);
console.log(`\nforced-concurrent fails: ${forcedFails.length}/${forced.length} runs | solo fails: ${soloFails.length}/${soloHealth.length + soloSup.length} runs`);
record({ step: "phase1b-summary", forcedFailCount: forcedFails.length, forcedRunCount: forced.length, soloFailCount: soloFails.length, soloRunCount: soloHealth.length + soloSup.length, forcedFails, soloFails });
