import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6def8bf4 — "an unedited pinned note sorts last and is never delivered."
//
// `sortPinnedByRecency` (project-memory-recall.ts) used to rank the pinned tiers by `updatedAt DESC`
// ALONE, STABLE. That order never changed between kickoffs unless a note was EDITED — so under a tight
// budget, whichever note had the OLDEST `updatedAt` sorted last on EVERY kickoff and was dropped every
// time, forever (measured live on this project: 4 pinned notes dark for 19 days). The fix reorders by
// `lastRetrievedAt` ASC (nulls-first — never-delivered notes get TOP priority), `updatedAt` DESC as
// tiebreak, `key` ASC as final tiebreak — see that function's own doc comment for the full argument.
//
// This file proves, against the REAL compiled composeProjectMemoryDigest:
//   1. GREEN: simulating repeated kickoffs (mutating `lastRetrievedAt` between rounds exactly as
//      `db.touchProjectMemoryRetrieved` does for whatever got included) delivers EVERY note at least
//      once, including the one with the oldest `updatedAt` that never gets edited.
//   2. DISCRIMINATING CONTROL: the SAME new code, the SAME rounds, but WITHOUT ever applying the
//      `lastRetrievedAt` bump (i.e. delivery tracking never fires) reproduces the OLD starvation —
//      proving the fix's mechanism (the bump + the sort reading it), not just "new code happens to
//      enumerate differently," is what rescues the note.
//   3. DoD-5: a REST note dropped on its very first candidacy (still `lastRetrievedAt: null`) is marked
//      "(never delivered)" inline in the routine overflow line; a note that HAS been delivered before and
//      drops again is not.
//   4. Every note in the fairness corpus is BYTE-IDENTICAL in size (only `updatedAt`/`lastRetrievedAt`
//      vary) — so a note that never appears (control) or does appear (fix) cannot be explained by size.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-pinned-fairness.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { composeProjectMemoryDigest, estimateTokens } = await import("../dist/sessions/project-memory-recall.js");

