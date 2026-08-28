// Card 17069e7e (DoD-2) acceptance evidence: per-file test durations, emitted on the normal gate path with
// no flag, matching the existing NDJSON schema at
// docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson (produced by that
// investigation's own measure-per-file-timing.mjs — reused, not reinvented). Exercises the exported
// `appendGateTimingRow`/`cheapHostSnapshot`/`topSlowestFiles`/`formatGateTimingSummaryLines`/
// `neverCompletedFiles` directly against synthetic inputs and a scratch file — never a real spawn of the
// whole script (that would either run the full hermetic suite or need a `--count`-shaped early exit,
// neither of which exercises this logic in isolation), same reasoning test-daemon-cli-args.mjs/
// test-daemon-rss-gap.mjs already established for this file. The REAL-spawn SIGKILL positive control for
// card 05056168 (the write-ahead record actually surviving a kill) lives separately in
// test-daemon-gate-timing-sigkill.mjs — that one specifically needs a real subprocess, which is exactly
// what this file's own pattern avoids for everything else.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendGateTimingRow,
  gateTimingWriteFailureSummary,
  cheapHostSnapshot,
  computeTestSourceBytes,
  topSlowestFiles,
  formatGateTimingSummaryLines,
  neverCompletedFiles,
  gateTimingOpId,
  classifyFailureDetail,
} from "../scripts/test-daemon.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gate-timing-test-"));

// ── appendGateTimingRow ─────────────────────────────────────────────────────────────────────────────────
{
  const target = path.join(scratchRoot, "nested", "dir", "rows.ndjson");
  // [positive control] a fresh nested path is created (mkdir -p) and each call appends one valid JSON line.
  appendGateTimingRow(target, { kind: "file", name: "a", durationMs: 10 });
  appendGateTimingRow(target, { kind: "file", name: "b", durationMs: 20 });
  const lines = fs.readFileSync(target, "utf8").trim().split("\n");
  check("[positive control] two calls produce exactly two NDJSON lines", lines.length === 2);
  check("each line round-trips as valid JSON with the fields given", JSON.parse(lines[0]).name === "a" && JSON.parse(lines[1]).durationMs === 20);

  // RED-FIRST (this exact block, run against a version of appendGateTimingRow with the try/catch removed,
  // threw synchronously and failed the whole test process before `caught` could ever be set) — proves the
  // write failure is actually swallowed, not merely assumed safe because no test happened to hit it.
  const fileNotADir = path.join(scratchRoot, "im-a-file");
  fs.writeFileSync(fileNotADir, "x");
  const unwritableTarget = path.join(fileNotADir, "sub", "rows.ndjson"); // mkdirSync(dirname) must ENOTDIR here
  let caught = null;
  // Card 17069e7e CR follow-up (DIRECTIVE #3): the fix under test here is "tally silently, never warn per
  // row" — capture every console.warn call while triggering THREE separate failures, so a regression back
  // to a per-call warn (which would produce 3 lines here, and 631 in a real gate run) is directly caught.
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnCalls.push(args.join(" ")); };
  const countBefore = gateTimingWriteFailureSummary().count;
  try {
    appendGateTimingRow(unwritableTarget, { kind: "file", name: "c" });
    appendGateTimingRow(unwritableTarget, { kind: "file", name: "d" });
    appendGateTimingRow(unwritableTarget, { kind: "file", name: "e" });
  } catch (err) {
    caught = err;
  } finally {
    console.warn = originalWarn;
  }
  check("[negative control] a write target whose parent is un-mkdir-able does NOT throw past this function", caught === null);
  check("[negative control] no file was created at the unwritable target", !fs.existsSync(unwritableTarget));
  check("[positive control — the actual CR fix] appendGateTimingRow itself NEVER calls console.warn, even across 3 failures (per-row warnings would print 633x in a real gate run)", warnCalls.length === 0);
  const summary = gateTimingWriteFailureSummary();
  check("[positive control] every failed call is still tallied (3 more than before this block)", summary.count === countBefore + 3);
  check("the tally records the real underlying error message (ENOTDIR), not a placeholder", summary.lastMessage?.includes("ENOTDIR") ?? false);
}

