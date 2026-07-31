// loom:gate-exempt: card fa52f555 — a real manual probe/test, deliberately run out of band as part of the
// census investigation harness, never by the daemon's own hermetic gate.
// Phase 1 — forced deterministic probe (re-sequenced ahead of the expensive census per manager directive
// #3). Cheap: pairs of real files run together repeatedly, not the full 585-file suite.
//
// Step A: positive-control the PROBE ITSELF (distinct from Phase 0's harness positive-control) —
//   a known-colliding pair (collide-a/collide-b, share one fixed external path) must show failures when
//   run together and pass when run solo; a known-non-colliding pair (pc-pass-1/pc-pass-2) must always
//   pass together. If the probe can't tell these apart, its verdict on real pairs isn't trustworthy.
// Step B: force real candidate pairs — tests already flagged contention-sensitive by the codebase's own
//   TEST_TIMEOUT_OVERRIDES comments, plus the historically-implicated codescape-lifecycle-hooks and the
//   folded-in worker-spawn-cap-toctou-race (6c0a6fe5) — under 3 conditions per pair:
//     (a) forced-concurrent: pool=2, just these 2 files, repeated
//     (b) sequential-in-invocation at concurrency=1: pool=1, same 2 files, one harness invocation —
//         tests the peer's exact clue (their specimen failed 2/2 in-suite at concurrent=1, passed 1/1 solo)
//     (c) solo control: each file alone, nothing else in the invocation
import path from "node:path";
import { runCensusBatch, appendNdjson, hostSnapshot } from "./lib.mjs";

const OUT = path.join(import.meta.dirname, "raw", "phase1.ndjson");
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");

function record(obj) {
  appendNdjson(OUT, { ts: new Date().toISOString(), ...obj });
}

async function runN(label, names, poolSize, reps, sourceDirs) {
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const { results, durationMs } = await runCensusBatch({ names, poolSize, sourceDirs, basePort: 4600 });
    const failed = results.filter((r) => !r.ok).map((r) => ({ name: r.name, status: r.status }));
    runs.push({ rep: i, durationMs, failed });
    console.log(`  [${label}] rep ${i + 1}/${reps}: ${failed.length ? "FAIL " + JSON.stringify(failed) : "clean"} (${durationMs}ms)`);
  }
  record({ step: "run", label, names, poolSize, reps, runs });
  return runs;
}

console.log("=== Phase 1 Step A: positive-control the probe itself ===");
{
  const collideDirs = { "collide-a": path.join(FIXTURES_DIR, "collide-a.mjs"), "collide-b": path.join(FIXTURES_DIR, "collide-b.mjs") };
  const passDirs = { "pc-pass-1": path.join(FIXTURES_DIR, "pc-pass-1.mjs"), "pc-pass-2": path.join(FIXTURES_DIR, "pc-pass-2.mjs") };

  const collidingTogether = await runN("probe-control:known-colliding-together", ["collide-a", "collide-b"], 2, 5, collideDirs);
  const collideASolo = await runN("probe-control:collide-a-solo", ["collide-a"], 1, 3, collideDirs);
  const collideBSolo = await runN("probe-control:collide-b-solo", ["collide-b"], 1, 3, collideDirs);
  const nonCollidingTogether = await runN("probe-control:known-non-colliding-together", ["pc-pass-1", "pc-pass-2"], 2, 5, passDirs);

  const collideFailRate = collidingTogether.filter((r) => r.failed.length > 0).length / collidingTogether.length;
  const soloFailRate = [...collideASolo, ...collideBSolo].filter((r) => r.failed.length > 0).length / (collideASolo.length + collideBSolo.length);
  const controlFailRate = nonCollidingTogether.filter((r) => r.failed.length > 0).length / nonCollidingTogether.length;

  console.log(`\nProbe self-check: known-colliding-together fail rate ${(collideFailRate * 100).toFixed(0)}%, solo fail rate ${(soloFailRate * 100).toFixed(0)}%, known-non-colliding fail rate ${(controlFailRate * 100).toFixed(0)}%`);
  const probeValid = collideFailRate > 0 && soloFailRate === 0 && controlFailRate === 0;
  record({ step: "probe-self-check", collideFailRate, soloFailRate, controlFailRate, valid: probeValid });
  if (!probeValid) {
    console.log("❌ PROBE SELF-CHECK FAILED — the forced-pair probe cannot reliably distinguish a known collision from a known-clean pair. Stopping before testing real candidates; this needs to be fixed first.");
    process.exit(1);
  }
  console.log("✅ Probe self-check passed — trusted to judge real candidate pairs below.\n");
}

console.log("=== Phase 1 Step B: force real candidate pairs ===");
const PAIRS = [
  { label: "merge-gate-reuse+gate-timeout-circuit-breaker", a: "merge-gate-reuse", b: "gate-timeout-circuit-breaker" },
  { label: "merge-gate-reuse+merge-repo-mutex", a: "merge-gate-reuse", b: "merge-repo-mutex" },
  { label: "merge-gate-reuse+filler(wake)", a: "merge-gate-reuse", b: "wake" },
  { label: "codescape-lifecycle-hooks+merge-gate-reuse", a: "codescape-lifecycle-hooks", b: "merge-gate-reuse" },
  { label: "codescape-lifecycle-hooks+filler(wake)", a: "codescape-lifecycle-hooks", b: "wake" },
  { label: "worker-spawn-cap-toctou-race+merge-gate-reuse", a: "worker-spawn-cap-toctou-race", b: "merge-gate-reuse" },
];

const summary = [];
for (const { label, a, b } of PAIRS) {
  console.log(`\n--- pair: ${label} ---`);
  const before = hostSnapshot();
  const forced = await runN(`${label}:forced-concurrent-2`, [a, b], 2, 2, undefined);
  const sequential = await runN(`${label}:sequential-concurrency-1`, [a, b], 1, 1, undefined);
  const soloA = await runN(`${label}:solo-${a}`, [a], 1, 1, undefined);
  const soloB = await runN(`${label}:solo-${b}`, [b], 1, 1, undefined);
  const after = hostSnapshot();

  const forcedFails = forced.flatMap((r) => r.failed);
  const seqFails = sequential.flatMap((r) => r.failed);
  const soloFails = [...soloA, ...soloB].flatMap((r) => r.failed);
  const entry = { label, a, b, forcedFails, seqFails, soloFails, hostBefore: before, hostAfter: after };
  summary.push(entry);
  record({ step: "pair-summary", ...entry });
  console.log(`  => forced-concurrent fails: ${JSON.stringify(forcedFails)} | sequential(c=1) fails: ${JSON.stringify(seqFails)} | solo fails: ${JSON.stringify(soloFails)}`);
}

console.log("\n=== Phase 1 summary ===");
for (const s of summary) {
  const flag = (s.forcedFails.length && !s.soloFails.length) ? "⭐ CANDIDATE (fails together, clean solo)"
    : (s.seqFails.length && !s.soloFails.length) ? "⭐ CANDIDATE (fails sequential@c=1, clean solo — peer's exact signature)"
    : (s.forcedFails.length || s.seqFails.length || s.soloFails.length) ? "note: some failure, needs reading"
    : "clean";
  console.log(`${s.label}: ${flag}`);
}
record({ step: "phase1-complete", summary: summary.map((s) => ({ label: s.label, forcedFails: s.forcedFails, seqFails: s.seqFails, soloFails: s.soloFails })) });
