#!/usr/bin/env node
// comment-anchor-lint.mjs — WARN-ONLY lint for the decision-anchor convention (card 5329a9af; wired as a
// live hook by card 67621894). Two entry points, one script:
//   1. CLI whole-repo scan: `node comment-anchor-lint.mjs [repoRoot] [--min-lines=N]` — prints the full
//      JSON report (all five checks, see below) to stdout. Manual/reporting use only; NOT what the hook
//      below invokes (a whole-repo scan on every Write/Edit would reintroduce the per-invocation hook cost
//      card 5244adc2 just existed to remove — see COMMENT_ANCHOR_LINT_SCRIPT's own doc in paths.ts).
//   2. PostToolUse hook: `node comment-anchor-lint.mjs --hook <repoRoot>` (matcher Write|Edit), reading the
//      hook payload on stdin and linting ONLY the one file just written (`runHook`/`computeFileReport`
//      below) — never a repo-wide scan. See `writeSessionSettings` (claude-settings.ts) for the wiring.
// Neither mode ever fails the process on a violation — "warn-only" is realized as an exit-code contract,
// not a config flag, so wiring this into anything later can never accidentally turn it blocking by
// omission. See the card's own Sequencing note for why blocking mode waits on a separate step (extracting
// the comment-heaviest files first).
//
// FIELD DETERMINATION (card 9b293b4b, 2026-09-09) — do not reintroduce a `systemMessage` copy on the
// hook's emitted payload (see `emitHook`/`runHook` below): it used to carry the advisory via BOTH
// `systemMessage` and `hookSpecificOutput.additionalContext`, "whichever the running Claude honors" — a
// hedge never actually checked. Card da723d41 checked it empirically for decision-records.mjs (three
// controlled `claude -p` trials, incl. a swapped-values control) and found `additionalContext` is the
// ONLY field the model ever sees; `systemMessage` is UI-only and never reaches it. This hook's own
// message is "the advisory text handed back to the agent" (see `formatHookMessage` below), not the human
// at the terminal, so the same determination applies here. See project memory
// `posttooluse-hook-honors-additionalcontext-not-systemmessage` and decision-records.mjs's own header for
// the full method.
//
// Fifteen checks, matching CLAUDE.md's comment-taxonomy section (card 90b19799):
//   1. unanchoredLongBlocks — a contiguous comment block >= `minLines` (default DEFAULT_MIN_LINES) with
//      no `@decision <id>` anywhere in it. The "narrative is regrowing in source" signal.
//   2. orphanAnchors — an `@decision <id>` whose id resolves to no record in ANY of the three stores this
//      convention actually uses at runtime (docs/adr, docs/decisions, docs/investigations/<id>-*/
//      findings.md — the same three `decision-records.mjs` resolves against; the card's own text says
//      "either register" naming only the first two, but mirroring the shipped resolver's full three-store
//      set is what avoids flagging an anchor that legitimately resolves via investigations). Card
//      969b0e1c: a `@decision sha:<id>` anchor is ALSO orphan if its sha no longer verifies as a real
//      commit in this repo (`anchorResolves`/`verifyCommitSha` below), even when a same-named record file
//      exists — mirroring `decision-records.mjs`'s own refuse-rather-than-fall-through resolver gate.
//   3. orphanRecords — a record with no inbound anchor anywhere in the swept source. ADVISORY, never an
//      error (see `advisory: true` on its report key) — a policy-level record can correctly have no single
//      anchor site, and treating this as a hard violation trains people to ignore the whole lint.
//      ⛔ NOT run by the hook (`runHook`/`computeFileReport` below), by design: it needs the WHOLE anchor
//      corpus (every source file's anchors) to know whether a record has zero inbound sites anywhere — a
//      single changed file can never answer that on its own, and re-scanning the whole repo to answer it
//      per-Write is exactly the cost the hook exists to avoid (see this file's own header). CLI-scan mode
//      only; a project wanting this check run stays on the manual/whole-repo path.
//   4. brokenAnchors (card ad3a9a85) — a `@decision` keyword NOT followed by a valid 8-hex id on the SAME
//      line: the shape a JSDoc line wrap produces when it breaks between the keyword and the id (`@decision`
//      on one continuation line, the id on the next). `ANCHOR_RE`/`findFileAnchors` match per-line, so a
//      wrapped anchor is invisible to every other check here — it looks like ordinary prose, never like an
//      orphan anchor (there is no anchor id to resolve) and never like an unanchored long block if the
//      surrounding block happens to be short. This is the ONLY check that catches it. Runs in BOTH the CLI
//      scan and the per-file hook (unlike orphanRecords above) — it needs only the one file already being
//      scanned, same as unanchoredLongBlocks/orphanAnchors.
//   5. oversizedRecords (card d0d0401b) — a record file (docs/adr, docs/decisions) whose byte size exceeds
//      `PER_RECORD_MAX_BYTES` (imported from decision-records.mjs — the SAME constant that script truncates
//      against at read time, never a second copy of the number). CLI-scan mode only: records live under
//      `docs/`, outside SOURCE_ROOTS, so the per-file hook (which only ever sees a write under
//      packages/{daemon,web,shared}) structurally never observes a record file being authored or edited.
//   6. collidingRecords (card a4b83fb7) — two or more record files (across docs/adr, docs/decisions, and
//      docs/investigations) whose ids resolve to the SAME id. `decision-records.mjs`'s own `resolveRecord()`
//      picks exactly ONE winner per id (store precedence, then alphabetically-first filename within that
//      store — replicated here, not imported, same reasoning as ANCHOR_RE's duplication above) and silently
//      drops every other file sharing that id, forever, with no error anywhere — the failure this check
//      exists to surface: a well-formed anchor that resolves, to the WRONG decision. Reports every colliding
//      id, every candidate file, and which one currently wins, so the author sees the casualty, not just a
//      count. CLI-scan mode only, same ground as oversizedRecords above: records live under `docs/`, outside
//      SOURCE_ROOTS, so the per-file hook structurally never observes a second record file for an id that
//      already has one.
//   7. overlongAnchorIds (card afc56dcc) — a `@decision` (optionally `sha:`-sigil'd) followed by 9+ hex
//      chars on the SAME line: the shape a verbatim 40-hex `git blame`/`git log` paste produces, once card
//      969b0e1c told authors to source a `sha:` id that way. `ANCHOR_RE` requires EXACTLY 8 hex chars
//      followed by a word boundary, so this shape never matches it at all — no anchor, no orphanAnchors
//      entry, no brokenAnchors entry (that check is EOL-only, a DIFFERENT defect shape — see
//      `BROKEN_ANCHOR_RE`'s own doc), no injection, no error: silent, total no-op. Runs in BOTH the CLI
//      scan and the per-file hook, same ground as brokenAnchors — it needs only the one file already being
//      scanned. ⛔ Does NOT catch a same-line id that's merely too SHORT (e.g. "@decision 12ab") — a
//      different, rarer shape outside this card's DoD, the same carve-out `BROKEN_ANCHOR_RE` already states.
//   8. sigilSpaceAnchors (card e708670b) — a `sha:` sigil with one or more whitespace characters adjacent
//      to its colon, on EITHER side (or both): after the colon, before it, or both. `ANCHOR_RE`'s `sha:`
//      alternative requires the colon to sit directly between the literal `sha` and the hex run with NO
//      intervening whitespace on either side, and the bare alternative can't match either (the literal
//      text "sha" isn't hex) — so, exactly like `overlongAnchorIds` above, this shape produces no anchor,
//      no orphanAnchors entry, no brokenAnchors entry (EOL-only, a different shape), no overlongAnchorIds
//      entry (that pattern also requires the hex to immediately follow the sigil): silent, total no-op.
//
//      @decision e708670b widened this from catching only whitespace AFTER the colon, once a sibling shape
//      shipped unhandled the first time (see SIGIL_SPACE_RE below).
//
//      Runs in BOTH the CLI scan and the per-file hook, same ground as brokenAnchors/overlongAnchorIds — it
//      needs only the one file already being scanned. ⛔ Does NOT catch a same-line id that's too SHORT
//      after/before the space (a different, rarer shape, the same carve-out every other check in this file
//      already states) — requires 8+ hex chars, mirroring `overlongAnchorIds`'s own
//      `{8,}`-vs-well-formed-length distinction.
//
//   9. bareCommitAnchors (card a2fc4031) — a BARE `@decision <id>` (never `sha:`-sigil'd) whose id ALSO
//      resolves as a real commit object in this repo's git history. CLAUDE.md's comment-taxonomy convention
//      is unconditional: a bare 8-hex id always means a board card, and the commit id-space REQUIRES the
//      `sha:` sigil (card 969b0e1c) — but `orphanAnchors` never verifies a bare (`ns === "card"`) id against
//      git at all (only a `sha:`-sigil'd id is), so a commit sha typed into the bare grammar resolves
//      totally normally (against a same-named record, if one exists) and orphanAnchors stays silent. This
//      check is the backstop: every bare anchor site whose id happens to ALSO be a real commit is reported,
//      one entry per SITE (not deduped by id, unlike orphanAnchors — the originating specimen cited the
//      same sha at two separate sites, and both need the fix). Resolution is via `git cat-file
//      --batch-check` (`batchResolveCommits` below), ONE batched call for every distinct bare id in the
//      whole sweep rather than one `execFileSync` per id — this repo's own measured population is in the
//      hundreds. Runs in BOTH the CLI scan and the per-file hook, same ground as orphanAnchors — it needs
//      only the file's own anchors plus one repo-scoped git call.
//  10. pointerAnchors (card a862e8f0; window widened by card 347d37d2) — an `@decision <id>` (or
//      `sha:<id>`) SITE whose own text window contains a phrase that POINTS AT the out-of-band record
//      instead of STATING the prohibition/consequence inline — "see docs/", "docs/adr/", "docs/decisions/",
//      "see the linked record", or "see the record". The convention (CLAUDE.md comment taxonomy,
//      docs/extraction-program.md) requires the anchor TEXT itself to carry the rule; the record is reached
//      by resolving the id, never by a "see docs/…" tail typed into the comment. The window is the anchor's
//      own paragraph — see `findPointerAnchors`'s own doc below for exactly where it ends (card 347d37d2:
//      a fixed 3-line cap missed a pointer tail on a real anchor's 4th+ line). Sent back by lead review 7
//      times across two seats before this check existed (card a862e8f0) — see project memory
//      `shipping-a-detector-is-not-someone-reading-it`. REPORT-ONLY (does not fail `guards` — see the card
//      for why the existing corpus wasn't clean enough to gate on). One entry per SITE, not deduped by id
//      (same convention as `bareCommitAnchors` above — every site needs its own fix). Runs in BOTH the CLI
//      scan (`computeReport`/`computeFileReport` — the FULL, unscoped list, always) and the per-file hook,
//      same ground as `bareCommitAnchors`/`overlongAnchorIds` — it needs only the one file's own
//      blocks/anchors already computed for those checks, no repo-wide corpus. ⚠️ The HOOK's own advisory
//      (`runHook`, not `computeFileReport`) additionally SCOPES this field — card 5e5841dd generalized
//      this to `overlongAnchorParagraphs`/`midSentenceAnchors` below too, so it is no longer only this
//      one — down to the site(s) the triggering edit actually just wrote (`extractWrittenText`/
//      `scopeHookAnchorSites`, both below), plus a hard cap (`HOOK_POINTER_ANCHOR_CAP`): a file already
//      carrying hundreds of pre-existing pointer anchors (measured: up to 197 in one file) would otherwise
//      inject the WHOLE list on every single edit to that file, regardless of relevance (card a862e8f0
//      lead review, round 2). `computeFileReport` itself is unaffected — it still always returns the
//      file's complete `pointerAnchors`; only what `runHook` chooses to SURFACE is narrowed.
//  11. overlongAnchorParagraphs (card 5e5841dd) — an `@decision <id>` (or `sha:<id>`) SITE whose own
//      CONTIGUOUS PARAGRAPH (the anchor's line plus its continuation lines, up to the next blank comment
//      line, a new JSDoc tag, the next `@decision` site, or the enclosing block's own end — the SAME window
//      `findPointerAnchors` computes, via the shared `anchorParagraphEnd` helper, never a second parser)
//      spans more than `GUARD_MAX_LINES` lines. CLAUDE.md's comment taxonomy requires a guard/prohibition
//      anchor be "compressed to <=3 lines" — nothing enforced it, and a paragraph that carries a real
//      `@decision <id>` is silently counted as "anchored" (excluded from `unanchoredLongBlocks`) no matter
//      how long it runs. REPORT-ONLY (does not fail `guards`) — the existing corpus carries pre-existing
//      overlong anchor paragraphs; fixing them is extraction-lane work, not this check's job. One entry per
//      SITE, not deduped by id, same convention as `pointerAnchors`/`bareCommitAnchors` above. Runs in BOTH
//      the CLI scan and the per-file hook, same ground as `pointerAnchors` — it needs only the one file's
//      own `blocks`/`anchors` already computed for that check, no extra cost. ⚠️ The HOOK's own advisory
//      SCOPES this field too, same mechanism and same reason as `pointerAnchors` above (a main-tree
//      baseline of 257, concentrated in the same giant files, would otherwise flood every edit there).
//  12. midSentenceAnchors (card 5e5841dd; per-occurrence fix card f3c054f3) — an `@decision` OCCURRENCE that
//      is NOT the first non-prefix token before ITS OWN position on the line (comment-syntax markers
//      stripped) — i.e. the anchor is embedded MID-SENTENCE inside other prose rather than opening its own
//      line/paragraph. This lets a whole contract paragraph get silently relabelled "anchored" by a token
//      buried partway through its own text, a defect no other check here catches (every other check cares
//      about the id's own SHAPE, never the token's POSITION on the line). Judged per OCCURRENCE (`a.col`,
//      card f3c054f3) rather than once per whole line: the original whole-line form could only ever reflect
//      the FIRST `@decision` on a line, so a SECOND `@decision` sharing that same physical line silently
//      inherited the first one's "opens the line" verdict regardless of where it actually sat — invisible to
//      every check in this file, since `embeddedAnchors`/`overlongAnchorParagraphs` are both keyed off
//      `anchorParagraphEnd`'s LINE-level window, never a same-line position. REPORT-ONLY, same posture as
//      `overlongAnchorParagraphs` above. One entry per SITE, not deduped by id. Runs in BOTH the CLI scan and
//      the per-file hook, same ground as `overlongAnchorParagraphs` — it needs only the one file's own
//      `anchors` already computed. ⚠️ The HOOK's own advisory SCOPES this field too, same mechanism as
//      `pointerAnchors`/`overlongAnchorParagraphs` (re-measure the main-tree baseline fresh — it moved with
//      this card's fix — rather than trusting a number restated here).
//  13. embeddedAnchors (card a873621e; round 2 lead review) — an `@decision` SITE whose own line ALSO
//      opens correctly (checked via `isMidSentenceAnchorLine` — `midSentenceAnchors` above owns every site
//      that doesn't; round-2 finding: 15 of the original 24 hits on this repo were exactly that population,
//      because round 1 never checked it) but is still embedded inside a LARGER sentence spanning an
//      adjacent line: its immediately PRECEDING comment line is non-blank and does not end a sentence (see
//      `endsSentence`'s DOCTRINE punctuation set below, and `isDecorativeSeparatorLine` for the "a section-
//      banner/box-drawing divider line is a real boundary" carve-out — round-2 finding: 4 hits were cleared
//      by the wider punctuation set, 2 by the divider carve-out), or its immediately FOLLOWING comment line
//      starts with `)`, `]`, `;`, or `,` (closing/continuing punctuation only — round-1 also tried a
//      leading-lowercase test and an em-dash here and DROPPED both once measured: a lowercase second line
//      is the ordinary, LEGAL shape of any compliant <= GUARD_MAX_LINES-line multi-line anchor, and
//      including it flagged ~1250 of ~1309 raw hits — almost all ordinary compliant anchors, not embeds).
//      Neither `midSentenceAnchors` (line-position only) nor `overlongAnchorParagraphs` (paragraph LENGTH
//      only) can see this shape: `anchorParagraphEnd` happily counts the embed as part of one short,
//      compliant-length paragraph. `embeddedAnchors.stackedUnterminated` (same field, a SEPARATE sub-list,
//      never counted in `embeddedAnchors.count`) is one deliberate carve-out: when the preceding line is
//      the LAST line of a DIFFERENT anchor's own already-computed paragraph (a legitimate stacked-anchors
//      run — the shape `anchorParagraphEnd` already treats as a boundary) AND that other anchor's own line
//      reads as an independent statement (`ownStatementLooksWellFormed`, not a continuation like the real
//      `ac90ca8e`/`3388be4d` specimen), a missing trailing period there is a punctuation nit between two
//      real, distinct decisions, not "an anchor swallowed by unrelated prose" — counting it there would
//      bury the genuine embeds under a much larger, less actionable population. Round-2 measured final:
//      3 real sites on this repo's own corpus (see docs/extraction-program.md and this card's report for
//      the exact file:line list). REPORT-ONLY. Runs in BOTH the CLI scan and the per-file hook (scoped like
//      `pointerAnchors`/`overlongAnchorParagraphs`/`midSentenceAnchors` above) — it needs only the one
//      file's own `blocks`/`anchors` already computed for those checks.
//  14. splitAnchorParagraphs (card a873621e; round 2 lead review) — an `@decision` SITE whose own paragraph
//      (the SAME `anchorParagraphEnd` window `overlongAnchorParagraphs`/`pointerAnchors` share) ends
//      because the NEXT comment line is genuinely BLANK (never the block's own bare closing delimiter, e.g.
//      a lone ` */` — `stripCommentMarkers` strips a trailing `*/` and would otherwise misclassify it as
//      blank), keyed on CONTINUATION rather than the paragraph's own last character (round-1 keyed on "does
//      the last line end a sentence" and produced 7 false positives that already ended properly in `)`/`]`/
//      backtick/`"` once the doctrine punctuation set — see `endsSentence` — was applied): flags when the
//      first content line after the blank CONTINUES the sentence — ordinary prose starting with a lowercase
//      letter or `)`/`]`/`;`/`,`, OR an `@decision` line whose own text after the id is itself a
//      continuation (`afterBlankContinues`; this is what keeps the round-1 Fixture B shape, where the line
//      right after the blank IS another anchor, not ordinary prose). `splitAnchorParagraphs.unterminated`
//      (same field, a SEPARATE sub-list, never counted in `splitAnchorParagraphs.count`, mirrors
//      `embeddedAnchors.stackedUnterminated`'s shape) is the round-1 bare-citation exclusion's natural
//      successor: a paragraph whose own last line lacks doctrine terminal punctuation but whose follow-on
//      is a genuinely FRESH paragraph (not a continuation) — a missing-period nit, not a cut sentence. A
//      paragraph that both terminates properly AND has no continuing follow-on is CLEAN, reported nowhere.
//      Round-2 measured final: 12 real sites (see docs/extraction-program.md and this card's report for
//      the exact file:line list — the `unterminated` population is comparatively large, since it also
//      picks up the pervasive bare-citation-only style; re-measure fresh rather than trusting a number
//      restated here). REPORT-ONLY. Runs in BOTH the CLI scan and the
//      per-file hook, same scoping convention as `overlongAnchorParagraphs`/`embeddedAnchors` above.
//  15. missingDoNotRecords (card abd049da) — a record file in `docs/adr` or `docs/decisions` (never
//      `docs/investigations` — see `findRecordsMissingDoNot`'s own doc for why those are excluded) with no
//      'Do not'-style heading at any level (`hasDoNotSection`, imported from decision-records.mjs — the
//      SAME predicate that script uses at read time to decide between Do-not-section injection and the
//      no-Do-not fallback). Authoring-time coverage check for the read-time fallback: the runtime path
//      never goes silent either way, but a record missing a 'Do not' section gets a smaller, less useful
//      injection (title + an explicit "no Do not section" note, rather than a real prohibition) — this
//      check makes that gap visible at authoring time instead of only discoverable by reading the injected
//      output. CLI-scan only, same ground as `oversizedRecords`/`collidingRecords` above: records live
//      under `docs/`, outside `SOURCE_ROOTS`, so the per-file hook structurally never observes one.
//
// A <= GUARD_MAX_LINES-line block that DOES carry an anchor is the convention's TARGET STATE (Class A: a
// short guard/prohibition, permanently inline) and is counted separately as `guardClassBlocks` — it is
// structurally excluded from `unanchoredLongBlocks` (that check only ever looks at blocks with NO anchor)
// and must never appear there; `packages/daemon/test/comment-anchor-lint.mjs` asserts this directly.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PER_RECORD_MAX_BYTES, hasDoNotSection } from "./decision-records.mjs";

