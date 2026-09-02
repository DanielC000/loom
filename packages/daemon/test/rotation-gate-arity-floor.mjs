import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process/git
// Positive-control test for card 34a6f07e's fix to packages/daemon/scripts/rotation-gate.mjs:
//
// THE DEFECT: the LIVE COMMITMENTS check used to be an EQUALITY (`live.count !== REQUIRED_LIVE_COMMITMENTS_COUNT`,
// count hardcoded at 14). An equality check on a list that legitimately grows over time does not merely
// fail to catch overflow — it CREATES the overflow: the cheapest way to add a 15th genuine commitment and
// keep the gate green is to leave it OUT of the counted section (as unprotected prose instead). Measured
// live on the filing seat's own rotation: 6 new binding terms were pushed into prose above the LIVE
// COMMITMENTS list specifically to dodge this check, and a doc that dropped that prose block entirely
// still passed — the equality check never looked at that region either way. (The filing card first
// miscounted these as 5, dropping "DISCLOSE A LIVE-WORKER-COUNT CHANGE ON THE CHANGE, not at the next
// natural letter" — corrected 2026-08-28 after a recount of the real vault doc.)
//
// THE FIX: assert a FLOOR (`>=`, via `LIVE_COMMITMENTS_FLOOR`) instead of an equality. Growing the list
// can never fail this check again; only shrinking below the floor can. The floor is bumped from 14 to 20
// in this same change (14 re-verified 2026-08-28 by card d78a6d5d, plus the 6 new terms card 34a6f07e
// names) — this is what actually PROTECTS those 6 terms: once they are moved from unprotected prose into
// the numbered LIVE COMMITMENTS list (a follow-up vault edit, out of this repo's reach), dropping them
// back out drops the count below the new floor and is refused. See rotation-gate.mjs's own header comment
// for the full reasoning and the vault hand-off this local repo cannot perform itself.
//
// THIS FILE PROVES BOTH HALVES OF THE CARD'S DoD-4, ON THE REAL PRE-FIX SCRIPT, NOT A DESCRIPTION OF IT:
//   (a) the OLD (equality) gate PASSES a doc that has silently dropped the 6-terms block — proven by
//       running the actual pre-fix script body (captured via `git show HEAD:<path>` BEFORE this card's
//       commit lands, i.e. the committed state this repo shipped until now) against a constructed fixture
//       that reproduces the exact shape described in the card: a "grown" doc (20 numbered items) that
//       passes the OLD gate ONLY when 6 of those items are demoted to unprotected prose instead of staying
//       numbered — and an OLD-gate run against the doc with that prose entirely deleted is BYTE-IDENTICAL
//       in verdict to the doc that still has it, because the old equality check never inspects that region.
//   (b) the FIXED (floor) gate REFUSES the exact same drop — a 14-item doc (the block/terms gone) fails
//       against the new 20-item floor, while the properly-protected 20-item doc (the 6 terms promoted to
//       real numbered items) passes.
// A test that only exercises a well-formed doc cannot see this (card 34a6f07e DoD-4's own words) — every
// case below is a positive control, deliberately constructed to fail on one side and pass on the other.
//
// Run: node packages/daemon/test/rotation-gate-arity-floor.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-arity-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// The marker tokens rotation-gate.mjs requires, independent of this card's fix (kept as a local
// literal — this file is a TEST, not the source of truth; rotation-gate.mjs's own MARKERS array is that).
// Card bcd3f690 (2026-09-02) retired 3 of the original 14 markers (MY-PEER-SEND-LEDGER,
// ANNOUNCE-CANNOT-CARRY-A-SHA, MGR122-FLOOR) — this list holds the 10 that survive that cut, unrelated to
// this test's own subject (the floor-vs-equality fix), so the fixtures below still satisfy the current
// marker check.
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
];