// ── cheapHostSnapshot ────────────────────────────────────────────────────────────────────────────────────
{
  const snap = cheapHostSnapshot();
  check("cpuCount is a positive number (no subprocess needed to read it)", typeof snap.cpuCount === "number" && snap.cpuCount > 0);
  check("freeMemMB/totalMemMB are numbers", typeof snap.freeMemMB === "number" && typeof snap.totalMemMB === "number");
  check("ts is an ISO string", typeof snap.ts === "string" && !Number.isNaN(Date.parse(snap.ts)));
  // Honest-null, not a guessed value — this repo has a standing rule against adding a subprocess here (see
  // createRssTracker's own scope caveat in scripts/test-daemon.mjs).
  check("nodeLikeProcessCount/nodeLikeWorkingSetMB are honestly null (no subprocess added)", snap.nodeLikeProcessCount === null && snap.nodeLikeWorkingSetMB === null);
}

// ── gateTimingOpId (card 720bb7ad DoD-3) ────────────────────────────────────────────────────────────────
{
  const savedEnv = process.env.LOOM_GATE_OP_ID;
  try {
    // [negative control] the common case — a human's own local `pnpm --filter @loom/daemon test:daemon`,
    // or CI, never sets this env var at all.
    delete process.env.LOOM_GATE_OP_ID;
    check("[negative control] undefined (never a fabricated empty string) when the env var is unset", gateTimingOpId() === undefined);
    process.env.LOOM_GATE_OP_ID = "";
    check("[negative control] an EMPTY string env var ALSO reads as undefined, never a fabricated ''", gateTimingOpId() === undefined);

    // [positive control] the daemon sets it (gateOpIdEnvOverride in sessions/service.ts) — a real opId
    // round-trips verbatim.
    process.env.LOOM_GATE_OP_ID = "ec0f9383-bcd0-498e-9f51-7f5fdd66dd14";
    check("[positive control] a real opId round-trips verbatim", gateTimingOpId() === "ec0f9383-bcd0-498e-9f51-7f5fdd66dd14");
  } finally {
    if (savedEnv === undefined) delete process.env.LOOM_GATE_OP_ID; else process.env.LOOM_GATE_OP_ID = savedEnv;
  }

  // The run-summary row itself: opId flows through appendGateTimingRow's plain JSON.stringify unmodified
  // when present, and OMITTED ENTIRELY (not a fabricated null) when undefined — JSON.stringify's own
  // standard undefined-key-drop behavior, exercised here against the REAL row shape rather than assumed.
  const target = path.join(scratchRoot, "opid-rows.ndjson");
  appendGateTimingRow(target, { kind: "run-summary", runUid: "r1", opId: "real-op-id-here" });
  appendGateTimingRow(target, { kind: "run-summary", runUid: "r2", opId: undefined });
  const rows = fs.readFileSync(target, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("a row WITH an opId carries it verbatim", rows[0].opId === "real-op-id-here");
  check("a row with opId:undefined OMITS the key entirely (not JSON `null`) — proof a reader can tell 'no id available' apart from a fabricated value", !("opId" in rows[1]));
}

// ── computeTestSourceBytes (card 90678ee9 DoD-5) ────────────────────────────────────────────────────────
{
  const testDirRoot = fs.mkdtempSync(path.join(scratchRoot, "src-bytes-"));
  fs.writeFileSync(path.join(testDirRoot, "alpha.mjs"), "x".repeat(100));
  fs.writeFileSync(path.join(testDirRoot, "beta.mjs"), "y".repeat(250));
  fs.writeFileSync(path.join(testDirRoot, "gamma.mjs"), "z".repeat(10));

  // [positive control] sums exactly the byte size of the SELECTED files' own source, ignoring an
  // on-disk file that isn't in the selection.
  check(
    "[positive control] sums selected files' on-disk byte sizes",
    computeTestSourceBytes(testDirRoot, ["alpha", "beta"]) === 350,
  );
  check(
    "an on-disk file NOT in the selection does not contribute",
    computeTestSourceBytes(testDirRoot, ["alpha"]) === 100,
  );
  // [negative control] a selected name with no matching file on disk (mirrors runOne's own
  // fs.existsSync skip) contributes 0 and must not throw — same posture as appendGateTimingRow.
  let threwOnMissing = false;
  let missingResult = null;
  try {
    missingResult = computeTestSourceBytes(testDirRoot, ["alpha", "does-not-exist"]);
  } catch {
    threwOnMissing = true;
  }
  check("[negative control] a selected name with no file on disk does not throw", !threwOnMissing);
  check("[negative control] a missing file contributes 0, not a fabricated size", missingResult === 100);
  check(
    "[negative control] an empty selection reports 0 bytes",
    computeTestSourceBytes(testDirRoot, []) === 0,
  );
}

// ── topSlowestFiles ──────────────────────────────────────────────────────────────────────────────────────
{
  const results = [
    { name: "slow", durationMs: 900 },
    { name: "fast", durationMs: 10 },
    { name: "mid", durationMs: 500 },
    { name: "skipped-1", skipped: true }, // no durationMs at all
    { name: "skipped-2", skipped: true, durationMs: undefined },
  ];
  const top2 = topSlowestFiles(results, 2);
  check("[positive control] the top-N slowest are returned, descending", top2.map((r) => r.name).join(",") === "slow,mid");
  check("a skipped/never-timed entry is excluded, not sorted in as a false 0", topSlowestFiles(results, 10).every((r) => r.name !== "skipped-1" && r.name !== "skipped-2"));
  check("[negative control] an all-skipped input reports zero slowest, not a fabricated entry", topSlowestFiles([{ name: "x", skipped: true }], 5).length === 0);
  check("n defaults to 20 when omitted", topSlowestFiles(Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, durationMs: i }))).length === 20);
}

