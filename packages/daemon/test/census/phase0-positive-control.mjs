// loom:gate-exempt: card fa52f555 — a real manual probe/test, deliberately run out of band as part of the
// census investigation harness, never by the daemon's own hermetic gate.
// Phase 0 — positive-control the census/probe harness itself, in BOTH directions, before trusting any
// "clean" result it reports later. Also: the manager's mandatory synthetic-dir-isolation safety check —
// prove a file placed under test/census/synthetic/ can NEVER be picked up by the REAL gate's discovery
// (scripts/test-daemon.mjs's fs.readdirSync(TEST_DIR) is shallow), by running that exact discovery with
// a synthetic file actually present and asserting the count is unchanged.
import fs from "node:fs";
import path from "node:path";
import { discoverHermetic, runCensusBatch, appendNdjson } from "./lib.mjs";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "raw", "phase0.ndjson");

function fixtureSourceDirs(names) {
  const map = {};
  for (const n of names) map[n] = path.join(FIXTURES_DIR, `${n}.mjs`);
  return map;
}

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

// --- 1. Known-good pair: both must pass, harness must report ok:true for both. ---
{
  const names = ["pc-pass-1", "pc-pass-2"];
  const { results, durationMs } = await runCensusBatch({
    names, poolSize: 2, sourceDirs: fixtureSourceDirs(names), basePort: 4590,
  });
  appendNdjson(OUT, { phase: "0", case: "known-good-pair", results, durationMs, ts: new Date().toISOString() });
  check("known-good pair: both pass", results.every((r) => r.ok));
}

// --- 2. Known-bad (deliberate failure): must report ok:false, non-timeout status. ---
{
  const names = ["pc-fail"];
  const { results } = await runCensusBatch({ names, poolSize: 1, sourceDirs: fixtureSourceDirs(names), basePort: 4592 });
  appendNdjson(OUT, { phase: "0", case: "known-bad-fail", results, ts: new Date().toISOString() });
  const r = results[0];
  check("known-bad (assertion failure): harness reports ok:false", r.ok === false);
  check("known-bad (assertion failure): status is a real nonzero exit, not timeout", r.status !== "timeout" && r.status !== 0);
  // node:test's default reporter writes the full TAP failure detail (assertion diff, stack) to STDOUT,
  // not stderr — so "untruncated evidence captured" means stdout OR stderr has content, not stderr specifically.
  check(
    "known-bad (assertion failure): full failure detail captured, untruncated (card 522cf573)",
    (!!r.stdout && r.stdout.length > 0) || (!!r.stderr && r.stderr.length > 0),
  );
  check("known-bad (assertion failure): captured detail includes the actual assertion diff", (r.stdout ?? "").includes("1 !== 2"));
}

// --- 3. Known-bad (deliberate timeout): must report ok:false, status:"timeout". ---
{
  const names = ["pc-timeout"];
  const { results } = await runCensusBatch({
    names, poolSize: 1, sourceDirs: fixtureSourceDirs(names), basePort: 4593,
    timeoutOverrides: { "pc-timeout": 2000 }, // fixture sleeps 10s; force a fast timeout for this check
  });
  appendNdjson(OUT, { phase: "0", case: "known-bad-timeout", results, ts: new Date().toISOString() });
  const r = results[0];
  check("known-bad (timeout): harness reports ok:false", r.ok === false);
  check("known-bad (timeout): status is exactly \"timeout\"", r.status === "timeout");
}

// --- 4. Synthetic-dir isolation safety check (manager's mandatory addition). ---
{
  const synthDir = path.join(import.meta.dirname, "synthetic");
  const probeFile = path.join(synthDir, "zz-isolation-probe.mjs");
  const { names: beforeNames } = await discoverHermetic();
  fs.writeFileSync(probeFile, "// isolation probe — must never be discovered by the real gate\n");
  let afterNames;
  try {
    ({ names: afterNames } = await discoverHermetic());
  } finally {
    fs.rmSync(probeFile, { force: true });
  }
  console.log(`real-gate discovery count BEFORE synthetic file exists: ${beforeNames.length}`);
  console.log(`real-gate discovery count WITH  synthetic file present: ${afterNames.length}`);
  check(
    "synthetic file under test/census/synthetic/ is INVISIBLE to the real gate's discovery (subdirectory, shallow readdirSync)",
    beforeNames.length === afterNames.length,
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} Phase 0 positive control: ${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
