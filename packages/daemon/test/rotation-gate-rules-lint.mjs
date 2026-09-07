import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// Tests for card 9a5837b2's two additions to packages/daemon/scripts/rotation-gate.mjs:
//   1. --rules <path> — a UNION with --active: a marker is satisfied if present in --active OR --rules.
//      Exists so moving durable-marker content out of the rotating doc into the non-rotating
//      Operations/Orchestrator Rules.md never makes the gate go blind to a marker mid-move — the two
//      landings (script change, vault move) become order-independent.
//   2. --lint — runs the same marker + LIVE COMMITMENTS checks without requiring/checking --archive, so
//      the gate can be run against the LIVE doc any time, not only at a rotation.
//
// EXTENDED by card e312b207 (owner-approved option (a): move §LIVE COMMITMENTS into the non-rotating
// rules file, and move its count guard with it): the --rules union above originally only covered MARKERS
// — the "LIVE COMMITMENTS FLOOR UNION" block below proves --rules now also unions the commitments-count
// check itself (found in either file, active tried first so behavior is unchanged while the section
// stays in --active, fail-closed refusal if the heading is in neither file).
//
// Run: node packages/daemon/test/rotation-gate-rules-lint.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-rl-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// The marker tokens rotation-gate.mjs requires, as of card 9a5837b2, narrowed by card bcd3f690
// (2026-09-02, which retired MY-PEER-SEND-LEDGER, ANNOUNCE-CANNOT-CARRY-A-SHA, MGR122-FLOOR), then
// amended by card a681aed5 (same day, restored MGR122-FLOOR) — kept as a local literal here;
// rotation-gate.mjs's own MARKERS array is the source of truth. Card 4cbb2999 (2026-09-07) added
// PRAISE-IS-THE-LEAST-AUDITED-INPUT and PRE-MERGE-PAIR — this file's fixtures include them as ordinary
// prose so every "all markers present" doc here still satisfies the real (now-larger) MARKERS array.
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

// `markers` are the non-heading tokens present as prose (LIVE COMMITMENTS / MY-PEER-SEND-LEDGER are
// always present via the real section headings below, independent of this list).
// LIVE_COMMITMENTS_FLOOR is 12 as of card bcd3f690 (2026-09-02, lowered from 20 by the owner's ceremony
// cut — see rotation-gate.mjs's own header). A well-formed doc in this file must carry >= 12 items; the
// default here (20) is simply well above that floor.
function docWith({ markers = ALL_MARKER_TOKENS, items = 20 } = {}) {
  return [
    "# Loom — Orchestrator Log (fixture)",
    "",
    markers.join(" · "),
    "",
    "## ⛔⛔ §LIVE COMMITMENTS — carried verbatim",
    commitmentsList(items),
    "",
    "## 📮 §MY-PEER-SEND-LEDGER — append every peer_message",
    "Nothing yet.",
    "",
  ].join("\n");
}

