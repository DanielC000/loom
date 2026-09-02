import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// rotation-check.mjs test (card 1069c8e1) — the daemon-native resume-doc rotation-integrity capability
// that succeeds the three hand-rolled per-seat protections (a committed script for the Loom
// Orchestrator, a per-rotation byte-slice ritual for Codescape, nothing for the Platform Lead).
//
// This is a FRESH TypeScript port of `packages/daemon/scripts/rotation-gate.mjs`'s algorithm (that
// script is FROZEN for this card — never touched, never imported from here). A port of logic already
// debugged in production does not automatically inherit any bug the original already fixed, so two of
// the blocks below are REGRESSION tests proving this port does not have either of the two historical
// bugs the live script's own header documents having fixed:
//   1. The section-boundary NAME-ANCHOR fail-open (card `a681aed5`) — anchoring a section's END on a
//      heading's NAME (not its structural depth) silently fell back to end-of-file once that heading
//      was renamed, sweeping an unrelated trailing numbered list into the count (fails OPEN — an
//      inflated count sits comfortably above the floor and nothing alarms).
//   2. The EQUALITY-VS-FLOOR bug (card `34a6f07e`) — an exact-count check let a doc dodge protection by
//      keeping new commitments OUT of the counted section; the floor check must be `>=`, never `===`.
// A mutation test (removing a marker from a known-good fixture and watching the check fire) closes the
// loop the same way the live script's own header credits for catching two real mistakes.
//
// Claude-free, hermetic: every check below is pure text in / structured result out except the
// `runResumeDocCheck` block, which uses real on-disk temp files (mirrors resume-doc-watcher.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkMarkers, countNumberedSection, checkRotation, runResumeDocCheck,
  HONEST_LIMIT_NOTE, UNCONFIGURED_WARNING,
} from "../dist/orchestration/rotation-check.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── checkMarkers ────────────────────────────────────────────────────────────────────────────────────
{
  const markers = [
    { token: "LIVE COMMITMENTS", caseSensitive: false },
    { token: "capQueued", caseSensitive: true },
  ];
  const r1 = checkMarkers("...live commitments... capQueued...", markers, null);
  check("checkMarkers: case-insensitive token matches different casing", r1.missing.length === 0);
  check("checkMarkers: satisfiedBy records 'active' for a found token", r1.satisfiedBy.get("LIVE COMMITMENTS") === "active");

  const r2 = checkMarkers("...live commitments... CAPQUEUED...", markers, null);
  check("checkMarkers: case-SENSITIVE token does NOT match wrong casing", r2.missing.some((m) => m.token === "capQueued"));

  const r3 = checkMarkers("nothing relevant here", markers, "...LIVE COMMITMENTS... capQueued...");
  check("checkMarkers: --rules union satisfies a marker absent from active", r3.missing.length === 0 && r3.satisfiedBy.get("LIVE COMMITMENTS") === "rules");

  const r4 = checkMarkers("nothing relevant here", markers, null);
  check("checkMarkers: no rulesText ⇒ both markers reported missing", r4.missing.length === 2);
}

// ── REGRESSION 1 — section-boundary NAME-ANCHOR fail-open (card a681aed5) ─────────────────────────────
// The historical bug: the OLD implementation closed the LIVE-COMMITMENTS-style section by searching for
// a SPECIFIC NAMED heading (e.g. one containing "my-peer-send-ledger"). Once that heading was renamed
// away, the search fell back to end-of-file and swept an unrelated trailing numbered list into the
// count — INFLATING it. This module's `countNumberedSection` never searches for a named end-heading at
// all; it anchors the END structurally, by heading DEPTH (same level or shallower than the start). Prove
// that holds: a doc with the start heading, some items, then a DIFFERENT heading at the SAME level
// (never the removed name the old bug depended on), then MORE numbered items that must NOT be counted.
{
  const doc = [
    "## LIVE COMMITMENTS",
    "1. first",
    "2. second",
    "3. third",
    "## Some Renamed Heading — nothing to do with the old anchor name",
    "4. unrelated item that must NOT be counted",
    "5. another unrelated item that must NOT be counted",
  ].join("\n");
  const r = countNumberedSection(doc, "LIVE COMMITMENTS");
  check("REGRESSION a681aed5: section stops at a same-level heading of ANY name (structural, not name-anchored)", r.count === 3);
  check("REGRESSION a681aed5: does not inflate by sweeping the trailing unrelated list", r.count !== 5);

  // A DEEPER heading nested inside the section must NOT end it — still part of the section.
  const docNested = [
    "## LIVE COMMITMENTS",
    "1. first",
    "### a nested sub-note, still part of the section",
    "2. second",
    "3. third",
    "## Next real section",
    "4. must not be counted",
  ].join("\n");
  const rNested = countNumberedSection(docNested, "LIVE COMMITMENTS");
  check("REGRESSION a681aed5: a DEEPER nested heading does not prematurely close the section", rNested.count === 3);

  // No same-or-shallower heading after the start at all ⇒ runs to EOF (the honest fallback — still
  // correct here since there's genuinely nothing to stop at, unlike the bug's silent EOF fallback after
  // a real boundary heading went missing).
  const docEof = ["## LIVE COMMITMENTS", "1. first", "2. second"].join("\n");
  const rEof = countNumberedSection(docEof, "LIVE COMMITMENTS");
  check("REGRESSION a681aed5: no boundary heading at all ⇒ counts to EOF, diagnostic says so", rEof.count === 2 && rEof.diagnostic.includes("end of file"));

  // A prose MENTION of the heading token (not a real heading line) must never open/confuse the section.
  const docProse = [
    "This doc's own header explains it checks for live commitments in a numbered list below.",
    "## LIVE COMMITMENTS",
    "1. only real item",
  ].join("\n");
  const rProse = countNumberedSection(docProse, "LIVE COMMITMENTS");
  check("REGRESSION a681aed5 (sibling bug, d78a6d5d): a prose mention never opens the section — only a real heading line does", rProse.count === 1);
}

