import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3b4e5dd4 — card 71192d47 shipped a WARNING (the 🔴 citedDroppedLine) for "a note the kickoff cited
// by key got dropped for budget" but never fed that citation back into SELECTION — an observed agent did
// not act on the warning, so a note the kickoff explicitly named as required reading could still silently
// fail to arrive. This file tests the fix: within the pinned-REST sub-tier ONLY, a note cited by exact key
// ({@link isKeyCitedInText}) gets PRIORITY packing ahead of the ordinary `sortPinnedByRecency` rotation,
// bounded by a reserve that binds on EITHER of two independent axes — at most CITED_REST_RESERVE_MAX_COUNT
// (3) notes, AND at most CITED_REST_RESERVE_FRACTION (50%) of `restCap` in tokens, whichever binds first —
// so a kickoff citing many keys can never starve every other pinned note. A cited note that doesn't fit
// the reserve is NOT penalized: it falls back to its ordinary LRU position, exactly as if it had never
// been cited. FLOOR and RELATED are untouched; `budgetTokens` itself is never touched.
//
// RED PROOF (verification, not embedded in this file — see the worker's report): the "(rescue)" block
// below fails against a `git stash` of just this card's reorder addition (pre-fix composeProjectMemoryDigest,
// restored via the worktree's own patch/revert recipe — never `git stash`), then passes once restored and
// rebuilt.
//
// Every scenario below computes its EXPECTED result via an independently-reimplemented reference (never
// hardcoded token counts) — the same pattern project-memory-related-floor.mjs uses for card 738568b6 — so
// a scenario's own arithmetic can't silently drift from what the real packer actually does.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-cited-reserve.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { composeProjectMemoryDigest, estimateTokens, isKeyCitedInText } =
  await import("../dist/sessions/project-memory-recall.js");

const mkEntry = (key, textBytes, overrides = {}) => ({
  id: `id-${key}`,
  projectId: "proj-cited-reserve-test",
  key,
  title: key,
  text: "p".repeat(textBytes),
  pinned: true,
  tags: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastRetrievedAt: null,
  retrievalCount: 0,
  version: 1,
  requestIds: null,
  ...overrides,
});

// ===================== independent reference — NOT the function under test =====================
// Mirrors the real source's block format exactly (card 56f989a6's [v#, date] stamp) and its plain
// (pre-this-card) greedy "continue past oversized" pack — same technique project-memory-related-floor.mjs
// uses for card 738568b6. `CITED_RESERVE_MAX_COUNT`/`CITED_RESERVE_FRACTION` mirror the real source's own
// (private, unexported) constants; if the lead ever revisits those bounds, update both here.
const CITED_RESERVE_MAX_COUNT = 3;
const CITED_RESERVE_FRACTION = 0.5;
const stampFor = (m) => `v${m.version}, ${m.updatedAt.slice(0, 10)}`;
const blockFor = (m) => `### ${m.key} (${m.key}) [${stampFor(m)}]\n${m.text}`;

function referencePack(notesInDeliveryOrder, capTokens) {
  const header = "## Pinned project memory (always included)";
  const blocks = [];
  const includedKeys = [];
  const droppedKeys = [];
  for (const m of notesInDeliveryOrder) {
    const block = blockFor(m);
    const candidate = [header, ...blocks, block].join("\n\n");
    if (estimateTokens(candidate) > capTokens) { droppedKeys.push(m.key); continue; }
    blocks.push(block);
    includedKeys.push(m.key);
  }
  return { includedKeys, droppedKeys };
}

