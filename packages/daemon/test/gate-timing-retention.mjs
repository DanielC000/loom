// Card f8b176f7 acceptance evidence: `compactGateTimingLogIfNeeded` (packages/daemon/scripts/lib/
// gate-timing-retention.mjs) bounds the growth of the gate-timing NDJSON without destroying cross-run
// comparability. Exercises the exported function directly against synthetic NDJSON content in a scratch
// dir — no real gate spawn needed (this is pure, synchronous fs logic), same reasoning
// test-daemon-gate-timing.mjs already established for the sibling appendGateTimingRow tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactGateTimingLogIfNeeded } from "../scripts/lib/gate-timing-retention.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gate-timing-retention-test-"));

/** Builds one run's worth of synthetic rows: a run-start, N file rows, and (unless `crashed`) a
 *  run-summary row — matching the real schema's field names closely enough for this module's own
 *  run-key/kind logic (it never reads any field this fixture omits). */
function makeRun(runUid, fileCount, { crashed = false } = {}) {
  const lines = [];
  lines.push(JSON.stringify({ kind: "run-start", runUid, runIndex: Number(runUid.split("-")[0]), poolSize: 2, testCount: fileCount, selected: [] }));
  for (let i = 0; i < fileCount; i++) {
    lines.push(JSON.stringify({ kind: "file", runUid, name: `file-${i}.mjs`, durationMs: 100 + i }));
  }
  lines.push(JSON.stringify({ kind: "host-sample", runUid, sampleIndex: 0, cpuBusyPct: 10 }));
  if (!crashed) {
    lines.push(JSON.stringify({ kind: "run-summary", runUid, poolSize: 2, testCount: fileCount, executedCount: fileCount, failedCount: 0, durationMs: 1000 + fileCount }));
  }
  return lines;
}

function writeNdjson(target, lines) {
  fs.writeFileSync(target, lines.join("\n") + "\n");
}

