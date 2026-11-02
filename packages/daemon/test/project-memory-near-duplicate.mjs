import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// Card b1f34988 — "warn at write time when a new note near-duplicates an existing one": on a BRAND-NEW
// key, `memory_write` queries the project's existing FTS5 index with the new note's own text and, when
// the top hit clears BOTH a conservative bm25 threshold AND a coverage-fraction gate, returns an
// ADVISORY `nearDuplicateStatus` field — never blocking the write. See the decision record
// (docs/decisions/b1f34988-near-duplicate-advisory-score-plus-coverage.md) for why a raw bm25 threshold
// ALONE was measured to perform near chance-level on this project's own real corpus, and why the
// coverage gate was added.
//
// Covers:
//   (1) a near-duplicate new note ⇒ advisory present, naming the existing key.
//   (2) a genuinely unrelated new note ⇒ no advisory.
//   (3) an update to an EXISTING key (even one whose new text closely resembles another note) ⇒ no
//       advisory — the mechanism is scoped to brand-new keys only (updating IS the fix for a flagged
//       duplicate, not something to re-flag).
//   (4) a short, generic note ⇒ does not false-fire.
//   (5) the pure classification helper (isNearDuplicateCandidate/computeNearDuplicateSignal) — negative
//       control: a candidate clearing only ONE of the two gates must not classify as a duplicate.
//   (6) db.ts's findNearDuplicateProjectMemory: undefined on an empty/no-match corpus, and excludeKey
//       actually excludes the named row from candidacy.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-near-duplicate.mjs

useOwnLoomHome("loom-pm-dup-");

