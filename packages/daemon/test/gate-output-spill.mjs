import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a16c580b: a settled gate's FULL child output must be recoverable by opId — the only durable record
// today (`gate_status.outputTail`) is a bounded ~4KB (or content-selected ~16KB on a failure) ring, cut
// mid-line, with no second copy anywhere. This proves the fix: `runGateStep`/`runGateSequential`'s new
// `spillFile` param streams every captured byte to a file, independent of the bounded ring — and that the
// retention sweep (`pruneGateSpills`) actually bounds the count of retained files.
//
// REAL spawn (real `node` children), no daemon/DB — drives orchestration/gate-runner.js +
// orchestration/gate-spill.js directly. Every spill file in this suite is written under a throwaway
// mkdtemp'd dir, NEVER the real LOOM_HOME/gate-output — the module's own `gateSpillPath`/`GATE_SPILL_DIR`
// are exercised separately (pure path derivation, no fs) so this file never touches the developer's real
// `~/.loom`.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-output-spill.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const { runGateStep, runGateSequential } = await import("../dist/orchestration/gate-runner.js");
const { gateSpillPath, pruneGateSpills, GATE_SPILL_DIR, GATE_SPILL_MAX_BYTES } = await import("../dist/orchestration/gate-spill.js");

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

const cwdDir = mkdtempManaged("loom-gs-cwd-");
const outDir = mkdtempManaged("loom-gs-out-");

// ── (A) NEGATIVE CONTROL — no `spillFile` given: byte-identical to pre-card behavior, no file anywhere. ──
{
  fs.writeFileSync(path.join(cwdDir, "ok.mjs"), "console.log('hello'); process.exit(0);");
  const res = await runGateStep("node ok.mjs", cwdDir, 15_000);
  check("(A) with no spillFile, outputFile is undefined", res.outputFile === undefined);
  check("(A) nothing was written under outDir (proves opt-in — a caller that never asks gets no file at all)",
    fs.readdirSync(outDir).length === 0);
}

// ── (B) THE ACCEPTANCE BAR — a genuinely oversized PASSING run: outputTail (the OLD path) evicts an early
//     marker; outputFile (the NEW path) recovers it in full. A PASSING step's outputTail is ALWAYS the
//     plain positional tail (gate-runner.ts's own `tail()`, never content-selected — that branch is
//     failure-only), so this is the cleanest possible proof: the marker's eviction from outputTail is
//     GUARANTEED by construction, not a probabilistic content-selection outcome. ──────────────────────────
{
  const MARKER = "EARLY-MARKER-must-survive-in-the-spill-file-only";
  // > OUTPUT_TAIL_BYTES (4096) of padding AFTER the marker — pushes it out of the positional ring.
  const PADDING_LINES = Array.from({ length: 400 }, (_, i) => `console.log('padding line ${i} '.padEnd(60, 'x'));`).join("\n");
  fs.writeFileSync(path.join(cwdDir, "flood-pass.mjs"), [
    `console.log(${JSON.stringify(MARKER)});`,
    PADDING_LINES,
    "process.exit(0);",
  ].join("\n"));

  const spillFile = path.join(outDir, "specimen-b.log");
  const res = await runGateStep("node flood-pass.mjs", cwdDir, 15_000, undefined, undefined, undefined, undefined, spillFile);

  check("(B) the step passed (status 0) — the positional-tail-only code path is the one under test",
    res.status === 0);
  check("(B) the flood alone genuinely exceeds OUTPUT_TAIL_BYTES (proves this isn't a short-run no-op)",
    Buffer.byteLength(PADDING_LINES, "utf-8") > 4096);
  check("(B) THE OLD PATH TRUNCATES: outputTail does NOT contain the early marker — genuinely evicted by the bounded ring",
    typeof res.outputTail === "string" && !res.outputTail.includes(MARKER),
    () => `outputTail length=${res.outputTail?.length}, first 200 chars: ${JSON.stringify(res.outputTail?.slice(0, 200))}`);
  check("(B) res.outputFile names the exact spillFile path passed in", res.outputFile === spillFile);
  check("(B) the spill file actually exists on disk", fs.existsSync(spillFile));
  const spilled = fs.readFileSync(spillFile, "utf-8");
  check("(B) THE ACCEPTANCE BAR: the FULL output IS recoverable via outputFile — the exact marker outputTail evicted is present in the spilled file",
    spilled.includes(MARKER));
  check("(B) the spilled file holds MORE than the bounded ring ever could (proves this is genuinely the full stream, not a re-derived tail)",
    spilled.length > 4096);
}

