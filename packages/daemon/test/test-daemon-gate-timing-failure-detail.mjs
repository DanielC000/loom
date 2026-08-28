// Card 237aa3a9 DoD-5 acceptance evidence — THE REAL POSITIVE CONTROL, and it is the whole card: force a
// REAL test file (a genuine `node` subprocess, not a synthetic string) to fail with >=2 DISTINCT assertion
// failures, run it through the SAME `spawnWithTimeout` -> `classifyFailureDetail` -> `appendGateTimingRow`
// pipeline `runOne`/`runLane` use, and prove a reader can name every failing assertion from ONE read of the
// resulting NDJSON row. A single-failure fixture cannot see the truncation problem (DoD-3), which is the
// whole point of this card — so this file always forces multiple.
//
// The fixture files below are written to a throwaway scratch dir at RUNTIME (mkdtempManaged), never
// committed under test/ — they intentionally fail, and this project's own discovery walk
// (discoverHermeticTests) would otherwise treat an uncommitted, undiscovered `.mjs` under test/ as either
// a violation or a silently-run extra test. Spawning them directly via the exported `spawnWithTimeout`
// (the same function `runOne` calls) exercises the real subprocess/capture path without touching discovery
// at all.
//
// The synthetic bucket/bound unit coverage for `classifyFailureDetail` (timeout, testThrew, unclassified,
// the exact truncation boundary) lives in test-daemon-gate-timing.mjs — this file is deliberately narrower:
// only what a REAL multi-failure spawn can prove that a synthetic string cannot.
import fs from "node:fs";
import path from "node:path";
import { spawnWithTimeout, classifyFailureDetail, appendGateTimingRow } from "../scripts/test-daemon.mjs";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const scratchRoot = mkdtempManaged("loom-gate-timing-failure-detail-");

function writeFixture(name, source) {
  const file = path.join(scratchRoot, `${name}.mjs`);
  fs.writeFileSync(file, source);
  return file;
}

