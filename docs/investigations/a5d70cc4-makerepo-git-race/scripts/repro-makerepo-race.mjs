// Repro harness for card a5d70cc4 — DoD-1: reproduce N concurrent makeRepo()-shaped
// `git init` chains on Windows, capture the raw failure text.
// Spawns N separate OS processes (repro-child-worker.mjs), each running the exact
// makeRepo() chain verbatim from packages/daemon/test/merge-rest-route-tracked.mjs:56-60,
// so this mirrors node --test's real pool-size-3 concurrency (separate processes), not
// just concurrent promises inside one event loop (execSync is synchronous and would
// serialize inside a single process).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, "repro-child-worker.mjs");

const N = Number(process.argv[2] || "3");
const ROUNDS = Number(process.argv[3] || "1");
const root = path.join(os.tmpdir(), `loom-repro-makerepo-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

function runChild(repo) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, repo], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ ok: false, repo, parseError: true, rawStdout: out, rawStderr: errOut, exitCode: code });
      }
    });
  });
}

async function main() {
  console.log(`root=${root} N=${N} ROUNDS=${ROUNDS}`);
  let totalFails = 0;
  let totalRuns = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const jobs = [];
    for (let i = 0; i < N; i++) {
      const repo = path.join(root, `r${round}-${i}`);
      jobs.push(runChild(repo));
    }
    const results = await Promise.all(jobs);
    for (const r of results) {
      totalRuns++;
      if (!r.ok) {
        totalFails++;
        console.log("FAIL", JSON.stringify(r, null, 2));
      }
    }
    console.log(`round ${round}: ${results.filter((r) => r.ok).length}/${N} ok`);
  }
  console.log(`TOTAL: ${totalRuns - totalFails}/${totalRuns} ok, ${totalFails} failed`);
  process.exitCode = totalFails > 0 ? 1 : 0;
}

main();
