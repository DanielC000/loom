import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// Card 57a91801 (mem0-comparison idea #3) — an optional `expiresAt` (ISO date/datetime, UTC) that
// retires a project-memory note from every KICKOFF tier (pinned floor/REST and FTS "related") past that
// date, WITHOUT deleting it: `memory_read`/`memory_list` keep returning it in full, annotated
// `expired:true`. See docs/decisions/57a91801-expiresat-gates-kickoff-delivery-not-existence.md for the
// three explicit design decisions this file also verifies: an expired UNPINNED note still counts toward
// `memory.maxNotes` eviction (no exemption), an expired note is still a near-duplicate CANDIDATE (the FTS
// corpus is never filtered by expiry), and expiry never deletes.
//
// Covers:
//   (1) isProjectMemoryExpired (packages/shared/src/types.ts) — the one shared predicate every layer
//       below defers to: null/undefined never expired, a past date/datetime expired, a future date not
//       expired, a malformed string not expired (fails toward NOT hiding).
//   (2) composeProjectMemoryDigest (pure, DB-free fixtures) — an expired PINNED note excluded from the
//       digest entirely; an expired RELATED note excluded; a future-dated pinned note rides unaffected; a
//       null-expiresAt pinned note rides unaffected (byte-identical to before this field existed).
//   (3) computeFloorTierStatus/computeRestTierStatus — an expired floor/REST note is excluded from the
//       write-time size advisories too (not just the real kickoff digest).
//   (4) db.ts: upsertProjectMemory/upsertProjectMemoryChecked PATCH semantics for expiresAt (omit
//       preserves, "" clears, a value sets) — and listPinnedProjectMemory/searchProjectMemory actually
//       exclude an expired row SQL-side, against a REAL Db.
//   (5) the two explicit DoD decisions: an expired UNPINNED note still counts toward the maxNotes
//       eviction cap (no special exemption); an expired note is still a near-duplicate CANDIDATE.
//   (6) mcp/memory.ts's writeProjectMemory: format validation (an unparseable date is REJECTED, with a
//       known-good date accepted as the positive control proving the check itself can fire), the
//       too-long rejection, and the `expiryStatus` advisory's two shapes (already-expired vs. not-yet).
//   (7) memory_read/memory_list (readProjectMemory/listProjectMemoryEntries): the `expired` annotation,
//       via a REAL write + read round-trip — and the note's body is still returned in full once expired.
//   (8) the full real-Db round-trip via retrieveProjectMemoryForKickoff: an expired pinned note is ABSENT
//       from the composed kickoff digest; a non-expired one is present (a positive control proving the
//       absence above isn't just a broken query returning nothing for every input).
//
// RED/GREEN proof: see the worker's own report for the `negative-control` script run against this exact
// file (--ref HEAD, since every source edit here is still uncommitted on top of HEAD).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-expiry.mjs

useOwnLoomHome("loom-pm-expiry-");