function readRows(target) {
  return fs.readFileSync(target, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ── below-threshold: a genuine no-op, proving the informative branch isn't the ONLY one exercised ────────
{
  const target = path.join(scratchRoot, "below-threshold.ndjson");
  const lines = [...makeRun("1-100", 5), ...makeRun("2-100", 5)];
  writeNdjson(target, lines);
  const before = fs.readFileSync(target, "utf8");

  const result = compactGateTimingLogIfNeeded(target, { triggerBytes: 10 * 1024 * 1024 });
  check("[negative control] a small file below the trigger is reported as NOT compacted", result.compacted === false && result.reason === "below-threshold");
  const after = fs.readFileSync(target, "utf8");
  check("[negative control] file content is byte-for-byte untouched when compaction skips", before === after);
}

// ── above-threshold: drive the writer past the threshold and prove a compaction ACTUALLY fires ────────────
{
  const target = path.join(scratchRoot, "above-threshold.ndjson");
  // 10 "old" runs (5 files each) + 3 "recent" runs (5 files each) — keepFullRuns=3 keeps only the last 3.
  const oldRuns = Array.from({ length: 10 }, (_, i) => makeRun(`${i}-old`, 5));
  const recentRuns = Array.from({ length: 3 }, (_, i) => makeRun(`${i}-recent`, 5));
  const allLines = [...oldRuns.flat(), ...recentRuns.flat()];
  writeNdjson(target, allLines);
  const beforeRows = readRows(target);
  const beforeCount = beforeRows.length;

  // triggerBytes:1 forces the informative branch to fire regardless of this fixture's real size — the
  // POSITIVE control this card's own kickoff demands: "a test that only writes below the threshold cannot
  // see this working or broken."
  const result = compactGateTimingLogIfNeeded(target, { triggerBytes: 1, keepFullRuns: 3, maxCompactedSummaries: 1000 });
  check("[positive control] compaction actually fires when above the (forced-low) threshold", result.compacted === true);
  check("row count dropped (old runs' file/host-sample/run-start rows were stripped)", result.afterRows < beforeCount && result.beforeRows === beforeCount);

  const afterRows = readRows(target);
  const oldRunUids = new Set(oldRuns.map((run) => JSON.parse(run[0]).runUid));
  const recentRunUids = new Set(recentRuns.map((run) => JSON.parse(run[0]).runUid));

  const oldSurvivors = afterRows.filter((r) => r.runUid && oldRunUids.has(r.runUid));
  check("every surviving OLD-run row is its run-summary (file/host-sample/run-start rows are gone)", oldSurvivors.length === oldRuns.length && oldSurvivors.every((r) => r.kind === "run-summary"));

  const recentSurvivors = afterRows.filter((r) => r.runUid && recentRunUids.has(r.runUid));
  const expectedRecentRowCount = recentRuns.reduce((sum, run) => sum + run.length, 0);
  check("every RECENT-run row survives untouched (full file/host-sample/run-start/run-summary detail)", recentSurvivors.length === expectedRecentRowCount);

  check("surviving run-summary rows are schema-identical to how they were written (DoD-4: still concatenable)", oldSurvivors.every((r) => typeof r.testCount === "number" && typeof r.durationMs === "number" && r.failedCount === 0));

  const afterBytes = fs.statSync(target).size;
  const beforeBytes = result.beforeBytes;
  check("the file actually shrank on disk", afterBytes < beforeBytes);
}

// ── hard ceiling: oldest compacted run-summary rows are dropped once maxCompactedSummaries is exceeded ────
{
  const target = path.join(scratchRoot, "ceiling.ndjson");
  // 5 old runs (crashed old runs never write run-summary — contribute 0 survivors on their own) + 5 clean
  // old runs (each contributes exactly 1 run-summary survivor) + 1 recent run (kept in full).
  const cleanOld = Array.from({ length: 5 }, (_, i) => makeRun(`${i}-clean-old`, 3));
  const crashedOld = Array.from({ length: 5 }, (_, i) => makeRun(`${i}-crashed-old`, 3, { crashed: true }));
  const recent = [makeRun("0-recent", 3)];
  writeNdjson(target, [...crashedOld.flat(), ...cleanOld.flat(), ...recent.flat()]);

  const result = compactGateTimingLogIfNeeded(target, { triggerBytes: 1, keepFullRuns: 1, maxCompactedSummaries: 2 });
  check("[positive control] the ceiling branch actually fires (drops beyond the cap)", result.compacted === true && result.droppedOldSummaries === 3);

  const afterRows = readRows(target);
  const cleanOldUids = cleanOld.map((run) => JSON.parse(run[0]).runUid);
  const survivingOldSummaries = afterRows.filter((r) => r.kind === "run-summary" && cleanOldUids.includes(r.runUid));
  check("exactly maxCompactedSummaries (2) old run-summary rows survive the ceiling", survivingOldSummaries.length === 2);
  // First-appearance order in the fixture is chronological (see makeRun call order above) — the two
  // SURVIVORS must be the two NEWEST clean-old runs (index 3 and 4), proving oldest-dropped-first, not an
  // arbitrary subset.
  const survivingIndices = survivingOldSummaries.map((r) => cleanOldUids.indexOf(r.runUid)).sort((a, b) => a - b);
  check("the survivors are the NEWEST old runs, not an arbitrary pair (oldest dropped first)", survivingIndices.length === 2 && survivingIndices[0] === 3 && survivingIndices[1] === 4);

  check("a crashed old run (no run-summary row) contributes zero survivors, never throws", afterRows.filter((r) => r.runUid && r.runUid.includes("crashed-old")).length === 0);
}

// ── never-fails: force the write step to fail and prove the caller still completes normally ───────────────
{
  const target = path.join(scratchRoot, "unwritable-target.ndjson");
  writeNdjson(target, makeRun("1-src", 3));
  const beforeContent = fs.readFileSync(target, "utf8");

  // Force the temp-file WRITE step (not the read/stat step) to fail: pre-create a DIRECTORY at exactly the
  // path this call will use as its temp file — fs.writeFileSync onto an existing directory throws EISDIR
  // on both POSIX and Windows, a reliable cross-platform "genuinely unwritable target", the same technique
  // test-daemon-gate-timing.mjs's own appendGateTimingRow tests already use (a file-where-a-dir-is-expected
  // trick, mirrored here as a dir-where-a-file-is-expected trick for the write side specifically).
  // SHARED MECHANISM with the real failure this guards against: both a full disk / permission-denied /
  // locked-file error and this EISDIR are a synchronous fs write call throwing INSIDE
  // compactGateTimingLogIfNeeded — the same outer try/catch in that function swallows either identically,
  // regardless of the specific errno.
  const forcedTmpPath = path.join(scratchRoot, "forced-tmp-is-a-dir");
  fs.mkdirSync(forcedTmpPath);

  let caught = null;
  let result;
  try {
    result = compactGateTimingLogIfNeeded(target, { triggerBytes: 1, tmpPath: forcedTmpPath });
  } catch (err) {
    caught = err;
  }
  check("[negative control] a forced write failure does NOT throw past this function", caught === null);
  check("the failure is reported, not silently swallowed into a false 'compacted:true'", result?.compacted === false && result?.reason === "write-failed");
  check("the real error (EISDIR) is surfaced, not a placeholder", result?.error?.includes("EISDIR") ?? false);

  const afterContent = fs.readFileSync(target, "utf8");
  check("[positive control] the SOURCE file is completely untouched when compaction fails mid-write", beforeContent === afterContent);
}

fs.rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅" : "❌"} gate-timing-retention: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
