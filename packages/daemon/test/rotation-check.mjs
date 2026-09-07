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
  checkMarkers, countNumberedSection, countNumberedSectionUnion, checkRotation, runResumeDocCheck, containUnderVault,
  checkMarkersUnion, countNumberedSectionUnionMulti,
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

// ── LIVE COMMITMENTS FLOOR UNION (card e312b207) — countNumberedSectionUnion + checkRotation('rules') ──
// Owner-approved option (a): move §LIVE COMMITMENTS into the non-rotating rules file, and move its count
// guard with it. Before this card the floor check only ever measured `activeText` — these prove the three
// required shapes: (1) the section is counted wherever its heading is found (active OR rules), (2)
// behaviour is UNCHANGED while the block stays in the active doc — active is tried FIRST and wins even
// when rules ALSO carries a (shorter) section, so this can never regress to "rules wins" by accident, and
// (3) FAIL-CLOSED when the heading is in NEITHER file — the catastrophic "block was lost" case must never
// degrade into "0 items, nothing to check, ok:true".
{
  const doc = (n) => ["## LIVE COMMITMENTS", ...Array.from({ length: n }, (_, i) => `${i + 1}. item`)].join("\n");
  const noHeading = "This doc mentions live commitments only in prose, never as a real heading line.";

  // (1) UNION: heading absent from active, present in rules ⇒ counted from rules.
  const rActiveMissing = countNumberedSectionUnion(noHeading, doc(15), "LIVE COMMITMENTS");
  check("union: heading absent from active, present in rules ⇒ count comes from rules", rActiveMissing.count === 15 && rActiveMissing.source === "rules");

  const rViaCheckRotation = checkRotation({ activeText: noHeading, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12, rules: { resolvedPath: "/x", text: doc(15) } });
  check("union via checkRotation: liveCommitments.ok:true, count/source from rules", rViaCheckRotation.liveCommitments.ok === true && rViaCheckRotation.liveCommitments.count === 15 && rViaCheckRotation.liveCommitments.source === "rules");
  check("union via checkRotation: overall ok:true", rViaCheckRotation.ok === true);

  // (2) UNCHANGED: heading present in active ⇒ active wins EVEN when rules also has one (with fewer
  // items that would fail the floor on their own) — proves this never silently prefers rules.
  const rActivePresent = countNumberedSectionUnion(doc(20), doc(3), "LIVE COMMITMENTS");
  check("unchanged: heading present in active ⇒ always counted from active, never rules", rActivePresent.count === 20 && rActivePresent.source === "active");

  const rViaCheckRotation2 = checkRotation({ activeText: doc(20), markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12, rules: { resolvedPath: "/x", text: doc(3) } });
  check("unchanged via checkRotation: source is 'active', count is active's 20 (not rules' failing 3)", rViaCheckRotation2.liveCommitments.source === "active" && rViaCheckRotation2.liveCommitments.count === 20 && rViaCheckRotation2.liveCommitments.ok === true);

  // Byte-identical to before this card when no `rules` is passed at all (the pre-existing REGRESSION 2
  // block above already proves the pass/fail shape; this proves `source` is populated the same way).
  const rNoRulesArg = checkRotation({ activeText: doc(20), markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12 });
  check("no rules argument at all ⇒ still works, source:'active'", rNoRulesArg.liveCommitments.ok === true && rNoRulesArg.liveCommitments.source === "active");

  // (3) FAIL-CLOSED: heading in NEITHER file.
  const rNeither = countNumberedSectionUnion(noHeading, noHeading, "LIVE COMMITMENTS");
  check("fail-closed: heading in neither file ⇒ count:null, source:null", rNeither.count === null && rNeither.source === null);
  check("fail-closed: diagnostic names BOTH files were checked", rNeither.diagnostic.includes("active doc or rules file"));

  const rNeitherViaCheckRotation = checkRotation({ activeText: noHeading, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12, rules: { resolvedPath: "/x", text: noHeading } });
  check("fail-closed via checkRotation: liveCommitments.ok is false, never a vacuous pass", rNeitherViaCheckRotation.liveCommitments.ok === false && rNeitherViaCheckRotation.liveCommitments.count === null && rNeitherViaCheckRotation.liveCommitments.source === null);
  check("fail-closed via checkRotation: overall ok is false", rNeitherViaCheckRotation.ok === false);

  // Fail-closed also holds with NO rules argument at all (the pre-existing single-file case, unregressed).
  const rNeitherNoRules = checkRotation({ activeText: noHeading, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12 });
  check("fail-closed, no rules argument: still ok:false, source:null (unregressed single-file case)", rNeitherNoRules.liveCommitments.ok === false && rNeitherNoRules.liveCommitments.source === null);

  // An UNREADABLE rules input (rules.error, not rules.text) must NOT be able to satisfy the union — mirrors
  // checkMarkers' own "an unreadable rules file adds no coverage" rule.
  const rUnreadableRules = checkRotation({
    activeText: noHeading, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12,
    rules: { resolvedPath: "/bogus.md", error: "rules path does not exist or is unreadable: /bogus.md" },
  });
  check("an unreadable rules input cannot satisfy the commitments union (still fail-closed)", rUnreadableRules.liveCommitments.ok === false && rUnreadableRules.liveCommitments.source === null);

  // ── BOUNDARY (code review, item 2) — active carries the heading but BELOW the floor, while rules
  // carries a section that would PASS on its own ⇒ must still FAIL, source:"active". Neither test above
  // pins this: both have active passing on its own (20 vs. floor 12), so a wrong "fall through to
  // whichever text passes" implementation would slip through unnoticed there. This is the single case
  // that actually exercises the precedence rule the guard exists to enforce.
  const activeBelowFloor = doc(3); // 3 < floor of 12
  const rulesAboveFloor = doc(20); // would pass on its own — must NOT be consulted
  const rBoundary = countNumberedSectionUnion(activeBelowFloor, rulesAboveFloor, "LIVE COMMITMENTS");
  check("boundary: active carries the heading (even though below floor) ⇒ source stays 'active', count from active (3, not rules' 20)", rBoundary.source === "active" && rBoundary.count === 3);

  const rBoundaryViaCheckRotation = checkRotation({ activeText: activeBelowFloor, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12, rules: { resolvedPath: "/x", text: rulesAboveFloor } });
  check("boundary via checkRotation: FAILS even though rules alone would have passed (never falls through to a passing rules count)", rBoundaryViaCheckRotation.liveCommitments.ok === false && rBoundaryViaCheckRotation.liveCommitments.count === 3 && rBoundaryViaCheckRotation.liveCommitments.source === "active");
  check("boundary via checkRotation: overall ok is false", rBoundaryViaCheckRotation.ok === false);

  // ── AMBIGUITY (code review, item 3 — product ruling (i)+(ii), NOT (iii)) — heading found in BOTH active
  // and rules must surface a loud, NON-GATING signal (active still wins on count; this must never fail
  // the gate by itself — that's ruling (iii), explicitly rejected).
  const rAmbiguous = countNumberedSectionUnion(doc(20), doc(5), "LIVE COMMITMENTS");
  check("ambiguity: both texts carry the heading ⇒ ambiguous:true, source/count from active, otherCount from rules", rAmbiguous.ambiguous === true && rAmbiguous.source === "active" && rAmbiguous.count === 20 && rAmbiguous.otherCount === 5);

  const rOnlyActive = countNumberedSectionUnion(doc(20), noHeading, "LIVE COMMITMENTS");
  check("ambiguity: only active carries it ⇒ ambiguous is ABSENT (not merely false)", rOnlyActive.ambiguous === undefined);

  const rOnlyRules = countNumberedSectionUnion(noHeading, doc(15), "LIVE COMMITMENTS");
  check("ambiguity: only rules carries it ⇒ ambiguous is ABSENT too (active never had a candidate to conflict with)", rOnlyRules.ambiguous === undefined);

  check("ambiguity: the pre-existing 'unchanged' fixture above (active=20/rules=3) is ITSELF an ambiguous shape", rViaCheckRotation2.liveCommitments.ambiguous === true && rViaCheckRotation2.liveCommitments.otherCount === 3);

  const rAmbiguousViaCheckRotation = checkRotation({ activeText: doc(20), markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12, rules: { resolvedPath: "/x", text: doc(5) } });
  check("ambiguity via checkRotation: liveCommitments.ambiguous:true, otherCount:5", rAmbiguousViaCheckRotation.liveCommitments.ambiguous === true && rAmbiguousViaCheckRotation.liveCommitments.otherCount === 5);
  check("ambiguity via checkRotation: STILL ok:true — ambiguity never gates the result (ruling (iii) explicitly rejected a hard fail)", rAmbiguousViaCheckRotation.ok === true);
  check("ambiguity via checkRotation: top-level ambiguityWarning is present and loud", typeof rAmbiguousViaCheckRotation.ambiguityWarning === "string" && rAmbiguousViaCheckRotation.ambiguityWarning.includes("AMBIGUOUS"));
  check("ambiguity via checkRotation: warning names both counts", rAmbiguousViaCheckRotation.ambiguityWarning.includes("20 item") && rAmbiguousViaCheckRotation.ambiguityWarning.includes("5 item"));

  const rNonAmbiguousViaCheckRotation = checkRotation({ activeText: doc(20), markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12 });
  check("ambiguity via checkRotation: no rules argument at all ⇒ no ambiguityWarning field (never a false positive)", rNonAmbiguousViaCheckRotation.ambiguityWarning === undefined && rNonAmbiguousViaCheckRotation.liveCommitments.ambiguous === undefined);

  // Ambiguous AND failing at the same time (active below floor, rules also carries it) — the two signals
  // are independent; a failing gate can still be worth flagging as ambiguous (it tells a reader WHY rules
  // wasn't consulted to rescue it).
  const rAmbiguousAndFailing = checkRotation({ activeText: activeBelowFloor, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12, rules: { resolvedPath: "/x", text: doc(20) } });
  check("ambiguity + failing boundary: both signals fire independently (ok:false AND ambiguityWarning present)", rAmbiguousAndFailing.ok === false && typeof rAmbiguousAndFailing.ambiguityWarning === "string");
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

// ── archiveCheck reason names the resolved path it tried (DoD-2, card f596215c) ────────────────────────
// The observed defect: a resolution failure claimed the archive "does not exist or is unreadable" with
// no way to tell "genuinely absent" from "resolved somewhere I didn't expect." The reason must now name
// the exact path the check actually stat'd.
{
  const bogusPath = tmpFile("nonexistent.md", null); // path only, never written (mirrors missingDocPath above)
  const r = checkRotation({
    activeText: "x", markers: [], commitmentsHeading: "", commitmentsFloor: 0,
    archive: { exists: false, isFile: false, size: 0, path: bogusPath },
  });
  check("archiveCheck reason: a resolution failure names the resolved path it actually tried", r.archiveCheck.reason.includes(bogusPath));

  // A caller that omits `path` (an older/hand-built ArchiveInfo literal) must not throw or produce
  // "undefined" in the reason — it degrades to an honest placeholder instead.
  const rNoPath = checkRotation({
    activeText: "x", markers: [], commitmentsHeading: "", commitmentsFloor: 0,
    archive: { exists: false, isFile: false, size: 0 },
  });
  check("archiveCheck reason: a missing `path` degrades gracefully (no literal 'undefined')", !rNoPath.archiveCheck.reason.includes("undefined"));
}

// ── containUnderVault + archivePath/rulesPath — the 2×2 (card f596215c) ────────────────────────────────
// A real resume-doc rotation observed `rulesPath` accepting a vault-relative path while `archivePath`'s
// IDENTICAL relative style failed with a false "does not exist" reason. Both params route through the
// SAME `containUnderVault` helper, so this locks in that both path forms behave identically for both
// params — only one cell of this matrix was ever exercised by the tests above (the flat-tmpdir
// `archivePath` case has no vault root and never goes through `containUnderVault` at all).
{
  const vaultRoot = path.join(os.tmpdir(), `loom-rot-vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(vaultRoot, "Projects", "Loom", "Operations"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "Projects", "Loom", "Orchestrator Log.archive"), { recursive: true });
  const activeDocPath = path.join(vaultRoot, "Projects", "Loom", "Orchestrator Log.md");
  fs.writeFileSync(activeDocPath, "active doc — no markers in here\n", "utf8");
  fs.writeFileSync(
    path.join(vaultRoot, "Projects", "Loom", "Operations", "Orchestrator Rules.md"),
    "RULES_ONLY_MARKER lives only here, never in the active doc\n", "utf8",
  );
  fs.writeFileSync(
    path.join(vaultRoot, "Projects", "Loom", "Orchestrator Log.archive", "2026-09-04-04.md"),
    "archived content, non-empty\n", "utf8",
  );

  const rulesRel = "Projects/Loom/Operations/Orchestrator Rules.md";
  const rulesAbs = path.join(vaultRoot, "Projects", "Loom", "Operations", "Orchestrator Rules.md");
  const archiveRel = "Projects/Loom/Orchestrator Log.archive/2026-09-04-04.md";
  const archiveAbs = path.join(vaultRoot, "Projects", "Loom", "Orchestrator Log.archive", "2026-09-04-04.md");

  for (const [label, rulesPathIn, archivePathIn] of [
    ["rulesPath relative + archivePath relative", rulesRel, archiveRel],
    ["rulesPath absolute + archivePath absolute", rulesAbs, archiveAbs],
    ["rulesPath relative + archivePath absolute", rulesRel, archiveAbs],
    ["rulesPath absolute + archivePath relative", rulesAbs, archiveRel],
  ]) {
    const rulesContained = containUnderVault(vaultRoot, rulesPathIn, "rulesPath");
    const archiveContained = containUnderVault(vaultRoot, archivePathIn);
    check(`containUnderVault (${label}): rulesPath resolves inside the vault`, rulesContained.ok === true);
    check(`containUnderVault (${label}): archivePath resolves inside the vault`, archiveContained.ok === true);

    const r = runResumeDocCheck({
      resumeDocPath: activeDocPath,
      markers: [{ token: "RULES_ONLY_MARKER" }],
      commitmentsHeading: "", commitmentsFloor: 0,
      rulesPath: rulesContained.ok ? rulesContained.value : null,
      archivePath: archiveContained.ok ? archiveContained.value : null,
    });
    check(`runResumeDocCheck (${label}): a marker present ONLY in the rules file is found via rulesPath`, r.markerSources.RULES_ONLY_MARKER === "rules");
    check(`runResumeDocCheck (${label}): archiveCheck passes on the real, non-empty archive file`, r.archiveCheck.checked === true && r.archiveCheck.ok === true);
    check(`runResumeDocCheck (${label}): overall ok:true`, r.ok === true);
  }

  fs.rmSync(vaultRoot, { recursive: true, force: true });
}

// ── LIVE COMMITMENTS FLOOR UNION, end-to-end through runResumeDocCheck's real fs wrapper (card e312b207)
// The pure-function block above proves `checkRotation`/`countNumberedSectionUnion`; this proves the SAME
// union survives the impure MCP-tool wrapper (real files, real rulesPath plumbing) — the actual code path
// `resume_doc_check` calls in both the manager and platform-lead surfaces.
{
  const noHeadingDoc = "This active doc mentions live commitments only in prose, never as a real heading.\n";
  const rulesDoc = ["## LIVE COMMITMENTS", ...Array.from({ length: 15 }, (_, i) => `${i + 1}. item`), ""].join("\n");

  const activePath = tmpFile("e312b207-active.md", noHeadingDoc);
  const rulesPath = tmpFile("e312b207-rules.md", rulesDoc);
  const r = runResumeDocCheck({
    resumeDocPath: activePath, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12,
    rulesPath,
  });
  check("runResumeDocCheck union: heading absent from active doc, present in rules ⇒ ok:true, count 15 via rules", r.liveCommitments.ok === true && r.liveCommitments.count === 15 && r.liveCommitments.source === "rules");
  check("runResumeDocCheck union: overall ok:true", r.ok === true);

  const rNoRulesPath = runResumeDocCheck({
    resumeDocPath: activePath, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12,
  });
  check("runResumeDocCheck fail-closed (no rulesPath at all): heading missing from the only file checked ⇒ ok:false", rNoRulesPath.liveCommitments.ok === false && rNoRulesPath.liveCommitments.count === null);

  const rulesPathNoHeadingEither = tmpFile("e312b207-rules-no-heading.md", "nothing relevant here either\n");
  const rBothMissing = runResumeDocCheck({
    resumeDocPath: activePath, markers: [], commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 12,
    rulesPath: rulesPathNoHeadingEither,
  });
  check("runResumeDocCheck fail-closed (rulesPath supplied but also has no heading): ok:false, count:null, source:null", rBothMissing.liveCommitments.ok === false && rBothMissing.liveCommitments.count === null && rBothMissing.liveCommitments.source === null);

  fs.rmSync(activePath, { force: true });
  fs.rmSync(rulesPath, { force: true });
  fs.rmSync(rulesPathNoHeadingEither, { force: true });
}

// ── rulesCheck — a SUPPLIED-but-unreadable rulesPath is reported, not silently swallowed (card 870edbcf)
// The observed defect: `rulesPath` is a UNION input, so a rules file that cannot be read just degrades
// the union to active-only with NO trace — `ok:true`, `missingMarkers:[]`, every `markerSources`
// `"active"`, byte-identical to a correctly-read rules file. THE DANGEROUS CELL below is exactly that
// shape: a marker the active doc satisfies on its own, PLUS a rulesPath that cannot be read — a test
// that lets the rules file itself supply a marker would never exercise this cell at all.
{
  const dangerDoc = tmpFile("danger.md", "prose containing DANGER_MARKER right here, nothing else\n");
  const bogusRulesPath = path.join(os.tmpdir(), `loom-rot-bogus-rules-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  // never written — proves the "supplied but unreadable" branch, mirrors missingDocPath's own pattern above

  // ── THE DANGEROUS CELL: rulesPath supplied + unreadable + active doc satisfies every marker alone ──
  const dangerResult = runResumeDocCheck({
    resumeDocPath: dangerDoc,
    markers: [{ token: "DANGER_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesPath: bogusRulesPath,
  });
  check("rulesCheck DANGEROUS CELL: overall ok is unaffected (DoD-2 decision — markers genuinely satisfied via active)", dangerResult.ok === true && dangerResult.missingMarkers.length === 0);
  check("rulesCheck DANGEROUS CELL: marker source correctly attributed to 'active', never falsely to a rules file never read", dangerResult.markerSources.DANGER_MARKER === "active");
  check("rulesCheck DANGEROUS CELL: rulesCheck.checked is true (a rulesPath WAS supplied)", dangerResult.rulesCheck?.checked === true);
  check("rulesCheck DANGEROUS CELL: rulesCheck.ok is false — this is the loud signal the old code never produced", dangerResult.rulesCheck?.ok === false);
  check("rulesCheck DANGEROUS CELL: resolvedPath names exactly the path that was tried", dangerResult.rulesCheck?.resolvedPath === bogusRulesPath);
  check("rulesCheck DANGEROUS CELL: reason names the resolved path too (self-diagnosing, mirrors archiveCheck)", (dangerResult.rulesCheck?.reason ?? "").includes(bogusRulesPath));

  // ── supplied-and-readable: unchanged, now also reports ok:true with the resolved path ──
  const rulesFilePath = tmpFile("rules-ok.md", "some rules content, irrelevant to the marker\n");
  const readableResult = runResumeDocCheck({
    resumeDocPath: dangerDoc,
    markers: [{ token: "DANGER_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesPath: rulesFilePath,
  });
  check("rulesCheck supplied+readable: checked:true, ok:true, resolvedPath set", readableResult.rulesCheck?.checked === true && readableResult.rulesCheck?.ok === true && readableResult.rulesCheck?.resolvedPath === rulesFilePath);
  check("rulesCheck supplied+readable: no reason on a successful read", readableResult.rulesCheck?.reason === undefined);
  fs.rmSync(rulesFilePath, { force: true });

  // ── not supplied at all: must stay silent — absence of rulesPath is not a failure ──
  const noRulesResult = runResumeDocCheck({
    resumeDocPath: dangerDoc,
    markers: [{ token: "DANGER_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
  });
  check("rulesCheck not supplied: checked:false, ok:true, no resolvedPath/reason (silent, as before this card)", noRulesResult.rulesCheck?.checked === false && noRulesResult.rulesCheck?.ok === true && noRulesResult.rulesCheck?.resolvedPath === undefined);

  fs.rmSync(dangerDoc, { force: true });
}

// ── rulesCheck on the docFound:false path must NOT contradict its own doc (card 1083e8f4, Finding 1) ──
// The observed defect: `runResumeDocCheck`'s early return hardcoded `rulesCheck: { checked: false, ok:
// true }` before `opts.rulesPath` was ever read — so a seat that has NOT yet written its resume doc AND
// passes a supplied-but-unreadable rulesPath was told "you didn't pass one," the OPPOSITE of card
// 870edbcf's own diagnosis for exactly this shape. THE DANGEROUS CELL below is docFound:false + a
// supplied rulesPath that cannot be read.
{
  const missingDocPath2 = tmpFile("missing2.md", null); // never written — proves docFound:false
  const bogusRulesPath2 = path.join(os.tmpdir(), `loom-rot-bogus-rules2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  // never written — proves the supplied-but-unreadable branch

  const r = runResumeDocCheck({
    resumeDocPath: missingDocPath2,
    markers: [{ token: "x" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesPath: bogusRulesPath2,
  });
  check("docFound:false + supplied rulesPath: docFound is false", r.docFound === false);
  check("docFound:false + supplied rulesPath: rulesCheck.checked is true (a rulesPath WAS supplied — not the pre-fix false)", r.rulesCheck?.checked === true);
  check("docFound:false + supplied rulesPath: rulesCheck.ok is false (it could not be read)", r.rulesCheck?.ok === false);
  check("docFound:false + supplied rulesPath: resolvedPath names exactly the path that was tried", r.rulesCheck?.resolvedPath === bogusRulesPath2);

  // POSITIVE CONTROL: docFound:false + NO rulesPath at all must stay silent (checked:false) — proves the
  // checks above discriminate "supplied" from "not supplied," not just always reporting true.
  const rNoRules = runResumeDocCheck({
    resumeDocPath: missingDocPath2,
    markers: [{ token: "x" }],
    commitmentsHeading: "", commitmentsFloor: 0,
  });
  check("docFound:false + no rulesPath: rulesCheck stays silent (checked:false) — the control proving the cell above isn't vacuous", rNoRules.rulesCheck?.checked === false && rNoRules.rulesCheck?.ok === true);
}

// ── checkRotation: the marker-union source and rulesCheck now derive from ONE shared input, not two
// (card 1083e8f4, Finding 2) — `rules` replaces the old separate `rulesText`/`rulesInfo` fields, so a
// marker-union hit and rulesCheck.ok can never disagree about whether the rules file was actually read.
{
  const rGood = checkRotation({
    activeText: "nothing relevant here", markers: [{ token: "SHARED_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: "/some/path.md", text: "...SHARED_MARKER..." },
  });
  check("checkRotation: rules.text satisfies the marker union", rGood.markerSources.SHARED_MARKER === "rules");
  check("checkRotation: the SAME `rules` input also reports rulesCheck.ok:true", rGood.rulesCheck.checked === true && rGood.rulesCheck.ok === true);

  const rBad = checkRotation({
    activeText: "nothing relevant here", markers: [{ token: "SHARED_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: "/some/bogus.md", error: "rules path does not exist or is unreadable: /some/bogus.md" },
  });
  check("checkRotation: an unreadable `rules` input cannot satisfy the marker union", rBad.missingMarkers.includes("SHARED_MARKER"));
  check("checkRotation: the SAME unreadable `rules` input reports rulesCheck.ok:false", rBad.rulesCheck.checked === true && rBad.rulesCheck.ok === false);

  const rNone = checkRotation({
    activeText: "nothing relevant here", markers: [{ token: "SHARED_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
  });
  check("checkRotation: omitted `rules` ⇒ rulesCheck stays silent (checked:false)", rNone.rulesCheck.checked === false && rNone.rulesCheck.ok === true);
}

// ── MULTI-FILE RULES UNION (card f6985338) — checkMarkersUnion / countNumberedSectionUnionMulti ──────────
// Lets resume_doc_check accept MULTIPLE rules files (the `rulesPaths` MCP argument), for a seat that has
// grown past one non-rotating doctrine file (the concrete trigger card 14f14d92 pre-registered: "if a
// third doctrine file is ever added, this is the trigger to revisit"). These GENERALIZE checkMarkers/
// countNumberedSectionUnion above from exactly-one-other-file to N — the ORIGINAL functions stay
// completely untouched (still exercised by every test above them, still what a legacy single-`rulesPath`
// caller runs through via checkRotation below), so this capability is purely additive.
{
  const markers = [
    { token: "ALPHA", caseSensitive: false },
    { token: "BETA", caseSensitive: false },
    { token: "GAMMA", caseSensitive: false },
  ];

  // (1) basic N-file union: each marker found in a DIFFERENT source, active has none.
  const sources = [
    { label: "/vault/rules-a.md", text: "...ALPHA lives here..." },
    { label: "/vault/rules-b.md", text: "...BETA lives here..." },
  ];
  const rMulti = checkMarkersUnion("nothing relevant in the active doc", markers, sources);
  check("checkMarkersUnion: ALPHA found in the first source, attributed to its own label (not a generic 'rules')", rMulti.satisfiedBy.get("ALPHA") === "/vault/rules-a.md");
  check("checkMarkersUnion: BETA found in the second source, attributed to its own label", rMulti.satisfiedBy.get("BETA") === "/vault/rules-b.md");
  check("checkMarkersUnion: GAMMA absent from active AND every source ⇒ reported missing", rMulti.missing.some((m) => m.token === "GAMMA"));

  // (2) precedence: active still wins over every source (unchanged from the single-file version).
  const rPrecedence = checkMarkersUnion("...ALPHA lives in the active doc too...", markers.slice(0, 1), sources);
  check("checkMarkersUnion: active still wins over every source", rPrecedence.satisfiedBy.get("ALPHA") === "active");

  // Sources are tried IN THE ORDER GIVEN — the first one that matches wins.
  const bothHaveAlpha = [
    { label: "/vault/first.md", text: "ALPHA here" },
    { label: "/vault/second.md", text: "ALPHA here too" },
  ];
  const rOrder = checkMarkersUnion("nothing relevant", markers.slice(0, 1), bothHaveAlpha);
  check("checkMarkersUnion: the FIRST source (in the order given) wins when more than one would satisfy it", rOrder.satisfiedBy.get("ALPHA") === "/vault/first.md");

  // (3) zero sources behaves exactly like the single-file version with no rulesText at all.
  const rNoSources = checkMarkersUnion("nothing relevant", markers.slice(0, 1), []);
  check("checkMarkersUnion: zero sources ⇒ missing, same as the single-file version with rulesText:null", rNoSources.missing.length === 1 && rNoSources.missing[0].token === "ALPHA");

  // ── countNumberedSectionUnionMulti ──
  const doc = (n) => ["## LIVE COMMITMENTS", ...Array.from({ length: n }, (_, i) => `${i + 1}. item`)].join("\n");
  const noHeading = "nothing relevant here";

  const rNeither = countNumberedSectionUnionMulti(noHeading, [{ label: "/a.md", text: noHeading }, { label: "/b.md", text: noHeading }], "LIVE COMMITMENTS");
  check("countNumberedSectionUnionMulti: fail-closed when the heading is in active AND every source", rNeither.count === null && rNeither.source === null);
  check("countNumberedSectionUnionMulti: fail-closed diagnostic names that rules files WERE checked", rNeither.diagnostic.includes("any supplied rules file"));

  // Found in the SECOND source only — proves the union actually walks past a non-matching source instead
  // of stopping at the first one tried.
  const rSecondOnly = countNumberedSectionUnionMulti(noHeading, [{ label: "/a.md", text: noHeading }, { label: "/b.md", text: doc(9) }], "LIVE COMMITMENTS");
  check("countNumberedSectionUnionMulti: found in the SECOND source when the first has no heading", rSecondOnly.count === 9 && rSecondOnly.source === "/b.md");

  // AMBIGUITY across 3 places (active + two sources) — the N-file generalization of the single-file
  // otherCount/otherDiagnostic pair, now `others` (plural, one entry per OTHER location).
  const rAmbiguous3 = countNumberedSectionUnionMulti(doc(20), [{ label: "/a.md", text: doc(5) }, { label: "/b.md", text: doc(3) }], "LIVE COMMITMENTS");
  check("countNumberedSectionUnionMulti: active wins (20), both sources reported as 'others'", rAmbiguous3.source === "active" && rAmbiguous3.count === 20 && rAmbiguous3.ambiguous === true);
  check("countNumberedSectionUnionMulti: 'others' names BOTH other locations with their own counts", rAmbiguous3.others.length === 2 && rAmbiguous3.others.some((o) => o.source === "/a.md" && o.count === 5) && rAmbiguous3.others.some((o) => o.source === "/b.md" && o.count === 3));

  // BOUNDARY: active is below the floor even though a LATER source would pass on its own — must never
  // fall through to a passing source (mirrors the single-file boundary test above).
  const rBoundaryMulti = countNumberedSectionUnionMulti(doc(2), [{ label: "/a.md", text: doc(20) }], "LIVE COMMITMENTS");
  check("countNumberedSectionUnionMulti: active carries the heading (even below a real floor) ⇒ never falls through to a passing source", rBoundaryMulti.source === "active" && rBoundaryMulti.count === 2);

  // Only ONE other location (active absent, exactly one source carries it) ⇒ `ambiguous` absent — proves
  // it isn't spuriously set just because a `sources` array was passed at all.
  const rOnlyOneOther = countNumberedSectionUnionMulti(noHeading, [{ label: "/only.md", text: doc(7) }], "LIVE COMMITMENTS");
  check("countNumberedSectionUnionMulti: exactly one source carries it, active absent ⇒ ambiguous is ABSENT", rOnlyOneOther.ambiguous === undefined && rOnlyOneOther.source === "/only.md" && rOnlyOneOther.count === 7);
}

// ── checkRotation('rulesFiles') — multi-file union end-to-end through the pure function (card f6985338) ──
{
  const markers = [{ token: "ALPHA" }, { token: "BETA" }];

  // DoD-1, the regression that matters most — a caller supplying ONLY the legacy `rules` field must get
  // the EXACT same result as before this card.
  //
  // ⚠️ CODE REVIEW (B1) CORRECTION: this used to compare `checkRotation(legacyInput)` against
  // `checkRotation({...legacyInput, rulesFiles: []})` and call the agreement "byte-identical to before
  // this card." That comparison is a TAUTOLOGY, not evidence — `rotation-check.ts`'s own
  // `input.rulesFiles ?? []` normalizes BOTH calls onto the IDENTICAL code path before either one runs, so
  // of course they agree; the reviewer proved this mechanically by mutating ONLY the legacy branch in a
  // scratch copy of the built module and watching that assertion stay green regardless. Two sides, one
  // source, is not two witnesses. The underlying CLAIM survives — the reviewer verified the legacy branch
  // (`if (!hasMultiFiles)`) is the OLD code moved verbatim, unedited — but this test must not be the
  // evidence cited for it. The GOLDEN SNAPSHOT below is: a hand-written literal, independent of
  // `checkRotation` itself, that would go RED the moment anyone changes the legacy path's shape or values
  // — which is exactly the property a "byte-identical" claim needs behind it.
  const rLegacy = checkRotation({
    activeText: "nothing relevant here", markers,
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: "/x/rules.md", text: "...ALPHA...BETA..." },
  });
  const golden = {
    configured: true,
    ok: true,
    missingMarkers: [],
    markerSources: { ALPHA: "rules", BETA: "rules" },
    rulesCheck: { checked: true, ok: true, resolvedPath: "/x/rules.md" },
    liveCommitments: {
      enabled: false, count: null, floor: 0, ok: true,
      diagnostic: "disabled — no rotationLiveCommitmentsHeading configured for this seat", source: null,
    },
    archiveCheck: { checked: false, ok: true },
    byteCheck: { checked: false, ok: true },
    honestLimitNote: HONEST_LIMIT_NOTE,
  };
  check("checkRotation DoD-1 GOLDEN SNAPSHOT: a legacy-only call's FULL result matches a hand-written literal, byte for byte — this is what actually goes red if the legacy path's shape/values ever change", JSON.stringify(rLegacy) === JSON.stringify(golden));
  check("checkRotation DoD-1: markerSources still say 'rules' verbatim, not a path", rLegacy.markerSources.ALPHA === "rules" && rLegacy.markerSources.BETA === "rules");
  check("checkRotation DoD-1: no rulesChecks field at all on the legacy path (absent, not [])", rLegacy.rulesChecks === undefined);

  // `rulesFiles:[]` vs. omitted DOES legitimately confirm the two spellings of "no multi-file input" are
  // treated identically (both normalize via `?? []`) — but, per the correction above, this is NOT
  // independent proof the legacy path is unchanged (both sides run the SAME code); it only tests that the
  // normalization itself doesn't discriminate on omitted-vs-explicit-empty.
  const rLegacyWithEmptyRulesFiles = checkRotation({
    activeText: "nothing relevant here", markers,
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: "/x/rules.md", text: "...ALPHA...BETA..." },
    rulesFiles: [],
  });
  check("checkRotation: rulesFiles:[] is treated identically to rulesFiles omitted (both normalize to the same branch, NOT independent evidence of legacy-path stability — see the golden snapshot above for that)", JSON.stringify(rLegacy) === JSON.stringify(rLegacyWithEmptyRulesFiles));

  // DoD-2/3: rulesFiles present ⇒ union across ALL of them, markerSources names the SPECIFIC file.
  const rMulti = checkRotation({
    activeText: "nothing relevant here", markers,
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesFiles: [
      { resolvedPath: "/vault/rules-a.md", text: "...ALPHA only here..." },
      { resolvedPath: "/vault/rules-b.md", text: "...BETA only here..." },
    ],
  });
  check("checkRotation multi-file: ALPHA attributed to rules-a.md specifically", rMulti.markerSources.ALPHA === "/vault/rules-a.md");
  check("checkRotation multi-file: BETA attributed to rules-b.md specifically", rMulti.markerSources.BETA === "/vault/rules-b.md");
  check("checkRotation multi-file: overall ok:true (every marker satisfied somewhere)", rMulti.ok === true && rMulti.missingMarkers.length === 0);

  // DoD-4: a rulesFiles entry that could not be read FAILS VISIBLY — a real ok:false entry in
  // `rulesChecks`, NEVER silently dropped from the array — even while the union itself is satisfied
  // elsewhere (the dangerous cell: a green `ok` must not hide a missing file).
  const rMissingFile = checkRotation({
    activeText: "nothing relevant here", markers,
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesFiles: [
      { resolvedPath: "/vault/rules-a.md", text: "...ALPHA...BETA..." },
      { resolvedPath: "/vault/bogus.md", error: "rules path does not exist or is unreadable: /vault/bogus.md" },
    ],
  });
  check("checkRotation multi-file DANGEROUS CELL: overall ok is unaffected (every marker genuinely satisfied by the readable file)", rMissingFile.ok === true && rMissingFile.missingMarkers.length === 0);
  check("checkRotation multi-file DANGEROUS CELL: rulesChecks has BOTH entries, in order — the bad one is NOT dropped", rMissingFile.rulesChecks.length === 2);
  check("checkRotation multi-file DANGEROUS CELL: the readable entry reports ok:true", rMissingFile.rulesChecks[0].ok === true && rMissingFile.rulesChecks[0].resolvedPath === "/vault/rules-a.md");
  check("checkRotation multi-file DANGEROUS CELL: the UNREADABLE entry reports ok:false with its own resolvedPath + reason — the loud signal", rMissingFile.rulesChecks[1].ok === false && rMissingFile.rulesChecks[1].resolvedPath === "/vault/bogus.md" && rMissingFile.rulesChecks[1].reason.includes("/vault/bogus.md"));

  // A marker ONLY the unreadable file could have satisfied must genuinely fail — never read as "satisfied
  // elsewhere" (the exact false-green DoD-4 exists to prevent).
  const rMissingFileIsTheOnlySource = checkRotation({
    activeText: "nothing relevant here", markers: [{ token: "ONLY_IN_BOGUS" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesFiles: [{ resolvedPath: "/vault/bogus.md", error: "rules path does not exist or is unreadable: /vault/bogus.md" }],
  });
  check("checkRotation multi-file: a marker ONLY the unreadable file could have satisfied genuinely fails, never a false green", rMissingFileIsTheOnlySource.ok === false && rMissingFileIsTheOnlySource.missingMarkers.includes("ONLY_IN_BOGUS"));
  check("checkRotation multi-file: rulesChecks still names the failure even though it changed nothing else", rMissingFileIsTheOnlySource.rulesChecks.length === 1 && rMissingFileIsTheOnlySource.rulesChecks[0].ok === false);

  // legacy `rules` PLUS `rulesFiles` together: the legacy field keeps its "rules" label, array entries get
  // their own paths — proves the two inputs COMPOSE rather than one silently overriding the other.
  const rMixed = checkRotation({
    activeText: "nothing relevant here", markers: [{ token: "ALPHA" }, { token: "BETA" }, { token: "GAMMA" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: "/legacy/rules.md", text: "...ALPHA..." },
    rulesFiles: [{ resolvedPath: "/vault/extra.md", text: "...BETA...GAMMA..." }],
  });
  check("checkRotation mixed rules+rulesFiles: legacy field still labeled 'rules'", rMixed.markerSources.ALPHA === "rules");
  check("checkRotation mixed rules+rulesFiles: the array entry is labeled by its own path", rMixed.markerSources.BETA === "/vault/extra.md" && rMixed.markerSources.GAMMA === "/vault/extra.md");
  check("checkRotation mixed rules+rulesFiles: legacy rulesCheck AND the new rulesChecks are BOTH populated", rMixed.rulesCheck.ok === true && rMixed.rulesChecks.length === 1 && rMixed.rulesChecks[0].resolvedPath === "/vault/extra.md");
}

// ── checkRotation('rulesFiles') — LIVE COMMITMENTS floor unions across N files too (DoD-2) ───────────────
{
  const doc = (n) => ["## LIVE COMMITMENTS", ...Array.from({ length: n }, (_, i) => `${i + 1}. item`)].join("\n");
  const noHeading = "nothing relevant here";

  const rFromSecondFile = checkRotation({
    activeText: noHeading, markers: [],
    commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 5,
    rulesFiles: [
      { resolvedPath: "/vault/a.md", text: noHeading },
      { resolvedPath: "/vault/b.md", text: doc(8) },
    ],
  });
  check("checkRotation multi-file floor: found in the second rules file when the first has none", rFromSecondFile.liveCommitments.ok === true && rFromSecondFile.liveCommitments.count === 8 && rFromSecondFile.liveCommitments.source === "/vault/b.md");

  const rAmbiguousMulti = checkRotation({
    activeText: doc(20), markers: [],
    commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 5,
    rulesFiles: [
      { resolvedPath: "/vault/a.md", text: doc(3) },
      { resolvedPath: "/vault/b.md", text: doc(9) },
    ],
  });
  check("checkRotation multi-file floor ambiguity: active wins (20), otherSources names BOTH other files", rAmbiguousMulti.liveCommitments.ambiguous === true && rAmbiguousMulti.liveCommitments.count === 20 && rAmbiguousMulti.liveCommitments.otherSources.length === 2);
  check("checkRotation multi-file floor ambiguity: single-file otherCount/otherDiagnostic are ABSENT (mutually exclusive with otherSources)", rAmbiguousMulti.liveCommitments.otherCount === undefined && rAmbiguousMulti.liveCommitments.otherDiagnostic === undefined);
  check("checkRotation multi-file floor ambiguity: top-level ambiguityWarning enumerates MULTIPLE places by path", typeof rAmbiguousMulti.ambiguityWarning === "string" && rAmbiguousMulti.ambiguityWarning.includes("MULTIPLE") && rAmbiguousMulti.ambiguityWarning.includes("/vault/a.md") && rAmbiguousMulti.ambiguityWarning.includes("/vault/b.md"));

  const rFailClosedMulti = checkRotation({
    activeText: noHeading, markers: [],
    commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 5,
    rulesFiles: [{ resolvedPath: "/vault/a.md", text: noHeading }, { resolvedPath: "/vault/b.md", text: noHeading }],
  });
  check("checkRotation multi-file floor: fail-closed when the heading is nowhere at all", rFailClosedMulti.liveCommitments.ok === false && rFailClosedMulti.liveCommitments.count === null && rFailClosedMulti.ok === false);
}

// ── runResumeDocCheck('rulesPaths') — the real fs wrapper, multi-file, end-to-end (card f6985338) ─────────
{
  const activeDoc = "active doc — no markers here\n";
  const activePath = tmpFile("f6985338-active.md", activeDoc);
  const rulesAPath = tmpFile("f6985338-rules-a.md", "RULE_ONE lives only here\n");
  const rulesBPath = tmpFile("f6985338-rules-b.md", "RULE_TWO lives only here\n");
  const bogusPath = path.join(os.tmpdir(), `loom-rot-f6985338-bogus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  // never written — proves the "supplied but unreadable" branch, mirrors the existing pattern above.

  const markers = [{ token: "RULE_ONE" }, { token: "RULE_TWO" }];

  const rGreen = runResumeDocCheck({
    resumeDocPath: activePath, markers,
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesPaths: [rulesAPath, rulesBPath],
  });
  check("runResumeDocCheck multi-path: both markers satisfied, each attributed to its own file", rGreen.ok === true && rGreen.markerSources.RULE_ONE === rulesAPath && rGreen.markerSources.RULE_TWO === rulesBPath);
  check("runResumeDocCheck multi-path: rulesChecks reports BOTH files as ok:true", rGreen.rulesChecks.length === 2 && rGreen.rulesChecks.every((r) => r.ok === true));

  // DoD-4: a missing rulesPaths entry fails visibly, not silently skipped, even while the union stays
  // green via the OTHER file.
  const rDangerousCell = runResumeDocCheck({
    resumeDocPath: activePath, markers: [{ token: "RULE_ONE" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesPaths: [rulesAPath, bogusPath],
  });
  check("runResumeDocCheck multi-path DANGEROUS CELL: ok unaffected (RULE_ONE genuinely satisfied by the readable file)", rDangerousCell.ok === true);
  check("runResumeDocCheck multi-path DANGEROUS CELL: rulesChecks names the bogus file as ok:false, not dropped", rDangerousCell.rulesChecks.length === 2 && rDangerousCell.rulesChecks.some((r) => r.resolvedPath === bogusPath && r.ok === false));

  // docFound:false + rulesPaths supplied (one missing) — must still report rulesChecks (generalizes the
  // existing docFound:false + rulesPath test above to the array form).
  const missingActivePath = tmpFile("f6985338-missing-active.md", null);
  const rDocMissing = runResumeDocCheck({
    resumeDocPath: missingActivePath, markers: [{ token: "x" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesPaths: [rulesAPath, bogusPath],
  });
  check("runResumeDocCheck docFound:false + rulesPaths: docFound is false", rDocMissing.docFound === false);
  check("runResumeDocCheck docFound:false + rulesPaths: rulesChecks STILL reports both files (not silently dropped just because the active doc itself is missing)", rDocMissing.rulesChecks.length === 2 && rDocMissing.rulesChecks.some((r) => r.resolvedPath === bogusPath && r.ok === false) && rDocMissing.rulesChecks.some((r) => r.resolvedPath === rulesAPath && r.ok === true));

  // ── DoD-5: BREAK → RED → REVERT (byte-identical) → GREEN, MULTI-PATH FORM ──
  const rulesBOriginal = fs.readFileSync(rulesBPath, "utf8");
  fs.writeFileSync(rulesBPath, "nothing relevant in this file any more\n", "utf8");
  const rRed = runResumeDocCheck({ resumeDocPath: activePath, markers, commitmentsHeading: "", commitmentsFloor: 0, rulesPaths: [rulesAPath, rulesBPath] });
  check("BREAK→RED (multi-path): removing RULE_TWO from rules-b flips ok to false", rRed.ok === false && rRed.missingMarkers.includes("RULE_TWO"));
  check("BREAK→RED (multi-path): RULE_ONE is still fine (not a blanket failure)", !rRed.missingMarkers.includes("RULE_ONE"));
  fs.writeFileSync(rulesBPath, rulesBOriginal, "utf8");
  const rGreenAgain = runResumeDocCheck({ resumeDocPath: activePath, markers, commitmentsHeading: "", commitmentsFloor: 0, rulesPaths: [rulesAPath, rulesBPath] });
  check("REVERT→GREEN (multi-path): restoring the exact original bytes flips ok back to true", rGreenAgain.ok === true && rGreenAgain.missingMarkers.length === 0);
  check("REVERT→GREEN (multi-path): the reverted result is byte-identical to the original green (same JSON)", JSON.stringify(rGreenAgain) === JSON.stringify(rGreen));

  fs.rmSync(activePath, { force: true });
  fs.rmSync(rulesAPath, { force: true });
  fs.rmSync(rulesBPath, { force: true });
  fs.rmSync(missingActivePath, { force: true });
}

// ── DoD-5: BREAK → RED → REVERT (byte-identical) → GREEN, SINGLE-PATH FORM ─────────────────────────────
// Proves the ORIGINAL single-`rulesPath` code path (unchanged by this card) still exhibits the same
// break/revert cycle through the real entry point — DoD-1's "the regression that matters most" is that
// this form's behavior never moved.
{
  const activeDoc = "active doc — no markers here\n";
  const activePath = tmpFile("f6985338-single-active.md", activeDoc);
  const rulesPath = tmpFile("f6985338-single-rules.md", "SOLO_MARKER lives only here\n");
  const markers = [{ token: "SOLO_MARKER" }];

  const rGreen = runResumeDocCheck({ resumeDocPath: activePath, markers, commitmentsHeading: "", commitmentsFloor: 0, rulesPath });
  check("BREAK→RED→REVERT→GREEN (single-path) baseline: ok:true", rGreen.ok === true);

  const original = fs.readFileSync(rulesPath, "utf8");
  fs.writeFileSync(rulesPath, "nothing relevant any more\n", "utf8");
  const rRed = runResumeDocCheck({ resumeDocPath: activePath, markers, commitmentsHeading: "", commitmentsFloor: 0, rulesPath });
  check("BREAK→RED (single-path): removing the marker from the rules file flips ok to false", rRed.ok === false && rRed.missingMarkers.includes("SOLO_MARKER"));

  fs.writeFileSync(rulesPath, original, "utf8");
  const rGreenAgain = runResumeDocCheck({ resumeDocPath: activePath, markers, commitmentsHeading: "", commitmentsFloor: 0, rulesPath });
  check("REVERT→GREEN (single-path): restoring the exact original bytes flips ok back to true", rGreenAgain.ok === true);
  check("REVERT→GREEN (single-path): the reverted result is byte-identical to the original green (same JSON)", JSON.stringify(rGreenAgain) === JSON.stringify(rGreen));

  fs.rmSync(activePath, { force: true });
  fs.rmSync(rulesPath, { force: true });
}

// ── CODE REVIEW N1 — top-level `rulesUnreadableWarning`, SINGULAR path too, never gates `ok` ────────────
// DoD-4 said "fail visibly"; `rulesCheck`/`rulesChecks` only report nested. This proves the promised
// TOP-LEVEL warning fires for BOTH the legacy singular path and the new plural path, stays absent when
// every supplied rules source read cleanly, and never changes `ok` on its own.
{
  const dangerDoc = "prose containing DANGER_MARKER right here, nothing else\n";
  const bogusPath = "/nonexistent/loom-rot-n1-bogus.md"; // never created — proves the unreadable branch

  // Singular `rules` (readable) ⇒ warning absent.
  const rSingularOk = checkRotation({
    activeText: dangerDoc, markers: [{ token: "DANGER_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: "/ok.md", text: "irrelevant" },
  });
  check("N1: singular rules readable ⇒ rulesUnreadableWarning ABSENT", rSingularOk.rulesUnreadableWarning === undefined);

  // Singular `rules` (unreadable) ⇒ warning PRESENT, names the path, `ok` UNAFFECTED (marker satisfied by active).
  const rSingularBad = checkRotation({
    activeText: dangerDoc, markers: [{ token: "DANGER_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: bogusPath, error: `rules path does not exist or is unreadable: ${bogusPath}` },
  });
  check("N1: singular rules UNREADABLE ⇒ top-level rulesUnreadableWarning fires (the more dangerous blind spot — every existing seat uses this path)", typeof rSingularBad.rulesUnreadableWarning === "string" && rSingularBad.rulesUnreadableWarning.includes(bogusPath));
  check("N1: the warning never flips ok on its own (marker genuinely satisfied by the active doc)", rSingularBad.ok === true);

  // Plural `rulesFiles`, one unreadable among several ⇒ warning PRESENT, names just that one.
  const rPluralMixed = checkRotation({
    activeText: dangerDoc, markers: [{ token: "DANGER_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesFiles: [
      { resolvedPath: "/good.md", text: "irrelevant" },
      { resolvedPath: bogusPath, error: `rules path does not exist or is unreadable: ${bogusPath}` },
    ],
  });
  check("N1: plural rulesFiles, one unreadable ⇒ warning fires, names exactly the bad one, not the good one", typeof rPluralMixed.rulesUnreadableWarning === "string" && rPluralMixed.rulesUnreadableWarning.includes(bogusPath) && !rPluralMixed.rulesUnreadableWarning.includes("/good.md"));

  // Plural `rulesFiles`, all readable ⇒ warning absent.
  const rPluralOk = checkRotation({
    activeText: dangerDoc, markers: [{ token: "DANGER_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesFiles: [{ resolvedPath: "/good.md", text: "irrelevant" }],
  });
  check("N1: plural rulesFiles all readable ⇒ rulesUnreadableWarning ABSENT", rPluralOk.rulesUnreadableWarning === undefined);

  // Both singular AND plural unreadable ⇒ warning names BOTH.
  const rBothBad = checkRotation({
    activeText: dangerDoc, markers: [{ token: "DANGER_MARKER" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: "/legacy-bogus.md", error: "rules path does not exist or is unreadable: /legacy-bogus.md" },
    rulesFiles: [{ resolvedPath: bogusPath, error: `rules path does not exist or is unreadable: ${bogusPath}` }],
  });
  check("N1: singular AND plural both unreadable ⇒ warning names BOTH paths", typeof rBothBad.rulesUnreadableWarning === "string" && rBothBad.rulesUnreadableWarning.includes("/legacy-bogus.md") && rBothBad.rulesUnreadableWarning.includes(bogusPath));

  // Genuine failure case: the ONLY source that could satisfy a marker is unreadable ⇒ ok:false AND the
  // warning both fire — the warning explains WHY the failure isn't "satisfied elsewhere".
  const rGenuineFailure = checkRotation({
    activeText: "nothing relevant here", markers: [{ token: "ONLY_IN_BOGUS" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rules: { resolvedPath: bogusPath, error: `rules path does not exist or is unreadable: ${bogusPath}` },
  });
  check("N1: genuine failure (only source is unreadable) ⇒ ok:false AND the warning both fire together", rGenuineFailure.ok === false && typeof rGenuineFailure.rulesUnreadableWarning === "string");

  // runResumeDocCheck's docFound:false early return must ALSO surface the warning (mirrors checkRotation).
  const rDocMissingWithBogusRules = runResumeDocCheck({
    resumeDocPath: "/nonexistent/loom-rot-n1-missing-active.md",
    markers: [{ token: "x" }], commitmentsHeading: "", commitmentsFloor: 0,
    rulesPath: bogusPath,
  });
  check("N1: docFound:false path also surfaces rulesUnreadableWarning for a supplied-but-unreadable rulesPath", rDocMissingWithBogusRules.docFound === false && typeof rDocMissingWithBogusRules.rulesUnreadableWarning === "string" && rDocMissingWithBogusRules.rulesUnreadableWarning.includes(bogusPath));
}

// ── CODE REVIEW N3 — dedupe by resolvedPath: no SPURIOUS ambiguityWarning on a duplicate path ────────────
// Verified defect: `rulesPaths:[A,A]`, or `rulesPath:A` + `rulesPaths:[A]` (a shape the tool description
// itself invites — "pass rulesPaths instead of/alongside rulesPath"), used to read as the heading being
// found in TWO different places, tripping a false ambiguityWarning that sends a reader hunting a
// duplicate heading that doesn't exist. Fixed by deduping on resolvedPath before building `sources`.
{
  const doc = (n) => ["## LIVE COMMITMENTS", ...Array.from({ length: n }, (_, i) => `${i + 1}. item`)].join("\n");
  const noHeading = "nothing relevant here";
  const dupPath = "/vault/same-file.md";

  // rulesPaths:[A, A] — the exact same path listed twice.
  const rDupInArray = checkRotation({
    activeText: noHeading, markers: [],
    commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 5,
    rulesFiles: [
      { resolvedPath: dupPath, text: doc(8) },
      { resolvedPath: dupPath, text: doc(8) },
    ],
  });
  check("N3: rulesPaths:[A,A] ⇒ NOT ambiguous (deduped to one source)", rDupInArray.liveCommitments.ambiguous === undefined && rDupInArray.liveCommitments.count === 8 && rDupInArray.liveCommitments.source === dupPath);
  check("N3: rulesPaths:[A,A] ⇒ no spurious top-level ambiguityWarning", rDupInArray.ambiguityWarning === undefined);

  // legacy `rules` (labeled "rules") + `rulesFiles:[A]` where A is the SAME resolvedPath as `rules`.
  const rDupAcrossLegacyAndPlural = checkRotation({
    activeText: noHeading, markers: [],
    commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 5,
    rules: { resolvedPath: dupPath, text: doc(8) },
    rulesFiles: [{ resolvedPath: dupPath, text: doc(8) }],
  });
  check("N3: rules===rulesFiles[0] (same resolvedPath) ⇒ NOT ambiguous, wins as 'rules' (legacy precedence)", rDupAcrossLegacyAndPlural.liveCommitments.ambiguous === undefined && rDupAcrossLegacyAndPlural.liveCommitments.source === "rules" && rDupAcrossLegacyAndPlural.liveCommitments.count === 8);
  check("N3: rules===rulesFiles[0] ⇒ no spurious top-level ambiguityWarning", rDupAcrossLegacyAndPlural.ambiguityWarning === undefined);

  // Marker union: same dedupe applies there too (a marker present in the duplicated file must still be
  // attributed to exactly one source, not silently double-counted or mis-picked).
  const rDupMarkers = checkRotation({
    activeText: "nothing relevant here", markers: [{ token: "ONLY_HERE" }],
    commitmentsHeading: "", commitmentsFloor: 0,
    rulesFiles: [
      { resolvedPath: dupPath, text: "...ONLY_HERE..." },
      { resolvedPath: dupPath, text: "...ONLY_HERE..." },
    ],
  });
  check("N3: marker union also deduped — ONLY_HERE attributed to the single deduped source", rDupMarkers.markerSources.ONLY_HERE === dupPath && rDupMarkers.ok === true);

  // NEGATIVE CONTROL — a GENUINE second file (different resolvedPath, same or different content) must
  // STILL trip ambiguity normally. Proves the dedupe fix didn't accidentally suppress real ambiguity too.
  const rGenuineAmbiguity = checkRotation({
    activeText: noHeading, markers: [],
    commitmentsHeading: "LIVE COMMITMENTS", commitmentsFloor: 5,
    rulesFiles: [
      { resolvedPath: "/vault/file-a.md", text: doc(8) },
      { resolvedPath: "/vault/file-b.md", text: doc(8) }, // different path, same content — still 2 real files
    ],
  });
  check("N3 NEGATIVE CONTROL: two DIFFERENT resolvedPaths (even with identical content) still correctly trip ambiguity — the dedupe fix didn't overreach", rGenuineAmbiguity.liveCommitments.ambiguous === true && rGenuineAmbiguity.liveCommitments.otherSources.length === 1 && rGenuineAmbiguity.ambiguityWarning !== undefined);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — rotation-check's marker/floor/archive/byte checks behave correctly, the two named historical bugs (a681aed5's name-anchor fail-open, 34a6f07e's equality-vs-floor) are proven absent from this port, a mutation test confirms a dropped marker is caught and named, configured:false is distinct from ok:true, the impure fs wrapper never throws on a missing doc, and the new multi-rules-file union (card f6985338) is byte-identical for a legacy single-rulesPath caller while correctly unioning/attributing/failing-visibly across N files — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