// ── Scenario A: >=2 distinct check() assertion failures, exactly this project's own check() shape (see
//    e.g. packages/daemon/test/merge-gate-reuse.mjs) ─────────────────────────────────────────────────────
{
  const fixture = writeFixture(
    "multi-assert-fail",
    [
      "let failures = 0;",
      'const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };',
      'check("(A) an unrelated passing check", 1 === 1);',
      'check("(B) first real assertion failure", 1 === 2);',
      'check("(C) second real assertion failure", "x" === "y");',
      "process.exit(failures === 0 ? 0 : 1);",
      "",
    ].join("\n"),
  );

  const r = await spawnWithTimeout(process.execPath, [fixture], { timeoutMs: 15_000 });
  check("[precondition] the fixture actually failed (nonzero exit, not a timeout)", r.ok === false && r.status === 1);

  const detail = classifyFailureDetail({ status: r.status, stdout: r.stdout, stderr: r.stderr });
  check("[positive control] a real multi-assertion-failure run classifies as 'assertionFailed'", detail.failureType === "assertionFailed");
  check(
    "[positive control — THE CARD] BOTH distinct real assertion failures are named, from one read of the classified detail",
    detail.messages.some((m) => m.includes("first real assertion failure")) && detail.messages.some((m) => m.includes("second real assertion failure")),
  );
  check("the real PASSING check's label never leaks into the failure messages", !detail.messages.some((m) => m.includes("an unrelated passing check")));
  check("well under the bound, nothing is truncated", detail.truncated === false);

  // Round-trip through the SAME appendGateTimingRow the real gate uses, then read it back — proves the
  // property survives the actual write/read boundary, not just the pure classifier in isolation.
  const ndjsonPath = path.join(scratchRoot, "rows.ndjson");
  appendGateTimingRow(ndjsonPath, { kind: "file", name: "multi-assert-fail", ok: false, status: r.status, failureDetail: detail });
  appendGateTimingRow(ndjsonPath, { kind: "file", name: "a-passing-file", ok: true, status: 0, failureDetail: undefined });
  const rows = fs.readFileSync(ndjsonPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const failRow = rows.find((row) => row.name === "multi-assert-fail");
  const passRow = rows.find((row) => row.name === "a-passing-file");
  check(
    "[positive control] a reader can name both real failing assertions from ONE read of the written+re-read row",
    failRow.failureDetail.messages.some((m) => m.includes("first real assertion failure")) && failRow.failureDetail.messages.some((m) => m.includes("second real assertion failure")),
  );
  check("[positive control] the failing row's failureDetail key is present after a real write+read round trip", "failureDetail" in failRow);
  check("[positive control — key-presence contract] the passing row's failureDetail key is genuinely ABSENT after the same round trip, not present-with-null", !("failureDetail" in passRow));
}

// ── Scenario B: the file's own code throws (uncaught), not a false assertion — real Node stack output ───
{
  const fixture = writeFixture("real-throw", 'throw new Error("boom from a real uncaught throw fixture");\n');
  const r = await spawnWithTimeout(process.execPath, [fixture], { timeoutMs: 15_000 });
  check("[precondition] the fixture actually failed via an uncaught throw (nonzero exit, not a timeout)", r.ok === false && r.status !== "timeout" && r.status !== 0);

  const detail = classifyFailureDetail({ status: r.status, stdout: r.stdout, stderr: r.stderr });
  check("[positive control] a real uncaught throw (no FAIL line) classifies as 'testThrew', not 'assertionFailed'", detail.failureType === "testThrew");
  check("[positive control] the real thrown error's own message is present in the captured detail", detail.messages.some((m) => m.includes("boom from a real uncaught throw fixture")));
}

// ── Scenario C: DoD-3's truncation bound, against a REAL run producing far more than the message cap ────
{
  const lines = Array.from({ length: 30 }, (_, i) =>
    `check("(${i}) real distinct assertion #${i}", false);`);
  const fixture = writeFixture(
    "many-real-failures",
    [
      "let failures = 0;",
      'const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };',
      ...lines,
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  const r = await spawnWithTimeout(process.execPath, [fixture], { timeoutMs: 15_000 });
  check("[precondition] the many-failure fixture actually produced 30 real FAIL lines", (r.stdout.match(/^FAIL\s\s/gm) ?? []).length === 30);

  const detail = classifyFailureDetail({ status: r.status, stdout: r.stdout, stderr: r.stderr });
  check("[positive control — DoD-3 against REAL output, the property a single-failure fixture cannot see] a real 30-failure run is capped, not silently accepted whole", detail.messages.length === 20);
  check("[positive control] the cap sets truncated:true on real output, exactly as it does on synthetic input", detail.truncated === true);
  check("the earliest real failures survive the cap, in original order", detail.messages[0].includes("(0) real distinct assertion #0") && detail.messages[19].includes("(19) real distinct assertion #19"));
}

// ── Scenario D (CR follow-up — manager review of cad5d5d6): a REAL mixed case — a check() failure
//    followed by the file's own code throwing uncaught. Proves the stderrExcerpt path end to end against
//    genuine captured output, then through the same write/read round trip as Scenario A.
{
  const fixture = writeFixture(
    "real-mixed-fail-and-throw",
    [
      "let failures = 0;",
      'const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };',
      'check("(D) a real assertion failure before the throw", 1 === 2);',
      'throw new Error("real secondary throw after the check already failed");',
      "",
    ].join("\n"),
  );
  const r = await spawnWithTimeout(process.execPath, [fixture], { timeoutMs: 15_000 });
  check("[precondition] the mixed fixture produced BOTH a real FAIL line and real stderr", /^FAIL\s\s/m.test(r.stdout) && r.stderr.trim().length > 0);

  const detail = classifyFailureDetail({ status: r.status, stdout: r.stdout, stderr: r.stderr });
  check("[positive control] a real mixed failure still classifies 'assertionFailed'", detail.failureType === "assertionFailed");
  check("the real assertion failure is named", detail.messages.some((m) => m.includes("a real assertion failure before the throw")));
  check("[positive control — THE FIX] the real thrown error is NOT silently dropped — it survives as stderrExcerpt", Array.isArray(detail.stderrExcerpt) && detail.stderrExcerpt.some((m) => m.includes("real secondary throw after the check already failed")));

  const ndjsonPath = path.join(scratchRoot, "mixed-rows.ndjson");
  appendGateTimingRow(ndjsonPath, { kind: "file", name: "real-mixed-fail-and-throw", ok: false, status: r.status, failureDetail: detail });
  const row = JSON.parse(fs.readFileSync(ndjsonPath, "utf8").trim());
  check("[positive control] the stderrExcerpt survives a real write+read round trip", row.failureDetail.stderrExcerpt.some((m) => m.includes("real secondary throw after the check already failed")));
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-gate-timing-failure-detail: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
