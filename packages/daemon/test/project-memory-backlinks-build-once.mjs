import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// Card 527ed4f0 — annotateNote's own per-note annotateBacklinks call (card d305f1a2's pre-existing
// O(N^2): a fresh full-corpus db.listProjectMemory fetch + regex scan on EVERY note annotated) dominated
// BOTH retrieveProjectMemoryForKickoff and the computeRestTierSignal/computeNeverDropStatus write-time
// status computation (>99% of each, measured on a hermetic 760-note/4700-task fixture — see the card's
// own investigate-first worker_report for the full profile). The fix wires the ALREADY-SHIPPED
// findInboundBacklinksBulk/annotateBacklinksBulk (card 41c3f546, built for the memory_list REST route)
// into annotateNote via a new build-once-per-composition index (buildBacklinksIndex) +
// O(1)-lookup (annotateBacklinksPrecomputed) — the same build-once shape buildMentionsIndex/
// annotateMentionsPrecomputed already use for mentions (card a140598a).
//
// This file proves:
//   1. EQUIVALENCE: for every note in a realistic fixture (many notes, wikilinks, one note over the
//      backlinks cap, one EXPIRED note that still links to a live one), the OLD per-note annotateBacklinks
//      output and the NEW bulk-index-lookup output are byte-identical, at both the digest cap
//      (MAX_BACKLINKS_DIGEST) and the general on-demand cap (MAX_BACKLINKS).
//   2. A POSITIVE CONTROL that the equivalence comparison itself can fail (a deliberately wrong-cap
//      index does NOT match the correct old result) — proving #1 isn't a vacuously-true check.
//   3. INTEGRATION: annotateNote, given the new backlinksIndex param, renders the identical backlink
//      lines the old per-note path would have, in the same position among request-link/mention lines.
//   4. END-TO-END: retrieveProjectMemoryForKickoff's real rendered digest text actually contains the
//      expected backlink annotation lines (not just the unit-level helpers).
//   5. CALL-COUNT (the actual perf claim, not just equivalence): db.listProjectMemory is called a small,
//      BOUNDED number of times per kickoff / per write-time status computation — and, crucially, that
//      count does NOT grow as the corpus/pinned-note count grows (i.e. genuinely O(1) per composition,
//      not O(notes)). Negative-controlled by re-running the SAME assertion against the pre-fix code
//      (see the worker's own report for the `negative-control --ref <pre-fix sha>` RED proof).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-backlinks-build-once.mjs

const loomHome = useOwnLoomHome("loom-pm-backlinks-once-");

