#!/usr/bin/env node
// READ-ONLY analysis for card 90678ee9 DoD-1/DoD-2, against the committed snapshot
// ../data/pool2-window-per-file-timing.ndjson (see extract-window.mjs for how it was pulled from the live
// ~/.loom/gate-timing/daemon-per-file-timing.ndjson and why this exact 17-run window was chosen).
//
// DoD-1 — key-stability + positive control:
//   our per-file identity field is `name` (a bare test-file identifier, e.g. "gate-cancel"), never an
//   absolute path — unlike the peer project's field, which carried a per-worktree hash segment and made a
//   naive cross-run join return 0 common files (indistinguishable from a genuinely re-drawn set). This
//   script's "positive control" table proves the join here is real: common-name counts between adjacent
//   runs are always non-zero and track the small testCount churn between runs, never the peer's failure
//   signature. A SECOND, stronger control reproduces the card's own already-published headline numbers
//   (fast-vs-slow aggregate ratio + top5/bottom5 file lists) directly from these raw rows — a broken join
//   could not have reproduced figures independently recorded elsewhere.
//
// DoD-2 — membership: is the inflated file set reliably the same files, or re-drawn run to run?
//   Computes per-file duration ratio (next run / this run) for every "heavy" file (baseline >= 8s, the
//   card's own threshold) across all 16 adjacent pairs in the window, reports each pair's dispersion (std
//   of ratios) and its set of files inflated >=1.5x, then checks how many DISTINCT files ever appear
//   inflated across the whole window vs. how many recur in more than one pair.
//
// Usage: node analyze-window.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.resolve(__dirname, "../data/pool2-window-per-file-timing.ndjson");

const HEAVY_MS = 8000; // the card's own "heavy file" threshold (fast run >= 8s)
const INFLATE_THRESH = 1.5; // the card's own worked-example threshold for "inflated"

