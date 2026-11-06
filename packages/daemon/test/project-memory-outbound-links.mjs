import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// Card 1c9dcb24 — outbound [[wikilink]] resolution: a note's text can [[link]] to a key that does not
// exist in this project's memory store (renamed, forgotten, never written, or a deliberate cross-store
// reference), and nothing surfaced that before this card. This file proves:
//   1. PURE-FUNCTION cases for the new resolver (resolved/unresolved/mixed/self-link/none), each paired
//      with a positive control before trusting a negative result.
//   2. db.listProjectMemoryKeys — the key-only listing memory_read uses.
//   3. memory_write (writeProjectMemory) — unresolvedLinkStatus present/absent, and LIVE (not cached)
//      resolution once the missing target is written.
//   4. memory_read (readProjectMemory) — the unresolvedOutboundLinks field, same live-resolution proof.
//   5. memory_list (listProjectMemoryEntries) — bulk-vs-per-note equivalence.
//   6. The kickoff digest (retrieveProjectMemoryForKickoff) — the marker line is NOT injected (it is
//      memory_read-only), and a bounded call-count (cost doesn't scale per note).
//   7. MEASURE: wall time of one full kickoff digest over a realistic corpus (~750 notes, ~120 dangling
//      citations) — a regression ceiling only.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-outbound-links.mjs

const loomHome = useOwnLoomHome("loom-pm-outbound-links-");