function commitmentsList(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. Commitment number ${i}.`);
  return lines.join("\n");
}

// `extraProse`, when given, is the 6-new-binding-terms block AS IT REALLY LANDED on the filing seat's own
// rotation: freeform prose ABOVE the numbered list, containing none of the 14 required markers and none
// of the /^\d+\. /gm numbered-item syntax — so it is invisible to both checks the OLD gate runs.
function docWith({ items = 14, extraProse = null } = {}) {
  return [
    "# Loom — Orchestrator Log (fixture)",
    "",
    ALL_MARKER_TOKENS.join(" · "),
    "",
    ...(extraProse !== null ? [extraProse, ""] : []),
    "## ⛔⛔ §LIVE COMMITMENTS — carried verbatim",
    commitmentsList(items),
    "",
    "## 📮 §MY-PEER-SEND-LEDGER — append every peer_message",
    "Nothing yet.",
    "",
  ].join("\n");
}

const SIX_TERMS_PROSE =
  "> BINDING AND UNPROTECTED: announce-with-an-earliest-floor · settles carry the drain verdict AND\n" +
  "> fraction-of-run-elapsed · compose-vs-send stamp gap · delivery is bimodal so a delivered-live 0.0s is\n" +
  "> definitional not measured · concurrentGates is admission-snapshot vs cgMax is ever-contended ·\n" +
  "> disclose a live-worker-count change on the change, not at the next natural letter.";

function runGateWith(scriptPath, argsArr) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...argsArr], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const runFixed = (argsArr) => runGateWith(SCRIPT, argsArr);

const archivePath = writeFixture("archive.md", "archive contents\n");

// ── Capture the REAL pre-fix script body via `git show HEAD:<path>` — not a paraphrase of what it used to
// do. This only proves what this card claims IF the committed HEAD at test time is genuinely the pre-fix
// equality-checking version; if this file is ever re-run long after the fix has landed and HEAD has moved
// past it, HEAD:rotation-gate.mjs is the FIXED script and section (a) below degenerates to a no-op check
// against the current behavior — so this file also asserts, directly, that the extracted copy still
// contains the literal `!==` equality operator against the LIVE COMMITMENTS count, and skips the
// old-gate comparison (reporting why) rather than silently passing on a stale premise. ────────────────────
let oldScriptPath = null;
let oldScriptIsPreFix = false;
try {
  const oldScriptSrc = execFileSync("git", ["show", `HEAD:${SCRIPT_REPO_REL}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  oldScriptIsPreFix = /live\.count\s*!==\s*(REQUIRED_LIVE_COMMITMENTS_COUNT|LIVE_COMMITMENTS_FLOOR)/.test(oldScriptSrc);
  oldScriptPath = writeFixture("rotation-gate-PRE-FIX.mjs", oldScriptSrc);
} catch (err) {
  console.log(`(unable to extract HEAD:${SCRIPT_REPO_REL} via git show — pre-fix comparison skipped: ${err.message})`);
}

if (oldScriptPath && oldScriptIsPreFix) {
  const runOld = (argsArr) => runGateWith(oldScriptPath, argsArr);

  // (a1) OLD gate on the "grown but properly counted" doc (20 items, 6 terms promoted to real numbered
  // items — i.e. the CORRECT outcome this whole card is arguing for): equality against 14 REFUSES it.
  // This is the mechanism that pressured the filing seat into hiding the terms in prose in the first place.
  {
    const p = writeFixture("old-grown-counted.md", docWith({ items: 20 }));
    const r = runOld(["--active", p, "--archive", archivePath]);
    check("OLD (equality) gate REFUSES a doc that legitimately grew to 20 counted items", r.status === 1);
    check("OLD gate: names the mismatch against its fixed 14", /expected 14/.test(r.stderr));
  }

  // (a2) OLD gate on the doc with 14 counted items PLUS the 6 terms as unprotected prose: PASSES.
  const oldDocWithProse = docWith({ items: 14, extraProse: SIX_TERMS_PROSE });
  const oldWithProsePath = writeFixture("old-with-prose.md", oldDocWithProse);
  {
    const r = runOld(["--active", oldWithProsePath, "--archive", archivePath]);
    check("OLD gate PASSES the doc with the 6 terms parked in unprotected prose", r.status === 0);
  }

  // (a3) THE CARD'S CENTRAL FINDING: OLD gate on the SAME doc with that prose block entirely DELETED —
  // still PASSES, identically, because the equality check never inspected that region either way.
  const oldDocProseDropped = docWith({ items: 14, extraProse: null });
  const oldProseDroppedPath = writeFixture("old-prose-dropped.md", oldDocProseDropped);
  {
    const r = runOld(["--active", oldProseDroppedPath, "--archive", archivePath]);
    check("OLD gate STILL PASSES once the 6-terms prose block is silently dropped entirely", r.status === 0);
  }
} else {
  console.log(
    oldScriptPath
      ? "(HEAD's rotation-gate.mjs no longer contains the pre-fix equality check — this card's fix has already " +
        "landed on HEAD; skipping the old-gate comparison rather than asserting a stale premise as if it still held)"
      : "(pre-fix comparison skipped — see message above)"
  );
}