// ── formatGateTimingSummaryLines ────────────────────────────────────────────────────────────────────────
{
  const results = [
    { name: "alpha", durationMs: 85_400 },
    { name: "beta", durationMs: 61_100 },
    { name: "gamma", skipped: true },
  ];
  const lines = formatGateTimingSummaryLines(results, 120_000, { topN: 5 });
  check("[positive control] the aggregate line reports the SUM of timed durations, in seconds, not wall-clock", lines[0].includes("aggregate 146.5s"));
  check("the aggregate line reports wall-clock separately", lines[0].includes("wall-clock 120.0s"));
  check("the aggregate line counts only TIMED files (2), excluding the skipped one", lines[0].includes("across 2 file(s)"));
  check("the slowest-files header names the count actually listed", lines.some((l) => l.includes("slowest 2 file(s)")));
  check("the slowest list is ordered by duration, descending", lines.findIndex((l) => l.includes("alpha")) < lines.findIndex((l) => l.includes("beta")));
  check("durations in the slowest list are decimal seconds (e.g. 85.4s), matching the card's own reference format", lines.some((l) => l.includes("85.4s") && l.includes("alpha")));

  // [negative control] zero timed files (e.g. every discovered test was skipped) must not crash the
  // formatter or fabricate a slowest-files section.
  const emptyLines = formatGateTimingSummaryLines([{ name: "only-skip", skipped: true }], 500);
  check("[negative control] all-skipped input reports 0 files, no slowest section, and does not throw", emptyLines[0].includes("across 0 file(s)") && !emptyLines.some((l) => l.includes("slowest")));
}