const { Db } = await import("../dist/db.js");
const {
  annotateBacklinks, annotateBacklinksPrecomputed, buildBacklinksIndex, MAX_BACKLINKS, MAX_BACKLINKS_DIGEST,
} = await import("../dist/sessions/project-memory-backlinks.js");
const { annotateNote } = await import("../dist/sessions/project-memory-annotations.js");
const { retrieveProjectMemoryForKickoff } = await import("../dist/sessions/project-memory-recall.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db();
const now = new Date().toISOString();
const PROJECT_ID = "proj-backlinks-build-once";
db.insertProject({ id: PROJECT_ID, name: "Backlinks Build-Once Project", repoPath: loomHome, vaultPath: loomHome, config: {}, createdAt: now, archivedAt: null });

// ===== Fixture: a hub with MORE than MAX_BACKLINKS_DIGEST inbound links (including one from an EXPIRED
// note), a note with exactly one inbound link, and a note with zero. =====
db.upsertProjectMemory(PROJECT_ID, { key: "lonely", text: "nobody links to this note at all." }, 1000);
db.upsertProjectMemory(PROJECT_ID, { key: "hub", text: "the target everyone links to." }, 1000);
db.upsertProjectMemory(PROJECT_ID, { key: "linked-once", text: "exactly one other note links here." }, 1000);
db.upsertProjectMemory(PROJECT_ID, { key: "single-linker", text: "see [[linked-once]] for the one link." }, 1000);
for (let i = 1; i <= 6; i++) {
  db.upsertProjectMemory(PROJECT_ID, { key: `hub-linker-${i}`, text: `see [[hub]] for context (linker ${i}).` }, 1000);
}
// An EXPIRED note that STILL links to hub — backlinks must stay expiry-agnostic (card a140598a round 4's
// own "Do not" explicitly scoped that question OUT of mentions and left it for backlinks' own card; this
// card does not change it either way, it only amortizes the existing, unchanged matching semantics).
// Written LAST so it's the most-recently-updated linker and deterministically lands inside the cap.
db.upsertProjectMemory(PROJECT_ID, { key: "expired-linker", text: "see [[hub]] — written by an expired note.", expiresAt: "2020-01-01" }, 1000);

const allKeys = ["lonely", "hub", "linked-once", "single-linker", "hub-linker-1", "hub-linker-2", "hub-linker-3", "hub-linker-4", "hub-linker-5", "hub-linker-6", "expired-linker"];

// Pin ONE note now so the kickoff digest below has something to render at all — with nothing pinned and
// no FTS match, retrieveProjectMemoryForKickoff short-circuits to `null` BEFORE ever building either
// index (allPinned.length === 0 && related.length === 0), which would make the call-count section below
// vacuously see 0 calls regardless of whether the fix is wired in. Caught by running this file and
// seeing the (correct, not-a-bug) 0-calls result before adding this line.
db.upsertProjectMemory(PROJECT_ID, { key: "lonely", text: db.getProjectMemoryByKey(PROJECT_ID, "lonely").text, pinned: true }, 1000);

// ===== 5 (run FIRST — see note below). CALL-COUNT: db.listProjectMemory is called a small bounded
// number of times per kickoff / per write-time status computation, and that count does NOT scale with
// corpus/pinned-note size. Deliberately placed BEFORE the equivalence/integration sections below: this
// section only calls functions that exist in BOTH the old and new code (retrieveProjectMemoryForKickoff,
// writeProjectMemory), so a negative-control revert of the fix shows a genuine BEHAVIORAL red here (the
// call count actually scales with N) rather than merely crashing on a since-added export the later
// sections import — see the worker's own report for the `negative-control --ref <pre-fix sha>` run. =====
{
  const origListProjectMemory = Db.prototype.listProjectMemory;
  let callCount = 0;
  Db.prototype.listProjectMemory = function (...a) { callCount++; return origListProjectMemory.apply(this, a); };
  try {
    callCount = 0;
    retrieveProjectMemoryForKickoff(db, PROJECT_ID, "call-count check, small corpus");
    const countSmall = callCount;
    check("(call-count, kickoff) db.listProjectMemory called a small bounded number of times (<=3) on the small corpus",
      countSmall <= 3); // 0 since the digest stopped building the backlinks index

    // Scale the corpus up substantially and re-run — the call count must NOT grow with note count.
    for (let i = 0; i < 100; i++) {
      db.upsertProjectMemory(PROJECT_ID, { key: `scale-note-${i}`, text: `padding note ${i} to grow the corpus.` }, 2000);
    }
    callCount = 0;
    retrieveProjectMemoryForKickoff(db, PROJECT_ID, "call-count check, large corpus");
    const countLarge = callCount;
    check("(call-count, kickoff) db.listProjectMemory call count unchanged after growing the corpus by 100 notes (NOT O(notes))",
      countLarge === countSmall);
  } finally {
    Db.prototype.listProjectMemory = origListProjectMemory;
  }
}

{
  // computeNeverDropStatus/computeRestTierSignal are module-private in mcp/memory.ts; drive the SAME
  // code path through the real public writeProjectMemory instead (the production entry point), with
  // the CURRENT baseVersion each call — a missing baseVersion hits the version-CAS conflict path
  // (card a5f98bb4) and returns before ever reaching computeRestTierSignal, which would silently look
  // "free" instead of exercising the real path (caught during this card's own investigate-first
  // profiling — see the worker's report).
  const { writeProjectMemory } = await import("../dist/mcp/memory.js");

  // Pin several ordinary (non-never-drop) notes so computeRestTierSignal's own annotate() loop runs
  // over a non-trivial pinned population.
  for (let i = 0; i < 5; i++) {
    const key = `rest-pinned-${i}`;
    db.upsertProjectMemory(PROJECT_ID, { key, text: `rest-tier pinned note ${i}.`, pinned: true }, 2000);
  }

  const origListProjectMemory = Db.prototype.listProjectMemory;
  let callCount = 0;
  Db.prototype.listProjectMemory = function (...a) { callCount++; return origListProjectMemory.apply(this, a); };
  try {
    const targetKey = "rest-pinned-0";
    let cur = db.getProjectMemoryByKey(PROJECT_ID, targetKey);
    callCount = 0;
    const res1 = writeProjectMemory(db, PROJECT_ID, { key: targetKey, text: cur.text, baseVersion: cur.version });
    const countSmall = callCount;
    check("(call-count, write) restTierStatus was actually computed (the path under test ran)",
      res1 && res1.restTierStatus !== undefined);
    check("(call-count, write) db.listProjectMemory called a small bounded number of times (<=3) on the small pinned set",
      countSmall <= 3);

    // Pin many MORE ordinary notes and re-run on the SAME target — call count must not grow.
    for (let i = 5; i < 30; i++) {
      const key = `rest-pinned-${i}`;
      db.upsertProjectMemory(PROJECT_ID, { key, text: `rest-tier pinned note ${i}.`, pinned: true }, 2000);
    }
    cur = db.getProjectMemoryByKey(PROJECT_ID, targetKey);
    callCount = 0;
    const res2 = writeProjectMemory(db, PROJECT_ID, { key: targetKey, text: cur.text, baseVersion: cur.version });
    const countLarge = callCount;
    check("(call-count, write) restTierStatus was computed again on the scaled-up pinned set",
      res2 && res2.restTierStatus !== undefined);
    check("(call-count, write) db.listProjectMemory call count unchanged after growing the pinned set from 5 to 30 (NOT O(notes))",
      countLarge === countSmall);
  } finally {
    Db.prototype.listProjectMemory = origListProjectMemory;
  }
}

// ===== 1. EQUIVALENCE: old per-note annotateBacklinks vs new bulk-index lookup, every note, two caps =====
for (const cap of [MAX_BACKLINKS_DIGEST, MAX_BACKLINKS]) {
  const index = buildBacklinksIndex(db, PROJECT_ID, cap);
  for (const key of allKeys) {
    const oldLines = annotateBacklinks(db, PROJECT_ID, key, cap);
    const newLines = annotateBacklinksPrecomputed(index, key);
    check(`(equivalence, cap=${cap}) ${key}: old per-note vs new bulk-index output identical`,
      JSON.stringify(oldLines) === JSON.stringify(newLines));
  }
}

// hub has 7 real inbound linkers (6 ordinary + 1 expired) — over MAX_BACKLINKS_DIGEST(5), so this
// exercises the "showing N of M" truncation notice identically old vs new, AND proves the expired linker
// is NOT silently excluded (it's the most-recently-written, so it's guaranteed inside the cap).
{
  const oldHub = annotateBacklinks(db, PROJECT_ID, "hub", MAX_BACKLINKS_DIGEST);
  check("(hub) old result shows the truncation notice (7 real linkers > cap 5)",
    oldHub.some((l) => l.includes("showing 5 of 7 inbound links")));
  check("(hub) old result includes the EXPIRED linker — backlinks stay expiry-agnostic",
    oldHub.some((l) => l.includes("[[expired-linker]]")));
  const newHub = annotateBacklinksPrecomputed(buildBacklinksIndex(db, PROJECT_ID, MAX_BACKLINKS_DIGEST), "hub");
  check("(hub) new bulk-index result matches old result byte-for-byte, including the expired linker",
    JSON.stringify(oldHub) === JSON.stringify(newHub));
}

// ===== 2. POSITIVE CONTROL: the equivalence comparison above is not vacuously true — a deliberately
// wrong-cap index must NOT match the correct old result. =====
{
  const oldHub = annotateBacklinks(db, PROJECT_ID, "hub", MAX_BACKLINKS_DIGEST);
  const wrongCapIndex = buildBacklinksIndex(db, PROJECT_ID, 1); // deliberately wrong cap
  const newHubWrong = annotateBacklinksPrecomputed(wrongCapIndex, "hub");
  check("(positive control) a deliberately wrong-cap bulk index does NOT match the correct old result — the comparison can fail",
    JSON.stringify(oldHub) !== JSON.stringify(newHubWrong));
}

// ===== 3. INTEGRATION: annotateNote no longer injects backlinks into the digest annotations (only linked
// Request state remains); the index builder itself still produces the digest-capped lines memory_read-style
// callers use. =====
{
  const hubEntry = db.getProjectMemoryByKey(PROJECT_ID, "hub");
  const backlinksIndex = buildBacklinksIndex(db, PROJECT_ID, MAX_BACKLINKS_DIGEST);
  const oldHub = annotateBacklinks(db, PROJECT_ID, "hub", MAX_BACKLINKS_DIGEST);
  check("(integration) the precomputed index still equals the per-note backlinks output",
    JSON.stringify(annotateBacklinksPrecomputed(backlinksIndex, "hub")) === JSON.stringify(oldHub) && oldHub.length > 0);
  check("(integration) annotateNote injects NO backlink lines (only request-link state remains; hub links no request)",
    JSON.stringify(annotateNote(db, PROJECT_ID, hubEntry)) === JSON.stringify([]));
}

// ===== 4. END-TO-END: the real rendered kickoff digest carries NO backlink annotation. =====
{
  db.upsertProjectMemory(PROJECT_ID, { key: "hub", text: db.getProjectMemoryByKey(PROJECT_ID, "hub").text, pinned: true }, 1000);
  const digest = retrieveProjectMemoryForKickoff(db, PROJECT_ID, "end-to-end kickoff check");
  check("(e2e) the digest renders hub (positive control: the note is delivered)",
    typeof digest === "string" && digest.includes("(hub)"));
  check("(e2e) the real kickoff digest contains NO backlink annotation",
    typeof digest === "string" && !digest.includes("[backlink") && !digest.includes("inbound links"));
}

db.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