// Switched from execFileSync/try-catch to spawnSync (code review, card e312b207): the old execFileSync
// form hardcoded `stderr: ""` on every SUCCESS path — it never captured the child's stderr at all unless
// the process actually threw. That was invisible until this card added a diagnostic (the AMBIGUOUS notice)
// that can legitimately print to stderr on a SUCCESSFUL run (exit 0) — every such assertion silently saw
// an empty string regardless of what the script actually printed. spawnSync returns {status, stdout,
// stderr} uniformly for both outcomes, so a passing run's stderr is now genuinely inspectable too. No
// existing assertion in this file reads `.stderr` on a success-path result, so this is additive only.
function runGate(argsArr) {
  const result = spawnSync(process.execPath, [SCRIPT, ...argsArr], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const archivePath = writeFixture("archive.md", "archive contents\n");
const goodActivePath = writeFixture("good-active.md", docWith({ items: 20 }));

// ── Baseline: no --rules, no --lint — must remain byte-shape-identical to pre-9a5837b2 behavior. ───────
{
  const r = runGate(["--active", goodActivePath, "--archive", archivePath]);
  check("baseline (no --rules/--lint): exits 0", r.status === 0);
  check("baseline: reports OK / Rotation may proceed", /\[rotation-gate\] OK/.test(r.stdout) && /Rotation may proceed/.test(r.stdout));
  check("baseline: does NOT print a marker-sources breakdown (no --rules supplied)", !/marker sources/.test(r.stdout));
}

// ── Positive control (a): the POINTER marker ("Orchestrator Rules") is missing from --active. ──────────
// (Card DoD-5a: "sed the Orchestrator Rules pointer to nonsense in a COPY ⇒ expect exit 1".)
{
  const markers = ALL_MARKER_TOKENS.filter((t) => t !== "Orchestrator Rules");
  const p = writeFixture("no-pointer.md", docWith({ markers, items: 20 }));
  const r = runGate(["--active", p, "--archive", archivePath]);
  check("control (a) missing pointer marker: exits 1", r.status === 1);
  check("control (a): names 'Orchestrator Rules' as missing", /Orchestrator Rules/.test(r.stderr));
}

// ── Positive control (b): commitments below the current floor of 12 (11 instead of 12). ─────────────────
// (Card DoD-5b: "delete one numbered commitment from another COPY ⇒ expect exit 1".)
{
  const p = writeFixture("short-commitments.md", docWith({ items: 11 }));
  const r = runGate(["--active", p, "--archive", archivePath]);
  check("control (b) 11/12 commitments: exits 1", r.status === 1);
  check("control (b): reports the real count", /holds 11 numbered item\(s\), fewer than the required floor of 12/.test(r.stderr));
}

// ── Positive control (c): the archive leg — nonexistent path, then an empty file. ───────────────────────
{
  const missingArchive = path.join(tmpDir, "does-not-exist.archive.md");
  const r1 = runGate(["--active", goodActivePath, "--archive", missingArchive]);
  check("control (c) nonexistent --archive: exits 1", r1.status === 1);
  check("control (c): REFUSED names the archive problem", /REFUSED: --archive/.test(r1.stderr));

  const emptyArchive = writeFixture("empty-archive.md", "");
  const r2 = runGate(["--active", goodActivePath, "--archive", emptyArchive]);
  check("control (c) empty --archive: exits 1", r2.status === 1);
  check("control (c): names the archive as empty", /is empty/.test(r2.stderr));
}

// ── --rules UNION: a marker present ONLY in --rules must FAIL without --rules and PASS with it. ────────
{
  const markersMinusQuietLane = ALL_MARKER_TOKENS.filter((t) => t !== "QUIET-LANE");
  const activeMissingOne = writeFixture("active-missing-quiet-lane.md", docWith({ markers: markersMinusQuietLane, items: 20 }));
  const rulesWithQuietLane = writeFixture("rules-with-quiet-lane.md", "# Orchestrator Rules (fixture)\n\nThis durable rule is tagged QUIET-LANE.\n");

  const withoutRules = runGate(["--active", activeMissingOne, "--archive", archivePath]);
  check("union: marker missing from --active, no --rules given: exits 1", withoutRules.status === 1);
  check("union: names QUIET-LANE as missing", /QUIET-LANE/.test(withoutRules.stderr));

  const withRules = runGate(["--active", activeMissingOne, "--archive", archivePath, "--rules", rulesWithQuietLane]);
  check("union: marker missing from --active but present in --rules: exits 0", withRules.status === 0);
  check("union: reports QUIET-LANE satisfied via --rules", /QUIET-LANE/.test(withRules.stdout) && /--rules/.test(withRules.stdout));
  check("union: per-marker source breakdown names QUIET-LANE: rules", /QUIET-LANE: rules/.test(withRules.stdout));
}

// ── --rules UNION, negative: a marker in NEITHER file still fails, even with --rules supplied. ─────────
{
  const markersMinusQuietLane = ALL_MARKER_TOKENS.filter((t) => t !== "QUIET-LANE");
  const activeMissingOne = writeFixture("active-missing-quiet-lane-2.md", docWith({ markers: markersMinusQuietLane, items: 20 }));
  const rulesWithoutIt = writeFixture("rules-without-quiet-lane.md", "# Orchestrator Rules (fixture)\n\nNothing relevant here.\n");
  const r = runGate(["--active", activeMissingOne, "--archive", archivePath, "--rules", rulesWithoutIt]);
  check("union: marker absent from BOTH --active and --rules: exits 1", r.status === 1);
  check("union: names QUIET-LANE as missing even with --rules supplied", /QUIET-LANE/.test(r.stderr));
}

// ── --rules UNION: when --rules is supplied but every marker is already satisfied by --active alone, say so. ──
{
  const r = runGate(["--active", goodActivePath, "--archive", archivePath, "--rules", writeFixture("unused-rules.md", "irrelevant\n")]);
  check("union: --rules supplied but not needed: exits 0", r.status === 0);
  check("union: reports all markers satisfied via --active alone", /all \d+ markers satisfied via --active alone/.test(r.stdout));
}

// ── --lint: skips --archive entirely — a clean doc passes with NO --archive argument at all. ────────────
{
  const r = runGate(["--active", goodActivePath, "--lint"]);
  check("lint: clean doc, no --archive given at all: exits 0", r.status === 0);
  check("lint: reports LINT OK", /\[rotation-gate\] LINT OK/.test(r.stdout));
  check("lint: does not claim rotation may proceed (this is not a rotation)", !/Rotation may proceed/.test(r.stdout));
}

// ── --lint still enforces the marker check — a doc missing a marker fails lint the same as rotation. ───
{
  const markers = ALL_MARKER_TOKENS.filter((t) => t !== "NO-CLEARANCE-FROM-SILENCE");
  const p = writeFixture("lint-missing-marker.md", docWith({ markers, items: 20 }));
  const r = runGate(["--active", p, "--lint"]);
  check("lint: missing marker still refused: exits 1", r.status === 1);
  check("lint: names the missing marker", /NO-CLEARANCE-FROM-SILENCE/.test(r.stderr));
}

// ── --lint still enforces the LIVE COMMITMENTS count. ────────────────────────────────────────────────
{
  const p = writeFixture("lint-short-commitments.md", docWith({ items: 5 }));
  const r = runGate(["--active", p, "--lint"]);
  check("lint: short commitments section still refused: exits 1", r.status === 1);
  check("lint: reports the real count", /holds 5 numbered item\(s\), fewer than the required floor of 12/.test(r.stderr));
}

// ── --lint combined with --rules: the union still applies under lint mode. ──────────────────────────────
{
  const markersMinusQuietLane = ALL_MARKER_TOKENS.filter((t) => t !== "QUIET-LANE");
  const activeMissingOne = writeFixture("lint-active-missing-quiet-lane.md", docWith({ markers: markersMinusQuietLane, items: 20 }));
  const rulesWithQuietLane = writeFixture("lint-rules-with-quiet-lane.md", "This durable rule is tagged QUIET-LANE.\n");
  const r = runGate(["--active", activeMissingOne, "--lint", "--rules", rulesWithQuietLane]);
  check("lint + --rules union: exits 0", r.status === 0);
  check("lint + --rules union: reports LINT OK", /LINT OK/.test(r.stdout));
}

// ── LIVE COMMITMENTS FLOOR UNION (card e312b207) — --rules now also covers the commitments count, not
// just markers. Owner-approved option (a): move §LIVE COMMITMENTS into the non-rotating rules file, and
// move its count guard with it. Proves the three required shapes: union (found in rules when active has
// no heading), unchanged (active wins even when rules also carries a shorter section), and fail-closed
// (heading in neither file, even with --rules supplied, must still refuse — never a silent "0 items,
// nothing to check" pass). ──────────────────────────────────────────────────────────────────────────────
{
  // Active doc: every marker present as prose (including "LIVE COMMITMENTS" itself as a plain mention,
  // NOT as a real heading line) so the marker check passes cleanly and only the commitments-section check
  // is under test. No MY-PEER-SEND-LEDGER heading needed — that marker was retired (see file header).
  // NOTE: the title line deliberately does NOT contain "live commitments" — a heading LINE containing
  // that phrase (even describing the fixture's own intent) would itself satisfy the structural heading
  // anchor and defeat the whole point of this fixture; the prose mention below is a non-heading line.
  const activeNoHeading = [
    "# Loom — Orchestrator Log (fixture)",
    "",
    ALL_MARKER_TOKENS.join(" · "),
    "This paragraph mentions live commitments in prose only, never as a real markdown heading line.",
    "",
  ].join("\n");
  const activeNoHeadingPath = writeFixture("commitments-union-active-no-heading.md", activeNoHeading);

  const rulesWithHeading = writeFixture("commitments-union-rules-with-heading.md", `## LIVE COMMITMENTS\n${commitmentsList(15)}\n`);
  const withRules = runGate(["--active", activeNoHeadingPath, "--archive", archivePath, "--rules", rulesWithHeading]);
  check("commitments union: heading absent from --active, present in --rules: exits 0", withRules.status === 0);
  check("commitments union: reports the count found via --rules (15 items)", /carries all \d+ markers and 15 LIVE COMMITMENTS item\(s\) \(via --rules\)/.test(withRules.stdout));
  check("commitments union: names the section as satisfied via rules", /LIVE COMMITMENTS section satisfied via: rules/.test(withRules.stdout));

  const withoutRules = runGate(["--active", activeNoHeadingPath, "--archive", archivePath]);
  check("commitments union: same active doc, NO --rules given at all: exits 1 (unregressed single-file behavior)", withoutRules.status === 1);
  check("commitments union: names the heading as missing, not a false '0 items'", /could not locate the LIVE COMMITMENTS section \(heading missing\)/.test(withoutRules.stderr));

  // Unchanged: --active carries the real heading, so it wins even when --rules ALSO has a section — one
  // that is deliberately BELOW the floor, to prove the gate never silently reads from --rules instead.
  const rulesWithShortSection = writeFixture("commitments-union-rules-short.md", `## LIVE COMMITMENTS\n${commitmentsList(2)}\n`);
  const activeWins = runGate(["--active", goodActivePath, "--archive", archivePath, "--rules", rulesWithShortSection]);
  check("commitments union unchanged: --active has the heading ⇒ counted from --active (20), never --rules (2): exits 0", activeWins.status === 0);
  check("commitments union unchanged: reports the count labeled '(via --active)', unconditionally (ruling (i))", /carries all \d+ markers and 20 LIVE COMMITMENTS item\(s\) \(via --active\) \(>= floor/.test(activeWins.stdout));
  check("commitments union unchanged: does NOT claim it came from --rules", !/20 LIVE COMMITMENTS item\(s\) \(via --rules\)/.test(activeWins.stdout));
  check("commitments union unchanged: names the section as satisfied via active", /LIVE COMMITMENTS section satisfied via: active/.test(activeWins.stdout));

  // This exact fixture is ALSO an AMBIGUOUS shape (code review, ruling (i)+(ii)): --rules carries a real
  // "## LIVE COMMITMENTS" heading too (with fewer items), so both files have a candidate — --active still
  // wins by precedence and the exit code is unaffected (ruling (iii) rejected a hard failure here), but
  // the shape must be surfaced loudly on stderr rather than passing as an ordinary, unremarkable green.
  check("commitments union unchanged (also AMBIGUOUS): the AMBIGUOUS notice fires on stderr even though the run still exits 0", /AMBIGUOUS/.test(activeWins.stderr));
  check("commitments union unchanged (also AMBIGUOUS): notice names both counts (20 from --active, 2 from --rules)", /--active \(20 item\(s\)\)/.test(activeWins.stderr) && /--rules \(2 item\(s\)\)/.test(activeWins.stderr));

  // NEGATIVE CONTROL: the earlier "heading absent from --active, present in --rules" case above is NOT
  // ambiguous (only one file carries a candidate) — proves the notice discriminates, not just always fires.
  check("commitments union NOT ambiguous when only one file carries the heading (negative control)", !/AMBIGUOUS/.test(withRules.stderr));

  // BOUNDARY (code review, item 2): --active carries the heading but BELOW the floor, while --rules
  // carries a section that would PASS on its own — must still FAIL, source --active. Neither test above
  // pins this (both have --active passing on its own), so a wrong "fall through to whichever passes"
  // implementation would slip through unnoticed there.
  const activeBelowFloorPath = writeFixture("commitments-boundary-active-below-floor.md", docWith({ items: 3 }));
  const rulesAboveFloor = writeFixture("commitments-boundary-rules-above-floor.md", `## LIVE COMMITMENTS\n${commitmentsList(20)}\n`);
  const boundaryResult = runGate(["--active", activeBelowFloorPath, "--archive", archivePath, "--rules", rulesAboveFloor]);
  check("commitments boundary: --active below floor, --rules above floor ⇒ still exits 1 (never falls through to a passing --rules count)", boundaryResult.status === 1);
  check("commitments boundary: reports the real --active count (3), not --rules' 20", /holds 3 numbered item\(s\), fewer than the required floor of 12/.test(boundaryResult.stderr));
  check("commitments boundary: this is ALSO an ambiguous shape (both files carry a candidate) — the notice still fires on a FAILING run", /AMBIGUOUS/.test(boundaryResult.stderr));

  // Fail-closed: the heading is in NEITHER file, even though --rules IS supplied — must still refuse.
  const rulesNoHeadingEither = writeFixture("commitments-union-rules-no-heading.md", "Nothing relevant here either.\n");
  const bothMissing = runGate(["--active", activeNoHeadingPath, "--archive", archivePath, "--rules", rulesNoHeadingEither]);
  check("commitments union fail-closed: heading in NEITHER --active nor --rules: exits 1", bothMissing.status === 1);
  check("commitments union fail-closed: reports 'heading missing', not a silent pass", /could not locate the LIVE COMMITMENTS section \(heading missing\)/.test(bothMissing.stderr));
  check("commitments union fail-closed: diagnostic names BOTH files were checked", /found in --active or --rules/.test(bothMissing.stderr));
}

// ── Usage errors: --active is always required (even under --lint); --archive still required without --lint. ──
{
  const r1 = runGate(["--lint"]);
  check("usage: --lint with no --active at all: exits 2", r1.status === 2);

  const r2 = runGate(["--active", goodActivePath]);
  check("usage: no --lint and no --archive: exits 2", r2.status === 2);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — --rules unions marker satisfaction across --active/--rules without ever weakening presence, --lint runs the same checks without requiring --archive, the unflagged rotation path is unchanged, and (card e312b207) the LIVE COMMITMENTS floor is now unioned the same way — active tried first (unchanged behavior), rules only when active has no heading, fail-closed refusal when the heading is in neither file."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