// Comment-syntax-agnostic, byte-identical to decision-records.mjs's own ANCHOR_RE — kept as a separate
// literal here (not imported) because assets ship as standalone files invoked by bare `node <path>`,
// mirroring the same duplication already accepted between decision-records.mjs and claude-settings.ts's
// `anyDecisionRecordStoreExists` (see that function's own doc for why, and the same "keep in sync" note
// applies here). `PER_RECORD_MAX_BYTES` above is the one EXCEPTION to that duplication convention (see its
// own doc in decision-records.mjs): card d0d0401b's DoD requires this lint to read the cap from a single
// source of truth, not a hand-copied number, and that script's `main()` is import-safe (guarded — see its
// own dispatch at the bottom of that file), so importing just the constant carries none of the "standalone
// invocation" risk the regex/function duplication above exists to avoid.
//
// Card 969b0e1c: a TWO-NAMESPACE union, mirroring decision-records.mjs's own ANCHOR_RE exactly (see that
// file's doc for the full rationale) — `sha:([0-9a-f]{8})` (group 1) keys a verified commit; the bare
// `([0-9a-f]{8})` (group 2) is the unchanged original form and keys a board card. `parseAnchorMatch` and
// `verifyCommitSha` below are the SAME duplicated-not-imported shape as this regex.
const ANCHOR_RE = /@decision\s+(?:sha:([0-9a-f]{8})|([0-9a-f]{8}))\b/gi;

/** Normalize one `ANCHOR_RE` match into `{ns, id}` — mirrors decision-records.mjs's own `parseAnchorMatch`
 * exactly (same doc there). */
function parseAnchorMatch(m) {
  return m[1] ? { ns: "sha", id: m[1].toLowerCase() } : { ns: "card", id: m[2].toLowerCase() };
}

/** True iff `sha` resolves to a real commit in `repoRoot`'s git history — mirrors decision-records.mjs's
 * own `verifyCommitSha` exactly (same doc there, including why any failure — including the bounded
 * `timeout` below firing, review S2 card 969b0e1c — reads as UNVERIFIED, never thrown). Used by this
 * lint's `orphanAnchors` check so a `sha:`-sigil'd anchor whose commit no longer verifies is correctly
 * reported as orphaned, not silently counted as resolved just because a same-named record file exists. */
function verifyCommitSha(repoRoot, sha) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** True iff anchor `a` ({ns, id}) resolves against `recordIdSet` (the set of ids `listRecordIds` found a
 * record for) — the `orphanAnchors` check's own resolvability predicate, deliberately mirroring (never
 * importing) `decision-records.mjs`'s `resolveRecord` gate: a `ns === "sha"` anchor is orphan unless its id
 * BOTH has a record file AND verifies as a real commit in `repoRoot`; a `ns === "card"` anchor is orphan
 * iff it merely has no record (unchanged, no verification). The record-existence check runs FIRST here
 * (unlike `resolveRecord`, which verifies first) — cheap and side-effect-free, so it's a pure optimization
 * that avoids a `git` subprocess call for an anchor that's doomed to be orphan either way; the final
 * boolean is identical regardless of order. `shaCache` (a Map) memoizes one `verifyCommitSha` call per
 * distinct sha id across the whole sweep, since the SAME sha may be cited at multiple anchor sites. */
function anchorResolves(repoRoot, a, recordIdSet, shaCache) {
  if (!recordIdSet.has(a.id)) return false;
  if (a.ns !== "sha") return true;
  if (!shaCache.has(a.id)) shaCache.set(a.id, verifyCommitSha(repoRoot, a.id));
  return shaCache.get(a.id);
}

/** Batch-resolve every id in `ids` (bare 8-hex ids) against `repoRoot`'s git history, returning the
 * subset that resolves as a real COMMIT object (card a2fc4031) — ONE `git cat-file --batch-check` call
 * for the whole set rather than one `execFileSync` spawn per id (this repo's own measured bare-id
 * population is in the hundreds; batching is the difference between one process and hundreds of them).
 * `--batch-check` emits exactly one output line per input line, IN THE SAME ORDER (documented git
 * behavior) — so this pairs each output line with `ids[i]` by INDEX, never by parsing the object name a
 * "found" line echoes back (the full resolved oid, not necessarily byte-identical to the possibly-
 * abbreviated input string). A "missing"/ambiguous line and a "found, but not a commit" line both fail
 * the `=== "commit"` check identically, so neither needs separate handling. Any failure (git missing, a
 * non-git `repoRoot`, the bounded `timeout` firing) returns an empty set rather than throwing — mirroring
 * `verifyCommitSha`'s own "any failure reads as unverified" posture: a git failure here must never crash
 * the whole sweep, and must never falsely report a bare id as a commit-collision either.
 */
