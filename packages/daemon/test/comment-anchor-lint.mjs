// comment-anchor-lint.mjs unit test (card 5329a9af). Deterministic — no daemon, no claude. Imports the
// shipped assets/comment-anchor-lint.mjs directly (plain ESM, no dist/ build needed) and exercises its
// exported pure functions against fixture source trees, asserting:
//   1. unanchoredLongBlocks: a block >= minLines with no `@decision` anchor is flagged; a block below
//      minLines is not, regardless of anchor.
//   2. orphanAnchors: an `@decision <id>` with no matching record in adr/decisions/investigations is
//      flagged; one that DOES resolve (via any of the three stores) is not.
//   3. orphanRecords: a record file whose id has no inbound anchor anywhere in swept source is flagged,
//      but always under `advisory: true` — never conflated with the two error-shaped checks above.
//   4. guard class (DoD-4): an isolated <=3-line block carrying an anchor is never flagged as an
//      unanchored long block. Also covers the real-world adjacent-merge shape found in this repo's own
//      pty/host.ts (a short anchor comment immediately followed, with no blank line, by further prose) —
//      the merged block still carries the anchor and must still never be flagged, even though it no
//      longer measures as a standalone <=3-line block.
//   5. minLines is configurable — the same fixture flags under a smaller N and not under a larger one.
//   6. brokenAnchors (card ad3a9a85): a `@decision` keyword whose id lands on a DIFFERENT line (a JSDoc
//      wrap) — invisible to every check above — is flagged, in both the CLI scan and the live per-file
//      hook (computeFileReport); a well-formed same-line anchor and ordinary anchor-free prose are not.
//   7. oversizedRecords (card d0d0401b): a record file over `PER_RECORD_MAX_BYTES` (imported from
//      decision-records.mjs — one source of truth, not a hand-copied number) is flagged with its measured
//      byte size; CLI-scan only — records live outside SOURCE_ROOTS, so the per-file hook never sees one.
// Run: `node test/comment-anchor-lint.mjs` from packages/daemon (no build, no LOOM_HOME needed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractCommentBlocks,
  findFileAnchors,
  findBrokenAnchors,
  findOversizedRecords,
  listRecordIds,
  computeReport,
  computeFileReport,
  bucketDistribution,
  DEFAULT_MIN_LINES,
  GUARD_MAX_LINES,
} from "../assets/comment-anchor-lint.mjs";
import { PER_RECORD_MAX_BYTES } from "../assets/decision-records.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- pure-function tests: extractCommentBlocks / findFileAnchors -----------------------------------

{
  // An isolated guard block: blank lines on both sides, 2 lines, carries an anchor.
  const lines = [
    "const a = 1;",
    "",
    "// @decision aaaaaaaa — a short guard, never regrows",
    "// see docs/adr/aaaaaaaa-example.md",
    "",
    "const b = 2;",
  ];
  const blocks = extractCommentBlocks(lines);
  check("isolated guard block: exactly one block found", blocks.length === 1);
  check("isolated guard block: length is 2 (<= GUARD_MAX_LINES)", blocks[0]?.length === 2 && GUARD_MAX_LINES >= 2);
  check("isolated guard block: anchor id captured", blocks[0]?.anchorIds.includes("aaaaaaaa"));
}

{
  // A long (16-line) block with NO anchor.
  const body = Array.from({ length: 16 }, (_, i) => `// narrative line ${i} — regrowing prose`);
  const lines = ["const a = 1;", "", ...body, "", "const b = 2;"];
  const blocks = extractCommentBlocks(lines);
  check("16-line unanchored block: exactly one block found", blocks.length === 1);
  check("16-line unanchored block: length is 16", blocks[0]?.length === 16);
  check("16-line unanchored block: no anchor ids", blocks[0]?.anchorIds.length === 0);
}

