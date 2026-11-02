import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a140598a — auto-detected card/decision/path references across memory notes, surfaced like the
// manual [[wikilink]] backlink mechanism (project-memory-backlinks.ts) but on a different signal: two
// notes that both cite the SAME board card, @decision anchor, or file path are connected even when
// nobody ever typed a [[key]] between them.
//
// THE FIX (sessions/project-memory-references.ts + sessions/project-memory-annotations.ts): extract card
// ids (8-hex, filtered to ones that resolve to a REAL task on the project), @decision anchors, and path
// tokens from note text; build a corpus-bounded reverse index ("which notes mention X"); render a
// "[mentions: ...]" annotation line, capped at MAX_MENTIONS_DIGEST, for any note whose own reference is
// ALSO shared by at least one other note. STRICT SUPERSET of the wikilink mechanism — a wikilink-wrapped
// id/path is masked out before extraction, so it is never double-counted here too.
//
// This file proves, against the REAL compiled modules:
//   1. extractDecisionAnchorIds: pure parsing (sha:/bare forms, dedup, case handling, negative controls).
//   2. extractCardIdCandidates: pure parsing + the wikilink/decision-anchor masking that keeps this
//      extractor disjoint from both of those (the "no double-counting" constraint), plus the \b boundary
//      rule that keeps it from matching only part of a longer hex run.
//   3. extractNoteReferences: the false-match limiter — a bare 8-hex token only counts as a card mention
//      once it resolves, unambiguously, to a real task on the project; an unresolvable or AMBIGUOUS
//      candidate is dropped, never guessed.
//   4. findConnectedMentionsBulk: the reverse index + "connected" semantics (shared by ≥1 OTHER note,
//      never just self), the MAX_MENTIONS_DIGEST cap + "N of M" totalFound, and a MEASURED ZERO for an
//      entity nothing else shares.
//   5. findConnectedMentions (DB-backed) equivalence to the bulk path, and the kickoff digest actually
//      rendering the "[mentions: ...]" annotation on a pinned note.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-references.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-project-memory-references-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const {
  extractDecisionAnchorIds, extractCardIdCandidates, extractNoteReferences,
  extractNoteReferencesUsingPrefixCounts, buildCardIdPrefixCounts,
  findConnectedMentionsBulk, buildMentionsIndex, annotateMentionsPrecomputed, MAX_MENTIONS_DIGEST,
} = await import("../dist/sessions/project-memory-references.js");
const { retrieveProjectMemoryForKickoff } = await import("../dist/sessions/project-memory-recall.js");
const { writeProjectMemory } = await import("../dist/mcp/memory.js");

const db = new Db();
const now = new Date().toISOString();

// Crafted task ids (mirrors test/agent-id-prefix.mjs's own pattern): real tasks whose DISPLAYED 8-char
// prefix is exactly what a note's bare mention would cite.
const SOLO_ID = "c0ffee00-0000-4000-8000-000000000001"; // unique prefix "c0ffee00"
const SOLO2_ID = "f00dcafe-0000-4000-8000-000000000002"; // unique prefix "f00dcafe"
const DUP_A = "deadbeef-0000-4000-8000-00000000000a"; // shares prefix "deadbeef" with…
const DUP_B = "deadbeef-0000-4000-8000-00000000000b"; // …this one — AMBIGUOUS on purpose
const DIGEST_SOLO_ID = "c0ffee00-0000-4000-8000-000000000099"; // own id, same DISPLAYED prefix "c0ffee00" as SOLO_ID, different project