// The reorder itself, reimplemented independently: pulls a bounded PREFIX of cited notes (in their
// existing restSorted relative order) to the front; everyone else keeps their original relative order.
function referenceCitedReorder(restSortedInOrder, kickoffText, restCap, { maxCount = CITED_RESERVE_MAX_COUNT, fraction = CITED_RESERVE_FRACTION } = {}) {
  const citedRest = restSortedInOrder.filter((m) => isKeyCitedInText(kickoffText, m.key));
  const capTokens = Math.floor(restCap * fraction);
  const blocks = [];
  const prioritized = [];
  for (const m of citedRest.slice(0, maxCount)) {
    const block = blockFor(m);
    const candidate = [...blocks, block].join("\n\n");
    if (estimateTokens(candidate) > capTokens) break;
    blocks.push(block);
    prioritized.push(m);
  }
  const prioritizedIds = new Set(prioritized.map((m) => m.id));
  return [
    ...restSortedInOrder.filter((m) => prioritizedIds.has(m.id)),
    ...restSortedInOrder.filter((m) => !prioritizedIds.has(m.id)),
  ];
}

// restSorted's own order for a same-updatedAt/never-delivered corpus: sortPinnedByRecency degrades to
// updatedAt DESC, key ASC among ties — mkEntry below gives each note a DISTINCT, descending updatedAt in
// construction order, so "construction order" IS "restSorted order" for every corpus in this file.

