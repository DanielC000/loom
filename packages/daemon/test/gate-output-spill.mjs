import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a16c580b: a settled gate's FULL child output must be recoverable by opId — the only durable record
// today (`gate_status.outputTail`) is a bounded ~4KB (or content-selected ~16KB on a failure) ring, cut
// mid-line, with no second copy anywhere. This proves the fix: `runGateStep`/`runGateSequential`'s new
// `spillFile` param streams every captured byte to a file, independent of the bounded ring — and that the
// retention sweep (`pruneGateSpills`) actually bounds BOTH the count and the TOTAL BYTES of retained
// files (the primary worst-case-disk-usage bound, per manager review — see gate-spill.ts's own doc).
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
const { gateSpillPath, pruneGateSpills, GATE_SPILL_DIR, GATE_SPILL_MAX_BYTES, GATE_SPILL_RETAIN_COUNT, GATE_SPILL_PROTECTED_RETAIN_COUNT } = await import("../dist/orchestration/gate-spill.js");

// The default `GATE_SPILL_MAX_TOTAL_BYTES` (200MB) makes a from-scratch fixture proving it trip
// impractically slow to write — (F2) below passes an explicit SMALL override instead (the param this
// module exists to make injectable), never the real default. `GATE_SPILL_MAX_BYTES` (the PER-FILE cap) is
// unaffected either way.

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
    // Deliberately NO explicit process.exit() here. process.stdout writes to a PIPE are documented as
    // SYNCHRONOUS on Windows but ASYNCHRONOUS on POSIX (Node's own "process.stdout"/"process.stderr" docs) —
    // an immediate process.exit() right after this loop let the child tear itself down before the OS pipe
    // write actually completed on Linux, truncating output below GATE_SPILL_MAX_BYTES before the daemon's
    // own spill() ever saw enough bytes to trip the cap-and-mark branch (the (C) size-cap assertion still
    // passed trivially — a smaller-than-cap file is still "under the cap" — while the marker assertion
    // failed, since the cap was never actually crossed). Letting the event loop drain naturally keeps
    // Node's writable-stream machinery alive until every byte is genuinely flushed, on every platform.
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

// ── (F2) Manager-review follow-up: the PRIMARY retention bound is TOTAL BYTES, not just file count — a
//     100 * 10MB = 1GB worst case is unacceptable on a shipped end-user machine, so the byte cap must
//     actually trip BEFORE the count cap would, given files that individually stay small. Uses an explicit
//     small override (never the real 200MB default — see the module-level comment above) so this stays a
//     fast, hermetic test. ────────────────────────────────────────────────────────────────────────────────
{
  const bytesDir = path.join(outDir, "retention-bytes");
  fs.mkdirSync(bytesDir, { recursive: true });
  const SMALL_CAP_BYTES = 1000;
  const now = Date.now();
  // 5 files, 300 bytes each (well under the file-COUNT cap of, say, 10) — but 3+ of them together exceed
  // the 1000-byte TOTAL cap. Newest-first: e (newest) ... a (oldest).
  const names = ["a.log", "b.log", "c.log", "d.log", "e.log"];
  names.forEach((name, i) => {
    const p = path.join(bytesDir, name);
    fs.writeFileSync(p, "x".repeat(300));
    const t = new Date(now - (names.length - i) * 60_000); // index 0 (a) oldest, last (e) newest
    fs.utimesSync(p, t, t);
  });

  pruneGateSpills(bytesDir, 10, SMALL_CAP_BYTES); // count cap (10) alone would keep all 5 — proves bytes, not count, is what trips here
  const remaining = fs.readdirSync(bytesDir).sort();
  check("(F2) THE FIX: the byte cap trips even though the file-count cap (10) is nowhere close to being hit",
    remaining.length < names.length,
    () => `remaining=${JSON.stringify(remaining)}`);
  const remainingBytes = remaining.reduce((sum, n) => sum + fs.statSync(path.join(bytesDir, n)).size, 0);
  check("(F2) the SURVIVING files' combined size respects the byte cap",
    remainingBytes <= SMALL_CAP_BYTES,
    () => `remainingBytes=${remainingBytes}, cap=${SMALL_CAP_BYTES}`);
  check("(F2) the NEWEST file (e.log) survives", remaining.includes("e.log"));
  check("(F2) the OLDEST file (a.log) was pruned", !remaining.includes("a.log"));
  check("(F2) NO GAPS: an older file never survives ahead of a newer one just because it individually 'fits' — eviction is a monotonic newest-first cutoff, not best-fit",
    (() => {
      // Every surviving file's own index in `names` must be >= every PRUNED file's index (survivors are a
      // contiguous newest-first suffix, not a scattered subset).
      const survivedIdx = remaining.filter((n) => names.includes(n)).map((n) => names.indexOf(n));
      const prunedIdx = names.map((n, i) => i).filter((i) => !remaining.includes(names[i]));
      return survivedIdx.every((s) => prunedIdx.every((p) => s > p));
    })());

  // POSITIVE CONTROL for the count cap STILL working when bytes are NOT the binding constraint: a huge
  // byte budget (bytes never binds) but a tight count cap (2) must still prune down to 2.
  const countDir = path.join(outDir, "retention-count-still-works");
  fs.mkdirSync(countDir, { recursive: true });
  ["p.log", "q.log", "r.log"].forEach((name, i) => {
    const p = path.join(countDir, name);
    fs.writeFileSync(p, "x");
    const t = new Date(now - (3 - i) * 60_000);
    fs.utimesSync(p, t, t);
  });
  pruneGateSpills(countDir, 2, 1024 * 1024 * 1024); // 1GB byte budget — never binds for 3 one-byte files
  check("(F2) POSITIVE CONTROL: the count cap alone still prunes correctly when the byte cap is nowhere close",
    fs.readdirSync(countDir).length === 2);
}