const { Db } = await import("../dist/db.js");
const { writeProjectMemory } = await import("../dist/mcp/memory.js");
const {
  NEAR_DUPLICATE_BM25_THRESHOLD, NEAR_DUPLICATE_COVERAGE_THRESHOLD,
  isNearDuplicateCandidate, computeNearDuplicateSignal,
} = await import("../dist/sessions/project-memory-dedup.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db();
const now = new Date().toISOString();
const projId = "proj-near-dup";
db.insertProject({ id: projId, name: "Near Dup Test Project", repoPath: now, vaultPath: now, config: {}, createdAt: now, archivedAt: null });

// bm25's IDF term degenerates toward zero on a TINY corpus (a rare term is only "rare" relative to a
// reasonably-sized population) — a single-note corpus produces a near-zero score for ANY overlap,
// duplicate or not. Seed enough unrelated filler notes that the real production shape (hundreds of
// notes) is at least approximated, so the near-dup/unrelated/short cases below exercise genuinely
// discriminating bm25 magnitudes rather than the degenerate tiny-corpus case.
for (let i = 0; i < 25; i++) {
  writeProjectMemory(db, projId, {
    key: `filler-note-${i}`,
    text: `filler note number ${i} discusses completely unrelated matters about topic number ${i} ` +
      "with generic words like apple banana cherry date elderberry fig grape honeydew",
  });
}

try {
  // ===================== (1) near-duplicate new note ⇒ advisory =====================
  {
    const wOriginal = writeProjectMemory(db, projId, {
      key: "foo-widget-rollback-procedure",
      title: "Foo widget rollback procedure",
      text: "To roll back the foo widget deployment, stop the foo widget service, revert the foo " +
        "widget config file to the previous foo widget version, and restart the foo widget service " +
        "using the foo widget restart script.",
    });
    check("(setup) writing the original note succeeds", !("error" in wOriginal));
    check("(setup) the original note's own write carries NO nearDuplicateStatus (nothing to match yet)",
      wOriginal.nearDuplicateStatus === undefined);

    const wDup = writeProjectMemory(db, projId, {
      key: "foo-widget-rollback-procedure-v2",
      text: "To roll back the foo widget deployment: stop the foo widget service, revert the foo " +
        "widget config file to the previous foo widget version, then restart the foo widget service " +
        "with the foo widget restart script.",
    });
    check("(1) writing a near-duplicate note under a DIFFERENT key still succeeds", !("error" in wDup));
    check("(1) the near-duplicate write carries a nearDuplicateStatus advisory",
      wDup.nearDuplicateStatus !== undefined);
    check("(1) the advisory names the existing key as the likely duplicate",
      wDup.nearDuplicateStatus?.key === "foo-widget-rollback-procedure");
    check("(1) the advisory's score clears the bm25 threshold",
      typeof wDup.nearDuplicateStatus?.score === "number" && wDup.nearDuplicateStatus.score <= NEAR_DUPLICATE_BM25_THRESHOLD);
    check("(1) the advisory's coverage clears the coverage threshold",
      typeof wDup.nearDuplicateStatus?.coverage === "number" && wDup.nearDuplicateStatus.coverage >= NEAR_DUPLICATE_COVERAGE_THRESHOLD);
    check("(1) the advisory message is a non-empty string naming the key",
      typeof wDup.nearDuplicateStatus?.message === "string" && wDup.nearDuplicateStatus.message.includes("foo-widget-rollback-procedure"));
  }

  // ===================== (2) a genuinely unrelated note ⇒ no advisory =====================
  {
    const wUnrelated = writeProjectMemory(db, projId, {
      key: "quarterly-budget-review-meeting",
      text: "The quarterly budget review meeting is scheduled for next Thursday with the finance team " +
        "to discuss projected revenue growth and headcount planning for the coming fiscal year.",
    });
    check("(2) writing an unrelated note succeeds", !("error" in wUnrelated));
    check("(2) an unrelated note carries NO nearDuplicateStatus",
      wUnrelated.nearDuplicateStatus === undefined);
  }

  // ===================== (3) updating an EXISTING key ⇒ no advisory, even if text closely resembles another note =====================
  {
    const wUpdate = writeProjectMemory(db, projId, {
      key: "foo-widget-rollback-procedure-v2",
      text: "To roll back the foo widget deployment: stop the foo widget service, revert the foo " +
        "widget config file to the previous foo widget version, then restart using the foo widget " +
        "restart script (edited).",
      baseVersion: 1,
    });
    check("(3) updating the existing near-duplicate key succeeds", !("error" in wUpdate));
    check("(3) updating an EXISTING key never carries a nearDuplicateStatus, however near-duplicate the text",
      wUpdate.nearDuplicateStatus === undefined);
  }

  // ===================== (4) a short, generic note does not false-fire =====================
  {
    const wShort = writeProjectMemory(db, projId, { key: "short-note-one", text: "fixed a typo in the readme" });
    check("(4) writing a short note succeeds", !("error" in wShort));
    check("(4) a short, generic note carries no nearDuplicateStatus",
      wShort.nearDuplicateStatus === undefined);

    const wShort2 = writeProjectMemory(db, projId, { key: "short-note-two", text: "bumped a dependency version" });
    check("(4) a second short, generic note also carries no nearDuplicateStatus",
      wShort2.nearDuplicateStatus === undefined);
  }

  // ===================== (5) pure classification helper — negative control on a partial match =====================
  {
    check("(5) a candidate clearing BOTH gates classifies as a duplicate",
      isNearDuplicateCandidate({ key: "x", score: NEAR_DUPLICATE_BM25_THRESHOLD - 5, coverage: NEAR_DUPLICATE_COVERAGE_THRESHOLD + 0.1 }));
    check("(5, negative control) a candidate clearing the score gate but NOT the coverage gate does NOT classify as a duplicate",
      !isNearDuplicateCandidate({ key: "x", score: NEAR_DUPLICATE_BM25_THRESHOLD - 50, coverage: NEAR_DUPLICATE_COVERAGE_THRESHOLD - 0.3 }));
    check("(5, negative control) a candidate clearing the coverage gate but NOT the score gate does NOT classify as a duplicate",
      !isNearDuplicateCandidate({ key: "x", score: NEAR_DUPLICATE_BM25_THRESHOLD + 10, coverage: 1 }));
    check("(5, negative control) undefined candidate is never a duplicate",
      !isNearDuplicateCandidate(undefined));
    check("(5) computeNearDuplicateSignal returns undefined for a non-qualifying candidate",
      computeNearDuplicateSignal({ key: "x", score: 0, coverage: 0 }) === undefined);
    check("(5) computeNearDuplicateSignal returns a signal for a qualifying candidate",
      computeNearDuplicateSignal({ key: "real-key", score: NEAR_DUPLICATE_BM25_THRESHOLD - 1, coverage: NEAR_DUPLICATE_COVERAGE_THRESHOLD })?.key === "real-key");
  }

  // ===================== (6) db.ts's findNearDuplicateProjectMemory directly =====================
  {
    const proj2 = "proj-near-dup-direct";
    db.insertProject({ id: proj2, name: "Direct Test Project", repoPath: now, vaultPath: now, config: {}, createdAt: now, archivedAt: null });
    check("(6) an empty corpus returns undefined",
      db.findNearDuplicateProjectMemory(proj2, "", "some text with real words") === undefined);

    writeProjectMemory(db, proj2, { key: "alpha-note", text: "the quick brown fox jumps over the lazy dog repeatedly" });
    check("(6) a totally non-overlapping query against a non-empty corpus returns undefined (no FTS match at all)",
      db.findNearDuplicateProjectMemory(proj2, "", "zzz yyy xxx www vvv uuu") === undefined);

    const found = db.findNearDuplicateProjectMemory(proj2, "", "the quick brown fox jumps over the lazy dog repeatedly");
    check("(6) an identical-text query matches the existing note", found?.key === "alpha-note");
    check("(6) coverage on an identical-text match is 1 (every query token present)", found?.coverage === 1);

    check("(6, excludeKey) excluding the ONLY matching key returns undefined even on an identical-text query",
      db.findNearDuplicateProjectMemory(proj2, "", "the quick brown fox jumps over the lazy dog repeatedly", "alpha-note") === undefined);
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  db.close();
}

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S)`);
} else {
  console.log(
    "\n✅ ALL PASS — the near-duplicate advisory (card b1f34988) fires on a brand-new key closely " +
    "resembling an existing note (naming that key, with a score+coverage that both clear their " +
    "thresholds), stays silent on a genuinely unrelated note, stays silent on an update to an existing " +
    "key regardless of text similarity, does not false-fire on a short/generic note, and the pure " +
    "score+coverage classification helper correctly requires BOTH gates (proven against two distinct " +
    "partial-match negative controls, not merely a passing positive case). db.ts's " +
    "findNearDuplicateProjectMemory degrades to undefined on an empty/no-match corpus and excludeKey " +
    "genuinely removes a row from candidacy. Against the REAL compiled db.ts + mcp/memory.ts + " +
    "sessions/project-memory-dedup.ts, claude-free, network-free.",
  );
}
process.exit(failures === 0 ? 0 : 1);
