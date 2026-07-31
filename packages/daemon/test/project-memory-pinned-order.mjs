import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 15503722 — the pinned tier used to pack notes in KEY-ALPHABETICAL order, silently `continue`-ing
// past (never reporting) any note that overflowed `budgetTokens`. On this project's OWN live memory store,
// AT THE TIME this card was filed (memory.budgetTokens=4000, 2026-07-31), that meant an explicit OWNER
// DIRECTIVE (`gate-cap-is-2-by-owner-decision-never-change-silently`) was silently dropped from every
// kickoff — nothing about importance, only spelling and size, decided who survived.
//
// ⚠️ budgetTokens IS OWNER-TUNABLE (a live Settings value) and WAS RAISED to 8000 mid-investigation on this
// card, which on its own would make the corpus below fit without overflowing at all — the exact "raise the
// budget, defer the failure" trap this card explicitly rules out as a fix (a larger budget still drops by
// spelling once IT overflows, just later). So `TEST_BUDGET_TOKENS` below is a DELIBERATELY FIXED literal,
// NEVER read from resolveConfig/the DB/any live project setting — do NOT "helpfully" sync it to whatever
// the project's resolved memory.budgetTokens currently is. Its only job is to sit below this fixture
// corpus's total size so the RED/GREEN contrast below keeps discriminating regardless of what the owner
// sets the real budget to.
//
// This file proves, against the REAL compiled `composeProjectMemoryDigest` (not a reimplementation):
//   1. RED/GREEN, DISCRIMINATING: the exact same real-shaped 10-note corpus, varied only by whether
//      `updatedAt` carries real recency signal or is flattened to one timestamp (which reduces the new
//      algorithm to its key-ascending tiebreak — i.e. the OLD alphabetical behavior) — proving the fix's
//      ordering signal, not just its presence, is what rescues the flagship note.
//   2. Overflow is REPORTED, not silent — the exact dropped keys appear in the digest text.
//   3. The `never-drop` floor tier packs first and gets its own distinct ALARM line when IT overflows,
//      never conflated with the routine overflow line.
// CLAUDE-free, network-free.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-pinned-order.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { composeProjectMemoryDigest, estimateTokens, NEVER_DROP_TAG } = await import("../dist/sessions/project-memory-recall.js");

check("(sanity) NEVER_DROP_TAG is the expected literal", NEVER_DROP_TAG === "never-drop");

// ===================== a real-shaped 10-note pinned corpus (card 15503722 provenance) =====================
// key, real text BYTE length (as reported live by the manager auditing this project's own memory store on
// 2026-07-31), real updatedAt (read live via memory_list, same date). Content itself is filler
// (`estimateTokens` is a pure byte-length heuristic — see project-memory-recall.ts), but the LENGTHS and
// TIMESTAMPS are real, snapshotted at that moment — this is fixture DATA, frozen for reproducibility, not a
// live read; it does NOT change if the real notes are edited/added/removed later.
const LIVE_CORPUS = [
  ["a-comment-is-a-claim-grep-them-when-you-fix", 3601, "2026-07-30T02:56:35.572Z"],
  ["codescape-is-private-no-user-visible-surface", 3857, "2026-07-28T18:26:22.979Z"],
  ["commit-before-run-gate-or-forfeit-reuse", 2134, "2026-07-31T09:02:29.522Z"],
  ["discriminating-control-and-proof-beats-measurement", 2131, "2026-07-31T09:02:11.641Z"],
  ["engine-confirmation-can-lag-minutes-timeouts-assume-seconds", 2151, "2026-07-31T09:02:37.164Z"],
  ["exoneration-proves-the-card-innocent-not-the-failure-spurious", 2231, "2026-07-31T09:02:21.226Z"],
  ["gate-cap-is-2-by-owner-decision-never-change-silently", 3873, "2026-07-30T15:41:22.676Z"], // ⭐ the flagship owner directive
  ["positive-control-your-searches-empty-is-not-evidence", 3556, "2026-07-29T05:38:22.487Z"],
  ["read-which-assertions-failed-not-how-many", 3099, "2026-07-29T13:54:16.876Z"],
  ["two-states-one-signature-add-a-discriminator", 2247, "2026-07-31T09:02:03.867Z"],
];
// DELIBERATELY FIXED, NOT read from resolveConfig/live config (see the top-of-file warning) — chosen only
// to sit well below LIVE_CORPUS's total (~28,880 bytes of note text alone, ~7.2k tokens once header/block
// overhead is added) so the corpus reliably overflows and the RED/GREEN contrast below keeps discriminating
// no matter what the project's real memory.budgetTokens is set to today or in the future.
const TEST_BUDGET_TOKENS = 4000;
const FLAGSHIP = "gate-cap-is-2-by-owner-decision-never-change-silently";

