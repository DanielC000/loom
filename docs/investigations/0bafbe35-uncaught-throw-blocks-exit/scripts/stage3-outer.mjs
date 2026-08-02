// Card 0bafbe35, Stage 3 (OUTER — this is the entry point). Mirrors
// packages/daemon/scripts/test-daemon.mjs's own runOne() as closely as possible: spawn stage3-inner.mjs
// as a raw child, TEST_TIMEOUT_MS=120000, child.kill() on timeout, status:"timeout"|exitCode, durationMs
// via Date.now() (matching that file's own card-17069e7e choice of Date.now over performance.now, for
// consistency with its own NDJSON schema — this is a one-shot investigation script, not a workflow
// script, so Date.now() is fine here).
// HOW TO RUN (from repo root, after `pnpm build`): expect the run to take ~120s and end in a forced kill.
//   node docs/investigations/0bafbe35-uncaught-throw-blocks-exit/scripts/stage3-outer.mjs
// MEASURED RESULT: see findings.md — status="timeout", durationMs=120047, tail character-for-character
// identical to the card's own recorded "GIVE-UP RECOVERY after 4 Enter attempts..." line.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const innerPath = path.join(import.meta.dirname, "stage3-inner.mjs");

const TEST_TIMEOUT_MS = 120_000; // exact value from packages/daemon/scripts/test-daemon.mjs:625

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loom-td-stage3-"));
let stdout = "";
let stderr = "";
let timedOut = false;

const startTs = Date.now();
console.log(`OUTER: launching child at iso=${new Date(startTs).toISOString()}, TEST_TIMEOUT_MS=${TEST_TIMEOUT_MS}`);
const child = spawn(process.execPath, [innerPath], {
  env: { ...process.env, LOOM_HOME: home, LOOM_TEST: "1" },
});

child.stdout.on("data", (d) => { const s = d.toString("utf8"); stdout += s; process.stdout.write(`  [child] ${s}`); });
child.stderr.on("data", (d) => { const s = d.toString("utf8"); stderr += s; process.stderr.write(`  [child-err] ${s}`); });

const timer = setTimeout(() => {
  timedOut = true;
  console.log(`OUTER: TEST_TIMEOUT_MS (${TEST_TIMEOUT_MS}ms) elapsed — calling child.kill() now, iso=${new Date().toISOString()}`);
  child.kill();
}, TEST_TIMEOUT_MS);

child.on("close", (status) => {
  clearTimeout(timer);
  const endTs = Date.now();
  const durationMs = endTs - startTs;
  const ok = !timedOut && status === 0;
  console.log(`\nOUTER: RESULT status=${JSON.stringify(timedOut ? "timeout" : status)} ok=${ok} durationMs=${durationMs} iso=${new Date(endTs).toISOString()}`);
  const tail = stdout.split("\n").filter(Boolean).slice(-8);
  console.log("OUTER: last 8 non-empty stdout lines:");
  for (const l of tail) console.log(`  ${l}`);
  // Isolate the exact GIVE-UP RECOVERY tail line(s) for a character-level diff against the card's own
  // recorded tail. NOTE (kept for the record, per findings.md): the GIVE-UP RECOVERY line is written via
  // console.error, i.e. it lands on STDERR — the first run of this script only scanned `stdout` here and
  // reported zero matches; the match was confirmed instead by direct inspection of the combined output.
  // Scanning both streams below fixes that for any future run of this script.
  const cardTail = "GIVE-UP RECOVERY after 4 Enter attempts — no engine output observed since the final Enter write; turn never confirmed started; recovering busy so the session doesn't wedge";
  const combined = `${stdout}\n${stderr}`;
  const giveUpLines = combined.split("\n").filter((l) => l.includes("GIVE-UP RECOVERY after"));
  console.log(`OUTER: GIVE-UP RECOVERY after... lines found (stdout+stderr): ${giveUpLines.length}`);
  for (const l of giveUpLines) {
    console.log(`  RAW: ${JSON.stringify(l)}`);
    const idx = l.indexOf("GIVE-UP RECOVERY after");
    const substr = idx >= 0 ? l.slice(idx, idx + cardTail.length) : "";
    console.log(`  char-for-char match against card's recorded tail: ${substr === cardTail}`);
    if (substr !== cardTail) console.log(`    observed: ${JSON.stringify(substr)}\n    card:     ${JSON.stringify(cardTail)}`);
  }
});
