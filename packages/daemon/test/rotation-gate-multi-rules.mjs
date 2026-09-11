import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// Regression test for card 115f2ba9's fix to packages/daemon/scripts/rotation-gate.mjs:
//
// THE DEFECT: `parseArgs` stored `--rules` as a single scalar (`out.rules = argv[++i]`), so a REPEATED
// `--rules` silently OVERWROTE the earlier occurrence(s) — only the LAST file was ever read, with no error
// or warning. This can only false-REFUSE (fewer files read can only satisfy fewer markers, never more),
// but its refusal named a marker as missing from "--active or --rules" even when it lived in a file the
// caller DID pass — steering a reader straight into writing that marker into the active doc instead, the
// one edit that disarms a rules-file-only guard (see the card body / file header for the full reasoning).
//
// THE FIX: `--rules` is now REPEATABLE and every occurrence is UNIONED (mirroring the server-side
// `resume_doc_check` MCP tool's own `rulesPaths[]`), never a last-one-wins overwrite. Passing --rules
// exactly once stays byte-identical to the pre-fix single-file behavior (covered by the existing
// rotation-gate-rules-lint.mjs suite, which this file does not duplicate). This file covers the NEW
// two-or-more-files shape.
//
// Run: node packages/daemon/test/rotation-gate-multi-rules.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-mr-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// Mirrors rotation-gate-rules-lint.mjs's own ALL_MARKER_TOKENS — kept as a local literal here too;
// rotation-gate.mjs's own MARKERS array is the source of truth.
const ALL_MARKER_TOKENS = [
  "Orchestrator Rules",
  "THE FOUR-LEG VERIFY",
  "OWNER-GATED",
  "ROTATE AT 40 KB",
  "THE SAFE-WRITE",
  "MULTI-HARNESS EPIC",
  "NO-CLEARANCE-FROM-SILENCE",
  "capQueued",
  "in-memory",
  "QUIET-LANE",
  "MGR122-FLOOR",
  "PRAISE-IS-THE-LEAST-AUDITED-INPUT",
  "PRE-MERGE-PAIR",
];