function batchResolveCommits(repoRoot, ids) {
  if (ids.length === 0) return new Set();
  let out;
  try {
    out = execFileSync("git", ["cat-file", "--batch-check"], {
      cwd: repoRoot,
      input: ids.join("\n") + "\n",
      timeout: 15000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return new Set();
  }
  const lines = out.split("\n");
  const commits = new Set();
  ids.forEach((id, i) => {
    const type = (lines[i] || "").trim().split(/\s+/)[1];
    if (type === "commit") commits.add(id);
  });
  return commits;
}

/** Every BARE (`ns === "card"`) anchor in `anchors` whose id is present in `commitIds` (as returned by
 * `batchResolveCommits`) — the `bareCommitAnchors` check's own filter (card a2fc4031). Every matching SITE
 * is returned, not deduped by id (unlike `orphanAnchors`'s one-per-id dedup) — the originating specimen
 * cited the same commit sha at two separate anchor sites, and both need the fix, not just one. */
function findBareCommitAnchors(anchors, commitIds) {
  return anchors.filter((a) => a.ns === "card" && commitIds.has(a.id));
}

/** Render one anchor's id for a human-facing report line — `sha:<id>` for a commit-namespaced anchor,
 * bare `<id>` for a card one (card 969b0e1c: the sigil must survive into every report/message this lint
 * produces, not just the source grammar, so a reader can never confuse the two id-spaces). */
function renderAnchorId(a) { return a.ns === "sha" ? `sha:${a.id}` : a.id; }

// Card ad3a9a85: a `@decision` keyword that is the LAST thing on its line (only trailing whitespace may
// follow) — the exact shape a JSDoc continuation wrap leaves behind when it breaks the keyword from its
// id onto the next line. Deliberately NARROWER than "not followed by a valid id anywhere on the line":
// a first pass used `/@decision\b(?!\s+[0-9a-f]{8}\b)/` (any `@decision` not immediately followed by a
// valid id) and, swept against this repo, flagged 26 sites — EVERY ONE a false positive, never a real
// wrapped anchor: this file's own doc comments describing the convention (`` `@decision <id>` `` as
// prose), the `ANCHOR_RE`/ANCHOR_RE-equivalent regex LITERAL definitions in this file, decision-records.mjs
// and mcp/decisions.ts (the regex source text itself contains the bare string "@decision" followed by
// `\s+(` — not real whitespace+hex), and this lint's own `formatHookMessage` output strings ("... no
// @decision anchor)", "— @decision ${a.id}"). The mid-line mention of the literal token "@decision" is
// common and legitimate; only a keyword with NOTHING after it on the line is the actual defect signature
// — a real wrap always leaves the keyword dangling alone at end-of-line. See `findBrokenAnchors` below.
// ⛔ Narrower scope, stated plainly: this does NOT catch a same-line malformed id (e.g. `@decision 12ab`,
// too short) — that's a different, rarer shape outside this card's DoD, which is specifically the wrap.
const BROKEN_ANCHOR_RE = /@decision\b\s*$/i;

// @decision afc56dcc — a same-line hex run of 9+ chars after `@decision` (optionally `sha:`-sigil'd, the shape
// a verbatim 40-hex `git blame`/`git log` paste produces).
//
// `ANCHOR_RE` requires exactly 8 hex chars, so this never matches it: silent, total no-op (no anchor, no
// orphanAnchors/brokenAnchors entry, no error). Deliberately the NARROW shape, not the broader "@decision not
// followed by a valid id anywhere on the line" form — that broader form was tried and rejected (card ad3a9a85,
// 26 false positives on this repo's own mid-line "@decision" mentions). Positive-controlled, measured ZERO real
// hits against every `@decision` occurrence in this repo — a proven-able zero, not an artifact of a broken
// pattern. ⛔ Scope, stated plainly (mirrors BROKEN_ANCHOR_RE's own carve-out): does NOT catch the EOL-wrap
// shape (that's BROKEN_ANCHOR_RE above) and does NOT catch a same-line id that's merely too SHORT (e.g.
// "@decision 12ab") — a different, rarer shape outside this card's DoD.
const OVERLONG_ANCHOR_ID_RE = /@decision\s+(sha:)?([0-9a-f]{9,})\b/gi;

// @decision e708670b — a `sha:` sigil with whitespace adjacent to its colon, AFTER it, BEFORE it, or both (e.g.
// "sha" then a space then the colon, or the colon then a space then the hex run, instead of the colon sitting
// directly between "sha" and the hex with nothing in between).
//
// `ANCHOR_RE`'s `sha:` alternative requires the colon to sit directly between "sha" and the hex run with no
// intervening whitespace, and the bare alternative can't match either (the literal text "sha" isn't hex) — so
// there is no position in the line the global scan can match: silent, total no-op (no anchor, no
// orphanAnchors/brokenAnchors/overlongAnchorIds entry, no error). Matches ANY hex run of 8+ chars adjacent to
// the malformed sigil (not just exactly 8), so a combined space-AND-overlong paste is also caught by this one
// pattern rather than needing a second. A sibling defect its own originating card named but shipped unhandled
// once already — never loosen the whitespace requirement to `\s*` on both sides, that also matches the
// well-formed form. Measured ZERO real hits across every placement. ⛔ Scope, stated plainly: does NOT catch a
// same-line id that's too SHORT after/before the space (a different, rarer shape — mirrors every other
// too-short carve-out in this file, and mirrors `overlongAnchorIds`'s own `{8,}` cutoff for the identical
// reason).
const SIGIL_SPACE_RE = /@decision\s+sha(?:\s+:\s*|:\s+)([0-9a-f]{8,})\b/gi;

// Card a862e8f0 — a phrase that POINTS AT the out-of-band record instead of STATING the
// prohibition/consequence in the anchor's own text (CLAUDE.md comment taxonomy: "≤3 lines, no
// 'See docs/…' pointer"). Deliberately a small, literal phrase set — mirrors BROKEN_ANCHOR_RE/
// OVERLONG_ANCHOR_ID_RE's own rejection of a broad heuristic (card ad3a9a85: a broad "not followed by
// a valid id anywhere on the line" pattern produced 26 false positives on this repo's own prose
// describing the convention). Case-insensitive; no `g` flag needed since every caller tests one
// pre-assembled window string and only needs the first match. See `findPointerAnchors` below for how
// the window itself is bounded (the anchor's own site, never a whole-file scan).
const POINTER_PHRASE_RE = /(see\s+docs\/|docs\/adr\/|docs\/decisions\/|docs\/investigations\/|see\s+the\s+linked\s+record|see\s+the\s+record\b)/i;
const FLAT_STORES = ["adr", "decisions"];

// Default N (DoD-3): justified against THIS repo's OWN measured block-length distribution (OBSERVED —
// `node comment-anchor-lint.mjs .` against base commit 67e5c672, population = the 5 SOURCE_ROOTS below,
// 326 files, 10663 blocks — never the card's second-hand figures, which are a DIFFERENT measurement).
// Bucketed by share of total comment VOLUME (lines, not block count): 1-3 lines 11.8%, 4-10 lines 33.2%,
// 11-25 lines 28.0%, 26+ lines 27.0%. 15 sits inside the "11-25" bucket — the largest non-trivial share —
// and clear of the 1-3/4-10 range where the guard-class and ordinary short-comment population lives.
export const DEFAULT_MIN_LINES = 15;
// Class A guard/prohibition ceiling (CLAUDE.md comment taxonomy): "compressed to <=3 lines". A block at
// or under this length that carries an anchor is the target state, never a violation.
export const GUARD_MAX_LINES = 3;

const SOURCE_ROOTS = [
  ["packages", "daemon", "src"],
  ["packages", "daemon", "assets"],
  ["packages", "daemon", "scripts"],
  ["packages", "web", "src"],
  ["packages", "shared", "src"],
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs"]);
// `test`/`tests`/`e2e` excluded deliberately: this repo's own test fixtures plant SYNTHETIC anchor ids
// (aaaaaaaa, deadbeef, cafebabe, ...) with no matching record by design — sweeping them would report
// fixture noise as real orphan-anchor violations. Measuring against real production source only.
const EXCLUDE_SEGMENTS = new Set(["node_modules", "dist", ".turbo", "coverage", "test", "tests", "e2e", ".git"]);
// `SOURCE_ROOTS`, posix-joined with a trailing slash, for the hook's cheap per-file "is this path even in
// scope" prefix test (`isInScope` below) — the same roots `walkSourceFiles` walks for the CLI scan, just
// tested against one relative path instead of driving a directory walk.
const SOURCE_ROOT_PREFIXES = SOURCE_ROOTS.map((parts) => `${parts.join("/")}/`);

const BUCKETS = [
  { key: "1-3", min: 1, max: 3 },
  { key: "4-10", min: 4, max: 10 },
  { key: "11-25", min: 11, max: 25 },
  { key: "26+", min: 26, max: Infinity },
];

function relPath(repoRoot, p) {
  return path.relative(repoRoot, p).replace(/\\/g, "/");
}

/**
 * Group `lines` into maximal contiguous comment-only runs — a blank line or a non-comment line always
 * breaks a block, mirroring `decision-records.mjs`'s own `expandStartToBlock` convention ("blank line =
 * block boundary") so both tools agree on what counts as one block. Handles `//` line comments and
 * `/* ... *\/` block comments (single- or multi-line); does not attempt to distinguish trailing code on
 * the line a block comment closes on — this repo's own style never puts code there.
 *
 * @decision 01e09f28 — a `*\/` closing a `/* ... *\/` comment, immediately followed (no blank line) by
 * a fresh `//`, `/*`, or `/**`, splits into a new block (two abutting doc comments are never one merged
 * run). Narrow: two abutting `//` lines never split (neither closes a `/* ... *\/` comment).
 */
export function extractCommentBlocks(lines) {
  const blocks = [];
  let start = null;
  let anchors = new Set();
  let inBlock = false;
  // True iff the PREVIOUS line was the line a `/* ... */` comment closed on (single- or multi-line) —
  // the doc-comment-boundary predicate above. Reset every iteration; only ever consulted the instant a
  // fresh comment line starts (see `isNewCommentStart` below), never while still inside an open block.
  let prevClosedBlockComment = false;

  const flush = (endLineNo) => {
    if (start !== null) {
      blocks.push({ startLine: start, endLine: endLineNo, length: endLineNo - start + 1, anchorIds: [...anchors] });
    }
    start = null;
    anchors = new Set();
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    let isComment = false;
    let isNewCommentStart = false; // this line freshly opens a comment (// or /*), not a continuation
    let closesBlockComment = false; // this line is the line a /* ... */ comment closes on

    if (inBlock) {
      isComment = true;
      if (trimmed.includes("*/")) { inBlock = false; closesBlockComment = true; }
    } else if (trimmed.startsWith("//")) {
      isComment = true;
      isNewCommentStart = true;
    } else if (trimmed.startsWith("/*")) {
      isComment = true;
      isNewCommentStart = true;
      if (trimmed.includes("*/")) closesBlockComment = true;
      else inBlock = true;
    }

    if (isComment) {
      // Doc-comment boundary: a fresh comment start immediately following a line that closed a
      // `/* ... */` comment splits the run, even though nothing here (yet) breaks contiguity.
      if (isNewCommentStart && prevClosedBlockComment && start !== null) flush(lineNo - 1);
      if (start === null) start = lineNo;
      // `anchorIds` stays a plain set of bare hex ids, namespace-blind — this block-level check only ever
      // asks "does this block carry ANY anchor" (guardClassBlocks / unanchoredLongBlocks), which doesn't
      // care which namespace resolved it; namespace only matters to `orphanAnchors`, which uses
      // `findFileAnchors` below instead.
      for (const m of lines[i].matchAll(ANCHOR_RE)) anchors.add(parseAnchorMatch(m).id);
    } else {
      flush(lineNo - 1);
    }

    prevClosedBlockComment = isComment && closesBlockComment;
  }
  flush(lines.length);
  return blocks;
}

/** Every `@decision <id>` site in `lines`, independent of comment-block grouping (an anchor is still an
 * anchor even on a line this file's own block heuristic fails to classify as a comment). Each entry now
 * also carries `ns` (`"card"` or `"sha"`, card 969b0e1c) and `col` (the match's 0-based character offset
 * on its own line, card f3c054f3 — lets `isMidSentenceAnchorLine` below judge a SPECIFIC anchor's own
 * position rather than the whole line) alongside the unchanged `id`/`line` fields — both purely additive,
 * so existing callers that only read `.id`/`.line` are unaffected. */
export function findFileAnchors(lines) {
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ANCHOR_RE)) found.push({ ...parseAnchorMatch(m), line: i + 1, col: m.index });
  });
  return found;
}

/** Every `@decision` keyword site in `lines` with NOTHING else after it on the same line (card ad3a9a85) —
 * the shape a JSDoc continuation wrap leaves behind when it splits the keyword from its id onto the next
 * line. See `BROKEN_ANCHOR_RE`'s own doc for why this is deliberately narrower than "not followed by a
 * valid id anywhere on the line" (that broader shape false-positives on every mid-line mention of the
 * token). Independent of comment-block grouping, same as `findFileAnchors` above (a broken anchor is
 * still broken even on a line this file's block heuristic fails to classify as a comment). */
export function findBrokenAnchors(lines) {
  const found = [];
  lines.forEach((line, i) => {
    if (BROKEN_ANCHOR_RE.test(line)) found.push({ line: i + 1 });
  });
  return found;
}

/** Every same-line over-long hex anchor id in `lines` (card afc56dcc) — an `@decision` (optionally
 * `sha:`-sigil'd) immediately followed by 9+ hex chars, the shape a verbatim 40-hex `git blame`/`git log`
 * paste produces. `ns` mirrors `parseAnchorMatch`'s own convention ("sha" when the `sha:` sigil matched,
 * else "card") even though the id itself never resolves either way — it's still useful in a report to say
 * which form the author was attempting. `match` carries the full matched text (verbatim) so a report can
 * show exactly what was pasted, not just a line number. Independent of comment-block grouping, same as
 * `findFileAnchors`/`findBrokenAnchors` above. See `OVERLONG_ANCHOR_ID_RE`'s own doc for the scope carve-out
 * (does not catch the EOL-wrap shape or a too-short same-line id). */
export function findOverlongAnchorIds(lines) {
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(OVERLONG_ANCHOR_ID_RE)) {
      found.push({ line: i + 1, ns: m[1] ? "sha" : "card", match: m[0] });
    }
  });
  return found;
}

/** Every same-line `sha`-sigil'd anchor with whitespace adjacent to its colon, on either side or both
 * (card e708670b) — invisible to every other check (see `SIGIL_SPACE_RE`'s own doc for the full mechanism
 * and scope carve-outs). `match` carries the full matched text (verbatim), same convention as
 * `findOverlongAnchorIds`. There is no `ns` field here (unlike `findOverlongAnchorIds`) — every match is
 * necessarily a malformed `sha` sigil by construction (the pattern requires the literal `sha` token plus a
 * colon with adjacent whitespace), so there's nothing to discriminate. Independent of comment-block
 * grouping, same as the other per-line finders above. */
export function findSigilSpaceAnchors(lines) {
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(SIGIL_SPACE_RE)) {
      found.push({ line: i + 1, match: m[0] });
    }
  });
  return found;
}

/** Strip the common `//`, `/*`, `/**`, `*`, `*​/` comment-syntax markers off `line` and trim — a
 * comment-agnostic "what text, if any, does this line actually carry" reduction shared by
 * `isBlankCommentLine`/`startsNewDocTag` below. */