try {
  // ===================== 1. extractDecisionAnchorIds: pure parsing =====================
  {
    check("(decision parse) a bare @decision <id> extracts the lowercased id",
      JSON.stringify(extractDecisionAnchorIds("@decision a140598a — never do X")) === JSON.stringify(["a140598a"]));
    check("(decision parse) a @decision sha:<8hex> extracts the sha-prefixed id",
      JSON.stringify(extractDecisionAnchorIds("@decision sha:c70a5e0e — a verified commit anchor")) === JSON.stringify(["sha:c70a5e0e"]));
    check("(decision parse) uppercase hex is normalized to lowercase",
      JSON.stringify(extractDecisionAnchorIds("@decision ABCD1234 — mixed case")) === JSON.stringify(["abcd1234"]));
    check("(decision parse) a repeated anchor is deduped to one entry, first-seen order preserved",
      JSON.stringify(extractDecisionAnchorIds("@decision a140598a first, @decision b2b2b2b2 second, @decision a140598a again"))
        === JSON.stringify(["a140598a", "b2b2b2b2"]));
    // NEGATIVE CONTROL: the literal keyword "@decision" must be present — plain bare hex is NOT a
    // decision anchor (that's the separate extractCardIdCandidates path, tested below).
    check("(decision parse) NEGATIVE CONTROL: bare hex with no @decision keyword extracts nothing",
      extractDecisionAnchorIds("just a140598a bare, no anchor keyword").length === 0);
    // NEGATIVE CONTROL: "@decisionX" (keyword glued to trailing text) must NOT match — proves the
    // regex is anchored to the literal keyword + whitespace, not a loose substring scan.
    check("(decision parse) NEGATIVE CONTROL: a glued '@decisionX a140598a' does not match",
      extractDecisionAnchorIds("@decisionX a140598a is not a real anchor").length === 0);
  }

  // ===================== 2. extractCardIdCandidates: pure parsing + masking =====================
  {
    check("(card parse) a bare 8-hex token is a candidate",
      JSON.stringify(extractCardIdCandidates("see c0ffee00 for the fix")) === JSON.stringify(["c0ffee00"]));
    check("(card parse) uppercase hex is normalized to lowercase",
      JSON.stringify(extractCardIdCandidates("see C0FFEE00 for the fix")) === JSON.stringify(["c0ffee00"]));
    check("(card parse) a repeated bare id is deduped",
      JSON.stringify(extractCardIdCandidates("c0ffee00 ... later also c0ffee00 again")) === JSON.stringify(["c0ffee00"]));

    // NO-DOUBLE-COUNT (wikilink): a bare hex token sitting INSIDE a [[key]] span is masked out, never
    // extracted as a separate card-id candidate — proven DISCRIMINATINGLY against the positive control
    // directly above (same identifier, in vs. out of brackets).
    check("(card parse) NO-DOUBLE-COUNT: a hex id wrapped in [[...]] is masked out (wikilinks own this)",
      extractCardIdCandidates("see [[c0ffee00]] for the fix").length === 0);
    check("(card parse) a bracketed id AND a separate bare mention of the SAME id still extracts the bare one",
      JSON.stringify(extractCardIdCandidates("[[c0ffee00]] and separately c0ffee00 bare")) === JSON.stringify(["c0ffee00"]));

    // NO-DOUBLE-COUNT (decision anchor): a hex id inside a @decision anchor is masked out too, never
    // ALSO extracted as a separate bare card-id candidate.
    check("(card parse) NO-DOUBLE-COUNT: a hex id inside @decision ... is masked out of bare extraction",
      extractCardIdCandidates("@decision c0ffee00 — only cited as a decision anchor").length === 0);

    // BOUNDARY: a longer contiguous hex run (a 40-char commit sha) is never partially matched — \b only
    // fires at the edges of the WHOLE alphanumeric run, never mid-run.
    check("(card parse) BOUNDARY: an 8-hex PREFIX embedded in a 40-char hex run does not match at all",
      extractCardIdCandidates("commit c0ffee001111111111111111111111111111aaaa touched this").length === 0);
    // Sanity that the SAME 40-char string, truncated right after the first 8 chars by a non-hex
    // boundary, DOES match — proves the boundary rule discriminates rather than silently rejecting all
    // hex-adjacent text.
    check("(card parse) BOUNDARY sanity: the identical 8-hex prefix DOES match once followed by a non-hex boundary",
      JSON.stringify(extractCardIdCandidates("commit c0ffee00-abcd touched this")) === JSON.stringify(["c0ffee00"]));
  }

  // ===================== 2b. path-token plausibility filter (manager review, round 2) =====================
  // extractPathTokens (reused unmodified) matches a bare numeric ratio like "3/3" in prose as a
  // syntactically valid 2-segment "path" — filtered HERE, at this module's own call site, so that
  // never becomes a mentions-feature connection, without touching extractPathTokens' own behavior for
  // its pre-existing triggerGlob caller.
  {
    const emptyPrefixCounts = new Map();
    check("(path filter) NEGATIVE CONTROL: a bare numeric ratio '3/3' is never treated as a path",
      !extractNoteReferencesUsingPrefixCounts("proven 3/3 in this run", emptyPrefixCounts).paths.includes("3/3"));
    check("(path filter) NEGATIVE CONTROL: '1/2' is likewise rejected",
      !extractNoteReferencesUsingPrefixCounts("passed 1/2 so far", emptyPrefixCounts).paths.includes("1/2"));
    check("(path filter) NEGATIVE CONTROL: a degenerate single-char-segment token 'a/b' is rejected",
      !extractNoteReferencesUsingPrefixCounts("see a/b for details", emptyPrefixCounts).paths.includes("a/b"));
    // POSITIVE CONTROLS, proving the filter discriminates rather than rejecting every path-shaped token.
    check("(path filter) POSITIVE: a real extension-bearing path still passes",
      extractNoteReferencesUsingPrefixCounts("see packages/daemon/src/db.ts for the real code", emptyPrefixCounts).paths.includes("packages/daemon/src/db.ts"));
    check("(path filter) POSITIVE: a real extension-less path (letters, no dot-extension) still passes",
      extractNoteReferencesUsingPrefixCounts("see docs/decisions for the record", emptyPrefixCounts).paths.includes("docs/decisions"));

    // END-TO-END: two notes that only share a "3/3"-style ratio must NEVER be reported as connected —
    // this is the actual failure mode the manager flagged (a bogus path linking unrelated notes).
    const proj = "proj-refs-path-filter-e2e";
    db.insertProject({ id: proj, name: "Path Filter E2E Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    db.upsertProjectMemory(proj, { key: "ratio-note-a", text: "our suite is green, proven 3/3 on this run" }, 500);
    db.upsertProjectMemory(proj, { key: "ratio-note-b", text: "completely unrelated topic, also proven 3/3 somewhere else" }, 500);
    const bulkPathFilter = findConnectedMentionsBulk(db.listProjectMemory(proj), db.listTasks(proj));
    check("(path filter) END-TO-END: two notes sharing ONLY a '3/3' ratio are reported as NOT connected",
      bulkPathFilter.get("ratio-note-a").totalFound === 0 && bulkPathFilter.get("ratio-note-b").totalFound === 0);
  }

  // ===================== 3. extractNoteReferences: false-match limiting (resolve-to-real-task) =====================
  {
    const proj = "proj-refs-resolve";
    db.insertProject({ id: proj, name: "Refs Resolve Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    db.insertTask({ id: SOLO_ID, projectId: proj, title: "solo card", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    db.insertTask({ id: DUP_A, projectId: proj, title: "dup A", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
    db.insertTask({ id: DUP_B, projectId: proj, title: "dup B", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
    const tasks = db.listTasks(proj);

    check("(resolve) a bare id that resolves to exactly one real task counts as a card mention",
      JSON.stringify(extractNoteReferences("see c0ffee00 for the fix", tasks).cardIds) === JSON.stringify(["c0ffee00"]));

    // FALSE-MATCH LIMITING (the card's own explicit DoD item): an 8-hex token shaped exactly like a
    // commit sha / random hex, with NO matching task on the project, must NOT be counted.
    check("(resolve) NEGATIVE CONTROL — false-match limiting: an 8-hex token with NO matching task is excluded",
      extractNoteReferences("looks like a commit 1234abcd but is not a card", tasks).cardIds.length === 0);

    // AMBIGUOUS PREFIX: two tasks share the same 8-char prefix — resolveIdPrefix reports "ambiguous",
    // and this must be treated as UNRESOLVED, never silently guessed (the 3a3f587 precedent).
    check("(resolve) an AMBIGUOUS prefix (matches two tasks) is excluded, never guessed",
      extractNoteReferences("references deadbeef in passing", tasks).cardIds.length === 0);

    // Decision anchors and path tokens are accepted as-is, unverified (no task/filesystem check).
    const refs = extractNoteReferences("@decision sha:ffffffff and packages/daemon/src/db.ts", tasks);
    check("(resolve) a decision sha: anchor is accepted unverified",
      JSON.stringify(refs.decisionIds) === JSON.stringify(["sha:ffffffff"]));
    check("(resolve) a path token is accepted unverified",
      refs.paths.includes("packages/daemon/src/db.ts"));

    // EQUIVALENCE (round 2, performance): the convenience wrapper (builds its own prefix map per call)
    // and the hot-path function (given a prebuilt prefix map) must agree exactly — the refactor changed
    // HOW card ids are resolved (O(tasks)-per-candidate scan -> O(1) map lookup), never WHAT counts as
    // resolved.
    const prefixCounts = buildCardIdPrefixCounts(tasks);
    const viaConvenience = extractNoteReferences("c0ffee00, 1234abcd, deadbeef, @decision sha:ffffffff", tasks);
    const viaPrefixCounts = extractNoteReferencesUsingPrefixCounts("c0ffee00, 1234abcd, deadbeef, @decision sha:ffffffff", prefixCounts);
    check("(resolve) EQUIVALENCE: extractNoteReferences and extractNoteReferencesUsingPrefixCounts agree exactly",
      JSON.stringify(viaConvenience) === JSON.stringify(viaPrefixCounts));

    // Additive guard: a project with zero tasks never throws, just resolves nothing.
    const emptyProj = "proj-refs-empty-tasks";
    db.insertProject({ id: emptyProj, name: "No Tasks Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    check("(resolve) a project with zero tasks resolves zero card mentions, no throw",
      extractNoteReferences("c0ffee00 mentioned here", db.listTasks(emptyProj)).cardIds.length === 0);
  }

  // ===================== 3b. db.listTaskIds: narrow id-only read (round 3, performance) =====================
  // card a140598a round 3 — buildMentionsIndex uses db.listTaskIds (never the general db.listTasks) so
  // it never pays toTask's per-row conversion or the separate deferral-edges join for data it never
  // reads. Proven here: the SAME set of ids as the general read, on a real multi-task project.
  {
    const proj = "proj-refs-listtaskids";
    db.insertProject({ id: proj, name: "listTaskIds Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    const craftedIds = [
      "11110000-0000-4000-8000-000000000001",
      "22220000-0000-4000-8000-000000000002",
      "33330000-0000-4000-8000-000000000003",
      "44440000-0000-4000-8000-000000000004",
    ];
    for (const id of craftedIds) {
      db.insertTask({ id, projectId: proj, title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    }
    const viaListTaskIds = new Set(db.listTaskIds(proj));
    const viaListTasks = new Set(db.listTasks(proj).map((t) => t.id));
    check("(listTaskIds) returns EXACTLY the same id set as db.listTasks(...).map(t => t.id)",
      viaListTaskIds.size === craftedIds.length && JSON.stringify([...viaListTaskIds].sort()) === JSON.stringify([...viaListTasks].sort()));

    // Additive guard: a project with zero tasks returns [], no throw.
    const emptyTaskProj = "proj-refs-listtaskids-empty";
    db.insertProject({ id: emptyTaskProj, name: "No Tasks", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    check("(listTaskIds) a project with zero tasks returns [], no throw", db.listTaskIds(emptyTaskProj).length === 0);
  }

  // ===================== 4. findConnectedMentionsBulk: reverse index, cap, totalFound =====================
  {
    const proj = "proj-refs-bulk";
    db.insertProject({ id: proj, name: "Refs Bulk Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    db.insertTask({ id: SOLO2_ID, projectId: proj, title: "lonely card", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const hubCardIds = [];
    for (let i = 0; i < 8; i++) {
      const id = `0000000${i}-0000-4000-8000-000000000000`;
      db.insertTask({ id, projectId: proj, title: `hub card ${i}`, body: "", columnKey: "backlog", position: 10 + i, priority: "p2", createdAt: now, updatedAt: now });
      hubCardIds.push(`0000000${i}`);
    }
    const tasks = db.listTasks(proj);

    db.upsertProjectMemory(proj, { key: "hub-note", text: `refs: ${hubCardIds.join(" ")}` }, 500);
    for (const cid of hubCardIds) {
      db.upsertProjectMemory(proj, { key: `satellite-${cid}`, text: `a satellite note referencing ${cid}` }, 500);
    }
    // A note mentioning a REAL, resolvable card that nothing else shares — a resolved reference that is
    // still NOT "connected" (the distinction connectedMentionsFor exists to make).
    db.upsertProjectMemory(proj, { key: "lonely-mentioner", text: `only I mention ${SOLO2_ID.slice(0, 8)}` }, 500);
    db.upsertProjectMemory(proj, { key: "unrelated-note", text: "nothing relevant here at all" }, 500);

    const corpus = db.listProjectMemory(proj);
    const bulk = findConnectedMentionsBulk(corpus, tasks);

    const hubResult = bulk.get("hub-note");
    check(`(bulk) hub note: totalFound reports the TRUE total (8 connected cards), uncapped`, hubResult.totalFound === 8);
    check(`(bulk) hub note: matches is capped at MAX_MENTIONS_DIGEST (${MAX_MENTIONS_DIGEST})`, hubResult.matches.length === MAX_MENTIONS_DIGEST);
    check("(bulk) hub note: every rendered match is kind:card", hubResult.matches.every((m) => m.kind === "card"));

    const unrelatedResult = bulk.get("unrelated-note");
    check("(bulk) MEASURED ZERO: a note with no references at all reports totalFound:0, matches:[]",
      unrelatedResult.totalFound === 0 && unrelatedResult.matches.length === 0);

    const lonelyResult = bulk.get("lonely-mentioner");
    check("(bulk) MEASURED ZERO (discriminating): a RESOLVED reference that NOTHING ELSE shares is still not 'connected'",
      lonelyResult.totalFound === 0 && lonelyResult.matches.length === 0);

    const satelliteResult = bulk.get(`satellite-${hubCardIds[0]}`);
    check("(bulk) a satellite note's own connection back to the hub's shared card is symmetric",
      satelliteResult.totalFound === 1 && satelliteResult.matches[0].kind === "card" && satelliteResult.matches[0].id === hubCardIds[0]);

    // POSITIVE CONTROL (DoD-4 shape): re-run against a DESYNCED corpus (missing one of the real
    // satellites) and require the hub's totalFound to come back LOWER — proves the comparison can
    // actually detect a real difference, not vacuously agree no matter what.
    const desyncedCorpus = corpus.filter((e) => e.key !== `satellite-${hubCardIds[7]}`);
    const desyncedBulk = findConnectedMentionsBulk(desyncedCorpus, tasks);
    check("(bulk) POSITIVE CONTROL: removing one satellite from the corpus correctly drops the hub's totalFound by one",
      desyncedBulk.get("hub-note").totalFound === hubResult.totalFound - 1);
  }

  // ===================== 4b. expired notes are excluded from the mentions corpus entirely (card 57a91801, round 4) =====================
  // Manager decision: consistent with 57a91801 excluding an expired note from every kickoff-rendering
  // tier, buildMentionsIndex excludes an expired note too — neither as a MENTIONER (its own references
  // never populate the reverse index) nor as a MENTIONED note (another live note sharing a reference
  // with ONLY an expired note is not "connected" either).
  {
    const proj = "proj-refs-expiry";
    db.insertProject({ id: proj, name: "Refs Expiry Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    const expiryCardId = "55550000-0000-4000-8000-000000000005";
    db.insertTask({ id: expiryCardId, projectId: proj, title: "expiry card", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const cardPrefix = expiryCardId.slice(0, 8);

    // A note that mentions the SAME card as a live note, but is itself EXPIRED (expiresAt in the past).
    db.upsertProjectMemory(proj, { key: "expired-mentioner", text: `an expired note mentioning ${cardPrefix}`, expiresAt: "2020-01-01" }, 500);
    db.upsertProjectMemory(proj, { key: "live-mentioner", text: `a live note ALSO mentioning ${cardPrefix}, no wikilink to the expired one` }, 500);
    // Sanity positive control: TWO live notes sharing a DIFFERENT card id ARE still connected — proves
    // the expiry filter discriminates rather than breaking connectivity altogether.
    const controlCardId = "66660000-0000-4000-8000-000000000006";
    db.insertTask({ id: controlCardId, projectId: proj, title: "control card", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
    const controlPrefix = controlCardId.slice(0, 8);
    db.upsertProjectMemory(proj, { key: "live-control-a", text: `control note A mentioning ${controlPrefix}` }, 500);
    db.upsertProjectMemory(proj, { key: "live-control-b", text: `control note B ALSO mentioning ${controlPrefix}` }, 500);

    const mentionsIndex = buildMentionsIndex(db, proj);
    check("(expiry) POSITIVE CONTROL: two LIVE notes sharing a card id ARE reported as connected",
      mentionsIndex.get("live-control-a")?.totalFound === 1 && mentionsIndex.get("live-control-b")?.totalFound === 1);
    check("(expiry) a LIVE note whose ONLY sharer is an EXPIRED note is reported as NOT connected",
      mentionsIndex.get("live-mentioner")?.totalFound === 0);
    check("(expiry) an EXPIRED note itself has NO entry in the mentions index at all (never a mentioner)",
      !mentionsIndex.has("expired-mentioner"));
    check("(expiry) annotateMentionsPrecomputed on the expired note's own key returns [] (no entry to look up)",
      annotateMentionsPrecomputed(mentionsIndex, "expired-mentioner").length === 0);
    check("(expiry) annotateMentionsPrecomputed on the live note that only shared with the expired one renders no line",
      annotateMentionsPrecomputed(mentionsIndex, "live-mentioner").length === 0);
  }

  // ===================== 5. buildMentionsIndex (built ONCE) + annotateMentionsPrecomputed + kickoff digest =====================
  {
    const proj = "proj-refs-digest";
    db.insertProject({ id: proj, name: "Refs Digest Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    db.insertTask({ id: DIGEST_SOLO_ID, projectId: proj, title: "solo card", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const canonical = writeProjectMemory(db, proj, { key: "digest-canonical", text: `the real fix lives behind c0ffee00`, pinned: true });
    check("(digest) setup: canonical note written", !("error" in canonical));
    const sharer = writeProjectMemory(db, proj, { key: "digest-sharer", text: `independently, ${DIGEST_SOLO_ID.slice(0, 8)} is also referenced here, no [[wikilink]] to the canonical note` });
    check("(digest) setup: a SECOND note shares the same card id, with NO manual wikilink between them", !("error" in sharer));
    const lonely = writeProjectMemory(db, proj, { key: "digest-lonely", text: "a note mentioning nothing shared" });
    check("(digest) setup: lonely note written", !("error" in lonely));

    // buildMentionsIndex (round 2): built EXACTLY ONCE, then every note's lookup is an O(1) Map.get —
    // this is what real callers (retrieveProjectMemoryForKickoff, computeNeverDropStatus/
    // computeRestTierSignal) now do instead of re-scanning the corpus+tasks per annotated note.
    const mentionsIndex = buildMentionsIndex(db, proj);
    const dbResult = mentionsIndex.get("digest-canonical");
    check("(db) buildMentionsIndex resolves the shared card id as a connected mention",
      dbResult.totalFound === 1 && dbResult.matches[0].kind === "card" && dbResult.matches[0].id === "c0ffee00");

    const lines = annotateMentionsPrecomputed(mentionsIndex, "digest-canonical");
    check("(db) annotateMentionsPrecomputed renders a '[mentions: card c0ffee00]' line",
      lines.some((l) => l === "[mentions: card c0ffee00]"));
    const lonelyLines = annotateMentionsPrecomputed(mentionsIndex, "digest-lonely");
    check("(db) annotateMentionsPrecomputed on a note with nothing connected returns [] (measured zero, not omitted)",
      Array.isArray(lonelyLines) && lonelyLines.length === 0);
    check("(db) annotateMentionsPrecomputed with an undefined index returns [] rather than throwing",
      Array.isArray(annotateMentionsPrecomputed(undefined, "digest-canonical")) && annotateMentionsPrecomputed(undefined, "digest-canonical").length === 0);

    // The kickoff digest actually renders the mentions annotation — THE auto-detected reference
    // surfacing a connection a hand wikilink never made (the card's own measurement framing).
    const framed = retrieveProjectMemoryForKickoff(db, proj, "");
    check("(digest) the kickoff digest renders the mentions annotation on the pinned canonical note",
      typeof framed === "string" && framed.includes("[mentions: card c0ffee00]"));
    check("(digest) the digest never renders a mentions line for the lonely note (no false positive noise)",
      !framed.includes("digest-lonely"));
  }

  // ===================== zero-notes additive guard =====================
  check("(additive) buildMentionsIndex on an empty project returns an empty map, no throw",
    (() => {
      const emptyProj = "proj-refs-empty";
      db.insertProject({ id: emptyProj, name: "Empty Refs Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
      const m = buildMentionsIndex(db, emptyProj);
      return m.size === 0;
    })());
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — auto-detected card/decision/path reference extraction (pure parsing, dedup, " +
    "@decision + wikilink masking for no-double-counting, \\b hex-boundary protection), the false-match " +
    "limiter (resolve-to-a-real-task, ambiguous-prefix exclusion), the corpus-bounded reverse index " +
    "(connected-vs-merely-resolved distinction, MAX_MENTIONS_DIGEST cap + totalFound), and the kickoff " +
    "digest rendering the '[mentions: ...]' annotation for a cross-note connection no [[wikilink]] ever " +
    "made — all claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
