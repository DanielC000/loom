import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// REGRESSION TEST (card b41301cb) for packages/daemon/scripts/rotation-gate.mjs's DEFAULT (heading-text,
// no --commitments-marker) LIVE COMMITMENTS locator.
//
// THE DEFECT: without --commitments-marker, `findHeadingLine` silently takes the FIRST heading line in a
// text that merely CONTAINS "live commitments" (case-insensitive) — `countLiveCommitmentsIn`'s no-marker
// branch never checked whether a SECOND matching heading also exists in the SAME text. The pre-existing
// "AMBIGUOUS" notice (card e312b207) only ever fires ACROSS files (--active vs --rules); it has nothing
// to say about two matching headings inside ONE file. rotation-gate-marker-anchor.mjs's own Case 1 already
// demonstrates the CONSEQUENCE of this (a citing heading earlier in a doc silently wins over the real
// section) but, being about --commitments-marker, never asserts anything about the no-marker path's own
// silence — this file is that missing regression test, and the fix: a loud, non-gating "HEADING AMBIGUOUS"
// notice naming every matching heading's line number, mirroring the existing "MARKER AMBIGUOUS" notice's
// own posture (card eba7a6f7) exactly (never a hard failure — see countLiveCommitmentsIn/main()'s own
// comments for why, same reasoning as ruling (iii) for the cross-file case).
//
// ✅ RED-BEFORE-FIX PROOF (Case 1, run via `git show HEAD`, same technique as
// rotation-gate-heading-anchor.mjs's Case 6 / rotation-gate-marker-anchor.mjs): the committed pre-fix
// script prints NO "HEADING AMBIGUOUS" notice at all on a fixture carrying two matching headings in
// --active — the ambiguity is silently swallowed. The fixed (current) script does print it.
//
// Run: node packages/daemon/test/rotation-gate-duplicate-heading.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT_REPO_REL = "packages/daemon/scripts/rotation-gate.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-duphead-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// Every marker rotation-gate.mjs requires, present as plain prose text (mirrors the fixture convention in
// rotation-gate-heading-anchor.mjs / rotation-gate-marker-anchor.mjs) — none of these lines are headings,
// so they satisfy the presence check without ever opening/closing the commitments span.
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

// spawnSync (not execFileSync) deliberately — execFileSync only captures stdout on a SUCCESSFUL (exit 0)
// run and discards stderr entirely in that case (stderr is only populated on the thrown-error path). Case
// 2 below needs stderr on a SUCCESS (exit 0) run — the HEADING AMBIGUOUS notice prints there too — so this
// helper must capture both streams unconditionally, which spawnSync does regardless of exit code.
function runGate(args, scriptPath = SCRIPT) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const archivePath = writeFixture("archive.md", "archive contents\n");

// Two REAL headings in the SAME file both matching "live commitments" (case-insensitive) — the exact
// same-file shape the cross-file "AMBIGUOUS" notice cannot see. The first (decoy) section is short (3
// items, below the floor); the second (real) section is a healthy 20 items — so the deterministic
// first-match landing on the decoy is CONSEQUENTIAL (a real doc would be wrongly refused), not cosmetic.
const duplicateHeadingDoc = [
  "# Loom — Orchestrator Log (fixture)",
  "",
  "## An earlier section that happens to mention LIVE COMMITMENTS in its own heading",
  commitmentsList(3),
  "",
  ALL_MARKERS_PROSE,
  "",
  "## ⛔⛔ §LIVE COMMITMENTS — the real section",
  commitmentsList(20),
  "",
].join("\n");

// ── Case 1: THE HAZARD — RED on the pre-fix script (extracted via `git show HEAD`, same technique as
// rotation-gate-heading-anchor.mjs's own Case 6), GREEN on the fixed (current) script. ────────────────────
{
  const p = writeFixture("duplicate-red.md", duplicateHeadingDoc);

  let oldScriptPath = null;
  let oldScriptIsPreFix = false;
  try {
    const oldScriptSrc = execFileSync("git", ["show", `HEAD:${SCRIPT_REPO_REL}`], { cwd: REPO_ROOT, encoding: "utf8" });
    oldScriptIsPreFix = !/function\s+findAllHeadingLines/.test(oldScriptSrc);
    oldScriptPath = writeFixture("rotation-gate-PRE-FIX.mjs", oldScriptSrc);
  } catch (err) {
    console.log(`(unable to extract HEAD:${SCRIPT_REPO_REL} via git show — pre-fix comparison skipped: ${err.message})`);
  }

  if (oldScriptPath && oldScriptIsPreFix) {
    const oldResult = runGate(["--active", p, "--archive", archivePath], oldScriptPath);
    check("🔴 RED — pre-fix script lands on the decoy (3 items, below floor) same as the fixed script", /holds 3 numbered item\(s\)/.test(oldResult.stderr));
    check("🔴 RED — pre-fix script prints NO 'HEADING AMBIGUOUS' notice — the second matching heading is silently swallowed", !/HEADING AMBIGUOUS/.test(oldResult.stderr));
  } else {
    console.log(
      oldScriptPath
        ? "(HEAD's rotation-gate.mjs already contains findAllHeadingLines — this card's fix has already " +
          "landed on HEAD; skipping the RED leg rather than asserting a stale premise)"
        : "(pre-fix comparison skipped — see message above)"
    );
  }

  const fixedResult = runGate(["--active", p, "--archive", archivePath]);
  check("✅ GREEN — fixed script still lands on the decoy deterministically (3 items, below floor) — the FIX is visibility, not a different winner", /holds 3 numbered item\(s\)/.test(fixedResult.stderr));
  check("✅ GREEN — fixed script prints the 'HEADING AMBIGUOUS' notice, unconditionally, on the refusal path", /HEADING AMBIGUOUS/.test(fixedResult.stderr));
  check("✅ GREEN — the notice names BOTH heading lines (3 and 13)", /line\(s\) 3, 13/.test(fixedResult.stderr));
  check("✅ GREEN — the notice names which line was actually used to anchor (the first, line 3)", /FIRST occurrence \(line 3\)/.test(fixedResult.stderr));
  check("✅ GREEN — the ambiguity is advisory only, never gating: exit code is driven by the floor check (1), not a separate ambiguity failure", fixedResult.status === 1);
}