function stripCommentMarkers(line) {
  return line.trim().replace(/^\/\*\*?/, "").replace(/\*\/$/, "").replace(/^\*/, "").replace(/^\/\//, "").trim();
}

/** True iff `line` carries no text once comment markers are stripped — a "blank" JSDoc line (e.g. a bare
 * " * " between two paragraphs) used by `findPointerAnchors` below to end an anchor's own paragraph
 * without ending the whole enclosing comment BLOCK: `extractCommentBlocks` only breaks a block on a
 * genuinely blank (or non-comment) SOURCE line, so a blank `*`-prefixed line inside a `/** ... *​/` run
 * stays part of one contiguous block even though it is exactly the paragraph-break convention JSDoc
 * authors use — this function is what lets `findPointerAnchors` see that break anyway. */
function isBlankCommentLine(line) {
  return stripCommentMarkers(line).length === 0;
}

/** True iff `line`'s own comment text STARTS a new JSDoc tag (`@param`, `@returns`, a follow-on
 * `@decision`, ...) — used by `findPointerAnchors` below as a second paragraph-break signal alongside
 * `isBlankCommentLine`. Deliberately tests the STRIPPED content's own leading character, never a bare
 * `includes("@")` — an inline `{@link X}` reference nested mid-sentence (this file's own style
 * throughout) must never end a run; only a tag that BEGINS the line's visible text does. */
function startsNewDocTag(line) {
  return /^@[A-Za-z]/.test(stripCommentMarkers(line));
}

/** Compute the END line (inclusive) of anchor `a`'s own contiguous paragraph within `blocks` — the SAME
 * paragraph-boundary rule `findPointerAnchors` uses (card 347d37d2), factored out here so every
 * paragraph-scoped check in this file (`findPointerAnchors`, `findOverlongAnchorParagraphs` below) shares
 * ONE computation of what an anchor's "own paragraph" is, rather than a second hand-derived parser (card
 * 5e5841dd's own DoD: "don't invent a second parser"). Starting at `a.line`, the window extends through
 * continuation lines until the FIRST of — (a) the enclosing comment BLOCK's own end; (b) the next
 * `@decision` SITE inside the same block (that site's own paragraph is not this anchor's text, however
 * contiguous the block); (c) a blank JSDoc line (`isBlankCommentLine`) — the ordinary paragraph-break
 * convention; or (d) a line starting a new JSDoc tag (`startsNewDocTag`, e.g. `@param`). A site whose line
 * falls outside every block (should not happen for a real anchor — `ANCHOR_RE` only ever matches inside a
 * comment) degrades to a one-line window rather than throwing. */
function anchorParagraphEnd(a, lines, blocks, anchors) {
  const block = blocks.find((b) => a.line >= b.startLine && a.line <= b.endLine);
  let windowEnd = block ? block.endLine : a.line;
  if (block) {
    for (const other of anchors) {
      if (other === a || other.line <= a.line || other.line > block.endLine) continue;
      if (other.line - 1 < windowEnd) windowEnd = other.line - 1;
    }
  }
  for (let ln = a.line + 1; ln <= windowEnd; ln++) {
    const line = lines[ln - 1] ?? "";
    if (isBlankCommentLine(line) || startsNewDocTag(line)) { windowEnd = ln - 1; break; }
  }
  return windowEnd;
}

/** Every anchor SITE in `anchors` (as returned by `findFileAnchors`) whose own TEXT WINDOW contains a
 * pointer phrase (card a862e8f0) — "see docs/", "docs/adr/", "docs/decisions/", "docs/investigations/",
 * "see the linked record", or "see the record" — instead of stating the prohibition/consequence itself,
 * per the convention (CLAUDE.md comment taxonomy, docs/extraction-program.md: "≤3 lines, no 'See docs/…'
 * pointer").
 *
 * @decision 347d37d2 — the window was a fixed `GUARD_MAX_LINES`-line cap (the anchor's line plus 2
 * continuation lines); a real anchor's own pointer tail landing on its 4th+ line was a false
 * negative on exactly the shape this check exists to catch.
 *
 * The window is the anchor's own CONTIGUOUS PARAGRAPH — see `anchorParagraphEnd` above for exactly where
 * it ends — so a pointer phrase sitting in an UNRELATED later paragraph of the same block (separated from
 * the anchor by one of those boundaries) is never miscounted as part of this anchor's own text. One entry
 * per SITE, not deduped by id (same convention as `findBareCommitAnchors` — every site needs its own fix,
 * independent of how many other sites share the id). `phrase` carries the matched text (trimmed), so a
 * report can show exactly what triggered it, not just a line number.
 *
 * @decision a862e8f0 — ships this check REPORT-ONLY: most of this repo's pre-existing anchors already
 * used the pointer-tail style, too many to gate `guards` on without a separate cleanup first. */
export function findPointerAnchors(lines, blocks, anchors) {
  const found = [];
  for (const a of anchors) {
    const windowEnd = anchorParagraphEnd(a, lines, blocks, anchors);
    const windowLines = [];
    for (let ln = a.line; ln <= windowEnd; ln++) windowLines.push(lines[ln - 1] ?? "");
    const m = POINTER_PHRASE_RE.exec(windowLines.join(" "));
    if (m) found.push({ ...a, phrase: m[0].trim() });
  }
  return found;
}

/** Every anchor SITE in `anchors` whose own paragraph (see `anchorParagraphEnd` above — the SAME window
 * `findPointerAnchors` uses) spans more than `maxLines` lines (default `GUARD_MAX_LINES`, card 5e5841dd) —
 * CLAUDE.md's comment taxonomy requires a guard/prohibition anchor be "compressed to <=3 lines", and
 * nothing enforced it: a 6+ line anchor paragraph is silently counted as "anchored" (it carries a real
 * `@decision <id>`) with no signal that the whole paragraph has drifted past the Class-A guard shape into
 * unbounded narrative. `length` is the paragraph's own line count (`windowEnd - a.line + 1`), so a report
 * can show how far over the cap it ran. One entry per SITE, not deduped by id, same convention as
 * `findPointerAnchors`/`findBareCommitAnchors` above — every site needs its own fix. REPORT-ONLY, same
 * posture as `pointerAnchors` (see that check's own doc): the baseline is non-zero (card 5e5841dd's own
 * DoD-2), so this is not a zero-tolerance gate on the existing corpus. */
export function findOverlongAnchorParagraphs(lines, blocks, anchors, maxLines = GUARD_MAX_LINES) {
  const found = [];
  for (const a of anchors) {
    const windowEnd = anchorParagraphEnd(a, lines, blocks, anchors);
    const length = windowEnd - a.line + 1;
    if (length > maxLines) found.push({ ...a, length });
  }
  return found;
}

/** True iff the text on `line` BEFORE character offset `col` (once comment-prefix markers are stripped,
 * via the same single-application chain `stripCommentMarkers` uses — not a second implementation) is
 * non-empty — i.e. THIS SPECIFIC `@decision` occurrence is not the first thing on the line, so it is
 * embedded MID-SENTENCE inside other prose rather than opening its own line/paragraph (card 5e5841dd's
 * DoD-1(b)). This is what lets a whole contract paragraph get silently relabelled "anchored" by a token
 * buried partway through its own prose — a defect no other check in this file catches, since every other
 * check cares about the id's own SHAPE, never the token's POSITION on the line. Judging a SPECIFIC
 * occurrence's own prefix (not the whole line, card f3c054f3) is what lets this also catch a SECOND
 * `@decision` sharing one physical line with a first: testing the whole line's own start (the original
 * shape) could only ever see the FIRST occurrence's own position, so a second anchor on that same line
 * inherited the first one's "opens the line" verdict no matter where it actually sat. */
function isMidSentenceAnchorLine(line, col) {
  return stripCommentMarkers(line.slice(0, col)).length > 0;
}

/** Every anchor SITE (as returned by `findFileAnchors`) whose own `@decision` occurrence embeds the token
 * mid-sentence rather than opening the line (card 5e5841dd's DoD-1(b)) — see `isMidSentenceAnchorLine`
 * above for the exact predicate, now judged per-occurrence via `a.col` (card f3c054f3) rather than once
 * per line, so a SECOND `@decision` sharing a line with a first is no longer invisible to this check just
 * because the first one legitimately opens the line. One entry per SITE, not deduped by id, same
 * convention as the other per-site checks in this file. REPORT-ONLY, same posture as
 * `pointerAnchors`/`findOverlongAnchorParagraphs` — see card 5e5841dd's own DoD-2 for the measured
 * baseline. */
export function findMidSentenceAnchors(lines, anchors) {
  return anchors.filter((a) => isMidSentenceAnchorLine(lines[a.line - 1] ?? "", a.col));
}

/** True iff `stripped` (already comment-marker-stripped) ends a sentence — card a873621e's own
 * `embeddedAnchors`/`splitAnchorParagraphs` primitive. The DOCTRINE set (lead review, card a873621e round
 * 2): `.`/`!`/`?`/`:`/`)`/`]`/backtick/`"` — the exact set standing kickoff line 14 and every lead-review
 * scan actually runs; a lint that disagreed with the scan reviewers actually use would be the two-
 * instrument-asymmetry anti-pattern (a bare word or code-quoted term closing a citation, e.g. "...already
 * said \"yes, proceed.\"" or "...sends again.)", is a real sentence end, not a dangling clause). See
 * `isDecorativeSeparatorLine` below for the companion boundary this doesn't cover (a line with no prose at
 * all). Measured, not assumed: see this card's own checkpoint/round-2 report for the corpus-wide count. */
function endsSentence(stripped) {
  return /[.!?:)\]`"]$/.test(stripped);
}

/** True iff `stripped` carries no letters or digits at all (a pure box-drawing/rule line, e.g.
 * "└────...────┘"), or is dominated by a long run (6+) of horizontal-rule characters even alongside a
 * section-banner label (e.g. "--- Manager cross-project channel ------...------") — round-2 lead-review
 * finding: a structural section divider is a real paragraph BOUNDARY, never a "doesn't end a sentence"
 * violation, whether or not it also carries a banner label. Deliberately narrow to ASCII/box-drawing rule
 * characters (`-─━═`), never an em-dash (`—`, a different codepoint) — an em-dash is ordinary prose
 * punctuation (see `companion/store.ts:177`'s real, still-flagged specimen, whose preceding line uses two
 * em-dashes and is NOT decorative). */
function isDecorativeSeparatorLine(stripped) {
  if (!/[a-zA-Z0-9]/.test(stripped)) return true;
  return /[-─━═]{6,}/.test(stripped);
}

// card a873621e — the SAME "does the next line continue the sentence" shape used by both
// `findEmbeddedAnchors` (narrow: punctuation only) and `findSplitAnchorParagraphs`'s continuation check
// (wide: punctuation OR a leading lowercase letter). Kept as two separate predicates, not one parameterized
// function, because the two call sites deliberately disagree on whether lowercase counts — collapsing them
// risks a future edit silently re-coupling two constants the checkpoint proved must differ.
const EMBEDDED_NEXT_CONTINUES_RE = /^[)\];,]/;
function looksLikeContinuation(stripped) {
  return EMBEDDED_NEXT_CONTINUES_RE.test(stripped) || /^[a-z]/.test(stripped);
}

// card a873621e — the anchor token itself, so `findEmbeddedAnchors`'s stacking carve-out can look at what
// comes AFTER the id on the anchor's OWN line, not just whether the PRECEDING line belongs to another
// anchor. A legitimate stacked decision states its OWN text right after the id (typically " — <text>",
// matching the anchor grammar in docs/extraction-program.md); a citation embedded mid-sentence (the
// specimen this card was filed over, host.ts's `ac90ca8e`/`3388be4d`) instead continues with closing/
// continuing punctuation ("): closes the native...") — never its own independent statement at all.
const ANCHOR_TOKEN_RE = /^@decision\s+(?:sha:)?[0-9a-f]{8}\b\s*/i;
function textAfterAnchorToken(stripped) {
  return stripped.replace(ANCHOR_TOKEN_RE, "");
}
/** True iff `a`'s own line, immediately after its id, reads as an independent statement rather than a
 * continuation of someone else's clause — see `ANCHOR_TOKEN_RE`'s own doc above. Empty (a bare citation
 * with no dash-explanation at all) also counts as well-formed-enough here — a stacked bare citation is a
 * legitimate style, and `afterBlankContinues` below relies on this same emptiness test for its own
 * `@decision`-line branch. */
function ownStatementLooksWellFormed(strippedOwnLine) {
  const after = textAfterAnchorToken(strippedOwnLine);
  return after.length === 0 || !looksLikeContinuation(after);
}

/** True iff `rawLine` is NOTHING but a block comment's own closing delimiter (one or more asterisks then a
 * closing slash, optionally lead-padded — e.g. a lone " " + star + slash) — `isBlankCommentLine` above would
 * otherwise misclassify it as an inserted blank paragraph-separator, since `stripCommentMarkers` strips that
 * trailing delimiter and leaves nothing. `findSplitAnchorParagraphs` below is the only caller that needs this
 * distinction (the block's own mandatory closing line is never an "inserted" artifact); `anchorParagraphEnd`'s
 * own existing blank-line handling, shared by `overlongAnchorParagraphs`/`pointerAnchors`, is UNCHANGED and
 * untouched by this. */
function isBareClosingDelimiterLine(rawLine) {
  return /^\*+\/$/.test(rawLine.trim());
}

/** Every anchor SITE in `anchors` whose own line opens correctly (so `midSentenceAnchors` above stays
 * silent) but is still embedded inside a LARGER sentence spanning an adjacent comment line (card a873621e).
 * See this file's header, check 13, for the full rationale and the measured reason the "next line continues"
 * side deliberately excludes a leading lowercase letter and an em-dash. Returns `{items, stacked}`:
 * `items` is the reportable `embeddedAnchors` population; `stacked` is the carved-out "previous line is
 * another anchor's own unterminated paragraph tail" population (surfaced separately, never counted here) —
 * see `computeReport`/`computeFileReport` for how the two are assembled into `embeddedAnchors`'s own shape.
 * One entry per SITE, not deduped by id, same convention as every other per-site check in this file. */
export function findEmbeddedAnchors(lines, blocks, anchors) {
  const items = [];
  const stacked = [];
  for (const a of anchors) {
    const block = blocks.find((b) => a.line >= b.startLine && a.line <= b.endLine);
    if (!block) continue;
    // `midSentenceAnchors` already owns "the @decision token isn't first on its own line" — never count
    // that population here too (round-2 lead-review finding: 15 of 24 hits on main were exactly this,
    // because this check never verified the anchor's OWN line before looking at its neighbors). Passing
    // `a.col` (card f3c054f3) keeps this skip correct when a second `@decision` shares `a`'s own line with
    // a first — without it this call judged the LINE, not `a`'s own occurrence, and a second same-line
    // anchor wrongly inherited the first one's "opens the line" verdict.
    if (isMidSentenceAnchorLine(lines[a.line - 1] ?? "", a.col)) continue;

    let rawPrevViolation = false;
    let isStackedTail = false;
    if (a.line > block.startLine) {
      const prevStripped = stripCommentMarkers(lines[a.line - 2] ?? "");
      if (prevStripped.length > 0 && !endsSentence(prevStripped) && !isDecorativeSeparatorLine(prevStripped)) {
        rawPrevViolation = true;
        // Is the preceding line exactly the LAST line of a DIFFERENT anchor's own already-computed
        // paragraph (a legitimate stacked-anchors run, no blank line between them) AND does `a`'s OWN line
        // read as an independent statement (not a continuation of that other anchor's own clause)? Both
        // must hold — the second is what tells `ac90ca8e`/`3388be4d` (a citation, "): closes...") apart
        // from a genuine adjacent decision like `eeeeeeee`/`ffffffff` (its own "— runs the shared..." text).
        let prevAnchor = null;
        for (const other of anchors) {
          if (other === a || other.line < block.startLine || other.line >= a.line) continue;
          if (!prevAnchor || other.line > prevAnchor.line) prevAnchor = other;
        }
        const ownLineStripped = stripCommentMarkers(lines[a.line - 1] ?? "");
        if (prevAnchor && anchorParagraphEnd(prevAnchor, lines, blocks, anchors) === a.line - 1
          && ownStatementLooksWellFormed(ownLineStripped)) {
          isStackedTail = true;
        }
      }
    }
    const prevViolation = rawPrevViolation && !isStackedTail;

    let nextViolation = false;
    if (a.line < block.endLine) {
      const nextStripped = stripCommentMarkers(lines[a.line] ?? "");
      if (nextStripped.length > 0 && EMBEDDED_NEXT_CONTINUES_RE.test(nextStripped)) nextViolation = true;
    }

    if (prevViolation || nextViolation) items.push({ ...a, prevViolation, nextViolation });
    if (rawPrevViolation && isStackedTail) stacked.push({ ...a });
  }
  return { items, stacked };
}

/** True iff `strippedLine` (the first content line right after an inserted blank) reads as a CONTINUATION
 * of the sentence that preceded the blank (card a873621e round 2) — the defect signal `findSplitAnchor
 * Paragraphs` below now keys on, replacing the old "last character" test. Two shapes: (1) ordinary prose
 * starting with a lowercase letter or closing/continuing punctuation (`looksLikeContinuation`); or (2) an
 * `@decision` line whose OWN text after the id is itself a continuation (`!ownStatementLooksWellFormed`) —
 * the shape Fixture B needs (the blank sits between "by" and the `3388be4d` anchor line, "...): closes...",
 * so the line right after the blank IS an anchor line, not ordinary prose, and its own trailing text is
 * what reveals the cut). A bare citation-only anchor never matches either branch of `ownStatementLooksWellFormed`'s
 * OWN test (empty trailing text reads as well-formed there), so this correctly leaves a genuine citation
 * alone while still catching one whose surrounding prose actually continues. */
function afterBlankContinues(strippedLine) {
  if (strippedLine.length === 0) return false;
  if (/^@decision\b/i.test(strippedLine)) return !ownStatementLooksWellFormed(strippedLine);
  return looksLikeContinuation(strippedLine);
}

/** Every anchor SITE in `anchors` whose own paragraph (the SAME `anchorParagraphEnd` window
 * `overlongAnchorParagraphs`/`pointerAnchors` share) ends at a genuinely blank comment line (card a873621e;
 * round 2 lead review) — see this file's header, check 14, for the full rationale. Returns `{items,
 * unterminated}`: `items` is the reportable `splitAnchorParagraphs` population — the content right after
 * the blank CONTINUES the sentence (`afterBlankContinues` above), meaning the blank line genuinely cut a
 * live sentence in two. `unterminated` (never counted in `items`, mirrors `embeddedAnchors.stacked`'s
 * carve-out shape) is a SEPARATE, informational population: the paragraph's own last line lacks doctrine
 * terminal punctuation (`endsSentence`/`isDecorativeSeparatorLine`) but what follows the blank is a
 * genuinely FRESH paragraph, not a continuation — a missing-period nit, not a cut sentence. A paragraph
 * whose last line DOES end properly AND whose follow-on doesn't continue is CLEAN — not reported anywhere
 * (round-2 measured: 7 of the original 21 hits were exactly this, once the doctrine's real punctuation set
 * — see `endsSentence` — is applied). The old bare-citation special case falls out of this naturally: a
 * bare `@decision <id>` token's own trailing text is empty, so `afterBlankContinues`'s `@decision` branch
 * only fires when a FOLLOWING `@decision` line's own text continues, never for the citation's own (non-
 * `@decision`) follow-on prose — which is judged by the SAME ordinary continuation test as everything else.
 * One entry per SITE, not deduped by id, same convention as every other per-site check in this file. */
export function findSplitAnchorParagraphs(lines, blocks, anchors) {
  const items = [];
  const unterminated = [];
  for (const a of anchors) {
    const block = blocks.find((b) => a.line >= b.startLine && a.line <= b.endLine);
    if (!block) continue;
    const windowEnd = anchorParagraphEnd(a, lines, blocks, anchors);
    const afterLn = windowEnd + 1;
    if (afterLn > block.endLine) continue; // paragraph ended at the block's own end, not a blank line
    const afterLine = lines[afterLn - 1] ?? "";
    if (isBareClosingDelimiterLine(afterLine)) continue; // the block's own closing "*/", not an inserted blank
    if (!isBlankCommentLine(afterLine)) continue; // ended due to the next anchor / a new doc tag

    const lastContent = stripCommentMarkers(lines[windowEnd - 1] ?? "");
    if (lastContent.length === 0) continue;

    // A paragraph whose own last line ALREADY ends properly (doctrine punctuation, or a decorative
    // divider) is clean regardless of what happens to follow it — an ordinary blank-line paragraph break
    // is legitimate, and the text after it is a NEW paragraph's business, not this anchor's. Continuation
    // only means anything for a paragraph that did NOT terminate properly in the first place.
    const terminatesProperly = endsSentence(lastContent) || isDecorativeSeparatorLine(lastContent);
    if (terminatesProperly) continue;

    const nextContentStripped = stripCommentMarkers(lines[afterLn] ?? "");
    if (afterBlankContinues(nextContentStripped)) items.push({ ...a, blankLine: afterLn });
    else unterminated.push({ ...a, blankLine: afterLn });
  }
  return { items, unterminated };
}

/** True iff `nameLower` is `id` followed by a real boundary — mirrors decision-records.mjs's own
 * `idBoundaryMatch` (same rationale: never let id `deadbeef` bare-prefix-match `deadbeefcafe-other.md`). */
function idBoundaryMatch(nameLower, id) {
  if (!nameLower.startsWith(id)) return false;
  const rest = nameLower.slice(id.length);
  return rest === "" || rest.startsWith("-") || rest.startsWith(".");
}

/** Every record this convention can actually resolve an anchor against, across all three stores
 * `decision-records.mjs` resolves at runtime (see this file's header for why investigations is included
 * despite the card text naming only two registers). */
export function listRecordIds(repoRoot) {
  const records = [];
  for (const store of FLAT_STORES) {
    const dir = path.join(repoRoot, "docs", store);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (!lower.endsWith(".md") || lower === "template.md") continue;
      const m = /^([0-9a-f]{8})[-.]/.exec(lower);
      if (m && idBoundaryMatch(lower, m[1])) records.push({ id: m[1], path: path.join(dir, name) });
    }
  }
  const invDir = path.join(repoRoot, "docs", "investigations");
  let entries;
  try { entries = fs.readdirSync(invDir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const lower = e.name.toLowerCase();
    const m = /^([0-9a-f]{8})-/.exec(lower);
    if (!m) continue;
    const findings = path.join(invDir, e.name, "findings.md");
    if (fs.existsSync(findings)) records.push({ id: m[1], path: findings });
  }
  return records;
}

/** Every record in `records` (as returned by `listRecordIds`) whose file exceeds `maxBytes` — measured the
 * SAME way `decision-records.mjs`'s own truncation functions measure it (UTF-8 byte length of the raw
 * file text, never a character/UTF-16 count — this repo's house typography is multi-byte, so the two
 * diverge).
 *
 * @decision d0d0401b
 *
 * This is the visible, authoring-time half of the size constraint; read-time truncation
 * (decision-records.mjs) stays the last-resort safety net, unchanged. An unreadable record is skipped
 * (never crashes the sweep) — a record that can't be read can't be injected either, so it's not this
 * check's problem to report. */
export function findOversizedRecords(records, maxBytes) {
  const oversized = [];
  for (const r of records) {
    let text;
    try { text = fs.readFileSync(r.path, "utf8"); } catch { continue; }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) oversized.push({ id: r.id, path: r.path, bytes });
  }
  return oversized;
}

/** True iff `recordPath` lives in one of the flat stores (`docs/adr`, `docs/decisions`) — never
 * `docs/investigations` — mirroring `FLAT_STORES`. */
function isFlatStorePath(repoRoot, recordPath) {
  const rel = relPath(repoRoot, recordPath).toLowerCase();
  return FLAT_STORES.some((s) => rel.startsWith(`docs/${s}/`));
}

/**
 * Every record in `records`, SCOPED TO `docs/adr` + `docs/decisions` ONLY, that has no 'Do not'-style
 * heading at any level (`hasDoNotSection`, imported from decision-records.mjs — the SAME predicate that
 * script uses to decide between Do-not-section injection and the no-Do-not fallback, one source of truth).
 *
 * Card `abd049da`: `docs/investigations/**\/findings.md` records are deliberately EXCLUDED from this
 * check — they are narrative investigation reports, not prohibition-carrying decision records, and
 * legitimately have no 'Do not' section to state. Extending this check to them would force a fabricated
 * prohibition into records that structurally have none. `decision-records.mjs`'s runtime fallback still
 * covers them (an explicit "no Do-not section" note, never silence) — this authoring-time check just
 * doesn't ask investigations to close that gap.
 *
 * An unreadable record is skipped (mirrors `findOversizedRecords`'s own posture).
 */
export function findRecordsMissingDoNot(repoRoot, records) {
  const missing = [];
  for (const r of records) {
    if (!isFlatStorePath(repoRoot, r.path)) continue;
    let text;
    try { text = fs.readFileSync(r.path, "utf8"); } catch { continue; }
    if (!hasDoNotSection(text)) missing.push({ id: r.id, path: r.path });
  }
  return missing;
}

/**
 * Every id with more than one candidate record file across the three stores, naming EVERY candidate and
 * which one currently wins (card a4b83fb7). Deliberately NOT built from `listRecordIds` above — that
 * function collapses store identity into a flat list, which loses exactly the information needed to
 * replicate `decision-records.mjs`'s own `resolveRecord()` winner pick: store precedence (`docs/adr`
 * before `docs/decisions` before `docs/investigations` — an id split across stores is decided by
 * precedence ALONE, never by filename, even if a `docs/decisions` file would sort first alphabetically),
 * then alphabetically-first WITHIN the winning store. This walks the same three directories itself
 * (duplicated, not imported — same "assets ship standalone" reasoning as `ANCHOR_RE`/`idBoundaryMatch`
 * above) so the winner this check reports is never a second, drifting implementation of that rule.
 * `.md` sort uses plain `<`/`>` (mirrors `resolveRecord`'s bare `.sort()`, i.e. UTF-16 code-unit order —
 * these filenames are ASCII, so this is equivalent to `resolveRecord`'s own default sort in every real
 * case); the investigations directory match uses `localeCompare`, mirroring `resolveRecord`'s own second
 * sort call exactly. Every other candidate for that id is DARK: unreachable by any anchor, ever, however
 * many anchors cite it — see this check's own header doc above for why neither `orphanAnchors` nor
 * `orphanRecords` can ever catch this (the anchor resolves fine; every candidate file has a record).
 */
export function findCollidingRecords(repoRoot) {
  const STORE_ORDER = [...FLAT_STORES, "investigations"];
  const byId = new Map(); // id -> [{ store, name, path }], in no particular order within the array

  for (const store of FLAT_STORES) {
    const dir = path.join(repoRoot, "docs", store);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (!lower.endsWith(".md") || lower === "template.md") continue;
      const m = /^([0-9a-f]{8})[-.]/.exec(lower);
      if (!m || !idBoundaryMatch(lower, m[1])) continue;
      const id = m[1];
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ store, name, path: path.join(dir, name) });
    }
  }
  const invDir = path.join(repoRoot, "docs", "investigations");
  let invEntries;
  try { invEntries = fs.readdirSync(invDir, { withFileTypes: true }); } catch { invEntries = []; }
  for (const e of invEntries) {
    if (!e.isDirectory()) continue;
    const lower = e.name.toLowerCase();
    const m = /^([0-9a-f]{8})-/.exec(lower);
    if (!m || !idBoundaryMatch(lower, m[1])) continue;
    const findings = path.join(invDir, e.name, "findings.md");
    if (!fs.existsSync(findings)) continue;
    const id = m[1];
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ store: "investigations", name: e.name, path: findings });
  }

  const colliding = [];
  for (const [id, candidates] of byId) {
    if (candidates.length <= 1) continue;
    let winner = null;
    for (const store of STORE_ORDER) {
      const inStore = candidates.filter((c) => c.store === store);
      if (inStore.length === 0) continue;
      winner = store === "investigations"
        ? [...inStore].sort((a, b) => a.name.localeCompare(b.name))[0]
        : [...inStore].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
      break;
    }
    colliding.push({
      id,
      winnerPath: relPath(repoRoot, winner.path),
      darkPaths: candidates.filter((c) => c !== winner).map((c) => relPath(repoRoot, c.path)),
    });
  }
  return colliding;
}

