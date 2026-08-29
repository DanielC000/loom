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
// Run: node packages/daemon/test/rotation-gate-heading-anchor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");

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
const ALL_MARKERS_PROSE = [
  "Orchestrator Rules · THE FOUR-LEG VERIFY · OWNER-GATED · ROTATE AT 40 KB · THE SAFE-WRITE ·",
  "MULTI-HARNESS EPIC · ANNOUNCE-CANNOT-CARRY-A-SHA · NO-CLEARANCE-FROM-SILENCE · MGR122-FLOOR ·",
  "capQueued · in-memory · QUIET-LANE",
].join("\n");

function commitmentsList(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. Commitment number ${i}.`);
  return lines.join("\n");
}

// LIVE_COMMITMENTS_FLOOR is 20 as of card 34a6f07e (was a fixed count of 14, now a floor — see
// rotation-gate.mjs's own header). A "clean"/well-formed doc in this file must carry >= 20 items.
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

function runGate(activePath, archivePath) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--active", activePath, "--archive", archivePath], {
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
  check("genuinely short section: reports the real count (3, not 0)", /holds 3 numbered item\(s\), fewer than the required floor of 20/.test(r.stderr));
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

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — rotation-gate.mjs anchors both LIVE COMMITMENTS boundaries to real markdown headings; a prose mention of either boundary token above its real heading no longer redefines the measured span, and a genuinely short section is still refused."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