function commitmentsList(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. Commitment number ${i}.`);
  return lines.join("\n");
}

function docWith({ markers = ALL_MARKER_TOKENS, items = 20 } = {}) {
  return [
    "# Loom — Orchestrator Log (fixture)",
    "",
    markers.join(" · "),
    "",
    "## ⛔⛔ §LIVE COMMITMENTS — carried verbatim",
    commitmentsList(items),
    "",
  ].join("\n");
}

function runGate(argsArr) {
  const result = spawnSync(process.execPath, [SCRIPT, ...argsArr], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const archivePath = writeFixture("archive.md", "archive contents\n");

// ── THE CARD'S OWN REPRODUCTION SHAPE: a marker lives ONLY in the FIRST of two --rules files. ───────────
// Under the pre-fix last-wins scalar, only rules2 (the LAST) is ever read, so QUIET-LANE (only in rules1)
// reads as missing from everywhere and the run refuses — even though the caller DID pass a file carrying
// it. This is the exact RED case the card asks for.
{
  const markersMinusQuietLane = ALL_MARKER_TOKENS.filter((t) => t !== "QUIET-LANE");
  const activeMissingOne = writeFixture("active-missing-quiet-lane.md", docWith({ markers: markersMinusQuietLane, items: 20 }));
  const rules1 = writeFixture("rules1-quiet-lane.md", "# Orchestrator Rules (fixture, part 1)\n\nThis durable rule is tagged QUIET-LANE.\n");
  const rules2 = writeFixture("rules2-unrelated.md", "# Orchestrator Rules (fixture, part 2)\n\nNothing relevant here.\n");

  const r = runGate(["--active", activeMissingOne, "--archive", archivePath, "--rules", rules1, "--rules", rules2]);
  check("two --rules, marker present ONLY in the FIRST file: exits 0 (union, never last-wins)", r.status === 0);
  check("reports QUIET-LANE satisfied via a --rules file", /QUIET-LANE/.test(r.stdout));
  check("per-file marker-sources breakdown names the FIRST file's own path for QUIET-LANE", r.stdout.includes(`QUIET-LANE: ${rules1}`));
}

// ── Symmetric: the marker lives ONLY in the SECOND file (proves it isn't simply "first wins" instead). ──
{
  const markersMinusMgr122 = ALL_MARKER_TOKENS.filter((t) => t !== "MGR122-FLOOR");
  const activeMissingOne = writeFixture("active-missing-mgr122.md", docWith({ markers: markersMinusMgr122, items: 20 }));
  const rules1 = writeFixture("rules1-unrelated.md", "# Orchestrator Rules (fixture, part 1)\n\nNothing relevant here.\n");
  const rules2 = writeFixture("rules2-mgr122.md", "# Orchestrator Rules (fixture, part 2)\n\nThis durable rule is tagged MGR122-FLOOR.\n");

  const r = runGate(["--active", activeMissingOne, "--archive", archivePath, "--rules", rules1, "--rules", rules2]);
  check("two --rules, marker present ONLY in the SECOND file: exits 0", r.status === 0);
  check("per-file marker-sources breakdown names the SECOND file's own path for MGR122-FLOOR", r.stdout.includes(`MGR122-FLOOR: ${rules2}`));
}

// ── Two DIFFERENT markers, each satisfied by a DIFFERENT one of the two files — proves this is a real
// per-file union, not just "whichever file happens to be read." ─────────────────────────────────────────
{
  const markersMinusTwo = ALL_MARKER_TOKENS.filter((t) => t !== "QUIET-LANE" && t !== "MGR122-FLOOR");
  const activeMissingTwo = writeFixture("active-missing-two.md", docWith({ markers: markersMinusTwo, items: 20 }));
  const rulesA = writeFixture("rulesA.md", "# Rules A\n\nTagged QUIET-LANE only.\n");
  const rulesB = writeFixture("rulesB.md", "# Rules B\n\nTagged MGR122-FLOOR only.\n");

  const r = runGate(["--active", activeMissingTwo, "--archive", archivePath, "--rules", rulesA, "--rules", rulesB]);
  check("two markers, each satisfied by a DIFFERENT one of two --rules files: exits 0", r.status === 0);
  check("marker sources name rulesA for QUIET-LANE", r.stdout.includes(`QUIET-LANE: ${rulesA}`));
  check("marker sources name rulesB for MGR122-FLOOR", r.stdout.includes(`MGR122-FLOOR: ${rulesB}`));
}

// ── Negative control: a marker absent from --active AND both --rules files still fails, even with two
// --rules files supplied. ────────────────────────────────────────────────────────────────────────────────
{
  const markersMinusQuietLane = ALL_MARKER_TOKENS.filter((t) => t !== "QUIET-LANE");
  const activeMissingOne = writeFixture("active-missing-quiet-lane-neg.md", docWith({ markers: markersMinusQuietLane, items: 20 }));
  const rules1 = writeFixture("rules1-neg.md", "Nothing relevant here.\n");
  const rules2 = writeFixture("rules2-neg.md", "Nothing relevant here either.\n");

  const r = runGate(["--active", activeMissingOne, "--archive", archivePath, "--rules", rules1, "--rules", rules2]);
  check("marker absent from --active and BOTH --rules files: exits 1", r.status === 1);
  check("names QUIET-LANE as missing", /QUIET-LANE/.test(r.stderr));
  check("failure message names 'any supplied --rules file', not just a single --rules", /--active or any supplied --rules file/.test(r.stderr));
}

// ── LIVE COMMITMENTS floor union across two --rules files: heading found only in the SECOND file. ──────
{
  const activeNoHeading = [
    "# Loom — Orchestrator Log (fixture)",
    "",
    ALL_MARKER_TOKENS.join(" · "),
    "This paragraph mentions live commitments in prose only, never as a real markdown heading line.",
    "",
  ].join("\n");
  const activeNoHeadingPath = writeFixture("commitments-active-no-heading.md", activeNoHeading);
  const rules1NoHeading = writeFixture("commitments-rules1-no-heading.md", "Nothing relevant here.\n");
  const rules2WithHeading = writeFixture("commitments-rules2-with-heading.md", `## LIVE COMMITMENTS\n${commitmentsList(15)}\n`);

  const r = runGate(["--active", activeNoHeadingPath, "--archive", archivePath, "--rules", rules1NoHeading, "--rules", rules2WithHeading]);
  check("commitments union across two --rules files, heading only in the second: exits 0", r.status === 0);
  check("reports the count (15 items) labeled via the second file's own path", r.stdout.includes(`15 LIVE COMMITMENTS item(s) (via ${rules2WithHeading})`));
  check("names the section as satisfied via the second file's own path", r.stdout.includes(`LIVE COMMITMENTS section satisfied via: ${rules2WithHeading}`));
}