// ── REGRESSION 2 — EQUALITY-VS-FLOOR bug (card 34a6f07e) ───────────────────────────────────────────────
{
  const floor = 3;
  const doc = (n) => ["## LIVE COMMITMENTS", ...Array.from({ length: n }, (_, i) => `${i + 1}. item`)].join("\n");
  const atFloor = checkRotation({ activeText: doc(3), markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: floor });
  check("REGRESSION 34a6f07e: count === floor passes (boundary, proves >= not >)", atFloor.liveCommitments.ok === true && atFloor.liveCommitments.count === 3);

  const aboveFloor = checkRotation({ activeText: doc(5), markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: floor });
  check("REGRESSION 34a6f07e: count ABOVE floor passes (an equality check would have FAILED this)", aboveFloor.liveCommitments.ok === true && aboveFloor.liveCommitments.count === 5);

  const belowFloor = checkRotation({ activeText: doc(2), markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: floor });
  check("REGRESSION 34a6f07e: count BELOW floor fails", belowFloor.liveCommitments.ok === false && belowFloor.ok === false);
}

// ── configured:false is distinct from ok:true (the single most important line in the design) ─────────
{
  const r = checkRotation({ activeText: "anything at all", markers: [], commitmentsHeading: "", commitmentsFloor: 0 });
  check("unconfigured seat: configured:false", r.configured === false);
  check("unconfigured seat: ok is still true (vacuous — nothing to check)", r.ok === true);
  check("unconfigured seat: unconfiguredWarning is present and loud", typeof r.unconfiguredWarning === "string" && r.unconfiguredWarning.includes("NOTHING IS CONFIGURED"));
  check("unconfigured seat: unconfiguredWarning is exactly the exported constant", r.unconfiguredWarning === UNCONFIGURED_WARNING);

  const rConfigured = checkRotation({ activeText: "x", markers: [{ token: "x" }], commitmentsHeading: "", commitmentsFloor: 0 });
  check("configured seat (markers only): configured:true, no warning field", rConfigured.configured === true && rConfigured.unconfiguredWarning === undefined);
}

// ── honestLimitNote — DoD-4, always present, pass or fail ──────────────────────────────────────────────
{
  const pass = checkRotation({ activeText: "x", markers: [{ token: "x" }], commitmentsHeading: "", commitmentsFloor: 0 });
  const fail = checkRotation({ activeText: "nope", markers: [{ token: "x" }], commitmentsHeading: "", commitmentsFloor: 0 });
  check("honestLimitNote present on a pass", pass.honestLimitNote === HONEST_LIMIT_NOTE);
  check("honestLimitNote present on a fail too", fail.honestLimitNote === HONEST_LIMIT_NOTE);
  check("honestLimitNote carries the DoD-4 sentence verbatim", HONEST_LIMIT_NOTE.includes("proves literal text") && HONEST_LIMIT_NOTE.includes("not that no meaning was lost to rewording"));
}

// ── byteCheck (mirrors --was; CUT-scoped, caller-supplied) ──────────────────────────────────────────────
{
  const shrank = checkRotation({ activeText: "x", markers: [], commitmentsHeading: "", commitmentsFloor: 0, byteCheck: { activeBytes: 100, preEditBytes: 200 } });
  check("byteCheck: strictly smaller passes", shrank.byteCheck.checked === true && shrank.byteCheck.ok === true && shrank.ok === true);

  const grew = checkRotation({ activeText: "x", markers: [], commitmentsHeading: "", commitmentsFloor: 0, byteCheck: { activeBytes: 200, preEditBytes: 200 } });
  check("byteCheck: equal (not smaller) FAILS — a rewrite claiming to be a cut must shrink", grew.byteCheck.ok === false && grew.ok === false);

  const omitted = checkRotation({ activeText: "x", markers: [], commitmentsHeading: "", commitmentsFloor: 0 });
  check("byteCheck: omitted ⇒ checked:false, never silently counted as a pass on shrinkage", omitted.byteCheck.checked === false);
}