// ── (b) THE FIXED (floor) GATE: must REFUSE the exact drop the old gate could not see, and PASS the
// doc where the 6 terms are properly protected as real numbered items. The floor itself is 12 as of card
// bcd3f690 (2026-09-02, lowered from 20 by the owner's ceremony cut — see rotation-gate.mjs's own header)
// — item counts below are chosen relative to THAT floor, not the original 14/20 this test was authored
// against. ──────────────────────────────────────────────────────────────────────────────────────────────
{
  // Below the current floor (12) regardless of the historical 14/20 story this fixture is modeling.
  const droppedDoc = docWith({ items: 10, extraProse: null });
  const droppedPath = writeFixture("fixed-prose-dropped.md", droppedDoc);
  const r = runFixed(["--active", droppedPath, "--archive", archivePath]);
  check("FIXED (floor) gate REFUSES a doc shrunk to 10 items (below the current floor)", r.status === 1);
  check("FIXED gate: names it against the current floor of 12", /fewer than the required floor of 12/.test(r.stderr));
}
{
  // 10 counted + 6 in prose — the floor fix alone does not make this doc pass, because the 6 terms are
  // still not counted; the floor only protects what is actually numbered.
  const withProseDoc = docWith({ items: 10, extraProse: SIX_TERMS_PROSE });
  const withProsePath = writeFixture("fixed-with-prose.md", withProseDoc);
  const r = runFixed(["--active", withProsePath, "--archive", archivePath]);
  check("FIXED gate ALSO REFUSES 10 counted + 6 in prose — the floor protects only what's counted, not prose", r.status === 1);
}
{
  // The properly-protected doc: well above the current floor of 12.
  const protectedDoc = docWith({ items: 20, extraProse: null });
  const protectedPath = writeFixture("fixed-protected.md", protectedDoc);
  const r = runFixed(["--active", protectedPath, "--archive", archivePath]);
  check("FIXED gate PASSES once the terms are real numbered items (20 total, above the floor of 12)", r.status === 0);
}
{
  // Negative control on the floor's OTHER direction: growth beyond the floor must never be punished —
  // this is the whole point of switching from equality to a floor.
  const grownMoreDoc = docWith({ items: 26, extraProse: null });
  const grownMorePath = writeFixture("fixed-grown-more.md", grownMoreDoc);
  const r = runFixed(["--active", grownMorePath, "--archive", archivePath]);
  check("FIXED gate PASSES a doc that grew WELL BEYOND the floor (26 items) — growth is never punished", r.status === 0);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — the pre-fix equality gate passed a doc with 6 binding terms silently dropped from unprotected " +
    "prose (and refused the legitimately-grown, properly-counted version instead); the fixed floor gate refuses " +
    "the exact same drop, refuses the terms staying unprotected in prose, passes once they are real numbered " +
    "items, and never punishes growth beyond the floor."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