// Card b4c4699e DIRECTIVE #2 — parses the ACTUALLY-RENDERED key list out of a notice, rather than trusting
// the notice's own reported COUNT (which is derived from droppedRestKeys.length directly and stays correct
// even when the LIST itself was truncated — that's exactly what made the original bug invisible to a
// count-only check). `marker` is the fixed prose immediately preceding the comma-joined key list; everything
// from there to the end of `text` is taken as the list (safe here because the notice line is always the
// last thing appended in these fixtures — no related-tier text follows it).
const parseListedKeys = (text, marker) => {
  const idx = text.indexOf(marker);
  if (idx === -1) return [];
  return text.slice(idx + marker.length).split(",").map((s) => s.trim()).filter(Boolean);
};

const mkEntry = ([key, textBytes, updatedAt], overrides = {}) => ({
  id: `id-${key}`,
  projectId: "proj-order-test",
  key,
  title: key,
  text: "x".repeat(textBytes),
  pinned: true,
  tags: [],
  createdAt: updatedAt,
  updatedAt,
  lastRetrievedAt: null,
  retrievalCount: 0,
  version: 1,
  requestIds: null,
  ...overrides,
});

try {
  // ===================== 1. RED/GREEN discriminating control on the REAL live corpus =====================
  {
    // GREEN: real, varied updatedAt — the actual shape this project's memory store is in today.
    const liveEntries = LIVE_CORPUS.map((row) => mkEntry(row));
    const { includedIds, droppedRestKeys } = composeProjectMemoryDigest(liveEntries, [], TEST_BUDGET_TOKENS);
    const includedKeys = liveEntries.filter((e) => includedIds.includes(e.id)).map((e) => e.key);
    check("(red-green GREEN) the flagship owner-directive note IS delivered under real recency ordering",
      includedKeys.includes(FLAGSHIP));
    check("(red-green GREEN) exactly the 4 known-dropped keys are reported dropped, nothing else",
      droppedRestKeys.length === 4 &&
      ["a-comment-is-a-claim-grep-them-when-you-fix", "read-which-assertions-failed-not-how-many",
        "positive-control-your-searches-empty-is-not-evidence", "codescape-is-private-no-user-visible-surface"]
        .every((k) => droppedRestKeys.includes(k)));
  }

  {
    // RED: the SAME corpus with updatedAt flattened to one shared timestamp — recency carries NO signal,
    // so the new algorithm degrades to its key-ascending tiebreak alone, which is BYTE-IDENTICAL in
    // behavior to the old key-alphabetical bug. This is the discriminating half of the control: same
    // code, same corpus, only the timestamp variance removed — and the flagship note goes back to being
    // dropped, proving it's the RECENCY SIGNAL (not just "a fix exists") doing the rescuing above.
    const flatEntries = LIVE_CORPUS.map((row) => mkEntry([row[0], row[1], "2026-01-01T00:00:00.000Z"]));
    const { includedIds } = composeProjectMemoryDigest(flatEntries, [], TEST_BUDGET_TOKENS);
    const includedKeys = flatEntries.filter((e) => includedIds.includes(e.id)).map((e) => e.key);
    check("(red-green RED) with recency neutralized (flat timestamps ⇒ pure key order), the SAME flagship note is dropped again — proving the ordering signal, not mere code presence, is what fixed it",
      !includedKeys.includes(FLAGSHIP));
    check("(red-green RED) and confirms key-alphabetical order IS what the flat-timestamp run reduces to",
      JSON.stringify(includedKeys) === JSON.stringify([...includedKeys].sort()));
  }

  // ===================== 2. overflow is REPORTED in the digest text itself =====================
  {
    const liveEntries = LIVE_CORPUS.map((row) => mkEntry(row));
    const { digest, includedIds } = composeProjectMemoryDigest(liveEntries, [], TEST_BUDGET_TOKENS);
    check("(overflow-visible) the digest text names the drop count", digest.includes("4 pinned note(s) dropped for budget"));
    check("(overflow-visible) the digest text names the actual dropped KEYS, not just a count",
      digest.includes("codescape-is-private-no-user-visible-surface") && digest.includes("read-which-assertions-failed-not-how-many"));
    check("(overflow-visible) a note that WAS delivered does not ALSO appear inside the drop line",
      !digest.slice(digest.indexOf("pinned note(s) dropped for budget")).includes(FLAGSHIP));
    // ⚠️ NOT a truncation-discriminating check (card b4c4699e DIRECTIVE #2): at this N=10, only 4 notes
    // drop — well under the OLD MAX_LISTED_DROPPED_KEYS=8, so no truncation would fire even on the PRE-FIX
    // code. This only guards the arithmetic identity itself as a cheap always-on regression net; it CANNOT
    // catch the +N-more truncation class. See section 7 below for the corpus that actually discriminates.
    check("(overflow-visible, N=10 — arithmetic sanity net, NOT a truncation control, see comment above) delivered + keys listed in the notice === total corpus",
      includedIds.length + parseListedKeys(digest, "pinned note(s) dropped for budget: ").length === LIVE_CORPUS.length);
  }

  // ===================== 3. never-drop floor: packs first, priority over recency =====================
  {
    // An OLD note (would lose on pure recency to everything else here) tagged never-drop must still beat
    // a newer, untagged note when both compete for the same tight remainder.
    const oldFloor = mkEntry(["floor-old-critical", 200, "2020-01-01T00:00:00.000Z"], { tags: [NEVER_DROP_TAG] });
    const newOrdinary = mkEntry(["zzz-new-ordinary", 200, "2026-07-31T00:00:00.000Z"]);
    const tightBudget = 90; // fits exactly one of the two note-blocks, not both
    const { includedIds } = composeProjectMemoryDigest([oldFloor, newOrdinary], [], tightBudget);
    check("(floor-priority) the OLD never-drop note wins the tight budget over a NEWER ordinary note",
      includedIds.includes("id-floor-old-critical") && !includedIds.includes("id-zzz-new-ordinary"));
  }

  // ===================== 4. never-drop floor tier ITSELF overflows: distinct ALARM, not routine ⚠️ =====================
  {
    const floorA = mkEntry(["floor-a", 100, "2026-07-30T00:00:00.000Z"], { tags: [NEVER_DROP_TAG] });
    const floorB = mkEntry(["floor-b", 100, "2026-07-29T00:00:00.000Z"], { tags: [NEVER_DROP_TAG] }); // older ⇒ loses within the floor tier
    const ordinary = mkEntry(["ordinary-note", 30, "2026-07-31T00:00:00.000Z"]);
    const tinyBudget = 50; // fits ONE floor note; both floor notes together don't fit; ordinary never gets a turn (verified via a budget sweep)
    const { includedIds, droppedFloorKeys, droppedRestKeys, digest } =
      composeProjectMemoryDigest([floorA, floorB, ordinary], [], tinyBudget);
    check("(floor-overflow) the newer floor note survives", includedIds.includes("id-floor-a"));
    check("(floor-overflow) the older floor note is the one that overflows the floor tier itself", droppedFloorKeys.includes("floor-b"));
    check("(floor-overflow) a broken never-drop guarantee produces the ALARM signal", digest.includes("ALARM") && digest.includes("BROKEN GUARANTEE"));
    check("(floor-overflow) the alarm names the actual note", digest.includes("floor-b"));
    check("(floor-overflow) the ordinary note is genuinely squeezed out (proves the floor tier truly packs FIRST, ahead of rest)",
      !includedIds.includes("id-ordinary-note") && droppedRestKeys.includes("ordinary-note"));
    check("(floor-overflow) the ALARM line and the routine ⚠️ line are TEXTUALLY DISTINCT — an alarm never wears the routine line's wording",
      digest.includes("🚨 ALARM") && digest.includes("⚠️") &&
      digest.indexOf("🚨 ALARM") !== digest.indexOf("⚠️"));
    check("(floor-overflow) the routine line does NOT also list the floor-tier's own dropped key (no double-reporting)",
      !digest.slice(digest.indexOf("⚠️")).includes("floor-b"));
  }

  // ===================== 5. deterministic tiebreak under equal timestamps =====================
  {
    const same = "2026-07-31T00:00:00.000Z";
    const a = mkEntry(["aaa-note", 50, same]);
    const b = mkEntry(["zzz-note", 50, same]);
    const r1 = composeProjectMemoryDigest([b, a], [], 4000); // caller order: b, a
    const r2 = composeProjectMemoryDigest([a, b], [], 4000); // caller order: a, b
    check("(determinism) both call orders produce the SAME included set (order is derived, not caller-dependent)",
      JSON.stringify([...r1.includedIds].sort()) === JSON.stringify([...r2.includedIds].sort()));
    check("(determinism) under equal timestamps the tiebreak is key-ascending (a before b in the digest text)",
      r1.digest.indexOf("aaa-note") < r1.digest.indexOf("zzz-note"));
  }

  // ===================== 6. no-drop case stays byte-identical to before (no stray alert lines) =====================
  {
    const roomy = LIVE_CORPUS.slice(0, 3).map((row) => mkEntry(row));
    const { digest } = composeProjectMemoryDigest(roomy, [], 100000);
    check("(no-overflow) plenty of budget ⇒ no overflow/alarm line appears at all",
      !digest.includes("dropped for budget") && !digest.includes("ALARM"));
  }

  // ===================== 7. AT-SCALE positive control (card b4c4699e): 30+ drops, EVERY key named =====================
  // The overflow assertions in section 2 above exercise only 4 drops — well UNDER the OLD
  // MAX_LISTED_DROPPED_KEYS cap of 8, so they'd pass identically whether or not the "+N more" truncation
  // bug existed (the exact trap this card warns against: a below-threshold test passes for the wrong
  // reason). This section forces 30+ drops in BOTH the routine (rest) and never-drop (floor) sub-tiers —
  // genuinely above where the old cap used to bite — and asserts every single dropped key is named, with a
  // negative control proving the "+N more" folding branch is GONE, not merely raised to a bigger number.
  {
    const N = 45;
    const restCorpus = Array.from({ length: N }, (_, i) =>
      mkEntry([`at-scale-rest-dropped-key-${String(i).padStart(2, "0")}`, 300, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`]));
    const TIGHT_BUDGET = 600; // fits only a handful of the 45 notes — forces the rest well past the old cap of 8
    const { digest, droppedRestKeys, droppedFloorKeys, includedIds } = composeProjectMemoryDigest(restCorpus, [], TIGHT_BUDGET);
    check("(at-scale rest) forces 30+ drops, genuinely above the old MAX_LISTED_DROPPED_KEYS=8 threshold",
      droppedRestKeys.length >= 30);
    check("(at-scale rest) EVERY dropped key is named in the digest text, none folded away",
      droppedRestKeys.every((k) => digest.includes(k)));
    check("(at-scale rest) the drop count in the digest text matches the real drop count",
      digest.includes(`${droppedRestKeys.length} pinned note(s) dropped for budget`));
    check("(at-scale rest) NEGATIVE CONTROL: no '+N more' folding text appears anywhere — the truncation branch is GONE, not merely raised",
      !/\+\d+ more/.test(digest));
    check("(at-scale rest) sanity: nothing tagged never-drop in this corpus, so no ALARM drops", droppedFloorKeys.length === 0);
    check("(at-scale rest) included + dropped accounts for the whole corpus", includedIds.length + droppedRestKeys.length === N);
    // Card b4c4699e DIRECTIVE #2 — the ARITHMETIC INVARIANT, parsed from the RENDERED text (not the
    // function's own droppedRestKeys array, which is checked above but can't catch a bug where the array is
    // right and only the STRINGIFIED notice truncates — exactly this card's original bug: the reported
    // COUNT was always correct, only the LIST was folded to "+N more"). This is the check that actually
    // discriminates at scale.
    check("(at-scale rest) ARITHMETIC INVARIANT: delivered + keys ACTUALLY LISTED in the rendered notice === total corpus",
      includedIds.length + parseListedKeys(digest, "pinned note(s) dropped for budget: ").length === N);
  }
  {
    const N = 45;
    const floorCorpus = Array.from({ length: N }, (_, i) =>
      mkEntry([`at-scale-floor-dropped-key-${String(i).padStart(2, "0")}`, 300, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`], { tags: [NEVER_DROP_TAG] }));
    const TIGHT_BUDGET = 600;
    const { digest, droppedFloorKeys, droppedRestKeys, includedIds } = composeProjectMemoryDigest(floorCorpus, [], TIGHT_BUDGET);
    check("(at-scale floor) forces 30+ ALARM drops, genuinely above the old cap of 8",
      droppedFloorKeys.length >= 30);
    check("(at-scale floor) EVERY dropped never-drop key is named in the ALARM line, none folded away",
      droppedFloorKeys.every((k) => digest.includes(k)));
    check("(at-scale floor) the ALARM count in the digest text matches the real drop count",
      digest.includes(`🚨 ALARM: ${droppedFloorKeys.length} note(s) tagged "${NEVER_DROP_TAG}"`));
    check("(at-scale floor) NEGATIVE CONTROL: no '+N more' folding text appears anywhere in the ALARM line",
      !/\+\d+ more/.test(digest));
    check("(at-scale floor) sanity: nothing in the routine sub-tier (all 45 are never-drop-tagged)", droppedRestKeys.length === 0);
    check("(at-scale floor) included + dropped accounts for the whole corpus", includedIds.length + droppedFloorKeys.length === N);
    // Card b4c4699e DIRECTIVE #2 — same arithmetic invariant as the rest-tier block above, parsed from the
    // RENDERED ALARM text rather than the function's own droppedFloorKeys array.
    check("(at-scale floor) ARITHMETIC INVARIANT: delivered + keys ACTUALLY LISTED in the rendered ALARM line === total corpus",
      includedIds.length + parseListedKeys(digest, "not routine overflow: ").length === N);
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
    "\n✅ ALL PASS — pinned-tier delivery order (card 15503722): a RED/GREEN discriminating control against " +
    "this project's OWN real 10-note pinned corpus proves the recency signal (not mere code presence) is what " +
    "rescues the previously-silently-dropped owner-directive note `gate-cap-is-2-by-owner-decision-never-change-silently`; " +
    "overflow is reported by name in the digest text; a `never-drop`-tagged floor sub-tier packs strictly first and " +
    "beats a newer ordinary note under a tight budget; a floor tier that itself overflows raises a textually-distinct " +
    "ALARM never conflated with the routine ⚠️ overflow line; ordering is deterministic under equal timestamps; and a " +
    "no-overflow digest stays free of any stray alert text. Against the REAL compiled composeProjectMemoryDigest, " +
    "claude-free, network-free.",
  );
}