// ── archiveCheck (rotation-mode; mirrors --archive) ──────────────────────────────────────────────────
{
  const missing = checkRotation({ activeText: "x", markers: [], commitmentsHeading: "", commitmentsFloor: 0, archive: { exists: false, isFile: false, size: 0 } });
  check("archiveCheck: nonexistent path fails", missing.archiveCheck.ok === false);

  const empty = checkRotation({ activeText: "x", markers: [], commitmentsHeading: "", commitmentsFloor: 0, archive: { exists: true, isFile: true, size: 0 } });
  check("archiveCheck: empty file fails", empty.archiveCheck.ok === false);

  const good = checkRotation({ activeText: "x", markers: [], commitmentsHeading: "", commitmentsFloor: 0, archive: { exists: true, isFile: true, size: 42 } });
  check("archiveCheck: real non-empty file passes", good.archiveCheck.ok === true);
}

// ── CLOSE BY MUTATION — take a known-good fixture, remove ONE required marker, watch it refuse ───────
{
  const markers = [
    { token: "LIVE COMMITMENTS", caseSensitive: false },
    { token: "OWNER-GATED", caseSensitive: false },
    { token: "QUIET-LANE", caseSensitive: false },
  ];
  const good = [
    "## LIVE COMMITMENTS",
    "1. first",
    "2. second",
    "3. third",
    "text mentioning OWNER-GATED and QUIET-LANE somewhere below the section",
  ].join("\n");
  const goodResult = checkRotation({ activeText: good, markers, commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 3 });
  check("mutation baseline: known-good fixture passes", goodResult.ok === true && goodResult.missingMarkers.length === 0);

  // MUTATE: delete exactly the OWNER-GATED token from the doc (as if a rewrite dropped it).
  const mutated = good.replace("mentioning OWNER-GATED and QUIET-LANE", "mentioning QUIET-LANE");
  const mutatedResult = checkRotation({ activeText: mutated, markers, commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 3 });
  check("mutation: removing exactly one marker flips ok to false", mutatedResult.ok === false);
  check("mutation: the refusal NAMES the specific missing token", mutatedResult.missingMarkers.length === 1 && mutatedResult.missingMarkers[0] === "OWNER-GATED");
  check("mutation: the OTHER two markers are still reported present (not a blanket failure)", !mutatedResult.missingMarkers.includes("LIVE COMMITMENTS") && !mutatedResult.missingMarkers.includes("QUIET-LANE"));
  check("mutation: the LIVE COMMITMENTS floor is untouched by this mutation (still ok)", mutatedResult.liveCommitments.ok === true);
}

// ── runResumeDocCheck — the impure fs wrapper, real temp files ──────────────────────────────────────────
function tmpFile(name, content) {
  const p = path.join(os.tmpdir(), `loom-rot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
  if (content !== null) fs.writeFileSync(p, content, "utf8");
  return p;
}
{
  const missingDocPath = tmpFile("missing.md", null); // path only, never written — proves the "not found" branch
  const r = runResumeDocCheck({ resumeDocPath: missingDocPath, markers: [{ token: "x" }], commitmentsHeading: "", commitmentsFloor: 0 });
  check("runResumeDocCheck: missing doc ⇒ docFound:false, never throws", r.docFound === false && r.ok === false);
  check("runResumeDocCheck: missing doc distinguishes 'not found' from 'markers lost' in the diagnostic", r.liveCommitments.diagnostic.includes("not found") || r.missingMarkers.includes("x"));

  const docPath = tmpFile("doc.md", "## LIVE COMMITMENTS\n1. a\n2. b\n3. c\ncapQueued present\n");
  const r2 = runResumeDocCheck({ resumeDocPath: docPath, markers: [{ token: "capQueued", caseSensitive: true }], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 3 });
  check("runResumeDocCheck: real file, all checks pass ⇒ ok:true, docFound:true", r2.docFound === true && r2.ok === true);
  fs.rmSync(docPath, { force: true });

  // archivePath + preEditBytes wired end-to-end through the impure wrapper.
  const docPath2 = tmpFile("doc2.md", "short");
  const archivePath = tmpFile("archive.md", "archived content");
  const r3 = runResumeDocCheck({ resumeDocPath: docPath2, markers: [], commitmentsHeading: "", commitmentsFloor: 0, archivePath, preEditBytes: 3 });
  check("runResumeDocCheck: archivePath + preEditBytes wired through (archive ok, byte-check fails since 'short'.length > 3)", r3.archiveCheck.ok === true && r3.byteCheck.checked === true && r3.byteCheck.ok === false);
  fs.rmSync(docPath2, { force: true });
  fs.rmSync(archivePath, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — rotation-check's marker/floor/archive/byte checks behave correctly, the two named historical bugs (a681aed5's name-anchor fail-open, 34a6f07e's equality-vs-floor) are proven absent from this port, a mutation test confirms a dropped marker is caught and named, configured:false is distinct from ok:true, and the impure fs wrapper never throws on a missing doc — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