// ── (C) THE DISK-USAGE CEILING: output genuinely exceeding GATE_SPILL_MAX_BYTES is capped, with an
//     explicit marker line — never grows unbounded. A single large write (not millions of console.log
//     calls) keeps this fast. ─────────────────────────────────────────────────────────────────────────
{
  fs.writeFileSync(path.join(cwdDir, "flood-huge.mjs"), [
    "const chunk = 'x'.repeat(1024 * 1024);",
    `for (let i = 0; i < ${Math.ceil((GATE_SPILL_MAX_BYTES * 1.5) / (1024 * 1024))}; i++) process.stdout.write(chunk);`,
    "process.exit(0);",
  ].join("\n"));
  const spillFile = path.join(outDir, "specimen-c.log");
  const res = await runGateStep("node flood-huge.mjs", cwdDir, 30_000, undefined, undefined, undefined, undefined, spillFile);
  check("(C) the step passed (status 0)", res.status === 0);
  const stat = fs.statSync(spillFile);
  check("(C) the spill file is capped at (or just past, for the marker line) GATE_SPILL_MAX_BYTES — never grows to hold the whole ~1.5x-cap stream",
    stat.size <= GATE_SPILL_MAX_BYTES + 500,
    () => `spill file size=${stat.size}, cap=${GATE_SPILL_MAX_BYTES}`);
  const spilled = fs.readFileSync(spillFile, "utf-8");
  check("(C) the cap marker line is present, naming what happened",
    spilled.includes("gate-output spill capped at"));
}

// ── (D) MULTI-STEP APPEND: every step of one runGateSequential call shares the SAME spillFile, appended
//     to in execution order — proves a multi-step gate command doesn't clobber step 1's output with step
//     2's. ──────────────────────────────────────────────────────────────────────────────────────────────
{
  fs.writeFileSync(path.join(cwdDir, "step1.mjs"), "console.log('STEP-ONE-MARKER'); process.exit(0);");
  fs.writeFileSync(path.join(cwdDir, "step2.mjs"), "console.log('STEP-TWO-MARKER'); process.exit(0);");
  const spillFile = path.join(outDir, "specimen-d.log");
  const seq = await runGateSequential("node step1.mjs && node step2.mjs", cwdDir, 15_000, undefined, undefined, undefined, undefined, undefined, spillFile);
  check("(D) the whole sequence passed", seq.passed === true);
  check("(D) runGateSequential forwards outputFile too", seq.outputFile === spillFile);
  const spilled = fs.readFileSync(spillFile, "utf-8");
  check("(D) BOTH steps' markers are present in the ONE shared spill file",
    spilled.includes("STEP-ONE-MARKER") && spilled.includes("STEP-TWO-MARKER"));
  check("(D) they appear in real execution order (step 1 before step 2), not interleaved/reversed",
    spilled.indexOf("STEP-ONE-MARKER") < spilled.indexOf("STEP-TWO-MARKER"));
}

// ── (E) THE TIMEOUT SETTLE PATH: `onTimeout`'s own resolve (a SEPARATE code path from `done()` — see
//     gate-runner.ts) must ALSO carry outputFile. A script that floods a marker then hangs, killed by the
//     step's own timeout. ────────────────────────────────────────────────────────────────────────────────
{
  fs.writeFileSync(path.join(cwdDir, "hangs.mjs"), [
    "console.log('PRE-TIMEOUT-MARKER');",
    "setInterval(() => {}, 1_000_000);",
  ].join("\n"));
  const spillFile = path.join(outDir, "specimen-e.log");
  const res = await runGateStep("node hangs.mjs", cwdDir, 2000, undefined, false, undefined, undefined, spillFile);
  check("(E) the step genuinely timed out (proves this exercises onTimeout's own resolve, not done()'s)",
    res.timedOut === true && res.status === null);
  check("(E) outputFile is still set on the timeout settle path", res.outputFile === spillFile);
  const spilled = fs.existsSync(spillFile) ? fs.readFileSync(spillFile, "utf-8") : "";
  check("(E) the pre-timeout output was captured before the kill landed",
    spilled.includes("PRE-TIMEOUT-MARKER"));
}