const { isProjectMemoryExpired } = await import("@loom/shared");
const {
  composeProjectMemoryDigest, computeFloorTierStatus, computeRestTierStatus, NEVER_DROP_TAG,
  retrieveProjectMemoryForKickoff,
} = await import("../dist/sessions/project-memory-recall.js");
const { Db } = await import("../dist/db.js");
const { writeProjectMemory, readProjectMemory, listProjectMemoryEntries } = await import("../dist/mcp/memory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const PAST = "2020-01-01"; // unambiguously expired, any reasonable "now"
const FUTURE = "2099-01-01"; // unambiguously not expired, any reasonable "now"

// ===== (1) isProjectMemoryExpired — the single shared predicate =====
{
  check("(1) null expiresAt -> not expired", isProjectMemoryExpired({ expiresAt: null }) === false);
  check("(1) undefined expiresAt (fixture never set it) -> not expired", isProjectMemoryExpired({}) === false);
  check("(1) a past date -> expired", isProjectMemoryExpired({ expiresAt: PAST }) === true);
  check("(1) a past full ISO datetime -> expired", isProjectMemoryExpired({ expiresAt: "2020-01-01T00:00:00.000Z" }) === true);
  check("(1) a future date -> NOT expired", isProjectMemoryExpired({ expiresAt: FUTURE }) === false);
  check("(1) a malformed, unparseable string -> NOT expired (fails toward not-hiding)", isProjectMemoryExpired({ expiresAt: "not-a-date" }) === false);
  // negative control: an intentionally-bogus value exercising the SAME code path as the malformed check
  // above must ALSO return false, proving the NaN branch itself (not just "any string returns false").
  check("(1) negative control: Date.parse('not-a-date') is genuinely NaN (the check's premise)", Number.isNaN(Date.parse("not-a-date")) === true);
  // explicit instant comparison: a timestamp exactly AT the expiry boundary is expired (t <= nowMs).
  check("(1) exactly-at-now is expired (<=, not <)", isProjectMemoryExpired({ expiresAt: new Date(1000).toISOString() }, 1000) === true);
  check("(1) one ms after now is NOT expired", isProjectMemoryExpired({ expiresAt: new Date(1001).toISOString() }, 1000) === false);
  check("(1) one ms before now IS expired", isProjectMemoryExpired({ expiresAt: new Date(999).toISOString() }, 1000) === true);
}

// ===== (2) composeProjectMemoryDigest — pure, DB-free fixtures =====
{
  const mkEntry = (over) => ({
    id: over.id, projectId: "proj-x", key: over.key, title: over.title ?? "", text: over.text,
    pinned: !!over.pinned, tags: over.tags ?? [], createdAt: now, updatedAt: now,
    lastRetrievedAt: null, retrievalCount: 0, version: 1, requestIds: null,
    triggerGlob: over.triggerGlob ?? null, expiresAt: over.expiresAt ?? null,
  });

  const expiredPinned = mkEntry({ id: "p-expired", key: "p-expired", text: "an expired pinned note", pinned: true, expiresAt: PAST });
  const futurePinned = mkEntry({ id: "p-future", key: "p-future", text: "a future-dated pinned note", pinned: true, expiresAt: FUTURE });
  const nullPinned = mkEntry({ id: "p-null", key: "p-null", text: "a plain pinned note with null expiresAt", pinned: true });

  const r1 = composeProjectMemoryDigest([expiredPinned, futurePinned, nullPinned], [], 4000);
  check("(2) an expired pinned note is EXCLUDED from the digest", !r1.digest.includes("an expired pinned note"));
  check("(2) a future-dated pinned note STILL RIDES (positive control: the exclusion is date-specific, not a broken packer)", r1.digest.includes("a future-dated pinned note"));
  check("(2) a null-expiresAt pinned note STILL RIDES (byte-identical to before this field existed)", r1.digest.includes("a plain pinned note with null expiresAt"));
  check("(2) the expired note's id is not in includedIds", !r1.includedIds.includes("p-expired"));
  check("(2) the future/null notes' ids ARE in includedIds", r1.includedIds.includes("p-future") && r1.includedIds.includes("p-null"));

  // An expired RELATED-tier note: composeProjectMemoryDigest takes pinned+related directly (no FTS here;
  // the FTS-level exclusion is covered against a real Db in section (4) below).
  const expiredRelated = mkEntry({ id: "r-expired", key: "r-expired", text: "an expired related note mentioning memory expiry stuff", pinned: false, expiresAt: PAST });
  const futureRelated = mkEntry({ id: "r-future", key: "r-future", text: "a future-dated related note mentioning memory expiry stuff", pinned: false, expiresAt: FUTURE });
  const r2 = composeProjectMemoryDigest([], [expiredRelated, futureRelated], 4000);
  check("(2) an expired RELATED note is EXCLUDED from the digest", !r2.digest.includes("an expired related note"));
  check("(2) a future-dated RELATED note STILL RIDES", r2.digest.includes("a future-dated related note"));

  // A floor (never-drop) note that's expired: still excluded, same as an ordinary pinned note — expiry
  // is orthogonal to (and takes priority over) the never-drop floor-tier guarantee.
  const expiredFloor = mkEntry({ id: "f-expired", key: "f-expired", text: "an expired never-drop floor note", pinned: true, tags: [NEVER_DROP_TAG], expiresAt: PAST });
  const r3 = composeProjectMemoryDigest([expiredFloor], [], 4000);
  check("(2) an expired never-drop FLOOR note is ALSO excluded — expiry overrides the floor guarantee", r3.digest === null);

  // All-expired ⇒ null digest (not an empty string, not a thrown error).
  const r4 = composeProjectMemoryDigest([expiredPinned], [expiredRelated], 4000);
  check("(2) all-expired input ⇒ digest is null (mirrors the pre-existing all-empty-input contract)", r4.digest === null);
}

// ===== (3) computeFloorTierStatus/computeRestTierStatus exclude expired notes too =====
{
  const mkEntry = (over) => ({
    id: over.id, projectId: "proj-x", key: over.key, title: "", text: over.text,
    pinned: true, tags: over.tags ?? [], createdAt: now, updatedAt: now,
    lastRetrievedAt: null, retrievalCount: 0, version: 1, requestIds: null,
    triggerGlob: null, expiresAt: over.expiresAt ?? null,
  });
  const expiredFloor = mkEntry({ id: "cf-1", key: "cf-1", text: "x".repeat(100), tags: [NEVER_DROP_TAG], expiresAt: PAST });
  const liveFloor = mkEntry({ id: "cf-2", key: "cf-2", text: "y".repeat(100), tags: [NEVER_DROP_TAG] });
  const floorStatus = computeFloorTierStatus([expiredFloor, liveFloor], 4000);
  check("(3) computeFloorTierStatus counts only the LIVE floor note, not the expired one", floorStatus.floorCount === 1);

  const expiredRest = mkEntry({ id: "cr-1", key: "cr-1", text: "x".repeat(100), expiresAt: PAST });
  const liveRest = mkEntry({ id: "cr-2", key: "cr-2", text: "y".repeat(100) });
  const restStatus = computeRestTierStatus([expiredRest, liveRest], 4000);
  check("(3) computeRestTierStatus counts only the LIVE rest note, not the expired one", restStatus.restCount === 1);
}

// ===== (4)/(5) real Db: PATCH semantics, SQL-side exclusion, eviction-cap + near-dup decisions =====
{
  const db = new Db();
  const projId = "proj-expiry-real";
  db.insertProject({ id: projId, name: "Expiry Real Db Test", repoPath: "/tmp/x", vaultPath: "/tmp/x", config: {}, createdAt: now, archivedAt: null });

  // --- PATCH semantics on upsertProjectMemory: omit preserves, "" clears, a value sets ---
  const w1 = db.upsertProjectMemory(projId, { key: "patch-note", text: "v1" }, 500);
  check("(4) a brand-new note with expiresAt omitted defaults to null", w1.expiresAt === null);
  const w2 = db.upsertProjectMemory(projId, { key: "patch-note", text: "v2", expiresAt: FUTURE }, 500);
  check("(4) setting expiresAt on update persists it", w2.expiresAt === FUTURE);
  const w3 = db.upsertProjectMemory(projId, { key: "patch-note", text: "v3" }, 500);
  check("(4) omitting expiresAt on a LATER update PRESERVES the stored value (PATCH, not reset)", w3.expiresAt === FUTURE);
  const w4 = db.upsertProjectMemory(projId, { key: "patch-note", text: "v4", expiresAt: "" }, 500);
  check("(4) an EXPLICIT empty string CLEARS expiresAt back to null", w4.expiresAt === null);

  // --- listPinnedProjectMemory excludes an expired PINNED row SQL-side ---
  db.upsertProjectMemory(projId, { key: "pinned-expired", text: "expired pinned body", pinned: true, expiresAt: PAST }, 500);
  db.upsertProjectMemory(projId, { key: "pinned-future", text: "future pinned body", pinned: true, expiresAt: FUTURE }, 500);
  db.upsertProjectMemory(projId, { key: "pinned-null", text: "null pinned body", pinned: true }, 500);
  const pinnedNow = db.listPinnedProjectMemory(projId);
  const pinnedKeys = pinnedNow.map((m) => m.key);
  check("(4) listPinnedProjectMemory EXCLUDES the expired pinned row", !pinnedKeys.includes("pinned-expired"));
  check("(4) listPinnedProjectMemory INCLUDES the future-dated pinned row (positive control)", pinnedKeys.includes("pinned-future"));
  check("(4) listPinnedProjectMemory INCLUDES the null-expiresAt pinned row", pinnedKeys.includes("pinned-null"));

  // --- searchProjectMemory excludes an expired UNPINNED row from the related/FTS tier ---
  db.upsertProjectMemory(projId, { key: "related-expired", text: "zephyr unique marker alpha", expiresAt: PAST }, 500);
  db.upsertProjectMemory(projId, { key: "related-future", text: "zephyr unique marker beta", expiresAt: FUTURE }, 500);
  const hits = db.searchProjectMemory(projId, "zephyr unique marker", 10).map((m) => m.key);
  check("(4) searchProjectMemory EXCLUDES the expired unpinned row", !hits.includes("related-expired"));
  check("(4) searchProjectMemory INCLUDES the future-dated unpinned row (positive control)", hits.includes("related-future"));

  // --- (5a) an expired UNPINNED note still counts toward the maxNotes eviction cap (no exemption) ---
  // upsertProjectMemory always excludes the row it JUST WROTE from its own triggering eviction sweep
  // (card 2bc735d3 — see evictProjectMemoryOverCap's own doc comment), so the candidate set below is
  // built from the two PRE-EXISTING rows, never the write that happens to trip the cap.
  const evictDb = new Db();
  evictDb.insertProject({ id: "proj-evict", name: "Evict Test", repoPath: "/tmp/x", vaultPath: "/tmp/x", config: {}, createdAt: now, archivedAt: null });
  evictDb.upsertProjectMemory("proj-evict", { key: "evict-expired", text: "an expired unpinned note, never retrieved", expiresAt: PAST }, 500);
  evictDb.upsertProjectMemory("proj-evict", { key: "evict-live", text: "a live unpinned note, will be marked retrieved" }, 500);
  // Mark ONLY the live note as retrieved, so under PROJECT_MEMORY_EVICTION_ORDER the never-retrieved
  // EXPIRED note is the MORE evictable of the two real candidates — if expiry exempted a row from
  // eviction, this expired-but-most-evictable-by-LRU note would survive anyway; it must not.
  const liveRow = evictDb.getProjectMemoryByKey("proj-evict", "evict-live");
  evictDb.touchProjectMemoryRetrieved([liveRow.id]);
  const rankBefore = evictDb.projectMemoryEvictionRank("proj-evict", "evict-expired");
  check("(5a) the expired unpinned note HAS a real eviction rank — it is a candidate, not exempted", rankBefore !== null && rankBefore.rank === 0 && rankBefore.unpinnedCount === 2);
  // A third write (excluded from its OWN candidacy) trips maxNotes=2 over the two pre-existing rows —
  // the never-retrieved EXPIRED note is now the most-evictable of the two real candidates and must
  // actually be deleted, proving expiry carries no eviction protection of its own.
  evictDb.upsertProjectMemory("proj-evict", { key: "evict-trigger", text: "the write that trips the cap" }, 2);
  const survivors = evictDb.listProjectMemory("proj-evict").filter((m) => !m.pinned).map((m) => m.key).sort();
  check("(5a) at cap=2, the never-retrieved EXPIRED note is the one actually evicted — no expiry exemption", JSON.stringify(survivors) === JSON.stringify(["evict-live", "evict-trigger"]));

  // --- (5b) an expired note is still a near-duplicate CANDIDATE ---
  db.upsertProjectMemory(projId, { key: "dup-source-expired", text: "quetzal unusual token for dedup matching", expiresAt: PAST }, 500);
  const dup = db.findNearDuplicateProjectMemory(projId, "", "quetzal unusual token for dedup matching, slightly reworded");
  check("(5b) an EXPIRED note is still returned as a near-duplicate candidate (never filtered by expiry)", dup !== undefined && dup.key === "dup-source-expired");

  // ===== (8) real round-trip: retrieveProjectMemoryForKickoff ABSENT for expired, PRESENT for live =====
  const kickoffDb = new Db();
  kickoffDb.insertProject({ id: "proj-kickoff", name: "Kickoff Test", repoPath: "/tmp/x", vaultPath: "/tmp/x", config: {}, createdAt: now, archivedAt: null });
  kickoffDb.upsertProjectMemory("proj-kickoff", { key: "kickoff-expired", text: "this note should never reach a kickoff once expired", pinned: true, expiresAt: PAST }, 500);
  kickoffDb.upsertProjectMemory("proj-kickoff", { key: "kickoff-live", text: "this note should reach every kickoff", pinned: true }, 500);
  const framed = retrieveProjectMemoryForKickoff(kickoffDb, "proj-kickoff", "an ordinary kickoff with no special text");
  check("(8) the expired pinned note is ABSENT from the real composed kickoff digest", !framed.includes("this note should never reach a kickoff once expired"));
  check("(8) the live pinned note is PRESENT (positive control — the absence above is not a broken/empty digest)", framed.includes("this note should reach every kickoff"));

  db.close();
  evictDb.close();
  kickoffDb.close();
}

// ===== (6) mcp/memory.ts's writeProjectMemory: validation, PATCH, and the expiryStatus advisory =====
{
  const db = new Db();
  const projId = "proj-mcp-expiry";
  db.insertProject({ id: projId, name: "MCP Expiry Test", repoPath: "/tmp/x", vaultPath: "/tmp/x", config: {}, createdAt: now, archivedAt: null });

  // --- format validation: a known-good date is the POSITIVE CONTROL proving the check can accept,
  // before trusting the negative result below means "rejects the bad one" rather than "rejects everything" ---
  const good = writeProjectMemory(db, projId, { key: "mcp-good-date", text: "clean", expiresAt: "2026-12-01" });
  check("(6) a well-formed date is ACCEPTED (positive control)", !("error" in good) && good.expiresAt === "2026-12-01");

  const bad = writeProjectMemory(db, projId, { key: "mcp-bad-date", text: "clean", expiresAt: "definitely-not-a-date" });
  check("(6) an unparseable expiresAt is REJECTED with {error}", "error" in bad);
  check("(6) the rejection names expiresAt", bad.error.includes("expiresAt"));
  check("(6) the bad-date note was NOT actually written", db.getProjectMemoryByKey(projId, "mcp-bad-date") === undefined);

  const tooLong = writeProjectMemory(db, projId, { key: "mcp-long-date", text: "clean", expiresAt: "2026-01-01T00:00:00.000Z-with-trailing-garbage-making-this-too-long" });
  check("(6) an over-length expiresAt is REJECTED on length, before the date-parse check even runs", "error" in tooLong && tooLong.error.includes("too long"));

  // --- PATCH semantics via the MCP layer (mirrors the db.ts-level checks in section (4), one level up) ---
  const create = writeProjectMemory(db, projId, { key: "mcp-patch", text: "v1" });
  check("(6) a brand-new MCP write with expiresAt omitted defaults to null", create.expiresAt === null);
  const setIt = writeProjectMemory(db, projId, { key: "mcp-patch", text: "v2", expiresAt: FUTURE, baseVersion: create.version });
  check("(6) setting expiresAt via MCP persists it", setIt.expiresAt === FUTURE);
  const preserveIt = writeProjectMemory(db, projId, { key: "mcp-patch", text: "v3", baseVersion: setIt.version });
  check("(6) omitting expiresAt on a later MCP update PRESERVES it", preserveIt.expiresAt === FUTURE);
  const clearIt = writeProjectMemory(db, projId, { key: "mcp-patch", text: "v4", expiresAt: "", baseVersion: preserveIt.version });
  check("(6) an explicit empty string via MCP CLEARS expiresAt", clearIt.expiresAt === null);

  // --- expiryStatus advisory: two shapes ---
  const noStatus = writeProjectMemory(db, projId, { key: "mcp-no-expiry", text: "no expiry at all" });
  check("(6) no expiryStatus when expiresAt is unset", !("expiryStatus" in noStatus));
  const futureStatus = writeProjectMemory(db, projId, { key: "mcp-future-status", text: "future", expiresAt: FUTURE });
  check("(6) a future expiresAt gets an expiryStatus with no alreadyExpired flag", "expiryStatus" in futureStatus && !futureStatus.expiryStatus.alreadyExpired);
  const pastStatus = writeProjectMemory(db, projId, { key: "mcp-past-status", text: "already past", expiresAt: PAST });
  check("(6) a PAST expiresAt gets expiryStatus.alreadyExpired:true", pastStatus.expiryStatus?.alreadyExpired === true);

  // ===== (7) memory_read/memory_list: the `expired` annotation, and the body still returns in full =====
  const readBack = readProjectMemory(db, projId, "mcp-past-status");
  check("(7) memory_read on an EXPIRED note still returns its full body", readBack.text === "already past");
  check("(7) memory_read annotates expired:true", readBack.expired === true);
  const readLive = readProjectMemory(db, projId, "mcp-future-status");
  check("(7) memory_read on a NOT-yet-expired note annotates expired:false (positive control)", readLive.expired === false);

  const listed = listProjectMemoryEntries(db, projId);
  const listedExpired = listed.find((r) => r.key === "mcp-past-status");
  const listedLive = listed.find((r) => r.key === "mcp-future-status");
  check("(7) memory_list also annotates expired:true for the expired note", listedExpired?.expired === true);
  check("(7) memory_list also returns the expired note's full body (not deleted)", listedExpired?.text === "already past");
  check("(7) memory_list annotates expired:false for the live note", listedLive?.expired === false);

  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — isProjectMemoryExpired correctly classifies null/undefined/past/future/malformed " +
    "expiresAt values; composeProjectMemoryDigest excludes an expired note from BOTH the pinned and " +
    "related tiers (floor-tier expiry overrides even the never-drop guarantee) while a future-dated or " +
    "null-expiresAt note rides unaffected; computeFloorTierStatus/computeRestTierStatus exclude an " +
    "expired note from the write-time size advisories too; a real Db's upsertProjectMemory/" +
    "upsertProjectMemoryChecked implement the omit-preserves/''-clears/value-sets PATCH convention for " +
    "expiresAt; listPinnedProjectMemory/searchProjectMemory exclude an expired row SQL-side against a " +
    "real Db while a future-dated row still surfaces (positive control); an expired UNPINNED note is " +
    "NOT exempted from the maxNotes eviction cap (ordinary LRU order decides, not expiry); an expired " +
    "note is still a legitimate near-duplicate candidate; retrieveProjectMemoryForKickoff's real composed " +
    "digest omits an expired pinned note while a live one rides; mcp/memory.ts's writeProjectMemory " +
    "rejects an unparseable expiresAt (with a well-formed date accepted as the positive control) and an " +
    "over-length one, implements the same PATCH convention, and returns an expiryStatus advisory whose " +
    "alreadyExpired flag is set only for a date that has actually passed; memory_read/memory_list both " +
    "annotate expired:true/false correctly while always returning the note's full body, proving expiry " +
    "gates delivery only, never existence."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