// ── AMBIGUOUS (N-file shape): the heading is found in --active AND in a --rules file — winner is
// --active, the notice must name it as MULTIPLE places, not silently reuse the old two-file-only wording. ──
{
  const activeWithHeading = docWith({ items: 20 });
  const activeWithHeadingPath = writeFixture("commitments-ambiguous-active.md", activeWithHeading);
  const rules1Short = writeFixture("commitments-ambiguous-rules1.md", `## LIVE COMMITMENTS\n${commitmentsList(2)}\n`);
  const rules2Short = writeFixture("commitments-ambiguous-rules2.md", `## LIVE COMMITMENTS\n${commitmentsList(3)}\n`);

  const r = runGate(["--active", activeWithHeadingPath, "--archive", archivePath, "--rules", rules1Short, "--rules", rules2Short]);
  check("ambiguous across active + two --rules files: still exits 0 (active wins by precedence)", r.status === 0);
  check("AMBIGUOUS notice fires", /AMBIGUOUS/.test(r.stderr));
  check("notice says MULTIPLE places (not the old two-file-only wording)", /MULTIPLE places/.test(r.stderr));
  check("notice names both other files", r.stderr.includes(rules1Short) && r.stderr.includes(rules2Short));
}

// ── Literal duplicate --rules <same-path> is deduped, not treated as two separate ambiguous sources. ────
{
  const activeNoHeading = [
    "# Loom — Orchestrator Log (fixture)",
    "",
    ALL_MARKER_TOKENS.join(" · "),
    "prose mention of live commitments only, not a heading.",
    "",
  ].join("\n");
  const activeNoHeadingPath = writeFixture("dedup-active-no-heading.md", activeNoHeading);
  const rulesOnce = writeFixture("dedup-rules.md", `## LIVE COMMITMENTS\n${commitmentsList(15)}\n`);

  const r = runGate(["--active", activeNoHeadingPath, "--archive", archivePath, "--rules", rulesOnce, "--rules", rulesOnce]);
  check("same --rules path passed twice: exits 0", r.status === 0);
  check("does NOT fire a false AMBIGUOUS notice for a literal duplicate path", !/AMBIGUOUS/.test(r.stderr));
  check("labels the single distinct file as 'rules' (byte-identical single-file shape), not its own path", /LIVE COMMITMENTS section satisfied via: rules/.test(r.stdout));
}

// ── Usage errors are unaffected by --rules being repeatable. ─────────────────────────────────────────────
{
  const r = runGate(["--lint"]);
  check("usage: --lint with no --active at all still exits 2", r.status === 2);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — repeated --rules is UNIONED across every occurrence (never last-wins), reports per-file which marker/section was satisfied where, dedupes a literal duplicate path, and generalizes the AMBIGUOUS notice to N files without disturbing the single-file shape."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
