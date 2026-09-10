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
//   8. collidingRecords (card a4b83fb7): two record files sharing an id are flagged, naming every
//      candidate AND which one currently wins — replicating decision-records.mjs's own `resolveRecord()`
//      winner pick (store precedence, then alphabetically-first within the winning store), not just
//      "same id, arbitrary member". CLI-scan only, same ground as oversizedRecords.
//   9. sigil namespace (card 969b0e1c): a `@decision sha:<id>` anchor citing a REAL, verified git commit
//      resolves like any other anchor; the SAME 8 hex characters under the ORIGINAL bare `@decision <id>`
//      form still resolve as a board-card id, never SHA-verified; and a `sha:`-sigil'd anchor whose id is
//      NOT a real commit in this repo is flagged as orphan even when a same-named record file exists
//      (the refuse-rather-than-fall-through gate, mirroring decision-records.mjs's own `resolveRecord`).
//  10. overlongAnchorIds (card afc56dcc): a same-line `@decision` (bare or `sha:`-sigil'd) followed by 9+
//      hex chars — the shape a verbatim 40-hex `git blame`/`git log` paste produces — is flagged, in both
//      the CLI scan and the live per-file hook; a well-formed 8-hex anchor (bare or sigil'd), a too-short
//      same-line id, the EOL-wrap shape (a DIFFERENT defect — brokenAnchors' own concern), and mid-line
//      mentions of the literal token are all confirmed NOT flagged.
//  11. sigilSpaceAnchors (card e708670b): a same-line `sha` sigil with whitespace adjacent to its colon on
//      EITHER side or both (e.g. "@decision sha: deadbeef", "@decision sha :deadbeef", or
//      "@decision sha : deadbeef") — the SECOND defect shape card afc56dcc named but whose original fix
//      (overlongAnchorIds) never covered, widened mid-review after the lead independently re-verified
//      that the space-before-colon shape was ALSO silent and NOT caught by the first (after-only) version
//      — is flagged, in both the CLI scan and the live per-file hook; a well-formed sigil'd anchor (no
//      space either side), a well-formed bare anchor, a too-short same-line id (either side), the EOL-wrap
//      shape, and mid-line mentions of the literal token are all confirmed NOT flagged.
//  12. bareCommitAnchors (card a2fc4031): a BARE `@decision <id>` (never `sha:`-sigil'd) whose id ALSO
//      resolves as a real commit object in this repo's git history — the exact silent mis-anchor
//      `CLAUDE.md`'s comment-taxonomy convention forbids (a bare id always means a board card; the commit
//      id-space requires the `sha:` sigil, card 969b0e1c) — is flagged, in both the CLI scan and the live
//      per-file hook; the SAME id in correctly-sigil'd `sha:` form, and a bare id that is NOT a real
//      commit, are both confirmed NOT flagged.
// Run: `node test/comment-anchor-lint.mjs` from packages/daemon (no build, no LOOM_HOME needed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import {
  extractCommentBlocks,
  findFileAnchors,
  findBrokenAnchors,
  findOverlongAnchorIds,
  findSigilSpaceAnchors,
  findOversizedRecords,
  findCollidingRecords,
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

// --- doc-comment boundary split (card 01e09f28 — anchoring the first of two abutting doc comments used to
// make the second vanish from unanchoredLongBlocks) ------------------------------------------------------