// @decision b8ae239e — do not exempt a decisions/adr + investigations collision by STORE SHAPE alone; the
// winner must CITE its dark sibling's exact path in its own text, or the collision stays flagged.
function isVerifiedInvestigationCrossReference(repoRoot, item) {
  if (!FLAT_STORES.some((store) => item.winnerPath.startsWith(`docs/${store}/`))) return false;
  if (item.darkPaths.length === 0) return false;
  if (!item.darkPaths.every((p) => p.startsWith("docs/investigations/"))) return false;
  let winnerText;
  try { winnerText = fs.readFileSync(path.join(repoRoot, item.winnerPath), "utf8"); } catch { return false; }
  return item.darkPaths.every((p) => winnerText.includes(p));
}

function walkSourceFiles(repoRoot) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (EXCLUDE_SEGMENTS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      if (SOURCE_EXTENSIONS.has(path.extname(e.name))) files.push(full);
    }
  };
  for (const parts of SOURCE_ROOTS) walk(path.join(repoRoot, ...parts));
  return files;
}

/** Bucket every block's LENGTH into the four card-cited ranges, reporting each bucket's share of total
 * comment VOLUME (sum of block lengths in the bucket / sum over all blocks) — a block count would
 * under-weight the few very long blocks that actually dominate how much narrative sits in source. */