// ── Case 2: the SAME notice fires on the SUCCESS path too — "advisory, never gating" means it must print
// even when the winning (first) section is itself perfectly healthy, not only on a refusal. ───────────────
{
  const healthyDuplicateDoc = [
    "# Loom — Orchestrator Log (fixture)",
    "",
    "## ⛔⛔ §LIVE COMMITMENTS — the real (and, deterministically, FIRST) section",
    commitmentsList(20),
    "",
    ALL_MARKERS_PROSE,
    "",
    "## A later section that also happens to mention live commitments in its own heading",
    commitmentsList(5),
    "",
  ].join("\n");
  const p = writeFixture("duplicate-green.md", healthyDuplicateDoc);
  const r = runGate(["--active", p, "--archive", archivePath]);
  check("Case 2: first (winning) section is healthy (20 >= floor 12) ⇒ exits 0", r.status === 0);
  check("Case 2: the HEADING AMBIGUOUS notice STILL fires on the success path (stdout+stderr), not only on refusal", /HEADING AMBIGUOUS/.test(r.stderr));
  check("Case 2: OK line still reports the correct (real, first) count of 20", /carries all \d+ markers and 20 LIVE COMMITMENTS item\(s\)/.test(r.stdout));
}

// ── Case 3: CONFIRMATION — a single (non-duplicate) heading still resolves cleanly, with NO ambiguity
// notice at all. The fix must not become a false positive on the overwhelmingly common, correct shape. ────
{
  const cleanDoc = [
    "# Loom — Orchestrator Log (fixture)",
    "",
    ALL_MARKERS_PROSE,
    "",
    "## ⛔⛔ §LIVE COMMITMENTS — carried verbatim",
    commitmentsList(12),
    "",
    "## 📮 §MY-PEER-SEND-LEDGER — append every peer_message",
    "Nothing yet.",
    "",
  ].join("\n");
  const p = writeFixture("clean-single-heading.md", cleanDoc);
  const r = runGate(["--active", p, "--archive", archivePath]);
  check("Case 3: a single LIVE COMMITMENTS heading (no duplicate) still passes cleanly", r.status === 0);
  check("Case 3: no HEADING AMBIGUOUS notice on a clean, non-duplicate doc", !/HEADING AMBIGUOUS/.test(r.stdout) && !/HEADING AMBIGUOUS/.test(r.stderr));
  check("Case 3: reports the correct count (12)", /carries all \d+ markers and 12 LIVE COMMITMENTS item\(s\)/.test(r.stdout));
}

// ── Case 4: --commitments-marker still takes priority — when a marker IS configured, the heading-text
// duplicate-scan never even runs (mirrors countLiveCommitmentsIn's own marker/no-marker branch split), so
// no spurious HEADING AMBIGUOUS notice fires even though the underlying text still has two matching
// headings. Mutual exclusivity with MARKER AMBIGUOUS is asserted directly. ─────────────────────────────────
{
  const MARKER = "<!-- loom:live-commitments -->";
  const markerDoc = [
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
  const p = writeFixture("marker-mode-duplicate-headings.md", markerDoc);
  const r = runGate(["--active", p, "--archive", archivePath, "--commitments-marker", MARKER]);
  check("Case 4: marker mode locates the real 20-item section despite the duplicate heading text", r.status === 0);
  check("Case 4: no HEADING AMBIGUOUS notice in marker mode (the marker's own path never runs findAllHeadingLines)", !/HEADING AMBIGUOUS/.test(r.stdout) && !/HEADING AMBIGUOUS/.test(r.stderr));
  check("Case 4: no MARKER AMBIGUOUS notice either (the marker itself occurs exactly once)", !/MARKER AMBIGUOUS/.test(r.stdout) && !/MARKER AMBIGUOUS/.test(r.stderr));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — card b41301cb: in DEFAULT (heading-text) mode, two matching LIVE COMMITMENTS headings within the SAME file are no longer a silent first-match — proven RED on the pre-fix script (no notice at all) and GREEN on the fixed one (a loud, non-gating 'HEADING AMBIGUOUS' notice naming every matching line, on both the refusal AND success paths), a single non-duplicate heading still resolves with no false-positive notice, and --commitments-marker mode is unaffected (no spurious notice, no cross-contamination with MARKER AMBIGUOUS)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