// ── (H) Card f55b64af — THE CARD'S OWN DoD, LITERALLY: 100+ clean (ordinary) spills must not evict an
//     older FAIL (protected) spill, and total bytes stay bounded. The FAIL spill is the OLDEST file in the
//     dir (every ordinary one is newer) — under the OLD single-pool "no gaps" policy this is exactly the
//     shape that would have pruned it first; under the two-pool policy its own smaller protected-pool cap
//     is the only thing it competes against. ────────────────────────────────────────────────────────────
{
  const dir = path.join(outDir, "protected-vs-100-clean");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const failOpId = "fail-op-oldest";
  fs.writeFileSync(path.join(dir, `${failOpId}.log`), "FAIL diagnostic content");
  // OLDEST of everything in this dir — every clean spill below is minted later (higher index = newer).
  fs.utimesSync(path.join(dir, `${failOpId}.log`), new Date(now - 1000 * 60_000), new Date(now - 1000 * 60_000));

  const CLEAN_COUNT = GATE_SPILL_RETAIN_COUNT + 5; // exceeds the ordinary pool's own cap, on purpose
  for (let i = 0; i < CLEAN_COUNT; i++) {
    const p = path.join(dir, `clean-op-${i}.log`);
    fs.writeFileSync(p, "clean pass content");
    const t = new Date(now - (CLEAN_COUNT - i) * 1000); // index 0 oldest-of-the-clean-set, last newest
    fs.utimesSync(p, t, t);
  }

  pruneGateSpills(dir, undefined, undefined, new Set([failOpId]));
  const remaining = new Set(fs.readdirSync(dir));
  check("(H) THE DoD: the older FAIL spill SURVIVES a flood of 100+ newer clean passes",
    remaining.has(`${failOpId}.log`));
  const remainingClean = [...remaining].filter((n) => n.startsWith("clean-op-"));
  check("(H) the ordinary pool is still trimmed to its own cap (GATE_SPILL_RETAIN_COUNT) despite the protected file being exempt from it",
    remainingClean.length === GATE_SPILL_RETAIN_COUNT,
    () => `remainingClean.length=${remainingClean.length}, expected=${GATE_SPILL_RETAIN_COUNT}`);
  check("(H) the NEWEST clean files are the ones that survived (oldest-of-the-clean-set pruned first, within its own pool)",
    remaining.has(`clean-op-${CLEAN_COUNT - 1}.log`) && !remaining.has("clean-op-0.log"));
  const totalBytes = [...remaining].reduce((sum, n) => sum + fs.statSync(path.join(dir, n)).size, 0);
  check("(H) total bytes stay bounded (well under the real 200MB default — every file here is tiny)",
    totalBytes < 1024 * 1024);
}