{
  // A `*/` closing a `/** */` comment, immediately followed (no blank line) by a SECOND `/** */` comment
  // starting — the shape memory `extraction-adjacent-anchor-merges-hides-next-block` measured: anchoring
  // only the FIRST doc must never hide the SECOND. Two blocks, not one merged run; each carries only its
  // OWN anchor.
  const firstDoc = ["/**", " * @decision aaaaaaaa — a short anchored doc, the convention's target state", " */"];
  const secondDoc = [
    "/**",
    ...Array.from({ length: 16 }, (_, i) => ` * regrowing narrative line ${i}, no anchor anywhere in this doc`),
    " */",
  ];
  const lines = [...firstDoc, ...secondDoc, "function f() {}"];
  const blocks = extractCommentBlocks(lines);
  check("doc-comment boundary: an anchored /** */ immediately followed by a second /** */ splits into TWO blocks (not one merged run)",
    blocks.length === 2);
  check("doc-comment boundary: the first block carries ONLY its own anchor",
    blocks[0]?.anchorIds.length === 1 && blocks[0].anchorIds.includes("aaaaaaaa"));
  check("doc-comment boundary: the second block carries NO anchor of its own",
    blocks[1]?.anchorIds.length === 0);
  check("doc-comment boundary: the second block is long enough to flag on its own (>= DEFAULT_MIN_LINES)",
    blocks[1]?.length >= DEFAULT_MIN_LINES);
  check("doc-comment boundary: the second block starts exactly where the second /** opens",
    blocks[1]?.startLine === firstDoc.length + 1);

  // Live per-file hook path (computeFileReport) must ALSO see the second doc as an independent,
  // unanchored, long block — not swallowed by the first doc's anchor.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-doc-boundary-split-"));
  try {
    fs.mkdirSync(path.join(dir, "packages", "daemon", "src"), { recursive: true });
    const filePath = path.join(dir, "packages", "daemon", "src", "fixture.ts");
    const content = lines.join("\n");
    fs.writeFileSync(filePath, content);
    const fileReport = computeFileReport(dir, filePath, content);
    check("doc-comment boundary (live hook path): the second, unanchored doc IS reported in unanchoredLongBlocks",
      fileReport?.unanchoredLongBlocks?.length === 1 && fileReport.unanchoredLongBlocks[0]?.startLine === firstDoc.length + 1);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

{
  // Positive control, reconstructed from the real specimen (memory `extraction-adjacent-anchor-merges-
  // hides-next-block`, card 5b001dde's own tranche-19 finding): `handleGiveUpExhausted`'s doc (card
  // ccb407eb) and `suppressMootParkNotice`'s doc (card 085d9422) in sessions/service.ts sat back-to-back.
  // FIRST_DOC below is the real, currently-committed compressed anchor comment (verbatim, `service.ts`
  // lines 7131-7135 as of HEAD `8d9fe59d`). SECOND_DOC_LINES is the real, PRE-extraction narrative for
  // `suppressMootParkNotice` — verbatim, from `git show fb53a9f6:packages/daemon/src/sessions/service.ts`
  // lines 7177-7223 (before this card's own tranche compressed it too) — reconstructing the exact
  // mid-tranche shape: first doc already compressed + anchored, second still long + unanchored, abutting.
  const firstDoc = [
    "  /**",
    "   * @decision ccb407eb — handleGiveUpExhausted's give-up terminal-branch policy: never-discard,",
    "   * re-mint-then-park (giveUpHeldUntil forces the HELD branch, also fixing a durable-record gap),",
    "   * AUDITABLE rootMsgId chain, and \"system\"-sender safety — fully recorded, docs/decisions/ccb407eb-*.md",
    "   */",
  ];
  const secondDocLines = ["  /**","   * Card 085d9422 — a MOOT `[loom:redelivery-parked]` notice costs far more than its own ~1.1KB: the","   * owner measured FOUR duplicate/moot notices in one 40-minute window, each forcing a full manager","   * verification turn (worker_status + worker_transcript + reasoning, ~2-5K tokens) to learn what THIS","   * check can rule out for free — suppressing one is worth roughly 10x shortening it. Called at the PARK","   * site, BEFORE the notice is built, so a suppressed case costs nothing beyond this query.","   *","   * THREE checks, each a real way this exact notice goes stale before it's even sent — NOT the notice's","   * OWN re-mint recursion, which this card's own investigation found is already safe (see","   * give-up-exhausted-durable.mjs scenario (7): the sentinel `\"system\"` sender never resolves to a live","   * session, so a notice that itself gives up terminates with zero follow-on dispatch, proven both ways).","   * That was this card's OWN leading hypothesis for the duplication and it does NOT hold — measured here","   * instead:","   *  (1) DUPLICATE PARK FOR THE SAME ROOT — established by this card's own reproduction (see the card body","   *      for the exact repro): `enqueueDurableMessage`'s auto-join (`hasAmbiguousMatch`, card 4a0af485)","   *      lets a SECOND, independent dispatch of matching content join an existing chain's `rootMsgId` —","   *      but the join only shares the LABEL; each dispatch still runs its OWN independent chainDepth","   *      counter and can reach PARK entirely on its own. Two independently-parking chains sharing one","   *      rootMsgId produce two BYTE-IDENTICAL notices (neither carrying a possible-duplicate tag, since","   *      each is a fresh, self-rooted send to the sender, not a re-mint of the other) — exactly the \"two","   *      byte-identical pairs\" this card's measured evidence describes. Once any chain has already parked","   *      this root, a second parking of the SAME root tells the sender nothing new.","   *  (2) SUPERSEDED BY A NEWER DIRECTIVE — mirrors `staleDirectiveProjection`'s own \"latest wins\" rule","   *      (mcp/orchestration.ts): if `sender` has since dispatched ANOTHER `message_worker`/`redirect_worker`","   *      to this SAME `recipientId` after the one that produced this `rootMsgId`, that newer directive is","   *      now the one worker_list/worker_status tracks — `parkedDirective` for the OLD root is no longer","   *      reachable from there either, so a notice about it describes a directive the sender has already","   *      moved past.","   *  (3) ALREADY CONFIRMED-AFTER-PARK — a late confirming hook (`handleGiveUpConfirmed`) can resolve this","   *      exact rootMsgId to `confirmed-after-park` in a narrow race before this PARK branch's own notice","   *      goes out; that path already sends its own `[loom:redelivery-confirmed]` retraction, so a","   *      `[loom:redelivery-parked]` notice for a chain already known to have landed would just contradict","   *      it moments later.","   *","   * Deliberately does NOT check \"does the recipient's transcript already contain the message\" (the","   * card's third candidate): no cross-session transcript-CONTENT read exists at this layer for the","   * general sender (see `canCheckRecipient`'s own honesty split in the caller, just below), and (3) above","   * already covers \"already landed\" via the durable confirmed-after-park signal for the one case that's","   * checkable without one. Also deliberately does NOT add a settle-delay before evaluating these checks","   * (the card floated one, since a late-arriving confirmation can beat a notice sent immediately) — that","   * would delay reporting a message that is GENUINELY lost, which the card's own DoD calls the","   * load-bearing half; the (3) check plus `handleGiveUpConfirmed`'s existing retraction already cover the","   * \"landed a little late\" case without adding latency to the \"actually lost\" case.","   *","   * Never suppresses a genuinely first, unresolved, un-superseded park — a message that is actually lost","   * still gets reported, at the same latency as before this card.","   */"];
  check("positive control setup: the real SECOND_DOC specimen is 47 lines, matching the measured fb53a9f6 range",
    secondDocLines.length === 47);
  check("positive control setup: the real SECOND_DOC specimen carries no @decision anchor of its own (this IS the defect shape)",
    findFileAnchors(secondDocLines).length === 0);

  const lines = [...firstDoc, ...secondDocLines, "  private suppressMootParkNotice() {}"];
  const blocks = extractCommentBlocks(lines);
  check("positive control (ccb407eb/085d9422 shape): splits into TWO blocks, not one merged run",
    blocks.length === 2);
  check("positive control: the first (compressed, real) block carries ONLY the ccb407eb anchor",
    blocks[0]?.anchorIds.length === 1 && blocks[0].anchorIds.includes("ccb407eb"));
  check("positive control: the second (real, pre-extraction) block carries NO anchor and is well above minLines",
    blocks[1]?.anchorIds.length === 0 && blocks[1]?.length >= DEFAULT_MIN_LINES);
}

{
  const lines = ["// @decision 11111111 — first  // @decision 22222222 — second"];
  const anchors = findFileAnchors(lines);
  check("findFileAnchors: a single line carrying two anchors yields both", anchors.length === 2
    && anchors.some((a) => a.id === "11111111") && anchors.some((a) => a.id === "22222222"));
}

// --- sigil namespace (card 969b0e1c): findFileAnchors distinguishes ns=card (bare) from ns=sha (sigil'd) ---

{
  const lines = ["// @decision 1974444d — bare form, unchanged from before this card"];
  const anchors = findFileAnchors(lines);
  check("sigil: a bare 8-hex anchor parses as ns=card", anchors.length === 1 && anchors[0].ns === "card" && anchors[0].id === "1974444d");
}

{
  const lines = ["// @decision sha:1974444d — sigil'd form keys a commit, never a card"];
  const anchors = findFileAnchors(lines);
  check("sigil: a sha:-sigil'd anchor parses as ns=sha, with the sigil stripped from id",
    anchors.length === 1 && anchors[0].ns === "sha" && anchors[0].id === "1974444d");
}

{
  // The SAME 8 hex characters, once bare and once sigil'd, on the SAME line — must yield two DISTINCT
  // anchors (different namespaces), never be deduped or conflated as "the same id twice".
  const lines = ["// @decision 1974444d — bare  // @decision sha:1974444d — sigil'd"];
  const anchors = findFileAnchors(lines);
  check("sigil: bare and sigil'd forms of the SAME hex on one line yield TWO distinct anchors",
    anchors.length === 2 && anchors.some((a) => a.ns === "card") && anchors.some((a) => a.ns === "sha"));
}

{
  // Case-insensitivity of the sigil itself (the regex carries the `i` flag) — "SHA:" must match too.
  const lines = ["// @decision SHA:deadbeef — uppercase sigil keyword"];
  const anchors = findFileAnchors(lines);
  check("sigil: the 'sha:' keyword is case-insensitive, matching the rest of ANCHOR_RE's own case handling",
    anchors.length === 1 && anchors[0].ns === "sha" && anchors[0].id === "deadbeef");
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

// --- findOverlongAnchorIds (card afc56dcc — the verbatim-40-hex-paste silent-failure defect) -----------

{
  // The exact real-world shape the card names: a verbatim 40-hex `git blame`/`git log` paste under the
  // `sha:` sigil. RED/GREEN: findFileAnchors (the pre-existing check) finds NOTHING — this IS the defect
  // card 969b0e1c's grammar made newly likely — and findOverlongAnchorIds flags it.
  const lines = ["// @decision sha:1234567890abcdef1234567890abcdef12345678 — a pasted 40-hex sha"];
  const anchors = findFileAnchors(lines);
  const overlong = findOverlongAnchorIds(lines);
  check("40-hex sha paste: findFileAnchors (the pre-existing check) finds NOTHING — this IS the defect",
    anchors.length === 0);
  check("40-hex sha paste: findOverlongAnchorIds flags it, exactly once, as ns=sha, with the full match text",
    overlong.length === 1 && overlong[0].line === 1 && overlong[0].ns === "sha"
    && overlong[0].match === "@decision sha:1234567890abcdef1234567890abcdef12345678");
}

{
  // The bare (non-sigil'd) equivalent — an over-long hex run with no `sha:` prefix at all.
  const lines = ["// @decision 1234567890 — a bare over-long hex run, no sigil"];
  const overlong = findOverlongAnchorIds(lines);
  check("bare over-long hex run: findOverlongAnchorIds flags it, as ns=card",
    overlong.length === 1 && overlong[0].ns === "card" && overlong[0].match === "@decision 1234567890");
}

{
  // Boundary: exactly 9 hex chars (the pattern's own lower bound) must flag; exactly 8 (a well-formed id)
  // must not — proves the {9,} boundary is where the card's DoD-1 said it should be, not off by one.
  check("boundary: 9 hex chars flags", findOverlongAnchorIds(["// @decision 123456789 — nine hex chars"]).length === 1);
  check("boundary: 8 hex chars (well-formed) does not flag", findOverlongAnchorIds(["// @decision 12345678 — eight hex chars"]).length === 0);
}

{
  // Positive control: well-formed anchors (bare AND sha:-sigil'd) must never be flagged as overlong.
  const bareWellFormed = ["// @decision 725dc89a — the prohibition, all on one line"];
  const sigilWellFormed = ["// @decision sha:725dc89a — the prohibition, all on one line"];
  check("well-formed bare anchor: findOverlongAnchorIds reports nothing", findOverlongAnchorIds(bareWellFormed).length === 0);
  check("well-formed sha:-sigil'd anchor: findOverlongAnchorIds reports nothing", findOverlongAnchorIds(sigilWellFormed).length === 0);
  check("well-formed bare anchor: findFileAnchors still finds it (sanity)", findFileAnchors(bareWellFormed).length === 1);
  check("well-formed sha:-sigil'd anchor: findFileAnchors still finds it (sanity)", findFileAnchors(sigilWellFormed).length === 1);
}

{
  // Scope boundary: a same-line id that's merely too SHORT is a DIFFERENT, out-of-scope shape (mirrors the
  // identical carve-out already tested for findBrokenAnchors above) — never flagged as overlong.
  const lines = ["// @decision 12ab — too short to be a real id"];
  check("malformed same-line id, too short (out of this check's scope): findOverlongAnchorIds does NOT flag it",
    findOverlongAnchorIds(lines).length === 0);
}

{
  // Scope boundary: the EOL-wrap shape is brokenAnchors' concern, not this check's — the keyword has
  // nothing after it on its own line, so there's no hex run for this pattern to even see.
  const lines = [" * @decision", " * 725dc89a — the prohibition"];
  check("EOL-wrap shape (brokenAnchors' concern, a DIFFERENT defect): findOverlongAnchorIds does NOT flag it",
    findOverlongAnchorIds(lines).length === 0);
  check("EOL-wrap shape: findBrokenAnchors DOES flag it (sanity — confirms the two checks partition correctly)",
    findBrokenAnchors(lines).length === 1);
}

{
  // Measured false-positive guard, same shape as the existing brokenAnchors negative control above: mid-
  // line mentions of the literal token "@decision" — prose, a regex-literal definition, a message string —
  // must never be flagged, since none of them carry a REAL 9+-hex run immediately after real whitespace.
  const lines = [
    "/** `@decision <id>` — the convention's own canonical example syntax, written as prose. */",
    "const ANCHOR_RE = /@decision\\s+([0-9a-f]{8})\\b/gi; // a regex LITERAL containing the bare token",
    "lines.push(`  - ${file}:${line} — @decision ${id}`); // a message string, not an anchor",
  ];
  check("mid-line mentions of the token are never flagged as overlong", findOverlongAnchorIds(lines).length === 0);
}

// --- findSigilSpaceAnchors (card e708670b — the "sha: deadbeef" / "sha :deadbeef" silent-failure --------
// defect, on EITHER side of the sigil's colon)

{
  // The exact real-world shape the card names first: a space AFTER the sigil's colon, before its 8-hex id.
  // RED/GREEN: findFileAnchors (the pre-existing check) finds NOTHING — this IS the defect card afc56dcc
  // was filed to end but whose shipped fix (overlongAnchorIds) never covered — and findSigilSpaceAnchors
  // flags it.
  const lines = ["// @decision sha: deadbeef — a space after the sigil's colon"];
  const anchors = findFileAnchors(lines);
  const spaced = findSigilSpaceAnchors(lines);
  check("sigil space (after colon): findFileAnchors (the pre-existing check) finds NOTHING — this IS the defect",
    anchors.length === 0);
  check("sigil space (after colon): findSigilSpaceAnchors flags it, exactly once, with the full match text",
    spaced.length === 1 && spaced[0].line === 1 && spaced[0].match === "@decision sha: deadbeef");
}

{
  // The lead's own re-verification, card e708670b: a space BEFORE the sigil's colon — a shape the FIRST
  // version of this check (after-the-colon-only) did NOT catch, confirmed independently by the lead in
  // the same session that approved widening this check to cover it. RED/GREEN against the widened pattern.
  const lines = ["// @decision sha :deadbeef — a space before the sigil's colon"];
  const anchors = findFileAnchors(lines);
  const spaced = findSigilSpaceAnchors(lines);
  check("sigil space (before colon): findFileAnchors (the pre-existing check) finds NOTHING — this IS the defect",
    anchors.length === 0);
  check("sigil space (before colon): findSigilSpaceAnchors flags it, exactly once, with the full match text",
    spaced.length === 1 && spaced[0].line === 1 && spaced[0].match === "@decision sha :deadbeef");
}

{
  // Whitespace on BOTH sides of the colon at once — must also flag, exactly once.
  const lines = ["// @decision sha : deadbeef — whitespace on both sides of the colon"];
  const spaced = findSigilSpaceAnchors(lines);
  check("sigil space (both sides): findSigilSpaceAnchors flags it, exactly once, with the full match text",
    spaced.length === 1 && spaced[0].match === "@decision sha : deadbeef");
}

{
  // A double space, and a tab, on EITHER side — must all flag; proves \s+ (not a fixed single space) is
  // doing the matching on both sides of the alternation, not just the after-colon side.
  const doubleAfter = ["// @decision sha:  deadbeef — two spaces after the sigil"];
  const doubleBefore = ["// @decision sha  :deadbeef — two spaces before the sigil"];
  const tabAfter = ["// @decision sha:\tdeadbeef — a tab after the sigil"];
  const tabBefore = ["// @decision sha\t:deadbeef — a tab before the sigil"];
  check("sigil space (double space, after): findSigilSpaceAnchors flags it", findSigilSpaceAnchors(doubleAfter).length === 1);
  check("sigil space (double space, before): findSigilSpaceAnchors flags it", findSigilSpaceAnchors(doubleBefore).length === 1);
  check("sigil space (tab, after): findSigilSpaceAnchors flags it", findSigilSpaceAnchors(tabAfter).length === 1);
  check("sigil space (tab, before): findSigilSpaceAnchors flags it", findSigilSpaceAnchors(tabBefore).length === 1);
}

{
  // The space-AND-overlong combination: a verbatim 40-hex paste that's ALSO separated from the sigil by a
  // space. One pattern catches both malformations at once (SIGIL_SPACE_RE matches 8+ hex chars, not just
  // exactly 8) — must flag as a sigil-space defect (the space alone already makes this unresolvable).
  const lines = ["// @decision sha: 1234567890abcdef1234567890abcdef12345678 — space AND overlong"];
  const spaced = findSigilSpaceAnchors(lines);
  check("sigil space + overlong combination: findSigilSpaceAnchors flags it",
    spaced.length === 1 && spaced[0].match === "@decision sha: 1234567890abcdef1234567890abcdef12345678");
}

{
  // Boundary: a space followed OR preceded by fewer than 8 hex chars is a DIFFERENT, out-of-scope shape
  // (too short) — mirrors the identical carve-out already tested for overlongAnchorIds/brokenAnchors above.
  const afterTooShort = ["// @decision sha: dead — too short to be a real id, even with the space"];
  const beforeTooShort = ["// @decision sha :dead — too short to be a real id, even with the space"];
  check("sigil space + too-short id, after (out of this check's scope): findSigilSpaceAnchors does NOT flag it",
    findSigilSpaceAnchors(afterTooShort).length === 0);
  check("sigil space + too-short id, before (out of this check's scope): findSigilSpaceAnchors does NOT flag it",
    findSigilSpaceAnchors(beforeTooShort).length === 0);
}

{
  // Positive control: well-formed anchors (bare AND sha:-sigil'd, no space) must never be flagged.
  const bareWellFormed = ["// @decision 725dc89a — the prohibition, all on one line"];
  const sigilWellFormed = ["// @decision sha:725dc89a — the prohibition, all on one line"];
  check("well-formed bare anchor: findSigilSpaceAnchors reports nothing", findSigilSpaceAnchors(bareWellFormed).length === 0);
  check("well-formed sha:-sigil'd anchor (no space): findSigilSpaceAnchors reports nothing", findSigilSpaceAnchors(sigilWellFormed).length === 0);
  check("well-formed bare anchor: findFileAnchors still finds it (sanity)", findFileAnchors(bareWellFormed).length === 1);
  check("well-formed sha:-sigil'd anchor: findFileAnchors still finds it (sanity)", findFileAnchors(sigilWellFormed).length === 1);
}

{
  // Scope boundary: the EOL-wrap shape is brokenAnchors' concern, not this check's.
  const lines = [" * @decision", " * 725dc89a — the prohibition"];
  check("EOL-wrap shape (brokenAnchors' concern, a DIFFERENT defect): findSigilSpaceAnchors does NOT flag it",
    findSigilSpaceAnchors(lines).length === 0);
}

{
  // Measured false-positive guard, same shape as the existing negative controls above: mid-line mentions of
  // the literal token "@decision" must never be flagged — none of them carry a real "sha:" sigil followed
  // by whitespace and a real hex run.
  const lines = [
    "/** `@decision <id>` — the convention's own canonical example syntax, written as prose. */",
    "const ANCHOR_RE = /@decision\\s+([0-9a-f]{8})\\b/gi; // a regex LITERAL containing the bare token",
    "lines.push(`  - ${file}:${line} — @decision ${id}`); // a message string, not an anchor",
  ];
  check("mid-line mentions of the token are never flagged as a sigil-space anchor", findSigilSpaceAnchors(lines).length === 0);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-oversized-records-"));
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

// --- findCollidingRecords (card a4b83fb7) --------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-colliding-records-"));
  try {
    fs.mkdirSync(path.join(dir, "docs", "adr"), { recursive: true });
    fs.mkdirSync(path.join(dir, "docs", "decisions"), { recursive: true });
    fs.mkdirSync(path.join(dir, "docs", "investigations", "cccccccc-third-collider"), { recursive: true });

    // aaaaaaaa: a SINGLE record, no collision — must never appear in the result at all.
    fs.writeFileSync(path.join(dir, "docs", "decisions", "aaaaaaaa-solo.md"), "# aaaaaaaa\n\nno collision.\n");

    // bbbbbbbb: TWO records, both in docs/decisions — resolveRecord's own bare `.sort()` picks
    // "bbbbbbbb-alpha-first.md" over "bbbbbbbb-zzz-later.md" (alphabetically first wins WITHIN a store).
    fs.writeFileSync(path.join(dir, "docs", "decisions", "bbbbbbbb-zzz-later.md"), "# bbbbbbbb (loses)\n");
    fs.writeFileSync(path.join(dir, "docs", "decisions", "bbbbbbbb-alpha-first.md"), "# bbbbbbbb (wins)\n");

    // cccccccc: THREE-way collision across all three stores — proves STORE PRECEDENCE beats alphabetical
    // filename order: "docs/adr" must win even though its own filename ("zzz-adr") would sort AFTER both
    // the docs/decisions file ("aaa-decisions") and the investigations directory name alphabetically.
    fs.writeFileSync(path.join(dir, "docs", "adr", "cccccccc-zzz-adr.md"), "# cccccccc (adr, must win)\n");
    fs.writeFileSync(path.join(dir, "docs", "decisions", "cccccccc-aaa-decisions.md"), "# cccccccc (decisions, must lose)\n");
    fs.writeFileSync(path.join(dir, "docs", "investigations", "cccccccc-third-collider", "findings.md"), "# cccccccc (investigations, must lose)\n");

    const colliding = findCollidingRecords(dir);
    const byId = Object.fromEntries(colliding.map((c) => [c.id, c]));

    check("findCollidingRecords: a solo record (no collision) never appears in the result",
      !("aaaaaaaa" in byId) && colliding.length === 2);
    check("findCollidingRecords: a same-store collision picks the alphabetically-first filename as the winner",
      byId.bbbbbbbb?.winnerPath === "docs/decisions/bbbbbbbb-alpha-first.md");
    check("findCollidingRecords: the same-store loser is named as dark, exactly once",
      byId.bbbbbbbb?.darkPaths.length === 1 && byId.bbbbbbbb.darkPaths[0] === "docs/decisions/bbbbbbbb-zzz-later.md");
    check("findCollidingRecords: a cross-store collision picks by STORE PRECEDENCE (docs/adr), "
      + "never by alphabetically-first filename across stores",
      byId.cccccccc?.winnerPath === "docs/adr/cccccccc-zzz-adr.md");
    check("findCollidingRecords: BOTH losers (docs/decisions AND docs/investigations) are named as dark",
      byId.cccccccc?.darkPaths.length === 2
      && byId.cccccccc.darkPaths.includes("docs/decisions/cccccccc-aaa-decisions.md")
      && byId.cccccccc.darkPaths.includes("docs/investigations/cccccccc-third-collider/findings.md"));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- bareCommitAnchors (card a2fc4031) -------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-bare-commit-anchor-"));
  try {
    fs.mkdirSync(path.join(dir, "packages", "daemon", "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "SEED.md"), "seed\n");
    commitAll(dir, "seed", "-c user.email=bare-commit-fixture@loom -c user.name=bare-commit-fixture");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim().slice(0, 8);

    const srcPath = path.join(dir, "packages", "daemon", "src", "fixture.ts");

    // RED/GREEN: a BARE @decision anchor whose id is a REAL commit sha — the exact defect card a2fc4031
    // exists to catch. CLAUDE.md: a bare id always means a board card; the commit id-space REQUIRES the
    // "sha:" sigil (card 969b0e1c). Written TWICE (two sites) to also prove sites aren't deduped by id —
    // mirrors the originating specimen, which cited the same sha at two separate anchor sites.
    fs.writeFileSync(srcPath, `// @decision ${sha} — bare form citing a real commit, site one\n\nconst x = 1;\n\n// @decision ${sha} — bare form citing a real commit, site two\n`);
    const reportBare = computeReport(dir, { minLines: 15 });
    check("bareCommitAnchors: a bare anchor whose id is a real commit sha is flagged, once per site (count 2)",
      reportBare.bareCommitAnchors?.count === 2
      && reportBare.bareCommitAnchors.items.every((a) => a.id === sha && a.file === "packages/daemon/src/fixture.ts"));
    check("bareCommitAnchors: the two sites report their own distinct line numbers",
      reportBare.bareCommitAnchors.items[0]?.line === 1 && reportBare.bareCommitAnchors.items[1]?.line === 5);

    // GREEN: the SAME id, in the correctly-sigil'd sha: form — must NOT be flagged.
    fs.writeFileSync(srcPath, `// @decision sha:${sha} — sigil'd form, correctly namespaced\n`);
    const reportSigiled = computeReport(dir, { minLines: 15 });
    check("bareCommitAnchors: the SAME id in sha: form is not flagged, count 0",
      reportSigiled.bareCommitAnchors?.count === 0);

    // Negative control: a bare anchor whose id is NOT a real commit must not be flagged either — proves
    // the check discriminates on "is a real commit", not just "is a bare anchor".
    fs.writeFileSync(srcPath, "// @decision deadbeef — bare form, not a real commit in this repo\n");
    const reportNotCommit = computeReport(dir, { minLines: 15 });
    check("bareCommitAnchors: a bare anchor whose id is NOT a real commit is not flagged, count 0",
      reportNotCommit.bareCommitAnchors?.count === 0);

    // computeFileReport (the live PostToolUse hook path) must ALSO catch it, at authoring time — same
    // ground as brokenAnchors/overlongAnchorIds/sigilSpaceAnchors above.
    fs.writeFileSync(srcPath, `// @decision ${sha} — bare form citing a real commit\n`);
    const fileReportBare = computeFileReport(dir, srcPath, fs.readFileSync(srcPath, "utf8"));
    check("computeFileReport (the live PostToolUse hook path): the bare-commit anchor is flagged too",
      fileReportBare?.bareCommitAnchors?.length === 1 && fileReportBare.bareCommitAnchors[0]?.id === sha
      && fileReportBare.bareCommitAnchors[0]?.line === 1);

    fs.writeFileSync(srcPath, `// @decision sha:${sha} — sigil'd form, correctly namespaced\n`);
    const fileReportSigiled = computeFileReport(dir, srcPath, fs.readFileSync(srcPath, "utf8"));
    check("computeFileReport: the sigil'd form of the same id is not flagged",
      fileReportSigiled?.bareCommitAnchors?.length === 0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- computeReport: fixture repo, all seven checks end to end ------------------------------------------

const REPO = path.join(os.tmpdir(), `loom-comment-anchor-lint-${Date.now()}-${process.pid}`);
try {
  fs.mkdirSync(path.join(REPO, "packages", "daemon", "src"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "packages", "daemon", "test"), { recursive: true }); // must be EXCLUDED from the sweep
  fs.mkdirSync(path.join(REPO, "docs", "adr"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "docs", "decisions"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "docs", "investigations", "bbbbbbbb-an-investigation"), { recursive: true });

  // Card 969b0e1c: a REAL git repo (not just a bare `.git` marker — computeReport doesn't need one, but
  // `verifyCommitSha` genuinely shells out to `git rev-parse`) so there's a real, verifiable commit sha to
  // test the sigil's SHA-verification gate against. One seed commit is enough; nothing else in this
  // fixture needs to be tracked.
  execFileSync("git", ["init", "-q"], { cwd: REPO });
  fs.writeFileSync(path.join(REPO, "SEED.md"), "seed\n");
  commitAll(REPO, "seed", "-c user.email=lint-fixture@loom -c user.name=lint-fixture");
  const REAL_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim().slice(0, 8);

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
  // Card afc56dcc DoD-4: built as a function of `includeOverlong` so a genuine BEFORE/AFTER comparison can
  // run against otherwise-byte-identical fixture content — the only permitted difference between the two
  // reports is `overlongAnchorIds` itself; every other field (orphanAnchors, brokenAnchors, collidingRecords,
  // oversizedRecords, totalAnchorSites) must read IDENTICAL in both.
  const buildSrc = (includeOverlong) => [
    "const before = 1;",
    "",
    "// @decision aaaaaaaa — resolved via docs/adr, never flagged as orphan",
    "",
    "// @decision bbbbbbbb — resolved via docs/investigations, never flagged as orphan",
    "",
    "// @decision dddddddd — resolves to nothing, must be flagged as an orphan anchor",
    "",
    `// @decision sha:${REAL_SHA} — card 969b0e1c: a genuine verified-commit record, must resolve`,
    "",
    "// @decision deadc0de — card 969b0e1c: bare form is a CARD id, never SHA-verified",
    "",
    "// @decision sha:deadc0de — card 969b0e1c: sigil'd form IS SHA-verified; deadc0de is not a real commit here",
    "",
    longUnanchored,
    "",
    longAnchored,
    "",
    splitAnchor,
    "",
    // Card afc56dcc: a verbatim 40-hex sha paste — invisible to ANCHOR_RE (so it can never reach
    // orphanAnchors or count toward totalAnchorSites), invisible to brokenAnchors (a DIFFERENT defect
    // shape), and must be the ONLY thing that moves overlongAnchorIds off zero in this fixture. Placed
    // LAST (after every other anchor/block) so its inclusion shifts no EARLIER line number — the
    // before/after comparison below diffs `brokenAnchors`/`orphanAnchors` items (including their line
    // numbers) and must see them byte-identical, not merely equal in count.
    ...(includeOverlong ? [
      "// @decision sha:1234567890abcdef1234567890abcdef12345678 — card afc56dcc: a pasted 40-hex sha",
      "",
    ] : []),
    "const after = 1;",
  ].join("\n");
  const fixturePath = path.join(REPO, "packages", "daemon", "src", "fixture.ts");

  // BEFORE: no malformed anchor in the fixture at all.
  fs.writeFileSync(fixturePath, buildSrc(false));

  // A synthetic fixture anchor placed under test/ must NEVER pollute the measured corpus.
  fs.writeFileSync(path.join(REPO, "packages", "daemon", "test", "fixture-test.mjs"),
    "// @decision ffffffff — a synthetic test-fixture anchor with no record; must be excluded from the sweep\n");

  fs.writeFileSync(path.join(REPO, "docs", "adr", "aaaaaaaa-example.md"), "# aaaaaaaa\n\nAn ADR.\n");
  fs.writeFileSync(path.join(REPO, "docs", "investigations", "bbbbbbbb-an-investigation", "findings.md"), "# bbbbbbbb\n\nAn investigation record.\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "eeeeeeee-orphan-example.md"), "# eeeeeeee\n\nA record nothing anchors to.\n");
  fs.writeFileSync(path.join(REPO, "docs", "adr", "template.md"), "# <card-id> — template, must never be treated as a record\n");
  // 12345678: a record over PER_RECORD_MAX_BYTES — must be flagged as oversized (card d0d0401b).
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "12345678-oversized.md"), "# 12345678\n\n" + "y".repeat(PER_RECORD_MAX_BYTES + 500) + "\n");
  // 99999999: two records sharing an id — must be flagged as colliding (card a4b83fb7).
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "99999999-b-loses.md"), "# 99999999 (loses)\n");
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "99999999-a-wins.md"), "# 99999999 (wins)\n");
  // Card 969b0e1c: REAL_SHA's own record — resolves under the sha: sigil (verified commit).
  fs.writeFileSync(path.join(REPO, "docs", "decisions", `${REAL_SHA}-sha-record.md`), `# ${REAL_SHA}\n\nGenuine commit-keyed record.\n`);
  // deadc0de's record — shared by BOTH the bare (resolves, never verified) and sigil'd (refused, not a
  // real commit) anchors above, so the SAME record file backs both the positive and negative case.
  fs.writeFileSync(path.join(REPO, "docs", "decisions", "deadc0de-namespace-test.md"),
    "# deadc0de\n\nNamespace test record — the bare form resolves without verification; the sha: sigil is refused because deadc0de is not a real commit in this repo.\n");

  const reportBefore = computeReport(REPO, { minLines: 15 });

  // AFTER: the same fixture, PLUS the malformed 40-hex-sha-paste line (card afc56dcc DoD-1).
  fs.writeFileSync(fixturePath, buildSrc(true));
  const report = computeReport(REPO, { minLines: 15 });

  // --- DoD-4: before/after — orphanAnchors, brokenAnchors, collidingRecords, oversizedRecords, and
  // totalAnchorSites must not move at all; overlongAnchorIds must move from 0 to exactly 1. ---
  check("DoD-4 before/after: totalAnchorSites is UNCHANGED by adding the malformed anchor (it was never a real anchor site)",
    report.totalAnchorSites === reportBefore.totalAnchorSites);
  check("DoD-4 before/after: orphanAnchors is UNCHANGED (count and items, by value)",
    report.orphanAnchors.count === reportBefore.orphanAnchors.count
    && JSON.stringify(report.orphanAnchors.items) === JSON.stringify(reportBefore.orphanAnchors.items));
  check("DoD-4 before/after: brokenAnchors is UNCHANGED (this is a DIFFERENT defect shape)",
    report.brokenAnchors.count === reportBefore.brokenAnchors.count
    && JSON.stringify(report.brokenAnchors.items) === JSON.stringify(reportBefore.brokenAnchors.items));
  check("DoD-4 before/after: collidingRecords is UNCHANGED",
    JSON.stringify(report.collidingRecords) === JSON.stringify(reportBefore.collidingRecords));
  check("DoD-4 before/after: oversizedRecords is UNCHANGED",
    JSON.stringify(report.oversizedRecords) === JSON.stringify(reportBefore.oversizedRecords));
  check("DoD-4 before/after: overlongAnchorIds moves from 0 (BEFORE) to exactly 1 (AFTER) — the new signal, and ONLY it, moved",
    reportBefore.overlongAnchorIds.count === 0 && report.overlongAnchorIds.count === 1);
  check("computeReport: the overlong anchor is reported with the correct file, ns, and full matched text",
    report.overlongAnchorIds.items[0]?.file === "packages/daemon/src/fixture.ts"
    && report.overlongAnchorIds.items[0]?.ns === "sha"
    && report.overlongAnchorIds.items[0]?.match === "@decision sha:1234567890abcdef1234567890abcdef12345678");

  // --- DoD-4 (card e708670b): a THIRD before/after step — add the sigil-space malformed anchor ON TOP of
  // the already-overlong-included fixture, and confirm ONLY sigilSpaceAnchors moves; every other field
  // (including overlongAnchorIds itself and totalAnchorSites) stays byte-identical to `report` above.
  {
    const sigilSpaceLine = "\n\n// @decision sha: cafebabe — card e708670b: a space between the sigil colon and its id";
    fs.writeFileSync(fixturePath, buildSrc(true) + sigilSpaceLine);
    const reportWithSigilSpace = computeReport(REPO, { minLines: 15 });

    check("DoD-4 (e708670b) before/after: totalAnchorSites is UNCHANGED by adding the sigil-space anchor (it was never a real anchor site)",
      reportWithSigilSpace.totalAnchorSites === report.totalAnchorSites);
    check("DoD-4 (e708670b) before/after: orphanAnchors is UNCHANGED",
      reportWithSigilSpace.orphanAnchors.count === report.orphanAnchors.count
      && JSON.stringify(reportWithSigilSpace.orphanAnchors.items) === JSON.stringify(report.orphanAnchors.items));
    check("DoD-4 (e708670b) before/after: brokenAnchors is UNCHANGED",
      reportWithSigilSpace.brokenAnchors.count === report.brokenAnchors.count
      && JSON.stringify(reportWithSigilSpace.brokenAnchors.items) === JSON.stringify(report.brokenAnchors.items));
    check("DoD-4 (e708670b) before/after: overlongAnchorIds is UNCHANGED (this is a DIFFERENT defect shape)",
      reportWithSigilSpace.overlongAnchorIds.count === report.overlongAnchorIds.count
      && JSON.stringify(reportWithSigilSpace.overlongAnchorIds.items) === JSON.stringify(report.overlongAnchorIds.items));
    check("DoD-4 (e708670b) before/after: collidingRecords is UNCHANGED",
      JSON.stringify(reportWithSigilSpace.collidingRecords) === JSON.stringify(report.collidingRecords));
    check("DoD-4 (e708670b) before/after: oversizedRecords is UNCHANGED",
      JSON.stringify(reportWithSigilSpace.oversizedRecords) === JSON.stringify(report.oversizedRecords));
    check("DoD-4 (e708670b) before/after: sigilSpaceAnchors moves from 0 to exactly 1 — the new signal, and ONLY it, moved",
      report.sigilSpaceAnchors.count === 0 && reportWithSigilSpace.sigilSpaceAnchors.count === 1);
    check("computeReport: the sigil-space anchor is reported with the correct file and full matched text",
      reportWithSigilSpace.sigilSpaceAnchors.items[0]?.file === "packages/daemon/src/fixture.ts"
      && reportWithSigilSpace.sigilSpaceAnchors.items[0]?.match === "@decision sha: cafebabe");

    // Restore the fixture to the (overlong-only) AFTER state — every remaining check below assumes
    // `report`'s exact fixture content, re-read from disk (e.g. the computeFileReport hook-path checks).
    fs.writeFileSync(fixturePath, buildSrc(true));
  }

  // Card e708670b (lead-requested widening): the IDENTICAL before/after step, but with the space BEFORE
  // the sigil's colon instead — the shape the lead independently re-verified was still silent under the
  // FIRST version of this check. Proves the widened computeReport-level detection, not just the pure
  // findSigilSpaceAnchors unit above, and re-asserts every DoD-4 invariant against the real fixture.
  {
    const sigilSpaceBeforeLine = "\n\n// @decision sha :cafebabe — card e708670b: a space before the sigil colon";
    fs.writeFileSync(fixturePath, buildSrc(true) + sigilSpaceBeforeLine);
    const reportWithSigilSpaceBefore = computeReport(REPO, { minLines: 15 });

    check("DoD-4 (e708670b widening) before/after: totalAnchorSites is UNCHANGED by adding the before-colon sigil-space anchor",
      reportWithSigilSpaceBefore.totalAnchorSites === report.totalAnchorSites);
    check("DoD-4 (e708670b widening) before/after: orphanAnchors is UNCHANGED",
      reportWithSigilSpaceBefore.orphanAnchors.count === report.orphanAnchors.count
      && JSON.stringify(reportWithSigilSpaceBefore.orphanAnchors.items) === JSON.stringify(report.orphanAnchors.items));
    check("DoD-4 (e708670b widening) before/after: brokenAnchors is UNCHANGED",
      reportWithSigilSpaceBefore.brokenAnchors.count === report.brokenAnchors.count
      && JSON.stringify(reportWithSigilSpaceBefore.brokenAnchors.items) === JSON.stringify(report.brokenAnchors.items));
    check("DoD-4 (e708670b widening) before/after: overlongAnchorIds is UNCHANGED (this is a DIFFERENT defect shape)",
      reportWithSigilSpaceBefore.overlongAnchorIds.count === report.overlongAnchorIds.count
      && JSON.stringify(reportWithSigilSpaceBefore.overlongAnchorIds.items) === JSON.stringify(report.overlongAnchorIds.items));
    check("DoD-4 (e708670b widening) before/after: collidingRecords is UNCHANGED",
      JSON.stringify(reportWithSigilSpaceBefore.collidingRecords) === JSON.stringify(report.collidingRecords));
    check("DoD-4 (e708670b widening) before/after: oversizedRecords is UNCHANGED",
      JSON.stringify(reportWithSigilSpaceBefore.oversizedRecords) === JSON.stringify(report.oversizedRecords));
    check("DoD-4 (e708670b widening) before/after: sigilSpaceAnchors moves from 0 to exactly 1 for the before-colon shape too",
      report.sigilSpaceAnchors.count === 0 && reportWithSigilSpaceBefore.sigilSpaceAnchors.count === 1);
    check("computeReport: the before-colon sigil-space anchor is reported with the correct file and full matched text",
      reportWithSigilSpaceBefore.sigilSpaceAnchors.items[0]?.file === "packages/daemon/src/fixture.ts"
      && reportWithSigilSpaceBefore.sigilSpaceAnchors.items[0]?.match === "@decision sha :cafebabe");

    // Restore the fixture to `report`'s exact content for every remaining check below.
    fs.writeFileSync(fixturePath, buildSrc(true));
  }

  check("computeReport: fixture-test.mjs under test/ is excluded from the sweep (filesScanned === 1)", report.filesScanned === 1);
  check("computeReport: the 20-line unanchored block is flagged", report.unanchoredLongBlocks.count === 1
    && report.unanchoredLongBlocks.items[0]?.length === 20);
  check("computeReport: aaaaaaaa (adr-resolved) is not an orphan anchor",
    !report.orphanAnchors.items.some((a) => a.id === "aaaaaaaa"));
  check("computeReport: bbbbbbbb (investigations-resolved) is not an orphan anchor",
    !report.orphanAnchors.items.some((a) => a.id === "bbbbbbbb"));
  check("computeReport: dddddddd (unresolved) IS an orphan anchor, exactly once",
    report.orphanAnchors.items.filter((a) => a.id === "dddddddd").length === 1);
  check("computeReport: the synthetic test/-fixture anchor ffffffff never reaches orphanAnchors",
    !report.orphanAnchors.items.some((a) => a.id === "ffffffff"));

  // --- sigil namespace, card 969b0e1c ---
  check("computeReport (sigil): a sha:-sigil'd anchor citing a REAL, verified commit is NOT an orphan",
    !report.orphanAnchors.items.some((a) => a.ns === "sha" && a.id === REAL_SHA));
  check("computeReport (sigil): the bare-form anchor sharing deadc0de's hex resolves as a CARD id "
    + "(never SHA-verified — it has a matching record and that's the whole check for ns=card)",
    !report.orphanAnchors.items.some((a) => a.ns === "card" && a.id === "deadc0de"));
  check("computeReport (sigil): the SAME hex under the sha: sigil IS refused — deadc0de is not a real "
    + "commit in this repo, even though a matching record file exists (refuse-rather-than-fall-through)",
    report.orphanAnchors.items.some((a) => a.ns === "sha" && a.id === "deadc0de"));
  check("computeReport (sigil): orphanAnchors.count is exactly 2 — dddddddd (pre-existing, unresolved) "
    + "and sha:deadc0de (new refusal); sha:REAL_SHA and card:deadc0de both resolve and add nothing",
    report.orphanAnchors.count === 2);
  check("computeReport: eeeeeeee (no inbound anchor) IS an orphan record, marked advisory",
    report.orphanRecords.items.some((r) => r.id === "eeeeeeee") && report.orphanRecords.advisory === true);
  // 8 real records (aaaaaaaa via adr, bbbbbbbb via investigations, eeeeeeee + 12345678 + the two
  // colliding 99999999 files + REAL_SHA + deadc0de via decisions) — template.md excluded despite living
  // in docs/adr alongside a real record.
  check("computeReport: template.md is never treated as a record",
    !report.orphanRecords.items.some((r) => r.path.endsWith("template.md")) && report.recordCount === 8);
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
  // Card a4b83fb7: 99999999's two records must be flagged as colliding, naming both files and the winner.
  check("computeReport: the colliding id 99999999 is flagged, exactly once, with the correct winner",
    report.collidingRecords.count === 1 && report.collidingRecords.items[0]?.id === "99999999"
    && report.collidingRecords.items[0]?.winnerPath === "docs/decisions/99999999-a-wins.md");
  check("computeReport: the collision's dark file is named",
    report.collidingRecords.items[0]?.darkPaths.length === 1
    && report.collidingRecords.items[0].darkPaths[0] === "docs/decisions/99999999-b-loses.md");
  check("computeReport: a non-colliding record (e.g. 12345678) never appears in collidingRecords",
    !report.collidingRecords.items.some((c) => c.id === "12345678"));
  // Guard class is a SHAPE classification (length <= GUARD_MAX_LINES && has an anchor), independent of
  // whether that anchor resolves — all six 1-line anchors (aaaaaaaa, bbbbbbbb, dddddddd, sha:REAL_SHA,
  // deadc0de, sha:deadc0de) are guard-class-shaped even though dddddddd and sha:deadc0de are separately
  // flagged as orphan anchors.
  check("computeReport: all 6 one-line anchors are guard-class-shaped, and none is flagged as unanchored-long",
    report.guardClassBlocks.count === 6 && report.unanchoredLongBlocks.items.every((b) => b.length >= 15));

  // Card ad3a9a85 DoD-3: does the LIVE per-file hook also surface a broken anchor, or only the CLI scan?
  // Answer: both — computeFileReport runs the same per-line findBrokenAnchors over the one file's content.
  {
    const fixturePath = path.join(REPO, "packages", "daemon", "src", "fixture.ts");
    const fileReport = computeFileReport(REPO, fixturePath, fs.readFileSync(fixturePath, "utf8"));
    check("computeFileReport (the live PostToolUse hook path): the split anchor is flagged too",
      fileReport?.brokenAnchors?.length === 1);
    // Card afc56dcc: the overlong anchor id must ALSO surface via the live per-file hook, not just the
    // CLI scan — this is the check that catches it AT AUTHORING TIME, before it's ever committed.
    check("computeFileReport (the live PostToolUse hook path): the overlong anchor id is flagged too",
      fileReport?.overlongAnchorIds?.length === 1
      && fileReport.overlongAnchorIds[0]?.ns === "sha"
      && fileReport.overlongAnchorIds[0]?.match === "@decision sha:1234567890abcdef1234567890abcdef12345678");
    // oversizedRecords is deliberately NOT part of computeFileReport (records live under docs/, outside
    // SOURCE_ROOTS — see this file's own header) — confirm the hook-shaped report has no such key at all,
    // rather than silently reporting zero and looking like it checked.
    check("computeFileReport: oversizedRecords is not a key on the hook-shaped report (CLI-scan only, by design)",
      !("oversizedRecords" in fileReport));
    // Card a4b83fb7 DoD-4: collidingRecords is CLI-scan only for the identical reason — a single changed
    // source file can never tell you whether ANOTHER record file under docs/ now shares its anchor's id.
    check("computeFileReport: collidingRecords is not a key on the hook-shaped report (CLI-scan only, by design)",
      !("collidingRecords" in fileReport));
  }

  // Card e708670b DoD-3: does the LIVE per-file hook also surface a sigil-space anchor (either side of the
  // colon), or only the CLI scan? Answer: both — computeFileReport runs the same per-line
  // findSigilSpaceAnchors over the file.
  {
    const fixturePath = path.join(REPO, "packages", "daemon", "src", "fixture.ts");
    const sigilSpaceLine = "\n\n// @decision sha: cafebabe — card e708670b: a space after the sigil colon";
    fs.writeFileSync(fixturePath, buildSrc(true) + sigilSpaceLine);
    const fileReport = computeFileReport(REPO, fixturePath, fs.readFileSync(fixturePath, "utf8"));
    check("computeFileReport (the live PostToolUse hook path): the after-colon sigil-space anchor is flagged too",
      fileReport?.sigilSpaceAnchors?.length === 1
      && fileReport.sigilSpaceAnchors[0]?.match === "@decision sha: cafebabe");
    // Restore the fixture to `report`'s exact content for anything else that re-reads it below.
    fs.writeFileSync(fixturePath, buildSrc(true));
  }

  {
    const fixturePath = path.join(REPO, "packages", "daemon", "src", "fixture.ts");
    const sigilSpaceBeforeLine = "\n\n// @decision sha :cafebabe — card e708670b widening: a space before the sigil colon";
    fs.writeFileSync(fixturePath, buildSrc(true) + sigilSpaceBeforeLine);
    const fileReport = computeFileReport(REPO, fixturePath, fs.readFileSync(fixturePath, "utf8"));
    check("computeFileReport (the live PostToolUse hook path): the before-colon sigil-space anchor is flagged too",
      fileReport?.sigilSpaceAnchors?.length === 1
      && fileReport.sigilSpaceAnchors[0]?.match === "@decision sha :cafebabe");
    // Restore the fixture to `report`'s exact content for anything else that re-reads it below.
    fs.writeFileSync(fixturePath, buildSrc(true));
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
    + "wrapped) anchor in both the CLI scan and the live per-file hook, flags a record over "
    + "PER_RECORD_MAX_BYTES (read from decision-records.mjs, not a hand-copied number), flags two "
    + "record files sharing an id, naming every candidate and which one resolveRecord() actually wins "
    + "(store precedence, then alphabetically-first within that store), flags a same-line over-long "
    + "hex anchor id (a verbatim 40-hex sha paste) in both the CLI scan and the live per-file hook, and "
    + "flags a sha sigil with whitespace adjacent to its colon on either side or both (e.g. \"sha: deadbeef\", "
    + "\"sha :deadbeef\", or \"sha : deadbeef\") in both the CLI scan and the live per-file hook, with "
    + "orphanAnchors/brokenAnchors/overlongAnchorIds/collidingRecords/oversizedRecords/totalAnchorSites "
    + "unmoved by any of it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
