#!/usr/bin/env node
// DoD-0 for card e75dc05a — HARD GATE. Validates the overlap reconstruction against the card's own
// known-truth controls BEFORE any trend analysis is reported. Reads only the committed JSON produced
// by extract-all-gate-admissions.mjs; no DB access.
//
// Four controls, all on 2026-08-01 (pinned from git commit dates, see findings.md):
//   POSITIVE 1: opId dbf1cd62, Loom, taskId 3fcd06d6 -> sha 5840938f (2026-08-01T02:43:10Z)
//               admitted ~02:20:05Z, joined ~02:33:03Z by Codescape opId bdb5a116, settled ~02:43Z
//               MUST classify mid-run-joined.
//   POSITIVE 2: opId 41eac0c6, Loom, taskId 48365fda -> sha 8b4a62e (2026-08-01T03:27:22Z)
//               admitted 2026-08-01T03:05:49Z, joined by Codescape opId ff192db9 admitted 03:18:08Z,
//               settled ~03:27Z. MUST classify mid-run-joined.
//   NEGATIVE A: opId edfb4c64, Loom, admitted 01:30:21Z (no taskId given in the card -- located by
//               admission time). MUST classify gate-uncontended-throughout (clean).
//   NEGATIVE B: opId 5b7f0bda, Loom, taskId 99fb882e -> sha 2cf77ccc (2026-08-01T03:04:06Z)
//               admitted 02:43:59.432Z, settled ~03:04Z. MUST classify clean.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.resolve(__dirname, "../data/all-gate-admissions.json");
const admissions = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// Overlap test between two intervals [admitMs, settleMs]. Strict: touching endpoints don't count as
// overlap (an admission at the exact instant another settles is not "mid-run").
function overlaps(a, b) {
  return a.admitMs < b.settleMs && b.admitMs < a.settleMs;
}

function classify(row) {
  const others = admissions.filter((o) => o !== row);
  const overlapping = others.filter((o) => overlaps(row, o));
  const joinedDuring = overlapping.filter((o) => o.admitMs > row.admitMs && o.admitMs < row.settleMs);
  return {
    overlappedAtAll: overlapping.length > 0,
    joinedMidRun: joinedDuring.length > 0,
    overlapping: overlapping.map((o) => ({
      opId: o.id, kind: o.kind, projectName: o.projectName, taskId: o.taskId,
      admitIso: o.admitIso, settleIso: new Date(o.settleMs).toISOString(),
    })),
  };
}

function findByTaskId(taskIdPrefix) {
  // orchestration_events.task_id stores the FULL task UUID; the card cites the short 8-char id.
  return admissions.filter((r) => r.taskId && r.taskId.startsWith(taskIdPrefix) && (r.kind === "build_gate" || r.kind === "build_gate_retry"));
}

function findByAdmitNear(isoTarget, projectName, toleranceMs = 5000) {
  const targetMs = Date.parse(isoTarget);
  return admissions
    .filter((r) => r.projectName === projectName && (r.kind === "build_gate" || r.kind === "build_gate_retry"))
    .filter((r) => Math.abs(r.admitMs - targetMs) <= toleranceMs)
    .sort((a, b) => Math.abs(a.admitMs - targetMs) - Math.abs(b.admitMs - targetMs));
}

let anyFail = false;
function report(label, candidates, expect) {
  console.log(`\n=== ${label} ===`);
  if (candidates.length === 0) {
    console.log("  NOT FOUND in the extracted series -- FAIL (cannot validate)");
    anyFail = true;
    return;
  }
  if (candidates.length > 1) {
    console.log(`  AMBIGUOUS: ${candidates.length} candidate rows matched -- listing all:`);
  }
  for (const row of candidates) {
    const { overlappedAtAll, joinedMidRun, overlapping } = classify(row);
    const settleIso = new Date(row.settleMs).toISOString();
    const pass = expect === "joined" ? joinedMidRun === true : overlappedAtAll === false;
    if (!pass) anyFail = true;
    console.log(`  row: taskId=${row.taskId ?? "(none)"} kind=${row.kind} admit=${row.admitIso} settle=${settleIso} durationMs=${row.durationMs} recorded-concurrentGates=${row.concurrentGates}`);
    console.log(`  => overlappedAtAll=${overlappedAtAll} joinedMidRun=${joinedMidRun} expect=${expect === "joined" ? "joinedMidRun=true" : "overlappedAtAll=false"} ${pass ? "PASS" : "*** FAIL ***"}`);
    if (overlapping.length > 0) {
      console.log(`  overlapping admissions found (${overlapping.length}):`);
      for (const o of overlapping) console.log(`    - ${o.projectName} ${o.kind} taskId=${o.taskId ?? "(none)"} admit=${o.admitIso} settle=${o.settleIso}`);
    }
  }
}

report("POSITIVE CONTROL 1 -- dbf1cd62 (taskId 3fcd06d6)", findByTaskId("3fcd06d6"), "joined");
report("POSITIVE CONTROL 2 -- 41eac0c6 (taskId 48365fda)", findByTaskId("48365fda"), "joined");
report("NEGATIVE CONTROL B -- 5b7f0bda (taskId 99fb882e)", findByTaskId("99fb882e"), "clean");
report("NEGATIVE CONTROL A -- edfb4c64 (admitted ~2026-08-01T01:30:21Z, Loom, no taskId given)",
  findByAdmitNear("2026-08-01T01:30:21Z", "Loom"), "clean");

console.log(`\n=== DoD-0 VERDICT: ${anyFail ? "*** AT LEAST ONE CONTROL FAILED -- STOP, DO NOT REPORT TREND NUMBERS ***" : "all controls PASS -- reconstruction validated"} ===`);
process.exit(anyFail ? 1 : 0);