// ── (F) RETENTION — pruneGateSpills keeps only the newest `keep` files, oldest-by-mtime evicted first. ──
{
  const retentionDir = path.join(outDir, "retention");
  fs.mkdirSync(retentionDir, { recursive: true });
  const names = ["a.log", "b.log", "c.log", "d.log", "e.log"];
  const now = Date.now();
  names.forEach((name, i) => {
    const p = path.join(retentionDir, name);
    fs.writeFileSync(p, "content");
    // Stagger mtimes so ordering is deterministic — index 0 is OLDEST, last is NEWEST.
    const t = new Date(now - (names.length - i) * 60_000);
    fs.utimesSync(p, t, t);
  });
  // A non-.log file must be untouched by the sweep, regardless of age.
  const nonLog = path.join(retentionDir, "keep-me.txt");
  fs.writeFileSync(nonLog, "not a spill");
  fs.utimesSync(nonLog, new Date(now - 999 * 60_000), new Date(now - 999 * 60_000));

  pruneGateSpills(retentionDir, 3);
  const remaining = fs.readdirSync(retentionDir).sort();
  check("(F) exactly the 3 newest .log files survive", remaining.includes("c.log") && remaining.includes("d.log") && remaining.includes("e.log"));
  check("(F) the 2 oldest .log files were pruned", !remaining.includes("a.log") && !remaining.includes("b.log"));
  check("(F) the non-.log file is untouched regardless of age (scoping: only *.log under this dir)", remaining.includes("keep-me.txt"));

  // keep<=0 retains everything (defensive default) — POSITIVE CONTROL first: prove the sweep CAN prune
  // (already shown above) before trusting a no-op result here.
  const retentionDir2 = path.join(outDir, "retention2");
  fs.mkdirSync(retentionDir2, { recursive: true });
  fs.writeFileSync(path.join(retentionDir2, "x.log"), "content");
  fs.writeFileSync(path.join(retentionDir2, "y.log"), "content");
  pruneGateSpills(retentionDir2, 0);
  check("(F) keep<=0 retains everything (defensive, never used in production but must not silently wipe)",
    fs.readdirSync(retentionDir2).length === 2);

  // A non-existent dir must not throw.
  let threw = false;
  try { pruneGateSpills(path.join(outDir, "does-not-exist"), 5); } catch { threw = true; }
  check("(F) a non-existent spill dir is a silent no-op, never a throw", threw === false);
}

// ── (G) gateSpillPath is a pure derivation — no fs access, so exercising it never touches real LOOM_HOME. ──
{
  const p1 = gateSpillPath("11111111-1111-1111-1111-111111111111");
  const p2 = gateSpillPath("22222222-2222-2222-2222-222222222222");
  check("(G) two different opIds derive two different paths", p1 !== p2);
  check("(G) the path is namespaced under GATE_SPILL_DIR", p1.startsWith(GATE_SPILL_DIR));
  check("(G) the path is keyed by the opId itself (recoverable by opId, per the card's own DoD)", p1.includes("11111111-1111-1111-1111-111111111111"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a settled gate's full child output is recoverable by opId via a bounded, count-retained file spill: unset by default (byte-identical to pre-card behavior), recovers content the bounded outputTail ring genuinely evicts, capped against a pathological run, shared correctly across a multi-step gate command, wired into BOTH gate-runner settle paths (done() and the separate onTimeout resolve), and its retention sweep prunes by mtime, scoped to *.log, without ever throwing on a missing dir."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
