#!/usr/bin/env node
// Splits today's per-file timing data (docs/investigations/6c1aadf7-daemon-suite-timing/data/
// per-file-timing.ndjson) into UNCHANGED / MODIFIED / NEW buckets relative to an old commit, and
// reports each bucket's n / mean / median / sum. Pure file reads -- no execution, no DB access.
//
// Usage (from repo root):
//   git ls-tree -r --name-only <OLD_SHA> -- packages/daemon/test | grep '\.mjs$' > /tmp/old-test-files.txt
//   git diff --name-only <OLD_SHA> HEAD -- packages/daemon/test > /tmp/changed-test-files.txt
//   node docs/investigations/e7d0e730-suite-floor-composition/scripts/composition-breakdown.mjs \
//     /tmp/old-test-files.txt /tmp/changed-test-files.txt \
//     docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson
import fs from "node:fs";
import path from "node:path";

const [, , oldTestFilesPath, changedTestFilesPath, perFileTimingPath] = process.argv;

const oldNames = new Set(
  fs.readFileSync(oldTestFilesPath, "utf8").trim().split("\n").map((p) => path.basename(p, ".mjs"))
);
const changedPaths = fs.readFileSync(changedTestFilesPath, "utf8").trim().split("\n").filter(Boolean);
const untouchedNames = new Set(
  // names present at OLD_SHA whose path never appears in the changed list
  [...oldNames].filter((n) => !changedPaths.some((p) => path.basename(p, ".mjs") === n))
);

const lines = fs.readFileSync(perFileTimingPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const fileRows = lines.filter((r) => r.kind === "file" && [6, 7, 8].includes(r.runIndex) && !r.skipped);
const byName = new Map();
for (const r of fileRows) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r.durationMs);
}

const buckets = { NEW: [], MODIFIED: [], UNCHANGED: [] };
for (const [name, durs] of byName) {
  const mean = durs.reduce((a, b) => a + b, 0) / durs.length;
  if (!oldNames.has(name)) buckets.NEW.push({ name, mean });
  else if (!untouchedNames.has(name)) buckets.MODIFIED.push({ name, mean });
  else buckets.UNCHANGED.push({ name, mean });
}

function stats(arr) {
  const vals = arr.map((x) => x.mean).sort((a, b) => a - b);
  const sum = vals.reduce((a, b) => a + b, 0);
  return { n: arr.length, meanMs: (sum / vals.length).toFixed(1), medianMs: vals[Math.floor(vals.length / 2)].toFixed(1), sumMs: sum.toFixed(0) };
}

for (const [label, arr] of Object.entries(buckets)) {
  console.log(label, JSON.stringify(stats(arr)));
}
const total = Object.values(buckets).reduce((a, b) => a + b.length, 0);
console.log("total classified:", total, "of", byName.size);