// ── (I) PROTECTED-POOL-OVER-25 — the protected pool has its OWN independent count cap
//     (GATE_SPILL_PROTECTED_RETAIN_COUNT), never the ordinary GATE_SPILL_RETAIN_COUNT: 30 protected spills,
//     an ordinary cap far above 30 (so the ordinary cap never binds here), must still trim to exactly
//     GATE_SPILL_PROTECTED_RETAIN_COUNT (25) newest. ──────────────────────────────────────────────────────
{
  const dir = path.join(outDir, "protected-pool-over-cap");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const PROTECTED_COUNT = GATE_SPILL_PROTECTED_RETAIN_COUNT + 5;
  const protectedOpIds = new Set();
  for (let i = 0; i < PROTECTED_COUNT; i++) {
    const opId = `weak-pass-op-${i}`;
    protectedOpIds.add(opId);
    const p = path.join(dir, `${opId}.log`);
    fs.writeFileSync(p, "weaker-pass content");
    const t = new Date(now - (PROTECTED_COUNT - i) * 1000); // index 0 oldest, last newest
    fs.utimesSync(p, t, t);
  }

  pruneGateSpills(dir, 10_000 /* ordinary cap never binds — nothing ordinary here anyway */, undefined, protectedOpIds);
  const remaining = fs.readdirSync(dir);
  check("(I) the protected pool is trimmed to exactly its OWN smaller cap",
    remaining.length === GATE_SPILL_PROTECTED_RETAIN_COUNT,
    () => `remaining.length=${remaining.length}, expected=${GATE_SPILL_PROTECTED_RETAIN_COUNT}`);
  check("(I) the newest protected file survives",
    remaining.includes(`weak-pass-op-${PROTECTED_COUNT - 1}.log`));
  check("(I) the oldest protected files (beyond the cap) were pruned",
    !remaining.includes("weak-pass-op-0.log") && !remaining.includes("weak-pass-op-1.log"));
}

// ── (J) BYTE-CAP-EVICTS-PROTECTED-TOO — "the byte ceiling stays absolute across everything" (card
//     f55b64af): a protected file is exempt ONLY from the count trim, never from the byte trim. A small
//     total-bytes budget, newer ORDINARY files alone already exceeding it, must still evict an OLDER
//     protected file even though it's well within its own count cap. ──────────────────────────────────────
{
  const dir = path.join(outDir, "byte-cap-evicts-protected");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const SMALL_CAP_BYTES = 1000;
  const protectedOpId = "protected-op-oldest";
  fs.writeFileSync(path.join(dir, `${protectedOpId}.log`), "x".repeat(300));
  fs.utimesSync(path.join(dir, `${protectedOpId}.log`), new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));

  // 4 newer ordinary files, 300 bytes each — 1200 bytes alone already exceeds the 1000-byte cap, so the
  // byte trim must reach back PAST every ordinary survivor into the protected file, which is otherwise
  // nowhere near its own protected-pool count cap (1 file vs a cap of 25).
  const names = ["clean-a.log", "clean-b.log", "clean-c.log", "clean-d.log"];
  names.forEach((name, i) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "x".repeat(300));
    const t = new Date(now - (names.length - i) * 60_000);
    fs.utimesSync(p, t, t);
  });

  pruneGateSpills(dir, undefined, SMALL_CAP_BYTES, new Set([protectedOpId]));
  const remaining = new Set(fs.readdirSync(dir));
  check("(J) THE FIX: the byte cap evicts the PROTECTED file too, despite it being nowhere near its own count cap",
    !remaining.has(`${protectedOpId}.log`),
    () => `remaining=${JSON.stringify([...remaining])}`);
  const remainingBytes = [...remaining].reduce((sum, n) => sum + fs.statSync(path.join(dir, n)).size, 0);
  check("(J) the surviving files' combined size respects the byte cap",
    remainingBytes <= SMALL_CAP_BYTES,
    () => `remainingBytes=${remainingBytes}, cap=${SMALL_CAP_BYTES}`);
  check("(J) the newest ordinary file survives (it's newer than the evicted protected one)",
    remaining.has("clean-d.log"));
}

