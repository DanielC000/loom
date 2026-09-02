import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 71192d47 — a kickoff can name a memory note as required reading by its literal key slug, and the
// budgeter can silently drop that same note from the digest. This file tests the citation-collision
// detector added to compose the two-tier digest (`isKeyCitedInText` + the in-digest 🔴 line built by
// `citedDroppedLine`): it must FIRE when a cited key is dropped, and — the direction that actually proves
// it discriminates rather than merely reacting to any drop — STAY SILENT when the same key is delivered
// or simply never cited, across all three tiers (floor/rest/related), plus the boundary-anchoring
// regression the design explicitly called out (a key must never fire on a longer, prefix-sharing sibling).
//
// RED PROOF (verification, not embedded in this file — see the worker's report): every check below fails
// against a `git stash` of just the citation-detection source addition (the pre-feature `dist/`), then
// passes once restored and rebuilt.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-cited-dropped.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { composeProjectMemoryDigest, isKeyCitedInText, NEVER_DROP_TAG, MAX_LISTED_CITED_DROPPED_KEYS } =
  await import("../dist/sessions/project-memory-recall.js");

const mkEntry = (key, textBytes, overrides = {}) => ({
  id: `id-${key}`,
  projectId: "proj-cited-dropped-test",
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

try {
  // ===================== Part 1: isKeyCitedInText — the pure boundary-matching unit =====================
  check("(unit) fires — bare prose mention", isKeyCitedInText("please read foo-bar first", "foo-bar"));
  check("(unit) fires — backtick citation", isKeyCitedInText("see `foo-bar` for context", "foo-bar"));
  check("(unit) fires — wikilink citation", isKeyCitedInText("linked: [[foo-bar]]", "foo-bar"));
  check("(unit) fires — key at the very start of the string", isKeyCitedInText("foo-bar is required reading", "foo-bar"));
  check("(unit) fires — key at the very end of the string", isKeyCitedInText("required reading: foo-bar", "foo-bar"));
  check("(unit) stays silent — no mention at all", !isKeyCitedInText("nothing relevant here", "foo-bar"));
  check("(unit) stays silent — key is a strict PREFIX of a longer, cited sibling key (the false-positive class this design exists to avoid)",
    !isKeyCitedInText("see foo-bar-baz for the real note", "foo-bar"));
  check("(unit) stays silent — key is a strict SUFFIX of a longer identifier",
    !isKeyCitedInText("see xfoo-bar for something unrelated", "foo-bar"));
  check("(unit) fires — one embedded (false) occurrence followed by a real standalone one (proves the scan continues past a non-match instead of stopping at the first hit)",
    isKeyCitedInText("foo-bar-baz is not it, but foo-bar itself is", "foo-bar"));
  check("(unit) stays silent — every occurrence is embedded, none standalone",
    !isKeyCitedInText("foo-bar-baz and xfoo-bar-y both mention only the longer form", "foo-bar"));

  // ===================== Part 2: REST tier, both directions =====================
  {
    const restEntry = mkEntry("cited-and-dropped", 500); // ~125 tokens, guaranteed to overflow the tiny budget below
    const TINY_BUDGET = 50;

    const fires = composeProjectMemoryDigest([restEntry], [], TINY_BUDGET, undefined,
      "please read cited-and-dropped before you start");
    check("(rest, fires) the routine ⚠️ overflow line still names the dropped key",
      fires.digest?.includes("⚠️ 1 pinned note(s) dropped for budget") && fires.digest.includes("cited-and-dropped"));
    check("(rest, fires) the 🔴 citation line is present and names memory_read + the key",
      fires.digest?.includes("🔴 1 note(s) this kickoff cited by key were dropped") &&
      fires.digest.includes("memory_read") && fires.digest.includes("cited-and-dropped"));

    const silentUncited = composeProjectMemoryDigest([restEntry], [], TINY_BUDGET, undefined,
      "please read something-else before you start");
    check("(rest, stays silent — not cited at all) the drop still happens...",
      silentUncited.digest?.includes("⚠️ 1 pinned note(s) dropped for budget"));
    check("(rest, stays silent — not cited at all) ...but NO 🔴 citation line is emitted",
      !silentUncited.digest?.includes("🔴"));

    const silentPrefix = composeProjectMemoryDigest([restEntry], [], TINY_BUDGET, undefined,
      "please read cited-and-dropped-extra before you start"); // cites a LONGER sibling that shares the exact key as a prefix
    check("(rest, stays silent — kickoff cites only a longer prefix-sharing sibling) the drop still happens...",
      silentPrefix.digest?.includes("⚠️ 1 pinned note(s) dropped for budget"));
    check("(rest, stays silent — kickoff cites only a longer prefix-sharing sibling) ...but NO 🔴 citation line fires (the exact false-positive class this design rejects)",
      !silentPrefix.digest?.includes("🔴"));

    const delivered = composeProjectMemoryDigest([restEntry], [], 4000, undefined,
      "please read cited-and-dropped before you start"); // roomy budget ⇒ the note is DELIVERED, not dropped
    check("(rest, stays silent — cited AND delivered) the note is actually included, not dropped",
      delivered.includedIds.includes("id-cited-and-dropped"));
    check("(rest, stays silent — cited AND delivered) no 🔴 citation line — proves the detector reacts to the DROP, not merely to the citation",
      !delivered.digest?.includes("🔴"));
  }

  // ===================== Part 3: FLOOR tier — co-occurs with the existing 🚨 ALARM =====================
  {
    const floorEntry = mkEntry("floor-cited-key", 500, { tags: [NEVER_DROP_TAG] });
    const TINY_BUDGET = 20;

    const fires = composeProjectMemoryDigest([floorEntry], [], TINY_BUDGET, undefined,
      "read floor-cited-key first, it's load-bearing");
    check("(floor, fires) the 🚨 ALARM still fires (broken guarantee, unaffected)",
      fires.digest?.includes("🚨 ALARM") && fires.digest.includes("floor-cited-key"));
    check("(floor, fires) the 🔴 citation line ALSO fires alongside the alarm",
      fires.digest?.includes("🔴 1 note(s) this kickoff cited by key were dropped") && fires.digest.includes("memory_read"));

    const silent = composeProjectMemoryDigest([floorEntry], [], TINY_BUDGET, undefined, "unrelated kickoff text");
    check("(floor, stays silent — not cited) 🚨 ALARM still fires...", silent.digest?.includes("🚨 ALARM"));
    check("(floor, stays silent — not cited) ...but no 🔴 citation line", !silent.digest?.includes("🔴"));
  }

  // ===================== Part 4: RELATED tier — co-occurs with the fddd58ef overflow line =====================
  {
    const relatedEntry = mkEntry("related-cited-key", 500, { pinned: false });
    const TINY_BUDGET = 30;

    const fires = composeProjectMemoryDigest([], [relatedEntry], TINY_BUDGET, undefined,
      "see related-cited-key for background");
    check("(related, fires) the routine ⚠️ related-overflow line still names the dropped key",
      fires.digest?.includes("related note(s) dropped for budget") && fires.digest.includes("related-cited-key"));
    check("(related, fires) the 🔴 citation line fires",
      fires.digest?.includes("🔴 1 note(s) this kickoff cited by key were dropped") && fires.digest.includes("memory_read"));

    const silent = composeProjectMemoryDigest([], [relatedEntry], TINY_BUDGET, undefined, "unrelated kickoff text");
    check("(related, stays silent — not cited) overflow line still fires...", silent.digest?.includes("related note(s) dropped for budget"));
    check("(related, stays silent — not cited) ...but no 🔴 citation line", !silent.digest?.includes("🔴"));
  }

  // ===================== Part 5: the cap — assert what SURVIVES it, not merely that it fires =====================
  // Card 237aa3a9's lesson, directly: a bound that fires is not proof the output is still useful once it
  // does. 20 distinct REST-tier keys, all dropped (budgetTokens: 0 ⇒ nothing can possibly fit), all cited.
  // The 🔴 line must cap at MAX_LISTED_CITED_DROPPED_KEYS and still name real, memory_read-able keys plus
  // an honest "+N more" — AND the routine, deliberately-uncapped ⚠️ line one paragraph above it must still
  // carry every one of the 20 keys, so the citation line's own "full list above" claim is actually true.
  {
    const pad = (i) => String(i).padStart(2, "0");
    const KEY_COUNT = MAX_LISTED_CITED_DROPPED_KEYS + 5;
    const entries = Array.from({ length: KEY_COUNT }, (_, i) => mkEntry(`cap-key-${pad(i)}`, 10));
    const kickoffText = entries.map((e) => e.key).join(" ");

    const result = composeProjectMemoryDigest(entries, [], 0, undefined, kickoffText);
    check("(cap) every one of the 20 keys is actually dropped", result.droppedRestKeys.length === KEY_COUNT);

    const blocks = result.digest.split("\n\n");
    const overflowBlock = blocks.find((b) => b.startsWith("⚠️"));
    const citedBlock = blocks.find((b) => b.startsWith("🔴"));
    check("(cap) both the routine overflow block and the citation block are present", !!overflowBlock && !!citedBlock);
    check("(cap) the citation block comes AFTER the uncapped overflow block (so 'full list above' is spatially true)",
      overflowBlock && citedBlock && blocks.indexOf(overflowBlock) < blocks.indexOf(citedBlock));

    check(`(cap) the UNCAPPED overflow line still names all ${KEY_COUNT} keys (b4c4699e's recovery-path guarantee, unaffected by this feature)`,
      overflowBlock ? entries.every((e) => overflowBlock.includes(e.key)) : false);

    check(`(cap) the citation line reports the true total (${KEY_COUNT}), not the capped count`,
      citedBlock?.startsWith(`🔴 ${KEY_COUNT} note(s) this kickoff cited by key were dropped`));
    check(`(cap) the citation line names the first ${MAX_LISTED_CITED_DROPPED_KEYS} keys VERBATIM (this is the part card 237aa3a9 shipped empty — assert on what survives, not just that the cap engaged)`,
      citedBlock ? entries.slice(0, MAX_LISTED_CITED_DROPPED_KEYS).every((e) => citedBlock.includes(e.key)) : false);
    check("(cap) the citation line does NOT list the keys past the cap",
      citedBlock ? entries.slice(MAX_LISTED_CITED_DROPPED_KEYS).every((e) => !citedBlock.includes(e.key)) : false);
    check("(cap) the citation line's own truncation note states the correct remaining count",
      citedBlock?.includes(`+${KEY_COUNT - MAX_LISTED_CITED_DROPPED_KEYS} more — full list above`));
  }
} catch (e) {
  console.log(`FAIL  (uncaught) ${e?.stack || e}`);
  failures++;
}

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S)`);
} else {
  console.log(
    "\n✅ ALL PASS — card 71192d47's citation-collision detector: fires when a note THIS KICKOFF cited by " +
    "exact key was dropped for budget (floor/rest/related, each independently), stays silent when the same " +
    "note is delivered instead of dropped, stays silent when the kickoff never cited it, and stays silent " +
    "on a longer prefix-sharing sibling key (the exact false-positive class the boundary-anchored matcher " +
    "exists to reject) — and the bounded highlight line still names real, memory_read-able keys plus an " +
    "honest '+N more' when capped, while the pre-existing UNCAPPED overflow line one paragraph above it " +
    "still carries the complete list. Against the REAL compiled composeProjectMemoryDigest, claude-free, " +
    "network-free.",
  );
}
process.exit(failures === 0 ? 0 : 1);