export function bucketDistribution(blocks) {
  const totals = BUCKETS.map(() => ({ blocks: 0, lines: 0 }));
  let totalLines = 0;
  for (const b of blocks) {
    totalLines += b.length;
    const idx = BUCKETS.findIndex((bk) => b.length >= bk.min && b.length <= bk.max);
    if (idx >= 0) { totals[idx].blocks += 1; totals[idx].lines += b.length; }
  }
  const out = {};
  BUCKETS.forEach((bk, i) => {
    out[bk.key] = {
      blocks: totals[i].blocks,
      lines: totals[i].lines,
      pctOfCommentVolume: totalLines ? Number(((totals[i].lines / totalLines) * 100).toFixed(1)) : 0,
    };
  });
  return out;
}

/**
 * Scan `repoRoot` and compute all ten checks plus the calibration distribution. Never throws on a
 * violation being found — violations are just data in the returned report (DoD-1/2: warn-only, with the
 * count reported). `opts.minLines` overrides `DEFAULT_MIN_LINES` (DoD-3: N is configurable).
 */
export function computeReport(repoRoot, opts = {}) {
  const minLines = Number.isInteger(opts.minLines) && opts.minLines > 0 ? opts.minLines : DEFAULT_MIN_LINES;
  const files = walkSourceFiles(repoRoot);
  const allBlocks = [];
  const allAnchors = [];
  const allBroken = [];
  const allOverlong = [];
  const allSigilSpace = [];
  const allPointer = [];
  const allOverlongParagraph = [];
  const allMidSentence = [];
  const allEmbedded = [];
  const allEmbeddedStacked = [];
  const allSplitParagraph = [];
  const allSplitParagraphUnterminated = [];

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = raw.split(/\r?\n/);
    const blocks = extractCommentBlocks(lines);
    const anchors = findFileAnchors(lines);
    for (const b of blocks) allBlocks.push({ file, ...b });
    for (const a of anchors) allAnchors.push({ ...a, file });
    for (const b of findBrokenAnchors(lines)) allBroken.push({ ...b, file });
    for (const o of findOverlongAnchorIds(lines)) allOverlong.push({ ...o, file });
    for (const s of findSigilSpaceAnchors(lines)) allSigilSpace.push({ ...s, file });
    for (const p of findPointerAnchors(lines, blocks, anchors)) allPointer.push({ ...p, file });
    for (const o of findOverlongAnchorParagraphs(lines, blocks, anchors)) allOverlongParagraph.push({ ...o, file });
    for (const m of findMidSentenceAnchors(lines, anchors)) allMidSentence.push({ ...m, file });
    const embedded = findEmbeddedAnchors(lines, blocks, anchors);
    for (const e of embedded.items) allEmbedded.push({ ...e, file });
    for (const e of embedded.stacked) allEmbeddedStacked.push({ ...e, file });
    const splitParagraph = findSplitAnchorParagraphs(lines, blocks, anchors);
    for (const s of splitParagraph.items) allSplitParagraph.push({ ...s, file });
    for (const s of splitParagraph.unterminated) allSplitParagraphUnterminated.push({ ...s, file });
  }

  const records = listRecordIds(repoRoot);
  const recordIdSet = new Set(records.map((r) => r.id));
  const anchorIdSet = new Set(allAnchors.map((a) => a.id));
  const oversizedRecords = findOversizedRecords(records, PER_RECORD_MAX_BYTES);
  const allCollidingRecords = findCollidingRecords(repoRoot);
  const verifiedCollidingRecords = allCollidingRecords.filter((item) => isVerifiedInvestigationCrossReference(repoRoot, item));
  const collidingRecords = allCollidingRecords.filter((item) => !isVerifiedInvestigationCrossReference(repoRoot, item));
  const missingDoNotRecords = findRecordsMissingDoNot(repoRoot, records);

  const unanchoredLong = allBlocks.filter((b) => b.length >= minLines && b.anchorIds.length === 0);
  const guardClass = allBlocks.filter((b) => b.length <= GUARD_MAX_LINES && b.anchorIds.length > 0);

  // One representative site per orphaned (ns, id) pair (a repeated anchor isn't a new violation each
  // occurrence) — keyed by "ns:id" (card 969b0e1c) so a sha-sigil'd anchor and a card anchor sharing the
  // same 8 hex characters are never conflated into one orphan entry.
  const shaCache = new Map();
  const orphanAnchorsById = new Map();
  for (const a of allAnchors) {
    const key = `${a.ns}:${a.id}`;
    if (!anchorResolves(repoRoot, a, recordIdSet, shaCache) && !orphanAnchorsById.has(key)) orphanAnchorsById.set(key, a);
  }
  const orphanRecords = records.filter((r) => !anchorIdSet.has(r.id));

  const cardIds = [...new Set(allAnchors.filter((a) => a.ns === "card").map((a) => a.id))];
  const commitResolvedIds = batchResolveCommits(repoRoot, cardIds);
  const bareCommitAnchors = findBareCommitAnchors(allAnchors, commitResolvedIds);

  return {
    repoRoot,
    minLines,
    guardMaxLines: GUARD_MAX_LINES,
    filesScanned: files.length,
    totalCommentBlocks: allBlocks.length,
    totalAnchorSites: allAnchors.length,
    uniqueAnchorIds: anchorIdSet.size,
    recordCount: records.length,
    unanchoredLongBlocks: {
      count: unanchoredLong.length,
      items: unanchoredLong.map((b) => ({ file: relPath(repoRoot, b.file), startLine: b.startLine, endLine: b.endLine, length: b.length })),
    },
    guardClassBlocks: { count: guardClass.length },
    orphanAnchors: {
      count: orphanAnchorsById.size,
      // `id` stays the bare hex (namespace-blind — unchanged shape, so an existing card-id comparison like
      // `items[0].id === "dddddddd"` keeps working); `ns` is additive (card 969b0e1c).
      items: [...orphanAnchorsById.values()].map((a) => ({ id: a.id, ns: a.ns, file: relPath(repoRoot, a.file), line: a.line })),
    },
    orphanRecords: {
      count: orphanRecords.length,
      advisory: true, // DoD-2: never an error — a policy-level record may legitimately have no anchor site.
      items: orphanRecords.map((r) => ({ id: r.id, path: relPath(repoRoot, r.path) })),
    },
    brokenAnchors: {
      count: allBroken.length,
      items: allBroken.map((b) => ({ file: relPath(repoRoot, b.file), line: b.line })),
    },
    overlongAnchorIds: {
      count: allOverlong.length,
      items: allOverlong.map((o) => ({ file: relPath(repoRoot, o.file), line: o.line, ns: o.ns, match: o.match })),
    },
    sigilSpaceAnchors: {
      count: allSigilSpace.length,
      items: allSigilSpace.map((s) => ({ file: relPath(repoRoot, s.file), line: s.line, match: s.match })),
    },
    oversizedRecords: {
      count: oversizedRecords.length,
      maxBytes: PER_RECORD_MAX_BYTES,
      items: oversizedRecords.map((r) => ({ id: r.id, path: relPath(repoRoot, r.path), bytes: r.bytes })),
    },
    collidingRecords: {
      count: collidingRecords.length,
      items: collidingRecords,
      // Card b8ae239e: a decisions/adr + investigations collision whose winner explicitly cites its dark
      // sibling's path is a verified, deliberate pairing — excluded from `count`/`items` above (it is not
      // the `ccb407eb` harm shape) but still surfaced here, never silently dropped.
      verified: {
        count: verifiedCollidingRecords.length,
        items: verifiedCollidingRecords,
      },
    },
    missingDoNotRecords: {
      count: missingDoNotRecords.length,
      // Card abd049da: scoped to docs/adr + docs/decisions only — docs/investigations findings.md
      // records are narrative reports, explicitly accepted as having no 'Do not' section (see
      // findRecordsMissingDoNot's own doc).
      scope: "docs/adr + docs/decisions only",
      items: missingDoNotRecords.map((r) => ({ id: r.id, path: relPath(repoRoot, r.path) })),
    },
    bareCommitAnchors: {
      count: bareCommitAnchors.length,
      items: bareCommitAnchors.map((a) => ({ file: relPath(repoRoot, a.file), line: a.line, id: a.id })),
    },
    pointerAnchors: {
      count: allPointer.length,
      // REPORT-ONLY (card a862e8f0 — see this file's header, check 10): never fails `guards`, unlike a
      // future guard would; a worker reads this field directly per docs/extraction-program.md.
      items: allPointer.map((p) => ({ file: relPath(repoRoot, p.file), line: p.line, id: p.id, ns: p.ns, phrase: p.phrase })),
    },
    overlongAnchorParagraphs: {
      count: allOverlongParagraph.length,
      // REPORT-ONLY (card 5e5841dd — see this file's header, check 11): same posture as pointerAnchors.
      items: allOverlongParagraph.map((o) => ({ file: relPath(repoRoot, o.file), line: o.line, id: o.id, ns: o.ns, length: o.length })),
    },
    midSentenceAnchors: {
      count: allMidSentence.length,
      // REPORT-ONLY (card 5e5841dd — see this file's header, check 12): same posture as pointerAnchors.
      items: allMidSentence.map((m) => ({ file: relPath(repoRoot, m.file), line: m.line, id: m.id, ns: m.ns })),
    },
    embeddedAnchors: {
      count: allEmbedded.length,
      // REPORT-ONLY (card a873621e — see this file's header, check 13): same posture as pointerAnchors.
      items: allEmbedded.map((e) => ({ file: relPath(repoRoot, e.file), line: e.line, id: e.id, ns: e.ns, prevViolation: e.prevViolation, nextViolation: e.nextViolation })),
      // Stacked-anchor "previous anchor's own tail lacks a period" sites, carved OUT of `count`/`items`
      // above (see `findEmbeddedAnchors`'s own doc) — informational only, never a violation by itself.
      stackedUnterminated: {
        count: allEmbeddedStacked.length,
        items: allEmbeddedStacked.map((e) => ({ file: relPath(repoRoot, e.file), line: e.line, id: e.id, ns: e.ns })),
      },
    },
    splitAnchorParagraphs: {
      count: allSplitParagraph.length,
      // REPORT-ONLY (card a873621e — see this file's header, check 14): same posture as pointerAnchors.
      items: allSplitParagraph.map((s) => ({ file: relPath(repoRoot, s.file), line: s.line, id: s.id, ns: s.ns, blankLine: s.blankLine })),
      // Missing-a-period-before-a-FRESH-paragraph sites, carved OUT of `count`/`items` above (see
      // `findSplitAnchorParagraphs`'s own doc) — informational only, mirrors `embeddedAnchors.
      // stackedUnterminated`'s shape: a punctuation nit, never a cut sentence.
      unterminated: {
        count: allSplitParagraphUnterminated.length,
        items: allSplitParagraphUnterminated.map((s) => ({ file: relPath(repoRoot, s.file), line: s.line, id: s.id, ns: s.ns, blankLine: s.blankLine })),
      },
    },
    distribution: bucketDistribution(allBlocks),
  };
}

// --- per-file hook mode (card 67621894) -------------------------------------------------------------

/**
 * Cheap "is this path even worth linting" test — extension + SOURCE_ROOTS prefix + no excluded segment
 * (mirrors `walkSourceFiles`'s own filters, tested against one relative path instead of a directory walk).
 * Returns the repo-relative path on a match, else `null`. For a repo NOT shaped like this one (no
 * `packages/{daemon,web,shared}/...` layout — i.e. every OTHER Loom-managed project) every write fails
 * this prefix test and the hook is a fast no-op: the SOURCE_ROOTS list itself is what scopes this lint to
 * this repo, the same way the CLI scan is already scoped by it — not a new limitation the hook introduces.
 */
