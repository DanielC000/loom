import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// REGRESSION/FEATURE TEST (card eba7a6f7) for packages/daemon/scripts/rotation-gate.mjs's OPTIONAL
// --commitments-marker flag — an explicit MACHINE MARKER that, when given, replaces heading-TEXT search
// as how the LIVE COMMITMENTS section's start is located.
//
// THE HAZARD: `countLiveCommitmentsIn`'s heading-text search (no marker) matches the FIRST heading line
// that merely CONTAINS "live commitments" — so a heading elsewhere in the doc that only CITES that text,
// and happens to appear earlier, silently wins over the real section. Case 1 below proves this hazard is
// REAL on the fixed (current) script when --commitments-marker is NOT given — a companion regression test
// to rotation-gate-heading-anchor.mjs, which already covers the PROSE-mention (non-heading) case; this file
// is about a second, real HEADING that cites the token.
//
// Run: node packages/daemon/test/rotation-gate-marker-anchor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-marker-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// Every marker rotation-gate.mjs requires, present as plain prose text (mirrors the fixture convention in
// rotation-gate-heading-anchor.mjs) — none of these lines are headings, so they satisfy the presence check
// without ever opening/closing the commitments span.
const ALL_MARKERS_PROSE = [
  "Orchestrator Rules · THE FOUR-LEG VERIFY · OWNER-GATED · ROTATE AT 40 KB · THE SAFE-WRITE ·",
  "MULTI-HARNESS EPIC · NO-CLEARANCE-FROM-SILENCE ·",
  "capQueued · in-memory · QUIET-LANE · MGR122-FLOOR ·",
  "PRAISE-IS-THE-LEAST-AUDITED-INPUT · PRE-MERGE-PAIR",
].join("\n");

function commitmentsList(n, startAt = 1) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`${startAt + i}. Commitment number ${startAt + i}.`);
  return lines.join("\n");
}

const MARKER = "<!-- loom:live-commitments -->";