// ===================== equal-size corpus, only updatedAt varies =====================
const N_NOTES = 6;
const SAME_TEXT_BYTES = 300;
const mkEntry = (key, updatedAt, overrides = {}) => ({
  id: `id-${key}`,
  projectId: "proj-fairness-test",
  key,
  title: key,
  text: "x".repeat(SAME_TEXT_BYTES),
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

// Six equal-size notes, `updatedAt` spread across distinct days. `stable-old-note` carries the OLDEST
// `updatedAt` and is NEVER edited again across the simulated rounds below (mirrors the real-world
// "settled invariant nobody has needed to correct" case the card names as the perverse incentive).
const CORPUS_SPEC = [
  ["stable-old-note", "2026-01-01T00:00:00.000Z"],
  ["note-b", "2026-02-01T00:00:00.000Z"],
  ["note-c", "2026-03-01T00:00:00.000Z"],
  ["note-d", "2026-04-01T00:00:00.000Z"],
  ["note-e", "2026-05-01T00:00:00.000Z"],
  ["note-f", "2026-06-01T00:00:00.000Z"],
];
check("(sanity) corpus size matches N_NOTES", CORPUS_SPEC.length === N_NOTES);

const freshEntries = () => CORPUS_SPEC.map(([key, updatedAt]) => mkEntry(key, updatedAt));

// A budget that fits some but not all 6 equal-size note-blocks — forces the packer to drop at least one
// per round.
const probe = composeProjectMemoryDigest(freshEntries(), [], 1_000_000);
check("(sanity) with a huge budget every note is included (corpus itself is well-formed)",
  probe.includedIds.length === N_NOTES);
const oneBlockTokens = Math.ceil(estimateTokens(probe.digest) / N_NOTES);
const TIGHT_BUDGET = oneBlockTokens * 4; // ~4 of 6 fit per round, leaving a real remainder

const ROUNDS = 8; // generously more than N_NOTES so a fair rotation would have cycled through all of them

// Runs ROUNDS simulated kickoffs. `applyTouch:true` mutates lastRetrievedAt/retrievalCount between rounds
// exactly as db.touchProjectMemoryRetrieved does for whatever composeProjectMemoryDigest included;
// `applyTouch:false` leaves the corpus untouched between rounds (delivery tracking never fires), the
// discriminating control below.
function simulateRounds(applyTouch) {
  const rows = freshEntries();
  const everDelivered = new Set();
  const dropHistory = []; // per-round droppedRestKeys, for the DoD-5 checks below
  for (let r = 0; r < ROUNDS; r++) {
    const { includedIds, droppedRestKeys, digest } = composeProjectMemoryDigest(rows, [], TIGHT_BUDGET);
    dropHistory.push({ droppedRestKeys, digest, includedIds: [...includedIds] });
    if (applyTouch) {
      const now = new Date(2026, 6, 1, 0, r).toISOString(); // monotonically increasing per round
      for (const id of includedIds) {
        everDelivered.add(id);
        const row = rows.find((e) => e.id === id);
        row.lastRetrievedAt = now;
        row.retrievalCount += 1;
      }
    } else {
      for (const id of includedIds) everDelivered.add(id);
    }
  }
  return { rows, everDelivered, dropHistory };
}

try {
  // ===================== 1. GREEN: the fix delivers every note =====================
  {
    const { rows, everDelivered } = simulateRounds(true);
    const neverDelivered = rows.filter((e) => !everDelivered.has(e.id)).map((e) => e.key);
    check(`(GREEN, fixed code) after ${ROUNDS} rounds, every note was delivered at least once`,
      neverDelivered.length === 0);
    check("(GREEN, fixed code) specifically, the never-edited oldest-updatedAt note IS delivered " +
      "(this is the exact note the old ordering starved permanently)",
      everDelivered.has("id-stable-old-note"));
  }

  // ===================== 2. DISCRIMINATING CONTROL: same fixed code, but delivery never registers =====
  {
    // Without ever bumping lastRetrievedAt, every entry stays null forever, so the primary sort key never
    // discriminates and the comparator falls through to its updatedAt-DESC tiebreak on EVERY round — i.e.
    // the exact pre-fix order, reproduced by the SAME (already-fixed) code. This isolates that it's the
    // lastRetrievedAt bump ACTUALLY FIRING (not just "new code exists") that rescues the note — the same
    // shape as this project's own read-the-artifact-before-you-send discipline: prove the mechanism, not
    // just the presence of a fix.
    const { rows, everDelivered } = simulateRounds(false);
    const neverDelivered = rows.filter((e) => !everDelivered.has(e.id)).map((e) => e.key);
    check("(control) WITHOUT the lastRetrievedAt bump, the same oldest-updatedAt note is starved again " +
      "— proving the FIX is the bump-plus-sort combination, not incidental new code",
      neverDelivered.includes("stable-old-note"));
  }

  // ===================== 3. DoD-5: "(never delivered)" marker on a first-ever drop =====================
  {
    const { dropHistory } = simulateRounds(true);
    const round0 = dropHistory[0];
    // Round 0: every entry starts with lastRetrievedAt:null, so any note dropped in round 0 is dropped on
    // its FIRST candidacy — it must be marked.
    check("(DoD-5) round 0 drops at least one note (sanity — otherwise this check proves nothing)",
      round0.droppedRestKeys.length > 0);
    for (const key of round0.droppedRestKeys) {
      check(`(DoD-5) round-0 dropped key "${key}" (never delivered before) is marked inline in the digest`,
        round0.digest.includes(`${key} (never delivered)`));
    }
    // Find a LATER round where a note that WAS already delivered at least once gets dropped again (only
    // meaningful if the rotation ever revisits an already-delivered note under this budget/corpus size —
    // guarded so the check can't pass vacuously if that never happens).
    const delivered = new Set();
    let sawRepeatDrop = false;
    for (const round of dropHistory) {
      for (const key of round.droppedRestKeys) {
        if (delivered.has(key)) {
          sawRepeatDrop = true;
          check(`(DoD-5) a repeat-drop of already-delivered key "${key}" is NOT marked "(never delivered)"`,
            !round.digest.includes(`${key} (never delivered)`));
        }
      }
      for (const id of round.includedIds) {
        const row = CORPUS_SPEC.find(([k]) => `id-${k}` === id);
        if (row) delivered.add(row[0]);
      }
    }
    check("(DoD-5) sanity: this corpus/budget combination actually produced at least one repeat-drop case " +
      "to exercise the negative half of the marker check above",
      sawRepeatDrop);
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
    "\n✅ ALL PASS — card 6def8bf4: the lastRetrievedAt-fairness sort delivers every pinned note (including " +
    "one whose updatedAt never changes) within 8 simulated rounds; a discriminating control shows the SAME " +
    "fixed code still starves that note when the lastRetrievedAt bump never fires, proving the mechanism " +
    "(not mere code presence) does the rescuing; and the REST overflow line marks a note's first-ever drop " +
    "as \"(never delivered)\" while leaving a repeat drop unmarked. Against the REAL compiled " +
    "composeProjectMemoryDigest, claude-free, network-free.",
  );
}