export function isInScope(repoRoot, filePath) {
  const rel = relPath(repoRoot, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // outside repoRoot entirely
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return null;
  if (!SOURCE_ROOT_PREFIXES.some((p) => rel.startsWith(p))) return null;
  if (rel.split("/").some((seg) => EXCLUDE_SEGMENTS.has(seg))) return null;
  return rel;
}

/**
 * The hook's actual per-file check: checks (1) unanchoredLongBlocks, (2) orphanAnchors, (4) brokenAnchors,
 * (7) overlongAnchorIds, (8) sigilSpaceAnchors, (9) bareCommitAnchors, (10) pointerAnchors, (11)
 * overlongAnchorParagraphs, and (12) midSentenceAnchors — see this file's header for why (3) orphanRecords,
 * (5) oversizedRecords, and (6) collidingRecords are deliberately excluded (all three need the whole repo's
 * record/anchor corpus, not just this one file) — scoped to ONE file's already-read `content`, never a
 * repo walk. `listRecordIds` is the only filesystem cost beyond the one file read: a `readdirSync` of up to
 * three small `docs/<kind>` directories (a handful of entries each in this repo today), not a source-tree
 * scan — see this function's own doc in `computeReport` above for why it's cheap. `bareCommitAnchors` adds
 * one `git cat-file --batch-check` call scoped to this file's own (usually tiny) set of bare-anchor ids —
 * the same cost model `orphanAnchors`' sha-verification already pays per file. `pointerAnchors`,
 * `overlongAnchorParagraphs`, and `midSentenceAnchors` are all free beyond that — they reuse
 * `blocks`/`anchors` already computed here for the other per-file checks, no extra filesystem or git cost.
 * Returns `null` for a file outside `isInScope`'s scope; otherwise a report shaped for `formatHookMessage`
 * below (empty arrays when the file is in scope but has nothing to flag — a real, distinguishable "clean"
 * result, not the same `null` as "not even scanned").
 */
export function computeFileReport(repoRoot, filePath, content, opts = {}) {
  const rel = isInScope(repoRoot, filePath);
  if (rel === null) return null;
  const minLines = Number.isInteger(opts.minLines) && opts.minLines > 0 ? opts.minLines : DEFAULT_MIN_LINES;

  const lines = content.split(/\r?\n/);
  const blocks = extractCommentBlocks(lines);
  const anchors = findFileAnchors(lines);
  const broken = findBrokenAnchors(lines);
  const overlong = findOverlongAnchorIds(lines);
  const sigilSpace = findSigilSpaceAnchors(lines);
  const pointer = findPointerAnchors(lines, blocks, anchors);
  const overlongParagraph = findOverlongAnchorParagraphs(lines, blocks, anchors);
  const midSentence = findMidSentenceAnchors(lines, anchors);
  const embedded = findEmbeddedAnchors(lines, blocks, anchors);
  const splitParagraph = findSplitAnchorParagraphs(lines, blocks, anchors);
  const unanchoredLong = blocks.filter((b) => b.length >= minLines && b.anchorIds.length === 0);

  const recordIdSet = new Set(listRecordIds(repoRoot).map((r) => r.id));
  const shaCache = new Map();
  const orphanAnchorsById = new Map();
  for (const a of anchors) {
    const key = `${a.ns}:${a.id}`;
    if (!anchorResolves(repoRoot, a, recordIdSet, shaCache) && !orphanAnchorsById.has(key)) orphanAnchorsById.set(key, a);
  }

  const cardIds = [...new Set(anchors.filter((a) => a.ns === "card").map((a) => a.id))];
  const commitResolvedIds = batchResolveCommits(repoRoot, cardIds);
  const bareCommitAnchors = findBareCommitAnchors(anchors, commitResolvedIds);

  return {
    file: rel,
    minLines,
    unanchoredLongBlocks: unanchoredLong.map((b) => ({ startLine: b.startLine, endLine: b.endLine, length: b.length })),
    orphanAnchors: [...orphanAnchorsById.values()].map((a) => ({ id: a.id, ns: a.ns, line: a.line })),
    brokenAnchors: broken.map((b) => ({ line: b.line })),
    overlongAnchorIds: overlong.map((o) => ({ line: o.line, ns: o.ns, match: o.match })),
    sigilSpaceAnchors: sigilSpace.map((s) => ({ line: s.line, match: s.match })),
    bareCommitAnchors: bareCommitAnchors.map((a) => ({ line: a.line, id: a.id })),
    pointerAnchors: pointer.map((p) => ({ line: p.line, id: p.id, ns: p.ns, phrase: p.phrase })),
    overlongAnchorParagraphs: overlongParagraph.map((o) => ({ line: o.line, id: o.id, ns: o.ns, length: o.length })),
    midSentenceAnchors: midSentence.map((m) => ({ line: m.line, id: m.id, ns: m.ns })),
    embeddedAnchors: embedded.items.map((e) => ({ line: e.line, id: e.id, ns: e.ns, prevViolation: e.prevViolation, nextViolation: e.nextViolation })),
    embeddedAnchorsStacked: embedded.stacked.map((e) => ({ line: e.line, id: e.id, ns: e.ns })),
    splitAnchorParagraphs: splitParagraph.items.map((s) => ({ line: s.line, id: s.id, ns: s.ns, blankLine: s.blankLine })),
    splitAnchorParagraphsUnterminated: splitParagraph.unterminated.map((s) => ({ line: s.line, id: s.id, ns: s.ns, blankLine: s.blankLine })),
  };
}

/** Render a non-empty `computeFileReport` result as the advisory text handed back to the agent.
 * `pointerAnchorsOmitted` (default 0, card a862e8f0) is the count `scopeHookAnchorSites` trimmed off
 * `report.pointerAnchors` before this call — when >0, an extra line says so, rather than the agent seeing
 * a shorter list with no explanation for why. `overlongAnchorParagraphsOmitted`/`midSentenceAnchorsOmitted`
 * (default 0, card 5e5841dd) are the SAME convention for those two fields. `embeddedAnchorsOmitted`/
 * `splitAnchorParagraphsOmitted` (default 0, card a873621e) are the SAME convention for those two fields —
 * `embeddedAnchors.stackedUnterminated` is never scoped/capped (it's informational, not a violation, and in
 * practice small — see this file's header, check 13). All five omitted-count params are optional and
 * additive: every existing call site (including every prior test) that omits them keeps rendering
 * byte-identical output. */
export function formatHookMessage(report, pointerAnchorsOmitted = 0, overlongAnchorParagraphsOmitted = 0, midSentenceAnchorsOmitted = 0, embeddedAnchorsOmitted = 0, splitAnchorParagraphsOmitted = 0) {
  const lines = [];
  if (report.unanchoredLongBlocks.length) {
    lines.push(`${report.unanchoredLongBlocks.length} unanchored long comment block(s) in ${report.file} (>= ${report.minLines} lines, no @decision anchor):`);
    for (const b of report.unanchoredLongBlocks) lines.push(`  - ${report.file}:${b.startLine}-${b.endLine} (${b.length} lines)`);
  }
  if (report.orphanAnchors.length) {
    lines.push(`${report.orphanAnchors.length} orphan @decision anchor(s) in ${report.file} (no record in docs/adr, docs/decisions, or docs/investigations):`);
    for (const a of report.orphanAnchors) lines.push(`  - ${report.file}:${a.line} — @decision ${renderAnchorId(a)}`);
  }
  if (report.brokenAnchors.length) {
    lines.push(`${report.brokenAnchors.length} broken @decision anchor(s) in ${report.file} (the keyword is not followed by a valid 8-hex id on the SAME line — likely a line wrap; the anchor is NOT detected and its record silently becomes an orphan):`);
    for (const b of report.brokenAnchors) lines.push(`  - ${report.file}:${b.line} — @decision with no valid id on this line`);
  }
  if (report.overlongAnchorIds.length) {
    lines.push(`${report.overlongAnchorIds.length} over-long @decision anchor id(s) in ${report.file} (9+ hex chars on the SAME line — likely a verbatim 40-hex git sha pasted where an 8-hex prefix belongs; the anchor is NOT detected and its record silently becomes an orphan):`);
    for (const o of report.overlongAnchorIds) lines.push(`  - ${report.file}:${o.line} — ${o.match}`);
  }
  if (report.sigilSpaceAnchors.length) {
    lines.push(`${report.sigilSpaceAnchors.length} @decision anchor(s) in ${report.file} with whitespace adjacent to the sha sigil's colon, before it, after it, or both (e.g. "sha: deadbeef" or "sha :deadbeef") — the anchor is NOT detected and its record silently becomes an orphan:`);
    for (const s of report.sigilSpaceAnchors) lines.push(`  - ${report.file}:${s.line} — ${s.match}`);
  }
  if (report.bareCommitAnchors.length) {
    lines.push(`${report.bareCommitAnchors.length} bare @decision anchor(s) in ${report.file} whose id resolves as a REAL GIT COMMIT in this repo (CLAUDE.md: a bare id always means a board card; the commit id-space requires the "sha:" sigil — card 969b0e1c):`);
    for (const a of report.bareCommitAnchors) lines.push(`  - ${report.file}:${a.line} — @decision ${a.id} (resolves as a commit — did you mean "sha:${a.id}"?)`);
  }
  if (report.pointerAnchors.length) {
    lines.push(`${report.pointerAnchors.length} @decision anchor(s) in ${report.file} whose text POINTS AT the out-of-band record instead of STATING the prohibition/consequence inline (CLAUDE.md comment taxonomy: the anchor's own text carries the rule; the record is reached by resolving the id, not by a "see docs/…" tail — card a862e8f0):`);
    for (const p of report.pointerAnchors) lines.push(`  - ${report.file}:${p.line} — @decision ${renderAnchorId(p)} (matched "${p.phrase}")`);
  }
  if (report.overlongAnchorParagraphs.length) {
    lines.push(`${report.overlongAnchorParagraphs.length} over-long @decision anchor paragraph(s) in ${report.file} (CLAUDE.md comment taxonomy: a guard/prohibition anchor is compressed to <=${GUARD_MAX_LINES} lines):`);
    for (const o of report.overlongAnchorParagraphs) lines.push(`  - ${report.file}:${o.line} — @decision ${renderAnchorId(o)} (${o.length} lines)`);
  }
  if (report.midSentenceAnchors.length) {
    lines.push(`${report.midSentenceAnchors.length} mid-sentence @decision anchor(s) in ${report.file} (the "@decision" token is not the first thing on its line — it is embedded inside other prose rather than opening its own paragraph):`);
    for (const m of report.midSentenceAnchors) lines.push(`  - ${report.file}:${m.line} — @decision ${renderAnchorId(m)} embedded mid-sentence`);
  }
  if (report.embeddedAnchors.length) {
    lines.push(`${report.embeddedAnchors.length} embedded @decision anchor(s) in ${report.file} (the anchor opens its own line, but the line before it doesn't end a sentence, or the line after it continues one — the anchor is still swallowed by a LARGER sentence spanning an adjacent line):`);
    for (const e of report.embeddedAnchors) lines.push(`  - ${report.file}:${e.line} — @decision ${renderAnchorId(e)} embedded across a line boundary`);
  }
  if (report.embeddedAnchorsStacked.length) {
    lines.push(`${report.embeddedAnchorsStacked.length} stacked @decision anchor(s) in ${report.file} whose PRECEDING anchor's own paragraph lacks a trailing period (a punctuation nit between two distinct decisions, not a swallowed anchor — informational only, not counted as an embedded-anchor violation):`);
    for (const e of report.embeddedAnchorsStacked) lines.push(`  - ${report.file}:${e.line} — @decision ${renderAnchorId(e)} follows an unterminated preceding anchor`);
  }
  if (report.splitAnchorParagraphs.length) {
    lines.push(`${report.splitAnchorParagraphs.length} split @decision anchor paragraph(s) in ${report.file} (an inserted blank comment line ends the anchor's REPORTED paragraph before its own sentence actually finishes):`);
    for (const s of report.splitAnchorParagraphs) lines.push(`  - ${report.file}:${s.line} — @decision ${renderAnchorId(s)} (paragraph cut short by the blank line at ${report.file}:${s.blankLine})`);
  }
  if (report.splitAnchorParagraphsUnterminated.length) {
    lines.push(`${report.splitAnchorParagraphsUnterminated.length} @decision anchor paragraph(s) in ${report.file} missing a trailing period before a FRESH paragraph (a punctuation nit, not a cut sentence — informational only, not counted as a split-anchor-paragraph violation):`);
    for (const s of report.splitAnchorParagraphsUnterminated) lines.push(`  - ${report.file}:${s.line} — @decision ${renderAnchorId(s)} unterminated before the blank line at ${report.file}:${s.blankLine}`);
  }
  if (pointerAnchorsOmitted > 0) {
    lines.push(`(${pointerAnchorsOmitted} more pointer-anchor site(s) in ${report.file} not shown here — run the CLI scan, \`node comment-anchor-lint.mjs .\`, for the full \`pointerAnchors\` list.)`);
  }
  if (overlongAnchorParagraphsOmitted > 0) {
    lines.push(`(${overlongAnchorParagraphsOmitted} more overlong-anchor-paragraph site(s) in ${report.file} not shown here — run the CLI scan, \`node comment-anchor-lint.mjs .\`, for the full \`overlongAnchorParagraphs\` list.)`);
  }
  if (midSentenceAnchorsOmitted > 0) {
    lines.push(`(${midSentenceAnchorsOmitted} more mid-sentence-anchor site(s) in ${report.file} not shown here — run the CLI scan, \`node comment-anchor-lint.mjs .\`, for the full \`midSentenceAnchors\` list.)`);
  }
  if (embeddedAnchorsOmitted > 0) {
    lines.push(`(${embeddedAnchorsOmitted} more embedded-anchor site(s) in ${report.file} not shown here — run the CLI scan, \`node comment-anchor-lint.mjs .\`, for the full \`embeddedAnchors\` list.)`);
  }
  if (splitAnchorParagraphsOmitted > 0) {
    lines.push(`(${splitAnchorParagraphsOmitted} more split-anchor-paragraph site(s) in ${report.file} not shown here — run the CLI scan, \`node comment-anchor-lint.mjs .\`, for the full \`splitAnchorParagraphs\` list.)`);
  }
  return `comment-anchor-lint (CLAUDE.md comment taxonomy, card 90b19799) flagged ${report.file}:\n${lines.join("\n")}\n`
    + `Advisory only: a long unanchored block may want "// @decision <id> — <the prohibition/consequence>" `
    + `(<=3 lines) plus an out-of-band record in docs/adr or docs/decisions; an orphan anchor needs a matching `
    + `record file; a broken anchor needs "@decision <id>" kept together on one line, never wrapped; an `
    + `over-long anchor id needs trimming to the 8-hex prefix (\`git rev-parse --short=8\`, or manually take `
    + `the first 8 chars of the full sha); a sigil-space anchor needs the whitespace after "sha:" removed so `
    + `it directly precedes the hex id; a bare-commit anchor needs the "sha:" sigil added if a commit was `
    + `genuinely intended, or a real board card id if one was; a pointer anchor needs its "see docs/…" tail `
    + `rewritten to state the actual prohibition/consequence — the record itself is reached by the id, not `
    + `by a pointer phrase in the comment; an over-long anchor paragraph needs compressing back to <=`
    + `${GUARD_MAX_LINES} lines; a mid-sentence anchor needs its "@decision <id>" moved to open its own line/`
    + `paragraph, not buried inside other prose; an embedded anchor needs moving so a real sentence boundary `
    + `(a period, or a blank line) sits on both sides of it, not a dangling word or continuing punctuation; a `
    + `split anchor paragraph needs its inserted blank line removed (or moved to a genuine sentence end) so `
    + `the anchor's own full text is what gets measured against the <=${GUARD_MAX_LINES}-line cap.`;
}

/**
 * Write `obj` as JSON to stdout and resolve only once the write has actually flushed (never before a
 * following `process.exit()` races the OS-level flush) — same shape as decision-records.mjs's own `emit`,
 * duplicated rather than imported for the same reason `ANCHOR_RE` is duplicated at the top of this file
 * (see that comment): each asset ships as a standalone file invoked by a bare `node <path>` spawn.
 */
function emitHook(obj) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    process.stdout.write(JSON.stringify(obj), finish);
    setTimeout(finish, 2000).unref();
  });
}

