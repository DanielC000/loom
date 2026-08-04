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
  topSlowestFiles,
  formatGateTimingSummaryLines,
  neverCompletedFiles,
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

fs.rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-gate-timing: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