function runGate(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const archivePath = writeFixture("archive.md", "archive contents\n");

// ── Case 1: THE HAZARD, DEMONSTRATED ON THE CURRENT SCRIPT — a real heading earlier in the doc CITES the
// LIVE COMMITMENTS heading text and carries its own short numbered list; the real section, further down,
// holds a healthy 20 items. WITHOUT --commitments-marker, the citing heading wins — the gate refuses a doc
// whose real section is fine, on the wrong section's count. This is the RED proof: run the SAME fixture
// again in Case 2 WITH --commitments-marker and it must pass. ─────────────────────────────────────────────
const citingHeadingDoc = [
  "# Loom — Orchestrator Log (fixture)",
  "",
  "## An earlier section that happens to mention LIVE COMMITMENTS in its own heading",
  commitmentsList(3),
  "",
  ALL_MARKERS_PROSE,
  "",
  MARKER,
  "## ⛔⛔ §LIVE COMMITMENTS — the real section",
  commitmentsList(20),
  "",
].join("\n");

{
  const p = writeFixture("citing-heading.md", citingHeadingDoc);
  const r = runGate(["--active", p, "--archive", archivePath]);
  check("Case 1 (RED, no marker): a citing heading earlier in the doc wins over the real 20-item section", r.status === 1);
  check("Case 1: refusal names the wrong (3-item) count, not the real 20", /holds 3 numbered item\(s\)/.test(r.stderr));
}

// ── Case 2: THE FIX — the SAME fixture, WITH --commitments-marker, correctly locates the real section. ──
{
  const p = writeFixture("citing-heading-2.md", citingHeadingDoc);
  const r = runGate(["--active", p, "--archive", archivePath, "--commitments-marker", MARKER]);
  check("Case 2 (GREEN, with marker): the SAME fixture now passes — the real 20-item section is located", r.status === 0);
  check("Case 2: OK line names the marker anchor", /via marker/.test(r.stdout));
}

// ── Case 3: marker configured but ABSENT from --active — no silent fallback to heading-text search, even
// though heading-text search would have (wrongly) found the citing heading and possibly passed/failed on
// it. Use a doc with ONLY the citing heading (no real marker anywhere) so a heading-text fallback would
// silently use the wrong 3-item section — the marker-mode result must instead be a clean "not found". ────
{
  const noMarkerDoc = [
    "# Loom — Orchestrator Log (fixture)",
    "",
    "## An earlier section that happens to mention LIVE COMMITMENTS in its own heading",
    commitmentsList(3),
    "",
    ALL_MARKERS_PROSE,
    "",
    "## Some other real section, no marker present anywhere in this file",
    commitmentsList(20),
    "",
  ].join("\n");
  const p = writeFixture("no-marker.md", noMarkerDoc);
  const r = runGate(["--active", p, "--archive", archivePath, "--commitments-marker", MARKER]);
  check("Case 3: marker configured but absent from --active ⇒ refused (never silently falls back to heading-text)", r.status === 1);
  check("Case 3: refusal names the marker anchor, not a heading-missing message", /marker anchor .* not found/.test(r.stderr));
}

// ── Case 4: the marker occurs TWICE — a decoy heading sits right after the FIRST occurrence, so the
// deterministic first-occurrence pick lands on the WRONG (3-item) section, correctly failing the floor —
// but the AMBIGUOUS notice must fire unconditionally on stderr, never silently. ─────────────────────────
{
  const ambiguousDoc = [
    "# Loom — Orchestrator Log (fixture)",
    "",
    MARKER,
    "## A decoy heading right after the stray marker occurrence",
    commitmentsList(3),
    "",
    ALL_MARKERS_PROSE,
    "",
    MARKER,
    "## ⛔⛔ §LIVE COMMITMENTS — the real section",
    commitmentsList(20),
    "",
  ].join("\n");
  const p = writeFixture("ambiguous.md", ambiguousDoc);
  const r = runGate(["--active", p, "--archive", archivePath, "--commitments-marker", MARKER]);
  check("Case 4: ambiguous marker ⇒ first occurrence wins, lands on the decoy (3 items, below floor) ⇒ refused", r.status === 1);
  check("Case 4: refusal names 3 items, not the real 20 — proves the ambiguity is consequential, not cosmetic", /holds 3 numbered item\(s\)/.test(r.stderr));
  check("Case 4: the MARKER AMBIGUOUS notice fires on stderr, unconditionally", /MARKER AMBIGUOUS/.test(r.stderr));
  check("Case 4: the notice names both occurrence lines", /line\(s\) 3, 14/.test(r.stderr));
}

// ── Case 5: --lint mode carries the same marker-anchored locator (no --archive required). ────────────────
{
  const p = writeFixture("lint-marker.md", citingHeadingDoc);
  const r = runGate(["--active", p, "--lint", "--commitments-marker", MARKER]);
  check("Case 5: --lint + --commitments-marker locates the real section too", r.status === 0);
  check("Case 5: LINT OK line names the marker anchor", /LINT OK/.test(r.stdout) && /via marker/.test(r.stdout));
}

// ── Case 6: byte-identical when --commitments-marker is omitted — the pre-existing rotation-gate-heading-
// anchor.mjs suite already proves this end-to-end (it never passes the flag), but assert it directly here
// too: the SAME citing-heading fixture behaves identically whether the flag is simply never mentioned. ────
{
  const p = writeFixture("omitted.md", citingHeadingDoc);
  const r = runGate(["--active", p, "--archive", archivePath]);
  check("Case 6: omitting --commitments-marker entirely reproduces Case 1's RED result unchanged", r.status === 1 && /holds 3 numbered item\(s\)/.test(r.stderr));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card eba7a6f7's --commitments-marker flag: proven RED on the current (already heading-anchor-fixed) script when a real citing heading appears earlier than the real LIVE COMMITMENTS section, proven GREEN on the identical fixture once the marker is supplied, never falls back to heading-text search when the marker itself is absent from --active, surfaces a loud (never silent) MARKER AMBIGUOUS notice naming every occurrence when the marker itself occurs more than once (and shows the consequence is real — the wrong section gets counted), carries into --lint mode, and is byte-identical to before this flag existed when omitted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
