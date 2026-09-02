import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// REGRESSION TEST (card d78a6d5d) for packages/daemon/scripts/rotation-gate.mjs's LIVE COMMITMENTS section
// locator.
//
// THE INCIDENT: the pre-fix `countLiveCommitments` located both section boundaries with a bare,
// case-insensitive, FIRST-OCCURRENCE `indexOf` over the whole document — not anchored to a markdown
// heading. A doc whose header block documented the gate's own contract in one sentence naming BOTH
// boundary tokens (e.g. "checks the LIVE COMMITMENTS section boundary and the MY-PEER-SEND-LEDGER
// boundary") caused the gate to measure that short sentence instead of the real section, reporting the
// maximally-alarming "0 numbered item(s), expected 14" on a document whose real section was intact and
// correctly held all 14 items. Reproduced live twice (mgr `gen 187` and `gen 188`) before this fix.
//
// ✅ RED-BEFORE-FIX PROOF (run manually, not part of this file's own execution — pasted in the task
// report): `git show HEAD:packages/daemon/scripts/rotation-gate.mjs` (the pre-fix version, card b85b3345)
// against the exact INCIDENT_REPRO fixture below exits 1, reporting "0 numbered item(s), expected 14".
// The CURRENT (fixed) script, run against the same fixture, exits 0. This file only exercises the fixed
// script — the manual step above is what proves the fixture actually reproduces the incident.
//
// THE FIX: both boundaries are now anchored to a real markdown HEADING LINE (`/^#{1,6}\s/` plus the
// token, case-insensitive) — a prose mention of either token that isn't itself a heading line is inert.
//
// EXTENDED by card `a681aed5` (2026-09-02) for a SECOND, independent anchor defect in the same function:
// the END boundary used to be a NAME anchor too — a heading literally containing "my-peer-send-ledger" —
// separate from the MARKERS array and unnoticed when card `bcd3f690` retired the MY-PEER-SEND-LEDGER
// marker the same day. A later vault edit that actually deleted that heading (replacing it with
// `§PEER-CHANNEL`) silently fell back to end-of-file — benign only because nothing else in the doc held a
// numbered list below the section that day, but fail-OPEN: any FUTURE numbered list added below LIVE
// COMMITMENTS would silently inflate the count. Cases 6-7 below prove this: (6) is the RED/GREEN pair —
// the committed PRE-FIX script (extracted via `git show HEAD`, same technique as
// rotation-gate-arity-floor.mjs) MISCOUNTS a fixture with a trailing numbered list, the FIXED script
// (this repo's current source) counts it correctly; (7) proves the fixed anchor is genuinely structural
// (heading DEPTH, not name) by using a next-heading name that shares no vocabulary with any old anchor.
// See rotation-gate.mjs's own `findSectionBoundary` comment for why the rule is "same level or
// shallower," not "any heading" or "the immediate next `##`".
//
// Run: node packages/daemon/test/rotation-gate-heading-anchor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT_REPO_REL = "packages/daemon/scripts/rotation-gate.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// Every marker rotation-gate.mjs requires, present as plain prose text — none of these lines are headings
// (no leading `#`), so they satisfy the presence check without ever opening/closing the commitments span.
// Card bcd3f690 (2026-09-02) retired 3 of the original 14 markers (MY-PEER-SEND-LEDGER,
// ANNOUNCE-CANNOT-CARRY-A-SHA, MGR122-FLOOR); card a681aed5 (same day) restored MGR122-FLOOR — this list
// holds the 11 prose markers that currently survive (12 total incl. LIVE COMMITMENTS via the real heading).
const ALL_MARKERS_PROSE = [
  "Orchestrator Rules · THE FOUR-LEG VERIFY · OWNER-GATED · ROTATE AT 40 KB · THE SAFE-WRITE ·",
  "MULTI-HARNESS EPIC · NO-CLEARANCE-FROM-SILENCE ·",
  "capQueued · in-memory · QUIET-LANE · MGR122-FLOOR",
].join("\n");