// ── (K) UNKNOWN-OPID ⇒ EVICTABLE — a `.log` file whose opId is NOT in the caller-supplied protectedOpIds
//     set (a cascade-deleted project/agent's pending_gate_ops row, or a spill older than verdict-writing)
//     must fail toward ORDINARY/evictable, never toward protected — this is the module's own contract, not
//     something a caller can get wrong by omission. Uses a DELIBERATELY tiny ordinary cap and a huge
//     protected cap — the shape that actually discriminates "unknown → ordinary" (correct) from "unknown →
//     protected" (a mis-classification bug): under the correct contract the ordinary pool's tiny cap prunes
//     the unknown file (it's the oldest); under the bug it would land in the near-unlimited protected pool
//     and survive instead. A large-ordinary/small-protected split (mirroring the module's real production
//     defaults) would let BOTH the correct and the buggy classification evict it, proving nothing. ────────
{
  const dir = path.join(outDir, "unknown-opid-evictable");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const unknownOpId = "orphaned-op-no-db-row";
  fs.writeFileSync(path.join(dir, `${unknownOpId}.log`), "unclassifiable content");
  fs.utimesSync(path.join(dir, `${unknownOpId}.log`), new Date(now - 1000 * 60_000), new Date(now - 1000 * 60_000));

  // A NON-EMPTY protectedOpIds set that deliberately does NOT include unknownOpId — proves this is about
  // the id being absent from the set, not about the set being empty/unused.
  const TINY_ORDINARY_KEEP = 3;
  const HUGE_PROTECTED_KEEP = 1000;
  const CLEAN_COUNT = TINY_ORDINARY_KEEP + 3; // exceeds the tiny ordinary cap, so a correct classification WILL evict something
  for (let i = 0; i < CLEAN_COUNT; i++) {
    const p = path.join(dir, `clean-op-${i}.log`);
    fs.writeFileSync(p, "clean pass content");
    const t = new Date(now - (CLEAN_COUNT - i) * 1000);
    fs.utimesSync(p, t, t);
  }
  pruneGateSpills(dir, TINY_ORDINARY_KEEP, undefined, new Set(["some-other-genuinely-protected-opid"]), HUGE_PROTECTED_KEEP);
  const remaining = new Set(fs.readdirSync(dir));
  check("(K) the unknown-opId file is evicted by the ORDINARY pool's own (tiny) cap — not spared by landing in the near-unlimited protected pool",
    !remaining.has(`${unknownOpId}.log`),
    () => `remaining=${JSON.stringify([...remaining])}`);
  const remainingClean = [...remaining].filter((n) => n.startsWith("clean-op-"));
  check("(K) the ordinary pool itself still obeys its own tiny cap",
    remainingClean.length === TINY_ORDINARY_KEEP,
    () => `remainingClean.length=${remainingClean.length}, expected=${TINY_ORDINARY_KEEP}`);
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
  ? "\n✅ ALL PASS — a settled gate's full child output is recoverable by opId via a bounded, count-AND-bytes-retained file spill: unset by default (byte-identical to pre-card behavior), recovers content the bounded outputTail ring genuinely evicts, capped against a pathological run, shared correctly across a multi-step gate command, wired into BOTH gate-runner settle paths (done() and the separate onTimeout resolve), and its retention sweep prunes by mtime, scoped to *.log, respects a DIRECT total-bytes ceiling (not just file count) with no gaps in the newest-first cutoff, and never throws on a missing dir."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