// ── neverCompletedFiles (card 05056168) ─────────────────────────────────────────────────────────────────
{
  // [positive control] the actual scenario this exists for: a run-start "selected" list where some names
  // never got a matching "file" completion row — the file(s) in flight when a run died mid-way.
  const selected = ["a", "b", "c"];
  check(
    "[positive control] a partially-completed run names exactly the file(s) with no completion row",
    neverCompletedFiles(selected, ["a", "c"]).join(",") === "b",
  );
  check(
    "[positive control] multiple never-completed files are all named, in original order",
    neverCompletedFiles(selected, []).join(",") === "a,b,c",
  );
  // [negative control] a run that DID terminate normally (every selected file has a completion row) must
  // report zero never-completed files — not a false positive from a naive implementation.
  check(
    "[negative control] a fully-completed run reports zero never-completed files",
    neverCompletedFiles(selected, ["a", "b", "c"]).length === 0,
  );
  check(
    "[negative control] an empty selected list reports zero never-completed files, not a thrown error",
    neverCompletedFiles([], ["a"]).length === 0,
  );
  check(
    "a completed name not present in `selected` at all is simply ignored (no crash, no spurious entry)",
    neverCompletedFiles(["a"], ["a", "z"]).length === 0,
  );
}

// ── classifyFailureDetail (card 237aa3a9) — synthetic bucket/bound coverage; the REAL multi-failure
// positive control (DoD-5) lives in test-daemon-gate-timing-failure-detail.mjs, against a genuine spawn.
{
  // [positive control] the "timeout" bucket ignores stdout/stderr entirely — already fully named by the
  // row's own `timeoutDetail` field, this just labels the bucket.
  check(
    "[positive control] status:'timeout' classifies as failureType:'timeout' regardless of captured output",
    classifyFailureDetail({ status: "timeout", stdout: "FAIL  should be ignored", stderr: "" }).failureType === "timeout",
  );
  check("the timeout bucket carries no messages (nothing to name beyond the bucket itself)",
    classifyFailureDetail({ status: "timeout", stdout: "x", stderr: "" }).messages.length === 0);

  // [positive control] multiple distinct "FAIL  <label>" lines are ALL named, a PASS line is excluded —
  // this is the exact reader-facing property card 237aa3a9 exists for.
  const multiFail = classifyFailureDetail({
    status: 1,
    stdout: "PASS  (A) an unrelated passing check\nFAIL  (B) first assertion\nFAIL  (C) second assertion\n",
    stderr: "",
  });
  check("[positive control] multiple distinct assertion failures classify as 'assertionFailed'", multiFail.failureType === "assertionFailed");
  check("[positive control] BOTH distinct failing labels are named, in order", multiFail.messages.join("|") === "(B) first assertion|(C) second assertion");
  check("a PASS line never leaks into the failure messages", !multiFail.messages.some((m) => m.includes("passing check")));
  check("well under the bound, nothing is truncated", multiFail.truncated === false);

  // [positive control] no FAIL line but real stderr content: the file's own code threw, not a false
  // assertion — classified "testThrew", the message carries the thrown error.
  const threw = classifyFailureDetail({ status: 1, stdout: "", stderr: "/x/fixture.mjs:3\nthrow new Error(\"boom\");\n\nError: boom\n    at Object.<anonymous>\n" });
  check("[positive control] stderr with no FAIL line classifies as 'testThrew'", threw.failureType === "testThrew");
  check("the thrown error's own message line is present in the captured messages", threw.messages.some((m) => m.includes("Error: boom")));

  // [negative control] nonzero exit, no FAIL line, no stderr at all — genuinely nothing to classify from;
  // an honest 'unclassified' beats guessing a wrong bucket.
  const nothing = classifyFailureDetail({ status: 1, stdout: "", stderr: "" });
  check("[negative control] no stdout FAIL line and no stderr classifies as 'unclassified'", nothing.failureType === "unclassified");
  check("[negative control] the unclassified bucket carries no fabricated messages", nothing.messages.length === 0);

  // [positive control — DoD-3, the actual bound] a run with far more than FAILURE_DETAIL_MAX_MESSAGES (20)
  // distinct FAIL lines is capped, not silently accepted whole, and the cap sets `truncated: true` rather
  // than leaving a reader to infer truncation from a suspiciously round count.
  const manyFailLines = Array.from({ length: 25 }, (_, i) => `FAIL  synthetic failure #${i}`).join("\n");
  const many = classifyFailureDetail({ status: 1, stdout: manyFailLines, stderr: "" });
  check("[positive control] a 25-failure run is capped at the 20-message bound", many.messages.length === 20);
  check("[positive control] the cap sets truncated:true — never a silent truncation", many.truncated === true);
  check("the FIRST 20 failures survive the cap, in original order (not an arbitrary subset)", many.messages[0] === "synthetic failure #0" && many.messages[19] === "synthetic failure #19");

  // [positive control — DoD-3, the char bound] one message alone can exceed the total-chars bound even
  // while well under the message-count bound.
  const oneHugeLine = `FAIL  ${"x".repeat(5000)}`;
  const huge = classifyFailureDetail({ status: 1, stdout: oneHugeLine, stderr: "" });
  // CR follow-up (manager review of cad5d5d6): an EMPTY `messages` array on a marked failure defeats the
  // card's own stated property ("a reader can name the failing assertion(s) from one read") — the bound
  // being marked (`truncated:true`) is not enough on its own if there's nothing left to read. A single
  // over-long message must still leave a non-empty, budget-sized PREFIX behind.
  check("[positive control — CR fix] a single message exceeding the char bound leaves a non-empty, budget-sized PREFIX, never an empty array", huge.messages.length === 1 && huge.messages[0].length === 4000);
  check("the prefix is a real, in-order slice of the actual message content (not a placeholder)", "x".repeat(5000).startsWith(huge.messages[0]));
  check("[positive control] exceeding the char bound alone still sets truncated:true", huge.truncated === true);

  // ── mixed case: FAIL line(s) AND stderr both present (CR follow-up — manager review of cad5d5d6) ──────
  // A file can throw uncaught AFTER one or more check() calls already failed. `failureType` stays
  // "assertionFailed" (the named assertions are the primary signal), but the stderr must not be silently
  // dropped — a bounded `stderrExcerpt` is attached alongside `messages`.
  const mixed = classifyFailureDetail({
    status: 1,
    stdout: "FAIL  (D) a real assertion failure before the throw\n",
    stderr: "/x/fixture.mjs:9\nthrow new Error(\"secondary throw after the check already failed\");\n\nError: secondary throw after the check already failed\n",
  });
  check("[positive control] the mixed case (FAIL line + stderr) still classifies 'assertionFailed', not a fifth bucket", mixed.failureType === "assertionFailed");
  check("the real FAIL line is still named in messages", mixed.messages.some((m) => m.includes("a real assertion failure before the throw")));
  check("[positive control] the stderr is NOT silently dropped — a stderrExcerpt is attached alongside the FAIL messages", Array.isArray(mixed.stderrExcerpt) && mixed.stderrExcerpt.some((m) => m.includes("secondary throw after the check already failed")));

  // [negative control] the ORDINARY assertionFailed case (no stderr at all) carries NO stderrExcerpt key —
  // presence of the key itself signals the mixed case, same unambiguous-presence discipline as
  // `failureDetail` itself on the row.
  check("[negative control] the ordinary (non-mixed) assertionFailed case carries no stderrExcerpt key at all", !("stderrExcerpt" in multiFail));

  // ── failureDetail key-presence contract (peer design input (b)) ──────────────────────────────────────
  // A reader censusing rows by KEY PRESENCE must never miscount a pass as a failure or vice versa —
  // `failureDetail` must be genuinely ABSENT (not present-with-a-falsy-value) on a passing row.
  const presenceTarget = path.join(scratchRoot, "failure-detail-presence.ndjson");
  appendGateTimingRow(presenceTarget, { kind: "file", name: "passing", ok: true, failureDetail: undefined });
  appendGateTimingRow(presenceTarget, { kind: "file", name: "failing", ok: false, failureDetail: classifyFailureDetail({ status: 1, stdout: "FAIL  (Z) example", stderr: "" }) });
  const presenceRows = fs.readFileSync(presenceTarget, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("[positive control] a passing row carries NO failureDetail key at all (JSON.stringify drops undefined)", !("failureDetail" in presenceRows[0]));
  check("[positive control] a failing row's failureDetail key IS present, with real content", "failureDetail" in presenceRows[1] && presenceRows[1].failureDetail.messages[0] === "(Z) example");
}

fs.rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-gate-timing: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