try {
  // ===================== (rescue) DoD-1/2: a cited note dropped under plain LRU is now delivered =====================
  {
    const BUDGET = 300; // no floor, no related ⇒ restCap === BUDGET (empirically: n0..n3 fit, n4 alone overflows it — see worker's report)
    // 5 same-size notes, descending updatedAt ⇒ plain restSorted/delivery order is exactly [n0..n4].
    const notes = Array.from({ length: 5 }, (_, i) =>
      mkEntry(`n${i}`, 220, { updatedAt: `2026-08-${String(20 - i).padStart(2, "0")}T00:00:00.000Z` }));

    const plainRef = referencePack(notes, BUDGET); // pre-this-card behavior: no reorder at all
    check("(rescue) setup sanity: under plain LRU order, the corpus genuinely overflows — n4 (last) is dropped",
      plainRef.droppedKeys.includes("n4"));
    check("(rescue) setup sanity: n4 is not the ONLY note that fits — at least one note is actually included",
      plainRef.includedKeys.length > 0);

    // Cite ONLY n4 — the one note plain order drops.
    const kickoffText = "required reading: n4";
    const reorderRef = referenceCitedReorder(notes, kickoffText, BUDGET);
    const boundedRef = referencePack(reorderRef, BUDGET);
    check("(rescue) setup sanity: the reference reorder pulls n4 to the front",
      reorderRef[0].key === "n4");
    check("(rescue) setup sanity: with n4 reprioritized, the reference pack now DELIVERS n4",
      boundedRef.includedKeys.includes("n4"));

    const { includedIds, droppedRestKeys, digest } = composeProjectMemoryDigest(notes, [], BUDGET, undefined, kickoffText);
    check("(rescue) THE FIX: the real compiled function delivers the cited note that plain LRU would have dropped",
      includedIds.includes("id-n4"));
    check("(rescue) the real function's dropped-key set matches the bounded reference exactly",
      droppedRestKeys.length === boundedRef.droppedKeys.length &&
      boundedRef.droppedKeys.every((k) => droppedRestKeys.includes(k)));
    check("(rescue) no stray 🔴 citation-drop line — the cited note was DELIVERED, not dropped",
      !digest.includes("🔴"));
  }

  // ===================== (starve) card-body DoD: citing MANY notes cannot starve the rest =====================
  {
    const NOTE_BYTES = 260;
    // Original restSorted order (descending updatedAt): u0, c0, u1, c1, c2, c3, c4, c5, c6, c7 — the two
    // UNCITED notes (u0/u1) sit near the FRONT; eight cited notes (c0..c7) fill the rest.
    const order = ["u0", "c0", "u1", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];
    const notes = order.map((key, i) =>
      mkEntry(key, NOTE_BYTES, { updatedAt: `2026-08-${String(28 - i).padStart(2, "0")}T00:00:00.000Z` }));
    const kickoffText = "please read " + order.filter((k) => k.startsWith("c")).join(" ") + " before you start";

    // Budget picked so the reference pack admits exactly 6 of the 10 (generous enough that the count-axis,
    // not the fraction-axis, is what would bind in the buggy "reorder ALL cited notes, unbounded" case).
    const singleTokens = estimateTokens(["## Pinned project memory (always included)", blockFor(notes[0])].join("\n\n"));
    const perNote = estimateTokens(blockFor(notes[0]));
    const BUDGET = singleTokens + perNote * 5; // room for exactly 6 notes of this exact size

    const boundedOrder = referenceCitedReorder(notes, kickoffText, BUDGET);
    const boundedRef = referencePack(boundedOrder, BUDGET);
    // The buggy hypothesis this scenario exists to reject: reorder ALL cited notes unconditionally ahead
    // of uncited ones, with no reserve cap at all (maxCount effectively unbounded, fraction effectively 1).
    const unboundedOrder = referenceCitedReorder(notes, kickoffText, BUDGET, { maxCount: order.length, fraction: 1 });
    const unboundedRef = referencePack(unboundedOrder, BUDGET);

    check("(starve) setup sanity: the picked budget admits exactly 6 of 10 notes under the bounded reference",
      boundedRef.includedKeys.length === 6);
    check("(starve) setup sanity: this scenario is DISCRIMINATING — the unbounded (buggy) reorder would starve BOTH uncited notes",
      unboundedRef.droppedKeys.includes("u0") && unboundedRef.droppedKeys.includes("u1"));
    check("(starve) setup sanity: the bounded reference does NOT starve either uncited note",
      boundedRef.includedKeys.includes("u0") && boundedRef.includedKeys.includes("u1"));

    const { includedIds, droppedRestKeys } = composeProjectMemoryDigest(notes, [], BUDGET, undefined, kickoffText);
    const includedKeys = order.filter((k) => includedIds.includes(`id-${k}`));
    check("(starve) THE FIX: citing 8 of 10 notes does not starve u0 — it is still delivered",
      includedIds.includes("id-u0"));
    check("(starve) THE FIX: citing 8 of 10 notes does not starve u1 — it is still delivered",
      includedIds.includes("id-u1"));
    check("(starve) the real function's included set matches the BOUNDED reference exactly (not the unbounded one)",
      includedKeys.length === boundedRef.includedKeys.length &&
      boundedRef.includedKeys.every((k) => includedKeys.includes(k)));
    check("(starve) the real function's dropped set does NOT match the unbounded (buggy) reference",
      !(droppedRestKeys.length === unboundedRef.droppedKeys.length &&
        unboundedRef.droppedKeys.every((k) => droppedRestKeys.includes(k))));
  }

  // ===================== (axis: count) more than 3 cited notes, token axis deliberately slack =====================
  {
    const BUDGET = 4000; // restCap === 4000 ⇒ token reserve = 2000, comfortably above 5 tiny notes combined
    // 5 tiny cited notes, all near the FRONT already is avoided on purpose — interleave with 2 uncited
    // notes so the count cap's effect on ORDER is actually visible, not accidentally already-true.
    const order = ["u0", "c0", "c1", "u1", "c2", "c3", "c4"];
    const notes = order.map((key, i) =>
      mkEntry(key, 40, { updatedAt: `2026-08-${String(20 - i).padStart(2, "0")}T00:00:00.000Z` }));
    const kickoffText = "please read c0 c1 c2 c3 c4 before you start";

    const reorder = referenceCitedReorder(notes, kickoffText, BUDGET);
    check("(axis-count) setup sanity: token axis is genuinely slack here — all 5 cited notes together fit well under the reserve",
      estimateTokens(["c0", "c1", "c2", "c3", "c4"].map((k) => blockFor(notes.find((n) => n.key === k))).join("\n\n"))
        < Math.floor(BUDGET * CITED_RESERVE_FRACTION));
    check("(axis-count) reference: exactly the first 3 cited notes (c0,c1,c2) are pulled to the front, in their original relative order",
      reorder.slice(0, 3).map((m) => m.key).join(",") === "c0,c1,c2");
    check("(axis-count) reference: the 4th/5th cited notes (c3,c4) are NOT prioritized — they keep their original relative order among the rest",
      reorder.slice(3).map((m) => m.key).join(",") === "u0,u1,c3,c4");

    // Budget is generous enough that ALL 7 notes fit ⇒ includedIds order should equal the reorder exactly.
    const { includedIds } = composeProjectMemoryDigest(notes, [], BUDGET, undefined, kickoffText);
    check("(axis-count) setup sanity: nothing is dropped at this budget (isolates ORDER from inclusion)",
      includedIds.length === 7);
    check("(axis-count) THE FIX: the real function's packing order matches the count-bounded reference exactly",
      includedIds.join(",") === reorder.map((m) => `id-${m.key}`).join(","));
  }

  // ===================== (axis: fraction) only 2 cited notes, but the 2nd alone exceeds the token reserve =====================
  {
    const BUDGET = 1000; // restCap === 1000 ⇒ token reserve = 500
    const order = ["u0", "c0", "c1", "u1"];
    // c0/c1 sized so ONE fits inside the 500-token reserve but c0+c1 together do not (empirically: ~283
    // tok alone, ~565 tok combined — see worker's report).
    const notes = [
      mkEntry("u0", 300, { updatedAt: "2026-08-20T00:00:00.000Z" }),
      mkEntry("c0", 1100, { updatedAt: "2026-08-19T00:00:00.000Z" }),
      mkEntry("c1", 1100, { updatedAt: "2026-08-18T00:00:00.000Z" }),
      mkEntry("u1", 300, { updatedAt: "2026-08-17T00:00:00.000Z" }),
    ];
    const kickoffText = "please read c0 c1 before you start";

    const c0Alone = estimateTokens(blockFor(notes[1]));
    const c0PlusC1 = estimateTokens([blockFor(notes[1]), blockFor(notes[2])].join("\n\n"));
    const reserveTokens = Math.floor(BUDGET * CITED_RESERVE_FRACTION);
    check("(axis-fraction) setup sanity: c0 alone fits inside the reserve",
      c0Alone <= reserveTokens);
    check("(axis-fraction) setup sanity: c0+c1 together EXCEED the reserve, even though count(2) < the count cap(3)",
      c0PlusC1 > reserveTokens);

    const reorder = referenceCitedReorder(notes, kickoffText, BUDGET);
    check("(axis-fraction) reference: only c0 is prioritized — c1 is excluded by the TOKEN axis, not the count axis",
      reorder[0].key === "c0" && reorder.slice(1).map((m) => m.key).join(",") === "u0,c1,u1");

    // Same BUDGET as the reference reorder above (restCap must match on both sides, or the reserve's own
    // token cap silently differs between the expectation and the real call) — and this corpus comfortably
    // fits within it whole, so nothing actually drops ⇒ isolates ORDER from inclusion, same as the
    // count-axis case above.
    const { includedIds } = composeProjectMemoryDigest(notes, [], BUDGET, undefined, kickoffText);
    check("(axis-fraction) setup sanity: nothing is dropped at this budget",
      includedIds.length === 4);
    check("(axis-fraction) THE FIX: c1 falls back to its ORIGINAL relative LRU position (right after u0, ahead of u1) — not penalized, just not prioritized",
      includedIds.join(",") === ["c0", "u0", "c1", "u1"].map((k) => `id-${k}`).join(","));
  }
} catch (e) {
  console.log(`FAIL  (uncaught) ${e?.stack || e}`);
  failures++;
}

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S)`);
} else {
  console.log(
    "\n✅ ALL PASS — card 3b4e5dd4's pinned-REST citation-priority reserve: a note the kickoff cites by " +
    "exact key is rescued from a drop plain LRU order would have caused; citing many notes cannot starve " +
    "the uncited rest (verified against both a correctly-bounded reference AND a deliberately-unbounded " +
    "buggy reference, so the test is discriminating rather than vacuous); the reserve's two independent " +
    "caps (count and token-fraction) each bind on their own in isolation, with the non-binding axis proven " +
    "slack rather than assumed; and a cited note that overflows either cap falls back to its exact original " +
    "LRU position rather than being penalized. Against the REAL compiled composeProjectMemoryDigest, " +
    "claude-free, network-free.",
  );
}
process.exit(failures === 0 ? 0 : 1);
