// Reads ONLY data/weaker-pass-evidence.json (no DB access) and reproduces every number in findings.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "weaker-pass-evidence.json"), "utf8"));

console.log("=== DoD-1/2: the specimen ===");
console.log(`Rows across the whole DB carrying retriedFile: ${data.specimenGateHistoryRows.filter((r) => r.kind === "build_gate").length}`);
for (const r of data.specimenGateHistoryRows) console.log(`  ${r.ts}  ${r.kind}  ${JSON.stringify(r.detail)}`);

const steps = data.specimenPendingGateOp.verdict_payload.steps;
const firstAttemptMs = steps.reduce((sum, s) => sum + s.durationMs, 0);
const totalMs = data.specimenPendingGateOp.verdict_payload.totalDurationMs;
const buildGateDurationMs = data.specimenGateHistoryRows.find((r) => r.kind === "build_gate").detail.durationMs;
const retryOwnMs = buildGateDurationMs - firstAttemptMs;
console.log(`\nFirst-attempt step sum: ${firstAttemptMs.toFixed(1)}ms (${(firstAttemptMs / 1000).toFixed(1)}s)`);
console.log(`build_gate event durationMs (gateStartedAt -> evt call, covers attempt 1 + retry): ${buildGateDurationMs}ms`);
console.log(`=> retry's OWN duration ≈ ${retryOwnMs.toFixed(1)}ms (${(retryOwnMs / 1000).toFixed(1)}s)`);
console.log(`(sanity: op-level totalDurationMs incl. squash-merge = ${totalMs}ms)`);

console.log("\n=== DoD-4a: wall-clock saved (this run) ===");
console.log(`Full first attempt (build+suite) cost ${(firstAttemptMs / 1000).toFixed(1)}s; the retry cost only ${(retryOwnMs / 1000).toFixed(1)}s`);
console.log(`=> saved ≈ ${((firstAttemptMs - retryOwnMs) / 1000).toFixed(1)}s vs. a hypothetical full re-run, on this run alone`);

console.log("\n=== DoD-4b: premise re-check — mgr #127's n=14/5-rejections ===");
const cardCreated = data.card344ce950.created_at;
console.log(`card 344ce950 created_at = ${cardCreated}`);
const runs = data.preFeatureBuildGateRuns;
const byBranch = new Map();
for (const r of runs) { if (!byBranch.has(r.branch)) byBranch.set(r.branch, []); byBranch.get(r.branch).push(r); }
function laterPassed(r) { return byBranch.get(r.branch).some((q) => q.ts > r.ts && q.passed); }

const before = runs.filter((r) => r.ts < cardCreated);
const last14total = before.slice(-14);
const rej14total = last14total.filter((r) => !r.passed);
console.log(`Last-14-TOTAL-RUNS reading (before card creation): n=${last14total.length}, rejections=${rej14total.length}, later-passed-same-branch=${rej14total.filter(laterPassed).length}`);

const allRejBefore = before.filter((r) => !r.passed);
const last14rej = allRejBefore.slice(-14);
console.log(`Last-14-REJECTIONS reading (before card creation): n=${last14rej.length}, later-passed-same-branch=${last14rej.filter(laterPassed).length}`);

const allRej = runs.filter((r) => !r.passed);
console.log(`\nFull pre-feature population: total build_gate runs=${runs.length}, rejections=${allRej.length}, later-passed-same-branch=${allRej.filter(laterPassed).length} (${(100 * allRej.filter(laterPassed).length / allRej.length).toFixed(1)}%)`);

console.log("\n=== DoD-4c: case study — is 'later passed on same branch' a bare re-run or a fix? ===");
for (const e of data.caseStudySessionEvents) console.log(`  ${e.ts}  ${e.kind}  ${JSON.stringify(e.detail).slice(0, 160)}`);