function std(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function load(p) {
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const runs = lines.filter((r) => r.kind === "run-summary").sort((a, b) => a.runStartTs.localeCompare(b.runStartTs));
  const filesByRun = new Map();
  for (const r of lines) {
    if (r.kind !== "file") continue;
    if (!filesByRun.has(r.runUid)) filesByRun.set(r.runUid, new Map());
    filesByRun.get(r.runUid).set(r.name, r.durationMs);
  }
  return { runs, filesByRun };
}

function joinPair(mapA, mapB, heavyMs) {
  const namesA = new Set(mapA.keys());
  const namesB = new Set(mapB.keys());
  const common = [...namesA].filter((n) => namesB.has(n));
  const heavy = common.filter((n) => mapA.get(n) >= heavyMs);
  const ratios = heavy.map((n) => ({ name: n, ratio: mapB.get(n) / mapA.get(n) }));
  ratios.sort((x, y) => y.ratio - x.ratio);
  return { sizeA: namesA.size, sizeB: namesB.size, common: common.length, heavyCount: heavy.length, ratios };
}

const { runs, filesByRun } = load(snapshotPath);
console.log(`loaded ${runs.length} run-summary rows from ${snapshotPath}\n`);

console.log("=== DoD-1a: key-stability positive control — common-name count between adjacent runs ===");
console.log("(non-zero and tracking testCount churn = real join; 0 = the peer's broken-join signature)\n");
for (let i = 0; i < runs.length - 1; i++) {
  const a = runs[i], b = runs[i + 1];
  const mapA = filesByRun.get(a.runUid), mapB = filesByRun.get(b.runUid);
  const { sizeA, sizeB, common } = joinPair(mapA, mapB, 0);
  console.log(`  ${a.runStartTs} -> ${b.runStartTs}  sizeA=${sizeA} sizeB=${sizeB} common=${common}`);
}

console.log("\n=== DoD-1b: reproduce the card's own published headline numbers (2nd, stronger control) ===");
const fastRun = runs.find((r) => r.runUid === "1785899077914-1828");
const slowRun = runs.find((r) => r.runUid === "1785914317958-19828");
if (!fastRun || !slowRun) {
  console.error("FATAL: the card's own fast/slow runUids are not both present in the snapshot.");
  process.exit(1);
}
{
  const mapFast = filesByRun.get(fastRun.runUid), mapSlow = filesByRun.get(slowRun.runUid);
  const aggFast = [...mapFast.values()].reduce((a, b) => a + b, 0);
  const aggSlow = [...mapSlow.values()].reduce((a, b) => a + b, 0);
  const { heavyCount, ratios } = joinPair(mapFast, mapSlow, HEAVY_MS);
  console.log(`  fast aggregate: ${(aggFast / 1000).toFixed(1)}s   slow aggregate: ${(aggSlow / 1000).toFixed(1)}s   ratio: x${(aggSlow / aggFast).toFixed(4)}`);
  console.log(`  card's published figure: x1.438 aggregate — ${Math.abs(aggSlow / aggFast - 1.438) < 0.001 ? "MATCHES" : "DOES NOT MATCH"}`);
  console.log(`  heavy files (>=8s): ${heavyCount}`);
  console.log("  top5:", ratios.slice(0, 5).map((r) => `${r.name}:x${r.ratio.toFixed(3)}`).join(", "));
  console.log("  bottom5:", ratios.slice(-5).map((r) => `${r.name}:x${r.ratio.toFixed(3)}`).join(", "));
  console.log("  card's published top5: companion-git-push:x2.803, gate-cancel:x2.780, gate-timeout-circuit-breaker:x1.820, gate-semaphore-concurrency:x1.632, merge-gate-reuse:x1.476");
  console.log("  card's published bottom5: worker-kickoff-guarantee:x1.010, pty-giveup-clear:x1.004, pty-healifstuck-clear:x1.004, pty-mode-convergence:x1.003, pty-giveup-false-negative:x0.999");
}

console.log("\n=== DoD-2: per-pair dispersion + files inflated >=1.5x, across all 16 adjacent pairs ===");
const pairSummaries = [];
const inflatedOccurrences = new Map(); // name -> [{pairIdx, ratio}]
for (let i = 0; i < runs.length - 1; i++) {
  const a = runs[i], b = runs[i + 1];
  const mapA = filesByRun.get(a.runUid), mapB = filesByRun.get(b.runUid);
  const { heavyCount, ratios } = joinPair(mapA, mapB, HEAVY_MS);
  const ratioVals = ratios.map((r) => r.ratio);
  const dispersion = std(ratioVals);
  const inflated = ratios.filter((r) => r.ratio >= INFLATE_THRESH);
  for (const r of inflated) {
    if (!inflatedOccurrences.has(r.name)) inflatedOccurrences.set(r.name, []);
    inflatedOccurrences.get(r.name).push({ pairIdx: i, ratio: r.ratio });
  }
  pairSummaries.push({ pairIdx: i, from: a.runStartTs, to: b.runStartTs, dispersion, heavyCount, inflatedNames: inflated.map((r) => r.name) });
  console.log(
    `  pair${i} ${a.runStartTs} -> ${b.runStartTs}  dispersion(std)=${dispersion.toFixed(3)}  heavy=${heavyCount}  inflated(>=1.5x)=${inflated.length} [${inflated.map((r) => r.name).join(", ")}]`,
  );
}

console.log("\n=== Dispersion distribution summary ===");
const disps = pairSummaries.map((p) => p.dispersion);
console.log(`  min=${Math.min(...disps).toFixed(3)}  max=${Math.max(...disps).toFixed(3)}  mean=${(disps.reduce((a, b) => a + b, 0) / disps.length).toFixed(3)}`);
console.log(`  pairs with dispersion <= 0.114 (peer's own "no meaningful inflation" ceiling): ${disps.filter((d) => d <= 0.114).length}/${disps.length}`);
console.log(`  pairs with dispersion >= 0.159 (peer's own "real divergence" floor): ${disps.filter((d) => d >= 0.159).length}/${disps.length}`);

console.log("\n=== Membership: does any file recur as inflated (>=1.5x) across MULTIPLE pairs? ===");
const repeat = [...inflatedOccurrences.entries()].filter(([, occ]) => occ.length > 1);
repeat.sort((a, b) => b[1].length - a[1].length);
console.log(`  distinct files ever inflated >=1.5x: ${inflatedOccurrences.size}`);
console.log(`  files appearing in exactly 1 pair: ${[...inflatedOccurrences.values()].filter((o) => o.length === 1).length}`);
console.log(`  files recurring in >1 pair: ${repeat.length}`);
for (const [name, occ] of repeat) {
  console.log(`    ${name} -> ${occ.length} pairs: ${occ.map((o) => `pair${o.pairIdx}:x${o.ratio.toFixed(2)}`).join(", ")}`);
}
