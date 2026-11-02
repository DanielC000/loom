import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 926e4ac8 (mem0-comparison idea #1, `Projects/Loom/Design/Project Memory vs mem0 — Comparison.md`
// §1) — a REST/FLOOR/RELATED note dropped for budget used to render as a bare key in the drop line. A
// reader can't tell whether a bare key is worth a `memory_read`. This file proves, against the REAL
// compiled `composeProjectMemoryDigest`:
//   1. a dropped entry with a title renders `key — title` in the drop line (REST, FLOOR, RELATED tiers).
//   2. a title longer than the truncation budget is cut to the budget + an ellipsis, never the full title.
//   3. a title-less entry (title: "") falls back to the bare key — byte-identical to the pre-this-card line.
//   4. the drop list stays COMPLETE/uncapped even with titles attached (b4c4699e's decision record is
//      unaffected by this card: completeness-by-count was never in scope here, only per-entry formatting).
//   5. the "(never delivered)" marker (card 6def8bf4 DoD-5) composes correctly with the title, appended
//      AFTER the key/title pair, never between them.
//   6. the added bytes ARE counted toward the shared digest budget: a heavier (title-bearing) drop line
//      measurably shrinks the RELATED tier's remaining capacity, exactly as a bigger note body would —
//      proven by pushing one related note from included to dropped purely by adding titles to the
//      REST-tier drop line, nothing else changed.
//
// RED PROOF (verification, not embedded in this file — see the worker's report): every check below fails
// against a `git stash`-equivalent snapshot of the pre-feature source (pinned to a fixed pre-fix sha, not
// `HEAD`), then passes once the feature is restored and rebuilt.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-dropped-title.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { composeProjectMemoryDigest, estimateTokens, NEVER_DROP_TAG } =
  await import("../dist/sessions/project-memory-recall.js");

const mkEntry = (key, textBytes, title, overrides = {}) => ({
  id: `id-${key}`,
  projectId: "proj-dropped-title-test",
  key,
  title,
  text: "p".repeat(textBytes),
  pinned: true,
  tags: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  lastRetrievedAt: null,
  retrievalCount: 0,
  version: 1,
  requestIds: null,
  ...overrides,
});

try {
  // ===================== 1. REST tier: a short title renders `key — title` =====================
  {
    const dropped = mkEntry("rest-short-title", 500, "Gate cap stays at 2 by owner decision");
    const TINY_BUDGET = 10; // far too small for even one note's own block
    const { digest, droppedRestKeys } = composeProjectMemoryDigest([dropped], [], TINY_BUDGET);
    check("(rest-title) the note is actually dropped (sanity, otherwise this proves nothing)",
      droppedRestKeys.includes("rest-short-title"));
    check("(rest-title) the drop line renders `key — title`, not a bare key",
      digest.includes("rest-short-title — Gate cap stays at 2 by owner decision"));
  }

  // ===================== 2. REST tier: a long title is truncated, never shown in full =====================
  {
    const longTitle = "a".repeat(120); // well past the ~60-char truncation budget
    const dropped = mkEntry("rest-long-title", 500, longTitle);
    const TINY_BUDGET = 10;
    const { digest, droppedRestKeys } = composeProjectMemoryDigest([dropped], [], TINY_BUDGET);
    check("(rest-title-trunc) sanity: dropped", droppedRestKeys.includes("rest-long-title"));
    check("(rest-title-trunc) the digest does NOT contain the full 120-char title",
      !digest.includes(longTitle));
    check("(rest-title-trunc) the digest DOES contain the truncated 60-char prefix immediately after the key, followed by an ellipsis",
      digest.includes(`rest-long-title — ${"a".repeat(60)}…`));
    check("(rest-title-trunc) nothing past char 60 of the title survives truncation",
      !digest.includes("a".repeat(61)));
  }

  // ===================== 3. a title-less entry falls back to the bare key =====================
  {
    const dropped = mkEntry("rest-no-title", 500, "");
    const TINY_BUDGET = 10;
    const { digest, droppedRestKeys } = composeProjectMemoryDigest([dropped], [], TINY_BUDGET);
    check("(rest-no-title) sanity: dropped", droppedRestKeys.includes("rest-no-title"));
    check("(rest-no-title) the drop line falls back to the bare key — no ` — ` separator anywhere for this entry",
      digest.includes("rest-no-title") && !/rest-no-title\s*—/.test(digest));
  }

  // ===================== 4. FLOOR tier (ALARM line) also renders the title =====================
  {
    const dropped = mkEntry("floor-title-key", 500, "Broken never-drop guarantee", { tags: [NEVER_DROP_TAG] });
    const TINY_BUDGET = 5;
    const { digest, droppedFloorKeys } = composeProjectMemoryDigest([dropped], [], TINY_BUDGET);
    check("(floor-title) sanity: dropped from the floor tier", droppedFloorKeys.includes("floor-title-key"));
    check("(floor-title) the ALARM line renders `key — title`",
      digest.includes("floor-title-key — Broken never-drop guarantee"));
  }

  // ===================== 5. RELATED tier also renders the title =====================
  {
    const dropped = mkEntry("related-title-key", 500, "Matched note worth a read", { pinned: false });
    const TINY_BUDGET = 5;
    const { digest, droppedRelatedKeys } = composeProjectMemoryDigest([], [dropped], TINY_BUDGET);
    check("(related-title) sanity: dropped from the related tier", droppedRelatedKeys.includes("related-title-key"));
    check("(related-title) the related overflow line renders `key — title`",
      digest.includes("related-title-key — Matched note worth a read"));
  }

  // ===================== 6. "(never delivered)" composes with the title, appended AFTER it =====================
  {
    const dropped = mkEntry("rest-never-delivered", 500, "First-ever drop, top priority");
    const TINY_BUDGET = 10;
    const { digest, droppedRestKeys } = composeProjectMemoryDigest([dropped], [], TINY_BUDGET);
    check("(never-delivered+title) sanity: dropped", droppedRestKeys.includes("rest-never-delivered"));
    check("(never-delivered+title) the marker is appended AFTER the key/title pair, not between them",
      digest.includes("rest-never-delivered — First-ever drop, top priority (never delivered)"));
  }

  // ===================== 7. completeness: many titled drops, all still named (uncapped, per b4c4699e) =====================
  {
    const N = 40; // genuinely above the old MAX_LISTED_DROPPED_KEYS=8 folding threshold
    const corpus = Array.from({ length: N }, (_, i) =>
      mkEntry(`at-scale-titled-${String(i).padStart(2, "0")}`, 300, `Title for note ${i}`));
    const TIGHT_BUDGET = 5;
    const { digest, droppedRestKeys, includedIds } = composeProjectMemoryDigest(corpus, [], TIGHT_BUDGET);
    check("(completeness) forces all 40 to drop", droppedRestKeys.length === N && includedIds.length === 0);
    check("(completeness) EVERY dropped note's key — title pair is present, none folded away",
      corpus.every((e) => digest.includes(`${e.key} — ${e.title}`)));
    check("(completeness) NEGATIVE CONTROL: no '+N more' folding text appears — the uncapped list is genuinely uncapped",
      !/\+\d+ more/.test(digest));
  }

  // ===================== 8. the added title bytes ARE counted toward the shared digest budget =====================
  // Card 926e4ac8's DoD: "account for the added bytes in the digest budget if the drop line is budget-
  // counted". It already is — composeProjectMemoryDigest computes `usedTokens` from the FINAL rendered
  // pinnedSection (AFTER the drop/alarm lines are appended, see the "Loud overflow" comment in source),
  // and the RELATED tier's remaining capacity is `budgetTokens - usedTokens - SECTION_SEP`. So a heavier
  // drop line (titles attached) automatically shrinks what's left for RELATED — no separate accounting
  // code was needed. Proven here empirically: the ONLY difference between the two runs below is whether
  // the REST-tier drop line carries titles; everything else (pinned corpus, related corpus, budgetTokens)
  // is identical.
  {
    const DROP_COUNT = 15;
    const TITLE_60 = "x".repeat(60); // at the truncation cap exactly — deterministic size, no "…" variance
    const BUDGET = 1000;
    const NOTE_BYTES = 5000; // ~1250 tokens alone — guarantees EVERY one of these drops under BUDGET=1000

    const buildPinned = (withTitle) => Array.from({ length: DROP_COUNT }, (_, i) =>
      mkEntry(`budget-drop-${String(i).padStart(2, "0")}`, NOTE_BYTES, withTitle ? TITLE_60 : ""));

    const noTitle = composeProjectMemoryDigest(buildPinned(false), [], BUDGET);
    const withTitle = composeProjectMemoryDigest(buildPinned(true), [], BUDGET);
    check("(budget-accounting) sanity: both runs drop everything (no note fits even alone)",
      noTitle.includedIds.length === 0 && noTitle.droppedRestKeys.length === DROP_COUNT &&
      withTitle.includedIds.length === 0 && withTitle.droppedRestKeys.length === DROP_COUNT);

    const usedTokensNoTitle = estimateTokens(noTitle.digest);
    const usedTokensWithTitle = estimateTokens(withTitle.digest);
    check("(budget-accounting) the titled drop line measurably increases the rendered pinned section's own size",
      usedTokensWithTitle > usedTokensNoTitle);

    const sepTokens = estimateTokens("\n\n");
    const remainingNoTitle = BUDGET - usedTokensNoTitle - sepTokens;
    const remainingWithTitle = BUDGET - usedTokensWithTitle - sepTokens;
    check("(budget-accounting) sanity: the titled run leaves strictly LESS remaining budget for the related tier",
      remainingWithTitle < remainingNoTitle);

    // Build one related note whose own rendered candidate (header + block) lands strictly between the two
    // remaining values — included when remaining is the LARGER (no-title) figure, dropped when it's the
    // SMALLER (with-title) figure. Mirrors the real block/header text exactly so the token estimate is
    // faithful to what packRelatedPrefix actually measures.
    const relHeader = "## Related project memory (matched your kickoff)";
    const relKey = "budget-related-probe";
    const relDate = "2026-11-01";
    const relBlockPrefix = `### ${relKey} (${relKey}) [v1, ${relDate}]\n`;
    const candidateTokens = (textBytes) =>
      estimateTokens([relHeader, relBlockPrefix + "p".repeat(textBytes)].join("\n\n"));

    const midTokens = Math.ceil((remainingNoTitle + remainingWithTitle) / 2);
    check("(budget-accounting) sanity: the window between the two remaining figures is wide enough to target a midpoint",
      midTokens > remainingWithTitle && midTokens <= remainingNoTitle);

    // Solve for textBytes directly (estimateTokens is a pure ceil(byteLength/4)), then nudge by whole
    // tokens if rounding/overhead puts the very first guess outside the target window.
    let textBytes = Math.max(1, midTokens * 4 - Buffer.byteLength(relBlockPrefix + relHeader + "\n\n", "utf8"));
    let attempts = 0;
    while (!(candidateTokens(textBytes) > remainingWithTitle && candidateTokens(textBytes) <= remainingNoTitle) && attempts < 50) {
      textBytes += candidateTokens(textBytes) <= remainingWithTitle ? 4 : -4;
      attempts++;
    }
    check("(budget-accounting) sanity: found a related-note size landing inside the target window",
      candidateTokens(textBytes) > remainingWithTitle && candidateTokens(textBytes) <= remainingNoTitle);

    const relatedNote = mkEntry(relKey, textBytes, relKey, { pinned: false, updatedAt: "2026-11-01T00:00:00.000Z" });
    const noTitleWithRelated = composeProjectMemoryDigest(buildPinned(false), [relatedNote], BUDGET);
    const withTitleWithRelated = composeProjectMemoryDigest(buildPinned(true), [relatedNote], BUDGET);

    check("(budget-accounting) the related note FITS when the REST drop line is title-less (more remaining budget)",
      noTitleWithRelated.includedIds.includes(`id-${relKey}`));
    check("(budget-accounting) the SAME related note is DROPPED when the REST drop line carries titles (strictly less remaining budget) — proving the added bytes are genuinely counted against the shared budget, not appended for free",
      !withTitleWithRelated.includedIds.includes(`id-${relKey}`) &&
      withTitleWithRelated.droppedRelatedKeys.includes(relKey));
  }
} catch (err) {
  console.error(err);
  failures++;
}

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log(
    "\n✅ ALL PASS — card 926e4ac8: a dropped REST/FLOOR/RELATED note renders `key — title` (truncated past " +
    "~60 chars, never the full title); a title-less entry falls back to the bare key; the drop list stays " +
    "uncapped/complete with titles attached; the \"(never delivered)\" marker composes correctly after the " +
    "title; and the added title bytes are genuinely counted toward the shared digest budget — proven by " +
    "pushing one related note from included to dropped purely by attaching titles to the REST drop line. " +
    "Against the REAL compiled composeProjectMemoryDigest, claude-free, network-free.",
  );
}
