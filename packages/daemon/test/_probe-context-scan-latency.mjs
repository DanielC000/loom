import "./_guard.mjs"; // arms LOOM_TEST=1 backstop (card 25f14a7b probe doesn't touch LOOM_HOME/DB at all —
// it only calls a pure fs-reading function against pre-existing REAL transcript files elsewhere on the
// host — imported anyway for convention/parity with every other test/probe in this directory).
//
// Card 25f14a7b DoD-4: does time-to-accept-a-submit vary with session context size AT ALL? This probe
// attacks a NARROWER, mechanism-level version of that question that is safe and cheap to measure directly
// (no real `claude` engine spawn, no new API spend, read-only against files that already exist):
//
//   `readContextStats` (sessions/context.ts) is called SYNCHRONOUSLY from pty/host.ts's Stop-hook
//   handler (deliverHook), INSIDE the M2 busy-gate window that runs from `setBusy(false)` to
//   `drainPending` with a documented "DO NOT INTRODUCE AN `await` IN THIS BRANCH" invariant (host.ts
//   ~line 4556-4595) — i.e. on the direct critical path to submitting the NEXT queued message. Despite
//   its own doc-comment calling it a "tail-scan", the actual implementation is `fs.readFileSync(file,
//   "utf8")` (whole file into memory) + `raw.split("\n")` + a `JSON.parse` per line — an O(file size)
//   operation, not a bounded tail read. A heavier-context session has a larger on-disk JSONL transcript
//   (verified below against this host's OWN real transcripts), so IF this parse cost is non-trivial and
//   scales with file size, that is a concrete, code-level mechanism for "the next submit takes longer to
//   get drained on a heavy-context session" — independent of, and much cheaper to test than, "the LLM
//   engine itself is slower to confirm with more context" (which would need a real, costly, risky engine
//   spawn at production context scale to test directly — see this card's own findings.md for why that
//   was NOT attempted here).
//
// METHOD: call the REAL, unmodified, compiled `readContextStats` (dist/sessions/context.js) against REAL
// transcript files already on this host (~/.claude/projects/**), spanning this project's own real file-size
// distribution (measured: p10=408KB, p50=1.54MB, p90=3.7MB, max=6.6MB, n=52 in the main loom project dir
// alone) — never synthetic filler. A bogus `cwd` is passed deliberately: `resolveTranscriptFile`'s direct
// path then always misses, forcing the fallback scan on the FIRST call for a given id (this is itself a
// positive control — that scan's cost was separately measured and documented at ~197ms avg against this
// project's own ~/.claude/projects, memory `resolve-transcript-file-fallback-scan-cost-measured`; landing
// near that figure here confirms this probe's methodology is sound) and the CACHED direct hit on every
// subsequent call for the same id (resolvedPathCache) — cleanly separating "find the file" (already
// measured elsewhere, scales with ~/.claude/projects/ dir COUNT, NOT with this file's own size) from "read
// + parse the file" (NOT previously measured, and the thing this probe actually targets, expected to scale
// with the FILE'S OWN size i.e. this session's own context).
//
// Run: 1) build (turbo builds shared first), 2) node test/_probe-context-scan-latency.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const { readContextStats } = await import("../dist/sessions/context.js");

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const LOOM_MAIN_DIR = path.join(PROJECTS_ROOT, "C--Users-danie--loom");

// Real files picked to span this project's own measured size distribution (see header) — smallest, ~p10,
// ~p50/lower-mid, ~p90, and two near the observed max. Filenames are real engine session ids (UUIDs)
// already on this host; nothing here was generated for this probe.
const CANDIDATES = [
  "dc25a3e8-af41-4230-b7e4-7211cc1af853", // 25,840 B  (smallest found)
  "b70270b4-10f9-4d4c-b113-a6ea6545ead9", //  99,284 B
  "2416184a-ac16-406a-b111-7072ea460050", // 1,379,025 B (~1.4MB)
  "9f1c6af8-6440-4fbb-a85a-b3bc319f23db", // 3,705,449 B (~3.7MB, p90)
  "66cf4dff-c8f4-4116-b60d-9d613ee3af07", // 4,811,954 B (~4.8MB)
  "afa7093c-beb2-4610-badd-74c02cb85646", // 6,645,109 B (~6.6MB, max)
];