{
  // The real repo shape (pty/host.ts): a short anchor comment immediately followed (NO blank line) by a
  // longer /** ... */ doc block. Blank-line-only block boundaries merge these into ONE block.
  const jsdocBody = Array.from({ length: 12 }, (_, i) => ` * further explanation line ${i}`);
  const lines = [
    "// @decision bbbbbbbb — a guard immediately preceding unrelated prose, no blank line between",
    "/**",
    ...jsdocBody,
    " */",
    "function f() {}",
  ];
  const blocks = extractCommentBlocks(lines);
  check("adjacent-merge shape: exactly one merged block", blocks.length === 1);
  check("adjacent-merge shape: merged block still carries the anchor", blocks[0]?.anchorIds.includes("bbbbbbbb"));
  check("adjacent-merge shape: merged block is well above GUARD_MAX_LINES", blocks[0]?.length > GUARD_MAX_LINES);
}

{
  // Single-line block comments (`/* ... */` closing on the same line) must not force `inBlock` state.
  const lines = ["/* one-liner */", "const x = 1;", "/* another */"];
  const blocks = extractCommentBlocks(lines);
  check("single-line block comments: two separate one-line blocks", blocks.length === 2 && blocks.every((b) => b.length === 1));
}

{
  const lines = ["// @decision 11111111 — first  // @decision 22222222 — second"];
  const anchors = findFileAnchors(lines);
  check("findFileAnchors: a single line carrying two anchors yields both", anchors.length === 2
    && anchors.some((a) => a.id === "11111111") && anchors.some((a) => a.id === "22222222"));
}

// --- findBrokenAnchors (card ad3a9a85 — the split-anchor silent-failure defect) ----------------------

{
  // The exact real-world shape from the card: a JSDoc continuation wrap breaks the keyword from its id.
  const lines = [
    " * @decision",
    " * 725dc89a — the prohibition",
  ];
  const anchors = findFileAnchors(lines);
  const broken = findBrokenAnchors(lines);
  check("split anchor: findFileAnchors (the pre-existing check) finds NOTHING — this IS the defect",
    anchors.length === 0);
  check("split anchor: findBrokenAnchors flags the keyword's own line, exactly once",
    broken.length === 1 && broken[0].line === 1);
}

{
  // Positive control: a correctly-formed single-line anchor must never be flagged as broken.
  const lines = ["// @decision 725dc89a — the prohibition, all on one line"];
  check("well-formed anchor: findBrokenAnchors reports nothing", findBrokenAnchors(lines).length === 0);
  check("well-formed anchor: findFileAnchors still finds it (sanity)", findFileAnchors(lines).length === 1);
}

{
  // A genuinely missing anchor (no `@decision` keyword at all) is NOT this check's concern —
  // brokenAnchors must never fire on ordinary prose with no keyword present.
  const lines = ["// just an ordinary comment, no decision anchor here at all"];
  check("no keyword at all: findBrokenAnchors reports nothing", findBrokenAnchors(lines).length === 0);
}

{
  // Scope boundary, made explicit: a same-line malformed id (too short) is a DIFFERENT, out-of-scope shape
  // — this check only catches the keyword DANGLING ALONE at end-of-line (the actual wrap defect), never a
  // same-line id that's merely the wrong length. Content still follows "@decision" on this line, so it's
  // not flagged, even though the id itself is invalid.
  const lines = ["// @decision 12ab — too short to be a real id"];
  check("malformed same-line id (out of this check's scope): findBrokenAnchors does NOT flag it",
    findBrokenAnchors(lines).length === 0);
}

{
  // Measured false-positive guard (card ad3a9a85 self-correction): mid-line mentions of the literal token
  // "@decision" — inside prose, a regex-literal definition, or a message string — must never be flagged.
  // A first-pass "not followed by a valid id anywhere on the line" version flagged 26 sites repo-wide, all
  // false positives of exactly this shape; this is the negative control that keeps that regression fixed.
  const lines = [
    "/** `@decision <id>` — the convention's own canonical example syntax, written as prose. */",
    "const ANCHOR_RE = /@decision\\s+([0-9a-f]{8})\\b/gi; // a regex LITERAL containing the bare token",
    "lines.push(`  - ${file}:${line} — @decision ${id}`); // a message string, not an anchor",
  ];
  check("mid-line mentions of the token are never flagged as broken", findBrokenAnchors(lines).length === 0);
}

