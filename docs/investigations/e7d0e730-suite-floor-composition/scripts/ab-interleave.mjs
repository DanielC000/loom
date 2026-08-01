#!/usr/bin/env node
// Interleaved A/B timing harness for card e7d0e730's DoD-3 (fixed-file historical control).
// Compares a byte-identical test file run against an OLD-commit build vs the CURRENT build, on the
// same host, same hour -- a controlled retrospective re-execution rather than historical data mining
// (which doesn't exist: no per-file timing was ever captured before 2026-08-01).
//
// Design (per manager directive, card e7d0e730):
//   - 1 warmup run per tree per file, DISCARDED (first run pays cold OS/page-cache cost; in a naive
//     old-first order that bias lands entirely on the OLD arm, working AGAINST the "new is slower"
//     hypothesis -- so it's conservative, not just tidy).
//   - ABBA counterbalanced order: alternate old->new / new->old across pairs, so a systematic
//     within-pair position effect cancels in the aggregate instead of loading onto one arm.
//   - Pairs run ADJACENT IN TIME (never all-A-then-all-B) so a step change in host load BETWEEN pairs
//     shifts both arms of every subsequent pair equally and cancels in the per-pair difference; only a
//     A step change felt WITHIN a pair would still bias it, and adjacency minimizes that window.
//
// Usage: node ab-interleave.mjs <output.json>
// Requires: NEW_TREE built (normal `pnpm build`), OLD_TREE checked out + built separately (see
// findings.md's "Reproduce this" for the exact commit and build steps).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const NEW_TREE = process.env.AB_NEW_TREE || "packages/daemon"; // resolved relative to repo root when run from there
const OLD_TREE = process.env.AB_OLD_TREE; // must be set -- see findings.md for how to create this checkout
const FILES = ["companion-messages", "config-bounds"];
const PAIRS_PER_FILE = 6;
const NODE = process.execPath;

if (!OLD_TREE) {
  console.error("Set AB_OLD_TREE to an absolute path to a separate worktree/checkout of the OLD commit's packages/daemon, already built.");
  process.exit(1);
}

function runOnce(tree, file) {
  const start = Date.now();
  let ok = true, err = null;
  try {
    execFileSync(NODE, [`test/${file}.mjs`], { cwd: tree, stdio: "pipe", timeout: 60000 });
  } catch (e) {
    ok = false;
    err = e.message;
  }
  const end = Date.now();
  return { durationMs: end - start, ok, err, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

const report = { startedAt: new Date().toISOString(), files: {} };

for (const file of FILES) {
  console.error(`\n=== ${file} ===`);
  const warmOld = runOnce(OLD_TREE, file);
  const warmNew = runOnce(NEW_TREE, file);
  console.error(`warmup old=${warmOld.durationMs}ms(ok=${warmOld.ok}) new=${warmNew.durationMs}ms(ok=${warmNew.ok}) -- DISCARDED`);

  const pairs = [];
  for (let i = 0; i < PAIRS_PER_FILE; i++) {
    const oldFirst = i % 2 === 0; // ABBA: alternate starting order
    let oldRun, newRun, order;
    if (oldFirst) {
      oldRun = runOnce(OLD_TREE, file);
      newRun = runOnce(NEW_TREE, file);
      order = "old->new";
    } else {
      newRun = runOnce(NEW_TREE, file);
      oldRun = runOnce(OLD_TREE, file);
      order = "new->old";
    }
    const diff = newRun.durationMs - oldRun.durationMs;
    pairs.push({ pairIndex: i + 1, order, old: oldRun, new: newRun, diffNewMinusOld: diff });
    console.error(`pair ${i + 1} [${order}]: old=${oldRun.durationMs}ms(ok=${oldRun.ok}) new=${newRun.durationMs}ms(ok=${newRun.ok}) diff(new-old)=${diff}ms`);
  }
  report.files[file] = { warmup: { old: warmOld, new: warmNew }, pairs };
}

report.endedAt = new Date().toISOString();
const outPath = process.argv[2] || "ab-result.json";
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error("\nwrote result to", outPath);
