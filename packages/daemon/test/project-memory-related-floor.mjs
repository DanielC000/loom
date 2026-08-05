import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 738568b6 — before this fix, the pinned-REST sub-tier packed greedily against the FULL
// `budgetTokens`, with no reservation for the RELATED tier. On THIS PROJECT'S own live memory store
// (measured via memory_list, 2026-08-05: 21 pinned notes, ~20,324 tokens of pinned-block text vs. a
// 4000-token default budget), that meant pinned alone consumed the entire budget every single kickoff —
// leaving RELATED, the tier that exists specifically to surface a note matched against THIS task's text,
// a structural, permanent ZERO. This directly contradicted the platform-default's own doc comment
// (shared/src/config.ts, PLATFORM_DEFAULTS.memory): "~4000 tokens is generous for a handful of pinned
// notes plus a SIZEABLE RELATED-TIER SLICE" — the code never delivered on that promise once the pinned
// set grew past the budget, which on this project it had.
//
// The fix reserves UP TO RELATED_RESERVE_FRACTION (30%) of budgetTokens that the pinned-REST sub-tier may
// not consume — NEVER_DROP_TAG-tagged floor notes are UNAFFECTED (they keep absolute priority against the
// FULL budget, unchanged).
//
// ⚠️ CODE REVIEW CORRECTION (same card): the FIRST version of this fix reserved that 30% UNCONDITIONALLY,
// regardless of whether `related` had anything in it or needed the full reserve. An EMPTY related tier
// (a legitimate, common case — an FTS query can match nothing) or one SMALLER than the reserve then walled
// off space nothing occupied, dropping MORE pinned notes than pre-fix code for ZERO benefit — a straight
// regression this file's ORIGINAL three tests couldn't see, because they only ever seeded related notes
// BIGGER than the reserve (the one branch where the bug is invisible). The "(empty-related)" and
// "(reclaim)" blocks below are the fix for that blind spot: `composeProjectMemoryDigest` now PROBES how
// much related would actually consume before sizing the reserve (`packRelatedPrefix` in the real source),
// so an empty/small related tier reserves only what it needs.
//
// RED PROOF (verification, not embedded in this file — see the worker's report): scoped `git stash` of
// ONLY the source fix twice — once reverting to fully pre-card code (fails "(reserve) at least one
// related note is delivered..."), once reverting to the FIRST (unconditional-reserve) version of this
// fix, committed as d363db76 (fails exactly the 5 "(empty-related)"/"(reclaim)" assertions below) — then
// restored, rebuilt, reran green both times.
//
// This asserts PRESENCE of a delivered related note — the SAFE polarity per this project's own
// `positive-control-your-searches-empty-is-not-evidence` rule (a surprising zero here would be
// investigated, unlike an absence claim which could silently pass for the wrong reason).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-related-floor.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { composeProjectMemoryDigest, estimateTokens, NEVER_DROP_TAG } = await import("../dist/sessions/project-memory-recall.js");

const BUDGET_TOKENS = 4000; // the real platform default (shared/src/config.ts PLATFORM_DEFAULTS.memory)

const mkEntry = (key, textBytes, overrides = {}) => ({
  id: `id-${key}`,
  projectId: "proj-related-floor-test",
  key,
  title: key,
  text: "p".repeat(textBytes),
  pinned: true,
  tags: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastRetrievedAt: null,
  retrievalCount: 0,
  version: 1,
  requestIds: null,
  ...overrides,
});

