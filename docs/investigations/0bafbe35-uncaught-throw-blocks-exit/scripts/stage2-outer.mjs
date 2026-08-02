// Card 0bafbe35, Stage 2 (OUTER — this is the entry point). Spawns stage2-inner.mjs as a REAL raw child
// process (same shape scripts/test-daemon.mjs's own runOne() uses: spawn, pipe stdio, time exit) and
// measures how long the child takes to exit after its own uncaught-throw marker — the residual's
// cleanest fork (see stage2-inner.mjs's own header for what it forces).
// HOW TO RUN (from repo root, after `pnpm build`):
//   node docs/investigations/0bafbe35-uncaught-throw-blocks-exit/scripts/stage2-outer.mjs
// Takes ~130s (95s forced wait + a 130s outer force-kill bound if the child never exits on its own).
// MEASURED RESULT: see stage2-inner.mjs's own header and findings.md.
import { spawn } from "node:child_process";
import path from "node:path";

const innerPath = path.join(import.meta.dirname, "stage2-inner.mjs");

const launchAt = performance.now();
console.log(`OUTER: launching child at iso=${new Date().toISOString()}`);
const child = spawn(process.execPath, [innerPath], { stdio: ["ignore", "pipe", "pipe"] });

let throwSeenAt = null;
let stopEvents = [];

function handleLine(line) {
  process.stdout.write(`  [child] ${line}\n`);
  if (line.includes("STAGE2-THROW-MARKER") && throwSeenAt === null) {
    throwSeenAt = performance.now();
    console.log(`OUTER: observed throw marker at +${(throwSeenAt - launchAt).toFixed(1)}ms since launch`);
  }
  const stopMatch = line.match(/STAGE2-STOP-(START|END) label=(\S+) sessionId=(\S+)(?: atMs=([\d.]+))?(?: durationMs=([\d.]+))?/);
  if (stopMatch) stopEvents.push({ at: performance.now() - launchAt, raw: line });
}

function wireLines(stream) {
  let carry = "";
  stream.on("data", (chunk) => {
    carry += chunk.toString("utf8");
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const l of lines) if (l.length) handleLine(l);
  });
}
wireLines(child.stdout);
wireLines(child.stderr);

const TIMEOUT_MS = 130_000; // generous outer bound so we can see if it genuinely never exits
const killTimer = setTimeout(() => {
  console.log(`OUTER: TIMEOUT — child did not exit within ${TIMEOUT_MS}ms, killing`);
  child.kill();
}, TIMEOUT_MS);

child.on("exit", (code, signal) => {
  clearTimeout(killTimer);
  const exitAt = performance.now();
  console.log(`OUTER: child exited code=${code} signal=${signal} at +${(exitAt - launchAt).toFixed(1)}ms since launch, iso=${new Date().toISOString()}`);
  if (throwSeenAt !== null) {
    console.log(`OUTER: RESULT msFromThrowMarkerToExit=${(exitAt - throwSeenAt).toFixed(1)}`);
  } else {
    console.log(`OUTER: RESULT no throw marker was ever observed (unexpected — check child output above)`);
  }
  console.log(`OUTER: stop events observed: ${stopEvents.length}`);
  for (const e of stopEvents) console.log(`  +${e.at.toFixed(1)}ms  ${e.raw}`);
});