// --- bucketDistribution -----------------------------------------------------------------------------

{
  const blocks = [{ length: 2 }, { length: 2 }, { length: 8 }, { length: 20 }, { length: 30 }];
  const dist = bucketDistribution(blocks);
  const totalLines = 2 + 2 + 8 + 20 + 30;
  check("bucketDistribution: 1-3 bucket gets the two 2-line blocks", dist["1-3"].blocks === 2 && dist["1-3"].lines === 4);
  check("bucketDistribution: 4-10 bucket gets the 8-line block", dist["4-10"].blocks === 1 && dist["4-10"].lines === 8);
  check("bucketDistribution: 11-25 bucket gets the 20-line block", dist["11-25"].blocks === 1 && dist["11-25"].lines === 20);
  check("bucketDistribution: 26+ bucket gets the 30-line block", dist["26+"].blocks === 1 && dist["26+"].lines === 30);
  check("bucketDistribution: percentages sum to ~100", Math.abs(Object.values(dist).reduce((s, b) => s + b.pctOfCommentVolume, 0) - 100) < 0.5
    && totalLines === 62);
}

// --- findOversizedRecords (card d0d0401b) --------------------------------------------------------------

{
  const dir = path.join(os.tmpdir(), `loom-oversized-records-${Date.now()}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const smallPath = path.join(dir, "small.md");
    const bigPath = path.join(dir, "big.md");
    fs.writeFileSync(smallPath, "# small\n\nwell under the cap\n");
    fs.writeFileSync(bigPath, "# big\n\n" + "x".repeat(PER_RECORD_MAX_BYTES + 500) + "\n");
    const records = [{ id: "aaaaaaaa", path: smallPath }, { id: "bbbbbbbb", path: bigPath }];
    const oversized = findOversizedRecords(records, PER_RECORD_MAX_BYTES);
    check("findOversizedRecords: the under-cap record is not flagged", !oversized.some((r) => r.id === "aaaaaaaa"));
    check("findOversizedRecords: the over-cap record IS flagged, with its measured byte size",
      oversized.length === 1 && oversized[0].id === "bbbbbbbb" && oversized[0].bytes > PER_RECORD_MAX_BYTES);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- computeReport: fixture repo, all five checks end to end ------------------------------------------

const REPO = path.join(os.tmpdir(), `loom-comment-anchor-lint-${Date.now()}-${process.pid}`);
try {
  fs.mkdirSync(path.join(REPO, "packages", "daemon", "src"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "packages", "daemon", "test"), { recursive: true }); // must be EXCLUDED from the sweep
  fs.mkdirSync(path.join(REPO, "docs", "adr"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "docs", "decisions"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "docs", "investigations", "bbbbbbbb-an-investigation"), { recursive: true });

  // aaaaaaaa: anchored AND recorded (docs/adr) → not orphan either direction.
  // bbbbbbbb: anchored, recorded via docs/investigations (third store) → not orphan.
  // dddddddd: anchor with NO matching record anywhere → orphan anchor.
  // eeeeeeee: a record with NO inbound anchor anywhere → orphan record (advisory).
  const longUnanchored = Array.from({ length: 20 }, (_, i) => `// regrowing narrative line ${i}`).join("\n");
  // The real repo shape (pty/host.ts): a long (>=15-line) block that DOES carry an anchor must never be
  // flagged — this is the case that actually exercises the anchor exclusion in `unanchoredLongBlocks`
  // (a guard-class <=3-line block is already below `minLines` regardless of the anchor check, so it
  // alone can't prove this filter works; a negative control that deleted the anchor check entirely from
  // `computeReport` still passed every other assertion in this file until this block was added).
  const longAnchored = [
    "// @decision aaaaaaaa — this long block DOES carry an anchor and must never be flagged",
    ...Array.from({ length: 18 }, (_, i) => `// supporting detail line ${i}`),
  ].join("\n");
  // The split-anchor shape (card ad3a9a85): the keyword and id land on different lines — ANCHOR_RE never
  // fires on either line alone, so this is invisible to every other check; only findBrokenAnchors sees it.
  const splitAnchor = [
    " * @decision",
    " * cccccccc — split across a line wrap, must be flagged as a broken anchor",
  ].join("\n");
  const src = [
    "const before = 1;",
    "",
    "// @decision aaaaaaaa — resolved via docs/adr, never flagged as orphan",
    "",
    "// @decision bbbbbbbb — resolved via docs/investigations, never flagged as orphan",
    "",
    "// @decision dddddddd — resolves to nothing, must be flagged as an orphan anchor",
    "",
    longUnanchored,
    "",
    longAnchored,
    "",
    splitAnchor,
    "",
    "const after = 1;",
  ].join("\n");
  fs.writeFileSync(path.join(REPO, "packages", "daemon", "src", "fixture.ts"), src);

  // A synthetic fixture anchor placed under test/ must NEVER pollute the measured corpus.
  fs.writeFileSync(path.join(REPO, "packages", "daemon", "test", "fixture-test.mjs"),
    "// @decision ffffffff — a synthetic test-fixture anchor with no record; must be excluded from the sweep\n");

  fs.writeFileSync(path.join(REPO, "docs", "adr", "aaaaaaaa-example.md"), "# aaaaaaaa\n\nAn ADR.\n");
  fs.writeFileSync(path.join(REPO, "docs", "investigations", "bbbbbbbb-an-investigation", "findings.md"), "# bbbbbbbb\n\nAn investigation record.\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "eeeeeeee-orphan-example.md"), "# eeeeeeee\n\nA record nothing anchors to.\n");
  fs.writeFileSync(path.join(REPO, "docs", "adr", "template.md"), "# <card-id> — template, must never be treated as a record\n");
  // 12345678: a record over PER_RECORD_MAX_BYTES — must be flagged as oversized (card d0d0401b).
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "12345678-oversized.md"), "# 12345678\n\n" + "y".repeat(PER_RECORD_MAX_BYTES + 500) + "\n");

  const report = computeReport(REPO, { minLines: 15 });

  check("computeReport: fixture-test.mjs under test/ is excluded from the sweep (filesScanned === 1)", report.filesScanned === 1);
  check("computeReport: the 20-line unanchored block is flagged", report.unanchoredLongBlocks.count === 1
    && report.unanchoredLongBlocks.items[0]?.length === 20);
  check("computeReport: aaaaaaaa (adr-resolved) is not an orphan anchor",
    !report.orphanAnchors.items.some((a) => a.id === "aaaaaaaa"));
  check("computeReport: bbbbbbbb (investigations-resolved) is not an orphan anchor",
    !report.orphanAnchors.items.some((a) => a.id === "bbbbbbbb"));
  check("computeReport: dddddddd (unresolved) IS an orphan anchor, exactly once",
    report.orphanAnchors.count === 1 && report.orphanAnchors.items[0]?.id === "dddddddd");
  check("computeReport: the synthetic test/-fixture anchor ffffffff never reaches orphanAnchors",
    !report.orphanAnchors.items.some((a) => a.id === "ffffffff"));
  check("computeReport: eeeeeeee (no inbound anchor) IS an orphan record, marked advisory",
    report.orphanRecords.items.some((r) => r.id === "eeeeeeee") && report.orphanRecords.advisory === true);
  // 4 real records (aaaaaaaa via adr, bbbbbbbb via investigations, eeeeeeee + 12345678 via decisions) —
  // template.md excluded despite living in docs/adr alongside a real record.
  check("computeReport: template.md is never treated as a record",
    !report.orphanRecords.items.some((r) => r.path.endsWith("template.md")) && report.recordCount === 4);
  // Card ad3a9a85: the split-anchor shape (keyword and id on different lines) is invisible to every other
  // check (no valid ANCHOR_RE match exists on either line) — brokenAnchors is the ONLY one that sees it.
  check("computeReport: the split anchor is flagged as a broken anchor, exactly once",
    report.brokenAnchors.count === 1 && report.brokenAnchors.items[0]?.file === "packages/daemon/src/fixture.ts");
  check("computeReport: the split anchor never surfaces as an orphan anchor (no valid id was ever extracted)",
    !report.orphanAnchors.items.some((a) => a.id === "cccccccc"));
  check("computeReport: a well-formed anchor (e.g. aaaaaaaa) is never counted as broken",
    !report.brokenAnchors.items.some((b) => b.file === "packages/daemon/src/fixture.ts" && b.line === 3));
  // Card d0d0401b: 12345678 exceeds PER_RECORD_MAX_BYTES and must be flagged; the small, well-under-cap
  // records (aaaaaaaa/bbbbbbbb/eeeeeeee) must not be.
  check("computeReport: the oversized record 12345678 is flagged, with its measured size and the shared cap",
    report.oversizedRecords.count === 1 && report.oversizedRecords.items[0]?.id === "12345678"
    && report.oversizedRecords.items[0]?.bytes > PER_RECORD_MAX_BYTES && report.oversizedRecords.maxBytes === PER_RECORD_MAX_BYTES);
  check("computeReport: the small records are never flagged as oversized",
    !report.oversizedRecords.items.some((r) => ["aaaaaaaa", "bbbbbbbb", "eeeeeeee"].includes(r.id)));
  // Guard class is a SHAPE classification (length <= GUARD_MAX_LINES && has an anchor), independent of
  // whether that anchor resolves — all three 1-line anchors (aaaaaaaa, bbbbbbbb, and the orphaned
  // dddddddd) are guard-class-shaped even though dddddddd is separately flagged as an orphan anchor.
  check("computeReport: all 3 one-line anchors are guard-class-shaped, and none is flagged as unanchored-long",
    report.guardClassBlocks.count === 3 && report.unanchoredLongBlocks.items.every((b) => b.length >= 15));

  // Card ad3a9a85 DoD-3: does the LIVE per-file hook also surface a broken anchor, or only the CLI scan?
  // Answer: both — computeFileReport runs the same per-line findBrokenAnchors over the one file's content.
  {
    const fixturePath = path.join(REPO, "packages", "daemon", "src", "fixture.ts");
    const fileReport = computeFileReport(REPO, fixturePath, fs.readFileSync(fixturePath, "utf8"));
    check("computeFileReport (the live PostToolUse hook path): the split anchor is flagged too",
      fileReport?.brokenAnchors?.length === 1);
    // oversizedRecords is deliberately NOT part of computeFileReport (records live under docs/, outside
    // SOURCE_ROOTS — see this file's own header) — confirm the hook-shaped report has no such key at all,
    // rather than silently reporting zero and looking like it checked.
    check("computeFileReport: oversizedRecords is not a key on the hook-shaped report (CLI-scan only, by design)",
      !("oversizedRecords" in fileReport));
  }

  // DoD-3: N is configurable — a smaller minLines flags what the default doesn't, a larger one flags less.
  const strict = computeReport(REPO, { minLines: 5 });
  const lax = computeReport(REPO, { minLines: 100 });
  check("computeReport: minLines is configurable (5 flags >= the default-15 count)", strict.unanchoredLongBlocks.count >= report.unanchoredLongBlocks.count);
  check("computeReport: minLines is configurable (100 flags nothing here)", lax.unanchoredLongBlocks.count === 0);
  check("computeReport: an invalid minLines (0) falls back to DEFAULT_MIN_LINES", computeReport(REPO, { minLines: 0 }).minLines === DEFAULT_MIN_LINES);
  check("computeReport: omitting minLines uses DEFAULT_MIN_LINES", computeReport(REPO).minLines === DEFAULT_MIN_LINES);
} finally {
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — comment-anchor-lint.mjs correctly flags unanchored long blocks and orphan anchors, "
    + "treats orphan records as advisory-only, never flags the guard class (isolated or merged-adjacent), "
    + "excludes test/-fixture noise from the sweep, honors a configurable minLines, flags a split (line-"
    + "wrapped) anchor in both the CLI scan and the live per-file hook, and flags a record over "
    + "PER_RECORD_MAX_BYTES (read from decision-records.mjs, not a hand-copied number)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