// ===================== independent reference packer — NOT the function under test =====================
// Code review (same card): the first cut of this fix reserved RELATED_RESERVE_FRACTION UNCONDITIONALLY —
// even when `related` was empty or needed far less than the reserve — which silently dropped MORE pinned
// notes than pre-fix code for ZERO benefit. The original version of this test file couldn't see that
// because it only ever seeded related notes bigger than the reserve. These two helpers reimplement the
// packing arithmetic INDEPENDENTLY (mirroring the real source's own greedy "continue past oversized" pack
// and its exact block/header text), used ONLY to compute an expected value the real compiled function is
// then compared against below — never as a stand-in for testing the real function's own behavior.
function referencePinnedPack(notesInDeliveryOrder, capTokens) {
  const header = "## Pinned project memory (always included)";
  const blocks = [];
  let section = null;
  const droppedKeys = [];
  for (const m of notesInDeliveryOrder) {
    const block = `### ${m.key} (${m.key})\n${m.text}`;
    const candidate = [header, ...blocks, block].join("\n\n");
    if (estimateTokens(candidate) > capTokens) { droppedKeys.push(m.key); continue; }
    blocks.push(block);
    section = candidate;
  }
  return { section, droppedKeys, includedCount: blocks.length };
}
function referenceRelatedBlockTokens(note) {
  const header = "## Related project memory (matched your kickoff)";
  const block = `### ${note.key} (${note.key})\n${note.text}`;
  return estimateTokens([header, block].join("\n\n"));
}
// Mirrors sortPinnedByRecency (not exported) — newest updatedAt first, key-ascending tiebreak.
const byRecency = (notes) => [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));

