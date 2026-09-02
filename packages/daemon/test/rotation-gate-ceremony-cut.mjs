import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// Regression test for card bcd3f690 (2026-09-02, step 1 of the owner's "cleanup all bad ceremonies"
// directive 2026-09-01): packages/daemon/scripts/rotation-gate.mjs retires 3 markers whose rules were
// retired in the same cut — "MY-PEER-SEND-LEDGER", "ANNOUNCE-CANNOT-CARRY-A-SHA", "MGR122-FLOOR" — and
// lowers LIVE_COMMITMENTS_FLOOR from 20 to 12 to match the lead's post-cut resume doc.
//
// UPDATED same day by card `a681aed5`: "MGR122-FLOOR" was RESTORED to MARKERS after a peer objection (see
// rotation-gate.mjs's own header for the full reasoning) — only "MY-PEER-SEND-LEDGER" and
// "ANNOUNCE-CANNOT-CARRY-A-SHA" remain retired. This file's fixtures/assertions below reflect that: 11
// surviving markers (was 10), 2 retired tokens (was 3). It also mutation-tests MGR122-FLOOR's restoration
// via the same per-token loop as every other surviving marker (card a681aed5 DoD-8) — no parallel test.
//
// THIS FILE PROVES BOTH DIRECTIONS, ON THE REAL SCRIPT:
//   (a) a document carrying only the 11 surviving markers and exactly the new floor (12) of numbered
//       LIVE COMMITMENTS items PASSES;
//   (b) a document missing any ONE surviving marker, or holding fewer than 12 commitments, still FAILS
//       with exit 1 — the cut narrowed WHAT is required, never weakened the check that runs.
// It also asserts the 2 retired tokens are no longer required at all (absent from a passing doc), and
// that the three markers the card explicitly calls out as "looks like ceremony but isn't" —
// NO-CLEARANCE-FROM-SILENCE, QUIET-LANE, and (restored) MGR122-FLOOR — are still enforced individually.
//
// Run: node packages/daemon/test/rotation-gate-ceremony-cut.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-cut-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// The 11 marker tokens rotation-gate.mjs requires AFTER cards bcd3f690 + a681aed5 (kept as a local
// literal — this file is a TEST, not the source of truth; rotation-gate.mjs's own MARKERS array is that).
// Excludes "LIVE COMMITMENTS", which is satisfied via the real section heading below, not this prose list.
const SURVIVING_MARKER_TOKENS = [
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
];

const RETIRED_MARKER_TOKENS = ["MY-PEER-SEND-LEDGER", "ANNOUNCE-CANNOT-CARRY-A-SHA"];

function commitmentsList(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. Commitment number ${i}.`);
  return lines.join("\n");
}

// No §MY-PEER-SEND-LEDGER heading — this mirrors the REAL post-cut resume doc (that section is retired
// by the lead's own step 4), and exercises the documented end-of-file fallback in countLiveCommitments.
function docWith({ markers = SURVIVING_MARKER_TOKENS, items = 12 } = {}) {
  return [
    "# Loom — Orchestrator Log (post-cut fixture)",
    "",
    markers.join(" · "),
    "",
    "## LIVE COMMITMENTS",
    commitmentsList(items),
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

// ── (a) THE POST-CUT DOC PASSES: 11 surviving prose markers (+ LIVE COMMITMENTS via the real heading =
// 12 total in MARKERS), none of the 2 retired tokens, exactly the new floor (12) of numbered commitments.
const cleanPath = writeFixture("postcut-clean.md", docWith({ items: 12 }));
{
  const r = runGate(["--active", cleanPath, "--lint"]);
  check("post-cut doc (12 markers, 12 commitments, no retired tokens): exits 0", r.status === 0);
  check("post-cut doc: reports LINT OK with 12 markers and 12 commitments", /LINT OK.*carries all 12 markers and 12/.test(r.stdout));
  for (const token of RETIRED_MARKER_TOKENS) {
    check(`post-cut doc genuinely omits retired token "${token}"`, !docWith({ items: 12 }).includes(token));
  }
}

// ── (b) MISSING ANY ONE SURVIVING MARKER STILL FAILS — one sub-case per token, including the two the
// card calls out by name (NO-CLEARANCE-FROM-SILENCE, QUIET-LANE) so their survival is individually
// mutation-tested, not just present by inclusion. ──────────────────────────────────────────────────────
for (const dropped of SURVIVING_MARKER_TOKENS) {
  const markers = SURVIVING_MARKER_TOKENS.filter((t) => t !== dropped);
  const p = writeFixture(`missing-${dropped.replace(/[^a-zA-Z0-9]/g, "_")}.md`, docWith({ markers, items: 12 }));
  const r = runGate(["--active", p, "--lint"]);
  check(`doc missing surviving marker "${dropped}": exits 1`, r.status === 1);
  check(`doc missing surviving marker "${dropped}": names it in the refusal`, r.stderr.includes(dropped));
}

// ── (b) HOLDING FEWER THAN THE NEW FLOOR (12) STILL FAILS. ─────────────────────────────────────────────
{
  const p = writeFixture("below-floor-11.md", docWith({ items: 11 }));
  const r = runGate(["--active", p, "--lint"]);
  check("doc with 11 commitments (one below the new floor of 12): exits 1", r.status === 1);
  check("doc with 11 commitments: names the real count against the new floor of 12", /holds 11 numbered item\(s\), fewer than the required floor of 12/.test(r.stderr));
}

// ── NEGATIVE CONTROL: growth beyond the new floor is never punished (the floor semantics survive the cut
// unchanged — only its numeric value moved). ──────────────────────────────────────────────────────────
{
  const p = writeFixture("above-floor-15.md", docWith({ items: 15 }));
  const r = runGate(["--active", p, "--lint"]);
  check("doc with 15 commitments (above the new floor): exits 0", r.status === 0);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — card bcd3f690's cut (as amended by a681aed5's restore of MGR122-FLOOR): 2 retired " +
    "markers are no longer required, the 11 surviving prose markers (12 total incl. LIVE COMMITMENTS) " +
    "are each still individually enforced, the LIVE COMMITMENTS floor is 12 (not 20), and growth above the " +
    "floor is never punished."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