const REPS = 5; // rep 1 = cold (pays the fallback scan once); reps 2-5 = warm (resolvedPathCache hit — pure parse cost)

console.log(`[measured] host ~/.claude/projects/ dir count (the fallback-scan cost driver, per the cited memory): ${fs.readdirSync(PROJECTS_ROOT).length}`);
console.log(`[measured] sampling ${CANDIDATES.length} REAL transcripts, ${REPS} reps each (rep1=cold/scan+parse, rep2-5=warm/parse-only)\n`);

const rows = [];
for (const id of CANDIDATES) {
  const filePath = path.join(LOOM_MAIN_DIR, `${id}.jsonl`);
  if (!fs.existsSync(filePath)) { console.log(`[skip] ${id} — file not found at ${filePath} (may have rotated/been cleaned up since this probe was written)`); continue; }
  const bytes = fs.statSync(filePath).size;

  const timesMs = [];
  let stats = null;
  for (let rep = 1; rep <= REPS; rep++) {
    const t0 = performance.now();
    stats = readContextStats("Z:\\definitely-not-a-real-project-cwd", id); // bogus cwd — forces fallback-scan resolution path
    const elapsed = performance.now() - t0;
    timesMs.push(elapsed);
  }
  const cold = timesMs[0];
  const warm = timesMs.slice(1);
  const warmAvg = warm.reduce((a, b) => a + b, 0) / warm.length;
  const warmMin = Math.min(...warm);
  const warmMax = Math.max(...warm);
  console.log(`[result] ${id} bytes=${bytes} ctxInputTokens=${stats?.inputTokens ?? "null"} turns=${stats?.turns ?? "null"} | cold(rep1, scan+parse)=${cold.toFixed(1)}ms | warm(rep2-5, parse-only) avg=${warmAvg.toFixed(1)}ms min=${warmMin.toFixed(1)}ms max=${warmMax.toFixed(1)}ms | all reps ms=[${timesMs.map((t) => t.toFixed(1)).join(", ")}]`);
  rows.push({ id, bytes, inputTokens: stats?.inputTokens ?? null, cold, warmAvg });
}

// Negative control: a file that does NOT exist anywhere — the fallback scan must pay its FULL cost (walks
// every dir, never early-exits on a hit) and readContextStats must return null, not throw and not fabricate a value.
{
  const bogusId = "00000000-0000-0000-0000-000000000000";
  const t0 = performance.now();
  const result = readContextStats("Z:\\also-not-real", bogusId);
  const elapsed = performance.now() - t0;
  console.log(`\n[negative control] nonexistent id ${bogusId}: result=${JSON.stringify(result)} (must be null) elapsed=${elapsed.toFixed(1)}ms (expected near the ~197ms documented full-scan-never-found cost, confirming this probe's cold-path timing is measuring the same thing that memory note measured)`);
  console.log(`[negative control] ${result === null ? "PASS — null, as expected for a genuinely absent transcript" : "FAIL — expected null"}`);
}

if (rows.length >= 2) {
  console.log("\n[summary] bytes vs warm parse-only avg ms (sorted by size):");
  for (const r of rows.slice().sort((a, b) => a.bytes - b.bytes)) {
    console.log(`  ${r.bytes.toString().padStart(9)} bytes  ctxInputTokens=${String(r.inputTokens).padStart(7)}  →  ${r.warmAvg.toFixed(1).padStart(7)} ms (warm, parse-only)`);
  }
  const smallest = rows.reduce((a, b) => (a.bytes < b.bytes ? a : b));
  const largest = rows.reduce((a, b) => (a.bytes > b.bytes ? a : b));
  const ratio = largest.warmAvg / Math.max(smallest.warmAvg, 0.001);
  console.log(`\n[summary] largest/smallest byte ratio=${(largest.bytes / smallest.bytes).toFixed(1)}x, corresponding warm-parse-latency ratio=${ratio.toFixed(1)}x`);
}