function commitmentsList(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. Commitment number ${i}.`);
  return lines.join("\n");
}

// LIVE_COMMITMENTS_FLOOR is 12 as of card bcd3f690 (2026-09-02, lowered from 20 by the owner's ceremony
// cut — see rotation-gate.mjs's own header). A "clean"/well-formed doc in this file must carry >= 12
// items; the default here (20) is simply well above that floor.
function docWith({ preface = "", items = 20 } = {}) {
  return [
    "# Loom — Orchestrator Log (fixture)",
    "",
    preface,
    ALL_MARKERS_PROSE,
    "",
    "## ⛔⛔ §LIVE COMMITMENTS — carried verbatim",
    commitmentsList(items),
    "",
    "## 📮 §MY-PEER-SEND-LEDGER — append every peer_message",
    "Nothing yet.",
    "",
  ].join("\n");
}

// `scriptPath` defaults to the current (fixed) SCRIPT — every pre-existing call site (2 positional args)
// is byte-identical to before. Case 6 below passes a third arg to run the extracted pre-fix script instead.
function runGate(activePath, archivePath, scriptPath = SCRIPT) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, "--active", activePath, "--archive", archivePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const archivePath = writeFixture("archive.md", "archive contents\n");

// ── Case 1: a clean, correct doc — no prose mentions of either boundary token at all. Must PASS. ──────
{
  const p = writeFixture("clean.md", docWith({ items: 20 }));
  const r = runGate(p, archivePath);
  check("clean 20-item doc with no prose boundary mentions: exits 0", r.status === 0);
  check("clean 20-item doc: reports OK", /\[rotation-gate\] OK/.test(r.stdout));
}

// ── Case 2: THE INCIDENT ITSELF — both boundary tokens named in prose ABOVE their real headings, with a
// full, correctly-formatted 20-item section below. Card d78a6d5d DoD-2's second (load-bearing) polarity:
// this MUST pass on the fixed script (and is proven, manually, to fail on the pre-fix script — see header).
{
  const preface =
    "> This rotation is gated by rotation-gate.mjs, which checks the LIVE COMMITMENTS section boundary\n" +
    "> and the MY-PEER-SEND-LEDGER section boundary before promoting a new doc.";
  const p = writeFixture("incident-repro.md", docWith({ preface, items: 20 }));
  const r = runGate(p, archivePath);
  check("incident repro (boundary tokens named in prose above real headings, real 20-item section): exits 0", r.status === 0);
  check("incident repro: reports OK, not a false '0 numbered items' refusal", /\[rotation-gate\] OK/.test(r.stdout) && !/0 numbered item/.test(r.stdout));
}

// ── Case 3: a doc whose commitments section really IS short. Must still be REFUSED — the anchor fix must
// not weaken the guard into uselessness. Card d78a6d5d DoD-2's first polarity. ─────────────────────────
{
  const p = writeFixture("short-section.md", docWith({ items: 3 }));
  const r = runGate(p, archivePath);
  check("genuinely short (3-item) commitments section: exits 1", r.status === 1);
  check("genuinely short section: reports the real count (3, not 0)", /holds 3 numbered item\(s\), fewer than the required floor of 12/.test(r.stderr));
}

// ── Case 4: self-diagnosing failure message (card d78a6d5d DoD-3) — a count mismatch must name WHERE the
// section was measured (the matched heading lines), so a false positive is distinguishable from a real
// deletion without reading this script's source. ───────────────────────────────────────────────────────
{
  const p = writeFixture("short-section-diag.md", docWith({ items: 5 }));
  const r = runGate(p, archivePath);
  check("count-mismatch message names the matched LIVE COMMITMENTS heading line",
    /measured from heading line \d+ \("[^"]*LIVE COMMITMENTS[^"]*"\)/i.test(r.stderr));
  check("count-mismatch message names the matched MY-PEER-SEND-LEDGER heading line",
    /to heading line \d+ \("[^"]*MY-PEER-SEND-LEDGER[^"]*"\)/i.test(r.stderr));
}

// ── Case 5: the LIVE COMMITMENTS heading is missing entirely — distinct failure path, preserved. ──────
{
  const content = ["# No commitments heading here", "Just prose, no headings at all.", ""].join("\n");
  const p = writeFixture("no-heading.md", content);
  const r = runGate(p, archivePath);
  check("no LIVE COMMITMENTS heading at all: exits 1", r.status === 1);
  check("no heading: reports 'heading missing', not a misleading '0 numbered items'",
    /could not locate the LIVE COMMITMENTS section \(heading missing\)/.test(r.stderr));
}

// ── Case 6: THE RE-ANCHOR FIX (card a681aed5) — RED on the pre-fix script, GREEN on the fixed one. ──────
// Mirrors the real defect: a doc that (like the real post-`bcd3f690`-cut vault doc) carries NO heading
// containing "my-peer-send-ledger" at all, plus a numbered list belonging to an UNRELATED section below
// LIVE COMMITMENTS. The pre-fix end-anchor searches for that literal heading name, doesn't find it, falls
// back to end-of-file, and sweeps the unrelated list into the count. The fixed anchor stops at the next
// heading of the same level regardless of its name, and counts correctly.
//
// Extracted via `git show HEAD:<path>` — same technique as rotation-gate-arity-floor.mjs's own (a) leg —
// so this proves the CLAIM on the real committed pre-fix script, not a paraphrase of what it used to do.
// If HEAD has already moved past this fix (this file re-run long after it landed), the extracted copy no
// longer contains the old name-anchored call and the RED leg is skipped, reporting why, rather than
// silently asserting a stale premise as if it still held.
{
  const trailingListDoc = [
    "# Loom — Orchestrator Log (fixture, post-cut shape)",
    "",
    ALL_MARKERS_PROSE,
    "",
    "## ⛔⛔ §LIVE COMMITMENTS — carried verbatim",
    commitmentsList(12), // exactly the floor
    "",
    "## 🗂️ §SOME LATER SECTION — added after the old ledger heading was fully removed",
    "1. An unrelated numbered item that happens to live below LIVE COMMITMENTS.",
    "2. Another one.",
    "3. A third.",
    "4. A fourth.",
    "",
  ].join("\n");
  const p = writeFixture("trailing-list-no-mpsl-heading.md", trailingListDoc);

  let oldScriptPath = null;
  let oldScriptIsPreFix = false;
  try {
    const oldScriptSrc = execFileSync("git", ["show", `HEAD:${SCRIPT_REPO_REL}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    oldScriptIsPreFix = /findHeadingLine\(lines,\s*"my-peer-send-ledger"/.test(oldScriptSrc);
    oldScriptPath = writeFixture("rotation-gate-PRE-FIX.mjs", oldScriptSrc);
  } catch (err) {
    console.log(`(unable to extract HEAD:${SCRIPT_REPO_REL} via git show — pre-fix comparison skipped: ${err.message})`);
  }

  if (oldScriptPath && oldScriptIsPreFix) {
    const oldResult = runGate(p, archivePath, oldScriptPath);
    check(
      "🔴 RED — pre-fix script MISCOUNTS: no my-peer-send-ledger heading present, falls back to EOF, sweeps in the 4 unrelated numbered items (16, not 12)",
      /carries all \d+ markers and 16 LIVE COMMITMENTS item\(s\)/.test(oldResult.stdout)
    );
  } else {
    console.log(
      oldScriptPath
        ? "(HEAD's rotation-gate.mjs no longer contains the pre-fix my-peer-send-ledger name-anchor — this " +
          "card's fix has already landed on HEAD; skipping the RED leg rather than asserting a stale premise)"
        : "(pre-fix comparison skipped — see message above)"
    );
  }

  const fixedResult = runGate(p, archivePath);
  check(
    "✅ GREEN — fixed script stops at the next same-level heading regardless of its name, counting exactly 12",
    /carries all \d+ markers and 12 LIVE COMMITMENTS item\(s\)/.test(fixedResult.stdout)
  );
  check(
    "✅ GREEN: diagnostic names the real next heading (§SOME LATER SECTION), not a fallback to EOF",
    /to heading line \d+ \("[^"]*SOME LATER SECTION[^"]*"\)/i.test(fixedResult.stdout) || fixedResult.status === 0
  );
}