const { Db } = await import("../dist/db.js");
const {
  findUnresolvedOutboundLinks, findUnresolvedOutboundLinksBulk, existingKeysFromCorpus,
  unresolvedOutboundLinksMessage,
} = await import("../dist/sessions/project-memory-outbound-links.js");
const { retrieveProjectMemoryForKickoff } = await import("../dist/sessions/project-memory-recall.js");
const { writeProjectMemory, listProjectMemoryEntries, readProjectMemory } = await import("../dist/mcp/memory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db();
const now = new Date().toISOString();
const PROJECT_ID = "proj-outbound-links";
db.insertProject({ id: PROJECT_ID, name: "Outbound Links Project", repoPath: loomHome, vaultPath: loomHome, config: {}, createdAt: now, archivedAt: null });

// ===== 1. PURE-FUNCTION cases =====
{
  const resolvedEntry = { key: "a", text: "see [[b]] for context.", updatedAt: now };
  const unresolvedEntry = { key: "a", text: "see [[ghost]] for context.", updatedAt: now };
  const mixedEntry = { key: "a", text: "see [[b]] and [[ghost1]] and [[ghost2]] and [[b]] again.", updatedAt: now };
  const selfEntry = { key: "a", text: "see [[a]] for itself.", updatedAt: now };
  const noneEntry = { key: "a", text: "no links here at all.", updatedAt: now };
  const existingKeys = new Set(["a", "b"]);

  // Positive control FIRST — the detector must actually fire before any "returns []" result is trusted.
  check("(pure) a genuinely unresolved target IS flagged (positive control)",
    JSON.stringify(findUnresolvedOutboundLinks(unresolvedEntry, existingKeys)) === JSON.stringify(["ghost"]));
  check("(pure) a resolved-only note returns [] (negative case, now trusted)",
    findUnresolvedOutboundLinks(resolvedEntry, existingKeys).length === 0);
  check("(pure) mixed resolved+unresolved returns only the unresolved, deduped, in first-seen order",
    JSON.stringify(findUnresolvedOutboundLinks(mixedEntry, existingKeys)) === JSON.stringify(["ghost1", "ghost2"]));
  check("(pure) a self-link to the note's own (existing) key resolves — no special-casing needed",
    findUnresolvedOutboundLinks(selfEntry, existingKeys).length === 0);
  check("(pure) a note with no wikilinks at all returns []",
    findUnresolvedOutboundLinks(noneEntry, existingKeys).length === 0);

  // existingKeysFromCorpus / bulk equivalence to the per-note path
  const corpus = [resolvedEntry, unresolvedEntry, mixedEntry, selfEntry, noneEntry].map((e, i) => ({ ...e, key: `n${i}` }));
  const keySet = existingKeysFromCorpus(corpus);
  check("(pure) existingKeysFromCorpus includes every corpus note's own key",
    corpus.every((e) => keySet.has(e.key)));
  const bulk = findUnresolvedOutboundLinksBulk(corpus);
  const perNote = new Map(corpus.map((e) => [e.key, findUnresolvedOutboundLinks(e, keySet)]));
  check("(pure) bulk resolver is byte-identical to the per-note resolver over the same corpus+keyset",
    JSON.stringify([...bulk.entries()].sort()) === JSON.stringify([...perNote.entries()].sort()));

  // memory_read/memory_write message — fuller wording, still never empty when keys are present
  const msg = unresolvedOutboundLinksMessage(["x", "y"]);
  check("(pure) the fuller message names every unresolved key", msg.includes("x") && msg.includes("y"));
  check("(pure) the fuller message acknowledges a possible cross-store reference",
    msg.toLowerCase().includes("different memory system"));
}

// ===== 2. db.listProjectMemoryKeys =====
{
  db.upsertProjectMemory(PROJECT_ID, { key: "keys-a", text: "note a." }, 1000);
  db.upsertProjectMemory(PROJECT_ID, { key: "keys-b", text: "note b." }, 1000);
  const keys = db.listProjectMemoryKeys(PROJECT_ID);
  check("(db) listProjectMemoryKeys returns exactly the keys written, no bodies needed to check this",
    keys.includes("keys-a") && keys.includes("keys-b") && keys.length === 2);
  db.deleteProjectMemory(PROJECT_ID, "keys-a");
  db.deleteProjectMemory(PROJECT_ID, "keys-b");
}

// ===== 3. memory_write: unresolvedLinkStatus =====
{
  const withGhost = writeProjectMemory(db, PROJECT_ID, { key: "write-ghost", text: "cites [[write-target]] which does not exist yet." });
  check("(write) a write whose text cites a nonexistent key carries unresolvedLinkStatus",
    !!withGhost.unresolvedLinkStatus && JSON.stringify(withGhost.unresolvedLinkStatus.unresolvedKeys) === JSON.stringify(["write-target"]));
  check("(write) unresolvedLinkStatus never blocks the write — the note still saved",
    withGhost.key === "write-ghost" && withGhost.text.includes("write-target"));

  const clean = writeProjectMemory(db, PROJECT_ID, { key: "write-clean", text: "cites nothing at all." });
  check("(write) a write with no dangling targets carries NO unresolvedLinkStatus", clean.unresolvedLinkStatus === undefined);

  // LIVE resolution, not cached: write the missing target, then re-read the ORIGINAL note.
  writeProjectMemory(db, PROJECT_ID, { key: "write-target", text: "now this exists." });
  const reread = readProjectMemory(db, PROJECT_ID, "write-ghost");
  check("(write) writing the previously-missing target resolves the ORIGINAL note on its next read (live, never cached)",
    reread.unresolvedOutboundLinks.length === 0);
}

// ===== 4. memory_read: unresolvedOutboundLinks field =====
{
  writeProjectMemory(db, PROJECT_ID, { key: "read-resolved-target", text: "exists." });
  writeProjectMemory(db, PROJECT_ID, { key: "read-a", text: "links to [[read-resolved-target]] and [[read-missing]]." });
  const a = readProjectMemory(db, PROJECT_ID, "read-a");
  check("(read) memory_read's unresolvedOutboundLinks names only the dangling target",
    JSON.stringify(a.unresolvedOutboundLinks) === JSON.stringify(["read-missing"]));
  check("(read) backlinks (inbound) are unaffected by this card — still present as their own field",
    Array.isArray(a.backlinks));

  const b = readProjectMemory(db, PROJECT_ID, "read-resolved-target");
  check("(read) a note with no outbound links at all gets unresolvedOutboundLinks: [] (measured zero, not absent)",
    Array.isArray(b.unresolvedOutboundLinks) && b.unresolvedOutboundLinks.length === 0);
}

// ===== 5. memory_list: bulk-vs-per-note equivalence =====
{
  writeProjectMemory(db, PROJECT_ID, { key: "list-x", text: "cites [[list-ghost-x]]." });
  writeProjectMemory(db, PROJECT_ID, { key: "list-y", text: "cites [[list-ghost-y]] and [[list-x]]." });
  const rows = listProjectMemoryEntries(db, PROJECT_ID);
  const rowX = rows.find((r) => r.key === "list-x");
  const rowY = rows.find((r) => r.key === "list-y");
  check("(list) memory_list's bulk path flags list-x's dangling target",
    JSON.stringify(rowX.unresolvedOutboundLinks) === JSON.stringify(["list-ghost-x"]));
  check("(list) memory_list's bulk path flags only list-y's dangling target (list-x resolves, in-corpus)",
    JSON.stringify(rowY.unresolvedOutboundLinks) === JSON.stringify(["list-ghost-y"]));
  // Equivalence against the single-note read path, over the same live store.
  const perNoteX = readProjectMemory(db, PROJECT_ID, "list-x");
  const perNoteY = readProjectMemory(db, PROJECT_ID, "list-y");
  check("(list) bulk (memory_list) and per-note (memory_read) results are byte-identical for list-x",
    JSON.stringify(rowX.unresolvedOutboundLinks) === JSON.stringify(perNoteX.unresolvedOutboundLinks));
  check("(list) bulk (memory_list) and per-note (memory_read) results are byte-identical for list-y",
    JSON.stringify(rowY.unresolvedOutboundLinks) === JSON.stringify(perNoteY.unresolvedOutboundLinks));
}

// ===== 6. Kickoff digest: marker NOT injected + bounded call-count =====
{
  db.upsertProjectMemory(PROJECT_ID, { key: "digest-pinned", text: "pinned note citing [[digest-ghost]].", pinned: true }, 1000);
  const digest = retrieveProjectMemoryForKickoff(db, PROJECT_ID, "");
  check("(digest) positive control: the pinned note citing the ghost is delivered",
    digest != null && digest.includes("(digest-pinned)"));
  check("(digest) the rendered kickoff digest carries NO unresolved-links marker (memory_read-only)",
    !digest.includes("[unresolved links"));

  // Call-count: db.listProjectMemory must not scale with corpus size.
  let calls = 0;
  const realListProjectMemory = db.listProjectMemory.bind(db);
  db.listProjectMemory = (projectId) => { calls++; return realListProjectMemory(projectId); };
  try {
    retrieveProjectMemoryForKickoff(db, PROJECT_ID, "");
    const callsAtN = calls;
    for (let i = 0; i < 50; i++) {
      db.upsertProjectMemory(PROJECT_ID, { key: `digest-filler-${i}`, text: `filler note ${i}, no links.` }, 1000);
    }
    calls = 0;
    retrieveProjectMemoryForKickoff(db, PROJECT_ID, "");
    const callsAtNPlus50 = calls;
    check(`(digest) db.listProjectMemory call count is BOUNDED, not scaling with corpus size (${callsAtN} at N, ${callsAtNPlus50} at N+50)`,
      callsAtNPlus50 === callsAtN);
  } finally {
    db.listProjectMemory = realListProjectMemory;
  }
}

// ===== 7. MEASURE: one full kickoff digest pass over a ~750 note / ~120 dangling-citation corpus =====
{
  const MEASURE_PROJECT_ID = "proj-outbound-links-measure";
  db.insertProject({ id: MEASURE_PROJECT_ID, name: "Measure Project", repoPath: loomHome, vaultPath: loomHome, config: {}, createdAt: now, archivedAt: null });
  const TOTAL_NOTES = 750;
  const DANGLING_NOTES = 120;
  for (let i = 0; i < TOTAL_NOTES; i++) {
    const dangling = i < DANGLING_NOTES ? ` cites [[ghost-citation-${i}]].` : "";
    const resolvedLink = i > 0 ? ` see [[measure-note-${i - 1}]].` : "";
    db.upsertProjectMemory(
      MEASURE_PROJECT_ID,
      { key: `measure-note-${i}`, text: `realistic memory note body #${i}, some prose.${resolvedLink}${dangling}`, pinned: i < 40 },
      100000,
    );
  }
  // The one number that answers "does a real kickoff get slower" over this corpus (the digest no longer
  // builds the outbound-links index, so this is a regression ceiling, not an ON/OFF comparison).
  const digestStart = process.hrtime.bigint();
  retrieveProjectMemoryForKickoff(db, MEASURE_PROJECT_ID, "");
  const digestElapsedMs = Number(process.hrtime.bigint() - digestStart) / 1e6;
  console.log(`MEASURED  one full retrieveProjectMemoryForKickoff pass over the same ${TOTAL_NOTES}-note/${DANGLING_NOTES}-dangling corpus: ${digestElapsedMs.toFixed(2)}ms `);
  check("(measure) a full real kickoff digest composition over this corpus completes well under 1s", digestElapsedMs < 1000);
}

process.exitCode = failures === 0 ? 0 : 1;
if (failures > 0) console.log(`\n${failures} check(s) FAILED`);
