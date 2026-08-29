import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// Tests for card 9a5837b2's two additions to packages/daemon/scripts/rotation-gate.mjs:
//   1. --rules <path> — a UNION with --active: a marker is satisfied if present in --active OR --rules.
//      Exists so moving durable-marker content out of the rotating doc into the non-rotating
//      Operations/Orchestrator Rules.md never makes the gate go blind to a marker mid-move — the two
//      landings (script change, vault move) become order-independent.
//   2. --lint — runs the same marker + LIVE COMMITMENTS checks without requiring/checking --archive, so
//      the gate can be run against the LIVE doc any time, not only at a rotation.
//
// Run: node packages/daemon/test/rotation-gate-rules-lint.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

// The exact 14 marker tokens rotation-gate.mjs requires, as of card 9a5837b2 (kept as a local literal —
// this file is a TEST, not the source of truth; rotation-gate.mjs's own MARKERS array is that).
const ALL_MARKER_TOKENS = [
  "Orchestrator Rules",
  "THE FOUR-LEG VERIFY",
  "OWNER-GATED",
  "ROTATE AT 40 KB",
  "THE SAFE-WRITE",
  "MULTI-HARNESS EPIC",
  "ANNOUNCE-CANNOT-CARRY-A-SHA",
  "NO-CLEARANCE-FROM-SILENCE",
  "MGR122-FLOOR",
  "capQueued",
  "in-memory",
  "QUIET-LANE",
];

function commitmentsList(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. Commitment number ${i}.`);
  return lines.join("\n");
}

// `markers` are the non-heading tokens present as prose (LIVE COMMITMENTS / MY-PEER-SEND-LEDGER are
// always present via the real section headings below, independent of this list).
// LIVE_COMMITMENTS_FLOOR is 20 as of card 34a6f07e (was a fixed count of 14, now a floor — see
// rotation-gate.mjs's own header). A well-formed doc in this file must carry >= 20 items.
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

function runGate(argsArr) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...argsArr], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
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

// ── Positive control (b): one numbered commitment deleted (18 instead of the 20-item floor). ────────────
// (Card DoD-5b: "delete one numbered commitment from another COPY ⇒ expect exit 1".)
{
  const p = writeFixture("short-commitments.md", docWith({ items: 18 }));
  const r = runGate(["--active", p, "--archive", archivePath]);
  check("control (b) 18/20 commitments: exits 1", r.status === 1);
  check("control (b): reports the real count", /holds 18 numbered item\(s\), fewer than the required floor of 20/.test(r.stderr));
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
  const markers = ALL_MARKER_TOKENS.filter((t) => t !== "MGR122-FLOOR");
  const p = writeFixture("lint-missing-marker.md", docWith({ markers, items: 20 }));
  const r = runGate(["--active", p, "--lint"]);
  check("lint: missing marker still refused: exits 1", r.status === 1);
  check("lint: names the missing marker", /MGR122-FLOOR/.test(r.stderr));
}

// ── --lint still enforces the LIVE COMMITMENTS count. ────────────────────────────────────────────────
{
  const p = writeFixture("lint-short-commitments.md", docWith({ items: 5 }));
  const r = runGate(["--active", p, "--lint"]);
  check("lint: short commitments section still refused: exits 1", r.status === 1);
  check("lint: reports the real count", /holds 5 numbered item\(s\), fewer than the required floor of 20/.test(r.stderr));
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

// ── Usage errors: --active is always required (even under --lint); --archive still required without --lint. ──
{
  const r1 = runGate(["--lint"]);
  check("usage: --lint with no --active at all: exits 2", r1.status === 2);

  const r2 = runGate(["--active", goodActivePath]);
  check("usage: no --lint and no --archive: exits 2", r2.status === 2);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — --rules unions marker satisfaction across --active/--rules without ever weakening presence, and --lint runs the same checks without requiring --archive, while the unflagged rotation path is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