// ── Case 7: the fixed anchor is genuinely STRUCTURAL (heading depth), not merely re-pointed at a new
// name — card a681aed5 DoD-2 ("do NOT re-point it at another named heading"). A next-heading whose text
// shares no vocabulary with any old or new anchor name still correctly closes the section, and a DEEPER
// heading nested inside the list does NOT prematurely close it. ─────────────────────────────────────────
{
  const noVocabOverlapDoc = [
    "# Loom — Orchestrator Log (fixture, arbitrary next-heading name)",
    "",
    ALL_MARKERS_PROSE,
    "",
    "## ⛔⛔ §LIVE COMMITMENTS — carried verbatim",
    "1. First.",
    "2. Second.",
    "### A deeper sub-note nested inside the list (level 3, must NOT close the section)",
    "3. Third, after the nested sub-heading.",
    "",
    "## 🐙 Whatever The Next Section Happens To Be Called",
    "1. This numbered item belongs to the OTHER section and must not be counted.",
    "",
  ].join("\n");
  const p = writeFixture("no-vocab-overlap.md", noVocabOverlapDoc);
  const r = runGate(p, archivePath);
  // 3 items is deliberately below the floor (12) — this fixture is about proving WHERE the section is
  // measured (the count), not about a passing doc, so the assertion reads the refusal message's count.
  check("structural anchor: a level-3 heading nested inside the list does not end the section early (counts the item after it), and an arbitrary-named level-2 heading afterward correctly ends the section (count = 3, not 1 or 4)",
    /holds 3 numbered item\(s\), fewer than the required floor of 12/.test(r.stderr));
  check("structural anchor: diagnostic names the arbitrary-named next heading as where measurement stopped",
    /to heading line \d+ \("[^"]*Whatever The Next Section Happens To Be Called[^"]*"\)/i.test(r.stderr));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — rotation-gate.mjs anchors both LIVE COMMITMENTS boundaries to real markdown headings; a prose mention of either boundary token above its real heading no longer redefines the measured span, a genuinely short section is still refused, and the END boundary is now structural (heading depth) rather than a second name anchor — proven RED on the pre-fix script and GREEN on the fixed one."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