/**
 * Best-effort extraction of the TEXT the triggering tool call itself just wrote, from the PostToolUse
 * payload's `tool_input`. Mirrors the SAME Edit/Write/MultiEdit tool schemas this hook's own harness
 * (Claude Code) invokes these tools with — not a guess: `Write`'s `tool_input.content` is the file's
 * ENTIRE new content (for a brand-new file that genuinely IS "everything just written"; for a full
 * rewrite of an existing file it over-includes pre-existing content too — an accepted, narrow trade,
 * since `Write` on an EXISTING file is rare here by convention, see `CLAUDE.md`: "Prefer editing
 * existing files... prefer the Edit tool"); `Edit`'s `tool_input.new_string` is the one replacement
 * snippet; `MultiEdit`'s `tool_input.edits` is an array of `{new_string, ...}` entries, joined.
 * Returns `null` (never `""`) when the shape doesn't match any of these known tools/fields — a caller
 * MUST treat `null` as "cannot determine what was written", never as "nothing was written" (those are
 * different: the former means fall back to a bounded cap, the latter would wrongly suppress every real
 * finding). No test in this repo currently observes MultiEdit's real payload shape (only Edit/Write
 * appear in captured fixtures) — this function's `edits` branch is therefore UNVERIFIED against a real
 * MultiEdit payload; it degrades safely to the `null`/cap path if the shape ever differs from this
 * file's own belief about it.
 *
 * @decision a862e8f0 — without this, the hook's advisory would flood with EVERY pre-existing pointer
 * anchor in the edited file, instead of only the site(s) the agent actually just authored.
 */
export function extractWrittenText(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  if (toolName === "Write" && typeof toolInput.content === "string") return toolInput.content;
  if (toolName === "Edit" && typeof toolInput.new_string === "string") return toolInput.new_string;
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    const parts = toolInput.edits
      .filter((e) => e && typeof e.new_string === "string")
      .map((e) => e.new_string);
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

// Hard cap on how many pointerAnchors sites the HOOK ever surfaces in one advisory, independent of the
// scoping below — a belt-and-suspenders bound, not the primary mechanism (card a862e8f0). Covers the one
// case scoping-by-written-text can still over-include: a `Write` of a genuinely large brand-new file
// carrying many real, freshly-authored pointer anchors all at once (every one of them legitimately
// "just written", so scoping alone wouldn't trim them) — and the fallback path below, when the payload
// shape can't be read at all. The CLI scan (`pointerAnchors` on `computeReport`) always has the complete,
// uncapped list; this cap only bounds what gets INJECTED into the agent's context per edit.
export const HOOK_POINTER_ANCHOR_CAP = 5;

/**
 * Scope any list of anchor-paragraph SITES — `pointerAnchors`, `overlongAnchorParagraphs`, or
 * `midSentenceAnchors` (anything carrying a `.line`), as returned on a `computeFileReport` result — down
 * to the sites the triggering edit actually just wrote, for the HOOK's advisory only — never changes what
 * `computeFileReport`/`computeReport` themselves report; this function is applied by `runHook`, after
 * computing the full report, purely to decide what to SURFACE. `lines` is the edited file's OWN lines
 * (post-edit, same split the report was computed against) — used to read each site's own raw line text
 * (line `p.line`, 1-indexed) for the containment test. `writtenText`, from `extractWrittenText` above:
 * `null` means the payload shape couldn't be read (falls back to a capped, unscoped slice of the full list
 * rather than either flooding or going silent — an unrecognized payload must never suppress a real
 * finding, but must also never dump everything); any string means "test each site's own anchor line for
 * containment in this text" — a site is kept IFF its own (trimmed) anchor line text is a substring of
 * `writtenText`. This is a SUBSTRING test, not a diff: it can theoretically false-keep a pre-existing site
 * whose anchor line happens to be reproduced verbatim inside an unrelated large `new_string`/`content` —
 * accepted, since a false keep only ever costs a little extra advisory text, never a missed real one (the
 * failure mode this fix exists to prevent is the OPPOSITE: silently dropping a site the agent DID just
 * write). Always applies `cap` (default `HOOK_POINTER_ANCHOR_CAP`) on top, regardless of scoping outcome,
 * as the belt-and-suspenders bound documented on that constant. Returns `{items, omitted}` — `omitted` is
 * the count trimmed by the cap (0 when nothing was trimmed), used by `formatHookMessage` to say so rather
 * than silently truncating.
 *
 * @decision a862e8f0 — never changes what `computeFileReport`/`computeReport` themselves report, only
 * what the hook's own advisory surfaces.
 *
 * Card 5e5841dd — generalized from the original `pointerAnchors`-only scoper (a862e8f0) to cover
 * `overlongAnchorParagraphs`/`midSentenceAnchors` too, one shared scoper rather than a second one per
 * field: a main-tree baseline of 257/155 (concentrated in the same giant files as pointerAnchors, e.g.
 * sessions/service.ts, pty/host.ts) would flood the hook's advisory on every edit to those files exactly
 * like the incident this scoper was built to fix, if either field went into the hook unscoped.
 */
export function scopeHookAnchorSites(sites, lines, writtenText, cap = HOOK_POINTER_ANCHOR_CAP) {
  const candidates = writtenText === null
    ? sites
    : sites.filter((p) => {
        const anchorLineText = (lines[p.line - 1] ?? "").trim();
        return anchorLineText.length > 0 && writtenText.includes(anchorLineText);
      });
  if (candidates.length <= cap) return { items: candidates, omitted: 0 };
  return { items: candidates.slice(0, cap), omitted: candidates.length - cap };
}

/** `pointerAnchors`-specific alias of `scopeHookAnchorSites` (card a862e8f0's original name), kept so
 * existing callers/imports (including `test/comment-anchor-lint-hook.mjs`) are unaffected by the
 * generalization above — behaviorally identical to `scopeHookAnchorSites(pointerAnchors, lines,
 * writtenText, HOOK_POINTER_ANCHOR_CAP)`. */
export function scopeHookPointerAnchors(pointerAnchors, lines, writtenText) {
  return scopeHookAnchorSites(pointerAnchors, lines, writtenText, HOOK_POINTER_ANCHOR_CAP);
}

/**
 * `node comment-anchor-lint.mjs --hook <repoRoot>` — the PostToolUse hook entry point (matcher Write|Edit;
 * see `writeSessionSettings` in claude-settings.ts for the wiring + its docLint gate). Reads the hook
 * payload on stdin: `{tool_name, tool_input:{file_path}, cwd}`. `repoRoot` is handed in as an argv (the
 * session's own `opts.cwd` from PtyHost — see paths.ts's `COMMENT_ANCHOR_LINT_SCRIPT` doc) rather than
 * derived by walking up from `cwd` looking for `.git` (decision-records.mjs's approach) — cheaper, and
 * this hook has no need to double-check the written file is inside the SAME repo the session booted in:
 * `isInScope` already requires the file to resolve to a relative, non-`..` path under `repoRoot`, which a
 * file outside it can never do. A non-Write/Edit/MultiEdit tool, a missing/unreadable file, or a file
 * `isInScope` rejects are all fast, silent no-ops — byte-identical to a session with no hook wired at all.
 * Always exits 0 (see the dispatcher at the bottom of this file): a bug here must never block a real Write.
 * `pointerAnchors`, `overlongAnchorParagraphs`, and `midSentenceAnchors` each get ONE extra step here
 * that no other check in this file needs: `computeFileReport` still returns the file's FULL, unscoped
 * list for all three (every check it computes always describes the whole file — that contract doesn't
 * change), but `runHook` narrows what it actually SURFACES to `scopeHookAnchorSites`'s output (one shared
 * scoper, applied to all three) before calling `formatHookMessage` — every other field is passed through
 * untouched (see `extractWrittenText`/`scopeHookAnchorSites` above for how the scoping itself works).
 *
 * @decision a862e8f0 — a single Edit to a file already carrying hundreds of pre-existing pointer anchors
 * would otherwise inject the ENTIRE list into the agent's context on EVERY edit, not just the site(s) it
 * actually just wrote.
 *
 * Card 5e5841dd — `overlongAnchorParagraphs`/`midSentenceAnchors` carry the SAME flood risk: a main-tree
 * baseline of 257/155, concentrated in the same giant files `pointerAnchors` already floods on (e.g.
 * sessions/service.ts, pty/host.ts), would otherwise inject a long list of pre-existing violations on
 * EVERY edit to those files, regardless of relevance — the exact incident `scopeHookAnchorSites` exists
 * to prevent, just for two more fields.
 *
 * Card a873621e — `embeddedAnchors`, `embeddedAnchors.stackedUnterminated` (surfaced here as the separate
 * `embeddedAnchorsStacked` field), and `splitAnchorParagraphs` get the SAME scoping, same reasoning: a
 * main-tree baseline in the low hundreds (see this file's header, checks 13/14) would otherwise flood the
 * advisory on every edit to the files that carry the most of them.
 */
async function runHook(repoRootArg) {
  if (!repoRootArg) return;
  const repoRoot = path.resolve(repoRootArg);

  let raw = "";
  for await (const c of process.stdin) raw += c;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const tool = payload.tool_name;
  if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") return;

  let filePath = payload.tool_input?.file_path;
  if (typeof filePath !== "string") return;
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  if (!path.isAbsolute(filePath)) filePath = path.resolve(cwd, filePath);

  if (isInScope(repoRoot, filePath) === null) return; // cheap reject before ever reading the file

  let content;
  try { content = fs.readFileSync(filePath, "utf8"); } catch { return; } // tool already ran → file is on disk

  const report = computeFileReport(repoRoot, filePath, content);
  if (!report) return;

  const writtenText = extractWrittenText(tool, payload.tool_input);
  const editedLines = content.split(/\r?\n/);
  const pointerScope = scopeHookAnchorSites(report.pointerAnchors, editedLines, writtenText);
  const overlongScope = scopeHookAnchorSites(report.overlongAnchorParagraphs, editedLines, writtenText);
  const midSentenceScope = scopeHookAnchorSites(report.midSentenceAnchors, editedLines, writtenText);
  const embeddedScope = scopeHookAnchorSites(report.embeddedAnchors, editedLines, writtenText);
  const embeddedStackedScope = scopeHookAnchorSites(report.embeddedAnchorsStacked, editedLines, writtenText);
  const splitParagraphScope = scopeHookAnchorSites(report.splitAnchorParagraphs, editedLines, writtenText);
  const splitParagraphUnterminatedScope = scopeHookAnchorSites(report.splitAnchorParagraphsUnterminated, editedLines, writtenText);
  const scopedReport = {
    ...report,
    pointerAnchors: pointerScope.items,
    overlongAnchorParagraphs: overlongScope.items,
    midSentenceAnchors: midSentenceScope.items,
    embeddedAnchors: embeddedScope.items,
    embeddedAnchorsStacked: embeddedStackedScope.items,
    splitAnchorParagraphs: splitParagraphScope.items,
    splitAnchorParagraphsUnterminated: splitParagraphUnterminatedScope.items,
  };

  if (scopedReport.unanchoredLongBlocks.length === 0 && scopedReport.orphanAnchors.length === 0
    && scopedReport.brokenAnchors.length === 0 && scopedReport.overlongAnchorIds.length === 0
    && scopedReport.sigilSpaceAnchors.length === 0 && scopedReport.bareCommitAnchors.length === 0
    && scopedReport.pointerAnchors.length === 0 && scopedReport.overlongAnchorParagraphs.length === 0
    && scopedReport.midSentenceAnchors.length === 0 && scopedReport.embeddedAnchors.length === 0
    && scopedReport.embeddedAnchorsStacked.length === 0 && scopedReport.splitAnchorParagraphs.length === 0
    && scopedReport.splitAnchorParagraphsUnterminated.length === 0) return;

  const msg = formatHookMessage(scopedReport, pointerScope.omitted, overlongScope.omitted, midSentenceScope.omitted, embeddedScope.omitted, splitParagraphScope.omitted);
  await emitHook({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg } });
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.find((a) => !a.startsWith("--"));
  const repoRoot = path.resolve(positional || process.cwd());
  const minLinesArg = args.find((a) => a.startsWith("--min-lines="));
  const minLines = minLinesArg ? Number(minLinesArg.slice("--min-lines=".length)) : undefined;
  const report = computeReport(repoRoot, { minLines });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// Only run as a CLI/hook when invoked directly (`node comment-anchor-lint.mjs ...`) — an import (the test
// file) must be able to pull in the exported functions above without triggering a scan as a side effect.
// `--hook <repoRoot>` (first argv) dispatches to the per-file PostToolUse hook (`runHook`, always exits 0,
// see its own doc); anything else stays the existing whole-repo CLI scan (`main`, unchanged).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === "--hook") {
    runHook(process.argv[3]).catch(() => {}).finally(() => process.exit(0));
  } else {
    main();
  }
}