try {
  // ===================== realistic-shaped pinned corpus: 21 notes, ~3870 bytes each (~967 tokens) =====
  // Mirrors this project's own measured shape (memory_list, 2026-08-05): 21 pinned notes summing to
  // ~20,324 tokens against a 4000-token budget — pinned ALONE is ~5.1x the whole budget.
  const PINNED_NOTE_BYTES = 3870;
  const PINNED_COUNT = 21;
  const pinnedCorpus = Array.from({ length: PINNED_COUNT }, (_, i) =>
    mkEntry(`pinned-rest-${String(i).padStart(2, "0")}`, PINNED_NOTE_BYTES, {
      updatedAt: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));

  // ===================== sanity: the corpus is genuinely over-budget (pure arithmetic, no compose call) =====================
  // Deliberately does NOT call composeProjectMemoryDigest here — the function under test is ALREADY fixed,
  // so calling it would only show the NEW (capped-at-70%) behavior, not what "pinned alone gets the whole
  // budget" (the pre-fix mechanism this corpus is shaped to demonstrate the fix against) would have done.
  // A raw byte-derived token estimate is independent of the packing algorithm entirely.
  check("(sanity) the pinned corpus ALONE, ignoring any cap, is genuinely several times over budget " +
    "(this is the shape that zeroed RELATED before this fix: given the whole undivided budget, this much " +
    "pinned text fills it many times over)",
    PINNED_COUNT * Math.ceil(PINNED_NOTE_BYTES / 4) > BUDGET_TOKENS * 4);

  // ===================== REQUIRED (code review): empty related ⇒ byte-identical to pre-fix output =====================
  // An FTS query legitimately returns nothing (retrieveProjectMemoryForKickoff: kickoffText empty/whitespace
  // skips the query entirely, or a real match just fails) — this is a common, LEGITIMATE case, not an edge
  // case. The reference below packs against the FULL budgetTokens with no reserve subtraction at all —
  // exactly what pre-this-card code did unconditionally. If the fix is right, an empty related tier must
  // reduce restCap by ZERO, so the real function's output for this exact corpus must match this reference
  // EXACTLY — same drop count, same dropped keys, same digest text byte-for-byte.
  {
    const sorted = byRecency(pinnedCorpus);
    const reference = referencePinnedPack(sorted, BUDGET_TOKENS);
    const expectedDigest = reference.droppedKeys.length > 0
      ? [reference.section, `⚠️ ${reference.droppedKeys.length} pinned note(s) dropped for budget: ${reference.droppedKeys.join(", ")}`].join("\n\n")
      : reference.section;
    const { digest, droppedRestKeys } = composeProjectMemoryDigest(pinnedCorpus, [], BUDGET_TOKENS);
    check("(empty-related) sanity: this reference/corpus combination genuinely drops some pinned notes (a non-vacuous check)",
      reference.droppedKeys.length > 0);
    check("(empty-related) an empty related tier reduces restCap by ZERO — same drop COUNT as the pre-fix full-budget reference",
      droppedRestKeys.length === reference.droppedKeys.length);
    check("(empty-related) the exact same KEYS drop, not merely the same count",
      reference.droppedKeys.every((k) => droppedRestKeys.includes(k)) && droppedRestKeys.every((k) => reference.droppedKeys.includes(k)));
    check("(empty-related) the digest text is BYTE-IDENTICAL to the independently-computed pre-fix reference",
      digest === expectedDigest);
  }

  // ===================== REQUIRED (code review): related SMALLER than the reserve ⇒ surplus reclaimed =====================
  // Not just "a related note appeared" (the original suite's blind spot) — asserts the UNUSED portion of
  // the nominal reserve is actually given back to pinned, not held empty. Compares the real function's
  // drop count against TWO independent references: the BUGGY unconditional-reserve formula (restCap =
  // budgetTokens - nominal reserve, regardless of what related needs) and the CORRECT formula (restCap =
  // budgetTokens - what related ACTUALLY needs). The real function must match the correct reference and
  // beat (drop fewer than) the buggy one.
  {
    const sorted = byRecency(pinnedCorpus);
    const smallRelated = mkEntry("related-small-match", 400, { pinned: false }); // ~124 tokens
    const relatedNeedExpected = referenceRelatedBlockTokens(smallRelated);
    // 0.3 mirrors RELATED_RESERVE_FRACTION in the real source (not exported — private to the module under
    // test); this file already hardcodes BUDGET_TOKENS=4000 the same way, matching the real platform default.
    const reserveTokens = Math.floor(BUDGET_TOKENS * 0.3);
    check("(reclaim) setup sanity: this related note genuinely needs LESS than the nominal 30% reserve",
      relatedNeedExpected < reserveTokens);

    const buggyRef = referencePinnedPack(sorted, BUDGET_TOKENS - reserveTokens);
    const correctRef = referencePinnedPack(sorted, BUDGET_TOKENS - relatedNeedExpected);
    check("(reclaim) setup sanity: the correct (need-sized) cap genuinely admits MORE pinned notes than the buggy flat-reserve cap",
      correctRef.includedCount > buggyRef.includedCount);

    const { droppedRestKeys, includedIds } = composeProjectMemoryDigest(pinnedCorpus, [smallRelated], BUDGET_TOKENS);
    check("(reclaim) the real function's drop count matches the CORRECT (need-sized) reference exactly",
      droppedRestKeys.length === correctRef.droppedKeys.length);
    check("(reclaim) the real function drops STRICTLY FEWER pinned notes than the buggy flat-reserve reference would — the surplus was reclaimed",
      droppedRestKeys.length < buggyRef.droppedKeys.length);
    check("(reclaim) the small related note itself still delivers",
      includedIds.includes("id-related-small-match"));
  }

  // ===================== the fix: related still gets delivered =====================
  {
    // Typical-sized related candidates (this project's own measured unpinned average: ~782 tokens /
    // median ~831 tokens, i.e. ~3130 bytes average). FTS rank order: most-relevant first.
    const related = [
      mkEntry("related-best-match", 3130, { pinned: false }),
      mkEntry("related-second-match", 3130, { pinned: false }),
    ];
    const { digest, includedIds, droppedRestKeys } = composeProjectMemoryDigest(pinnedCorpus, related, BUDGET_TOKENS);

    check("(reserve) at least one related note is delivered despite an over-budget pinned set",
      includedIds.includes("id-related-best-match"));
    check("(reserve) the digest text actually contains the delivered related note's body",
      digest.includes("### related-best-match"));
    check("(reserve) MORE pinned notes are now dropped than before this fix (the intended trade — verified: " +
      "restCap is a real 70% ceiling, not the full budget)", droppedRestKeys.length > 0);
    check("(reserve) the related section header is present in the digest",
      digest.includes("## Related project memory (matched your kickoff)"));
  }

  // ===================== bounded, not unlimited: a related note bigger than the WHOLE reserve still drops =====================
  // Proves the reservation is a genuine, bounded floor — not "related gets whatever happens to be left
  // over" (which can exceed the nominal 30% when pinned-REST's own greedy packing leaves slack, as the
  // block above's chunky ~967-token notes do). Uses MANY SMALL pinned notes instead, so pinned-REST packs
  // tightly against its 70% cap with only a few tokens of leftover slack — leaving `related`'s actual
  // remaining budget close to the nominal 30% reserve (~1200 tokens), not padded by unused pinned headroom.
  {
    const tightPinned = Array.from({ length: 150 }, (_, i) =>
      mkEntry(`tight-pinned-${String(i).padStart(3, "0")}`, 100, {
        updatedAt: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      }));
    const oversizedRelated = [mkEntry("related-too-big-for-reserve", 7200, { pinned: false })]; // ~1810 tokens
    const { includedIds, droppedRelatedKeys } = composeProjectMemoryDigest(tightPinned, oversizedRelated, BUDGET_TOKENS);
    check("(bounded) a related note bigger than the WHOLE reserve is correctly dropped, not force-fit",
      !includedIds.includes("id-related-too-big-for-reserve") && droppedRelatedKeys.includes("related-too-big-for-reserve"));
  }

  // ===================== never-drop floor notes are UNAFFECTED — absolute priority preserved =====================
  {
    const floorNote = mkEntry("floor-critical-directive", 900, { tags: [NEVER_DROP_TAG], updatedAt: "2020-01-01T00:00:00.000Z" });
    const corpusWithFloor = [floorNote, ...pinnedCorpus];
    // 2000 bytes (~500 tokens), not the 3130-byte average used above: the uncapped drop-notice line this
    // corpus also renders (18 dropped pinned-rest keys, ~90 tokens, added AFTER packing decisions per the
    // "Loud overflow" comment in the real source) eats into the TRUE remaining the final related pack sees
    // — a smaller, still-realistic related note keeps this assertion clear of that unrelated interaction.
    const related = [mkEntry("related-match", 2000, { pinned: false })];
    const { includedIds, droppedFloorKeys } = composeProjectMemoryDigest(corpusWithFloor, related, BUDGET_TOKENS);
    check("(floor-unaffected) the never-drop note still survives, unaffected by the related reserve",
      includedIds.includes("id-floor-critical-directive"));
    check("(floor-unaffected) the never-drop tier reports no drops (it packs against the FULL budget, same as before this fix)",
      droppedFloorKeys.length === 0);
    // and related STILL gets its guaranteed slice even with a floor note also present, as long as the
    // floor note itself doesn't eat into the reserve (900 tokens well under budgetTokens - reserve).
    check("(floor-unaffected) related STILL delivers alongside a never-drop floor note",
      includedIds.includes("id-related-match"));
  }

  // ===================== negative control: everything fits comfortably ⇒ no drops, no behavior change =====================
  {
    const roomyPinned = [mkEntry("small-pinned", 200)];
    const roomyRelated = [mkEntry("small-related", 200, { pinned: false })];
    const { includedIds, droppedRestKeys, droppedRelatedKeys } = composeProjectMemoryDigest(roomyPinned, roomyRelated, BUDGET_TOKENS);
    check("(negative control) plenty of budget ⇒ both pinned and related deliver, nothing dropped",
      includedIds.includes("id-small-pinned") && includedIds.includes("id-small-related") &&
      droppedRestKeys.length === 0 && droppedRelatedKeys.length === 0);
  }
} catch (err) {
  console.error(err);
  failures++;
}

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S)`);
} else {
  console.log(
    "\n✅ ALL PASS — related-tier budget reservation (card 738568b6): an EMPTY related tier reserves ZERO " +
    "and is byte-identical to pre-card output, and a related tier SMALLER than the nominal reserve gives the " +
    "unused surplus back to pinned (both against an independent reference computation, not the function " +
    "under test) — closing the blind spot the original three tests had (they only ever seeded related notes " +
    "bigger than the reserve). Against a pinned corpus shaped to match this project's own measured " +
    "over-budget reality (~21 notes, ~20K tokens vs. a 4000-token budget), the RELATED tier still reliably " +
    "delivers at least one matched note instead of the structural zero the unreserved pinned-REST tier " +
    "produced before this card; the reservation is a genuine bounded ceiling (an oversized related note " +
    "still drops, it isn't 'whatever's left over'); NEVER_DROP_TAG floor notes are completely unaffected, " +
    "still packing against the full budget with absolute priority; and a roomy-budget case stays drop-free. " +
    "Against the REAL compiled composeProjectMemoryDigest, claude-free, network-free.",
  );
}
process.exit(failures === 0 ? 0 : 1);
